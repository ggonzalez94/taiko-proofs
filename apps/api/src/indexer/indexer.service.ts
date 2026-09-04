import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  decodeEventLog,
  type AbiEvent,
  Log,
  HttpRequestError,
  TimeoutError
} from "viem";
import { PrismaService } from "../prisma/prisma.service";
import { ChainService } from "../chain/chain.service";
import { AppConfigService } from "../config/app-config.service";
import { StatsService } from "../stats/stats.service";
import { shastaInboxAbi } from "../chain/shastaInboxAbi";
import { redactUrlSecrets } from "../common/redact";
import { ShastaProofClassifierService } from "./shasta-proof-classifier.service";

const proposedEvent = shastaInboxAbi.find(
  (item) => item.type === "event" && item.name === "Proposed"
) as AbiEvent;
const provedEvent = shastaInboxAbi.find(
  (item) => item.type === "event" && item.name === "Proved"
) as AbiEvent;
const SHASTA_FORK_TIMESTAMP = 1775135700n; // 2026-04-02 13:15:00 UTC

type IndexingResult = {
  fromBlock: string;
  toBlock: string;
  targetBlock: string;
  processed: number;
  status: "skipped" | "partial" | "success";
};

type ProposedLogArgs = {
  id: number | bigint;
  proposer: string;
  parentProposalHash: `0x${string}`;
};

type ProvedLogArgs = {
  firstProposalId: number | bigint;
  firstNewProposalId: number | bigint;
  lastProposalId: number | bigint;
  actualProver: string;
};

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private logRangeLimit?: bigint;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    private readonly config: AppConfigService,
    private readonly classifier: ShastaProofClassifierService,
    private readonly stats: StatsService
  ) {
    if (this.config.indexerLogRangeLimit) {
      this.logRangeLimit = BigInt(this.config.indexerLogRangeLimit);
    }
  }

  async runIndexing(): Promise<IndexingResult> {
    const client = this.chain.getClient();
    let safeBlock: bigint;
    let startBlock: bigint;

    try {
      const latestBlock = await client.getBlockNumber();
      safeBlock =
        latestBlock > BigInt(this.config.confirmations)
          ? latestBlock - BigInt(this.config.confirmations)
          : latestBlock;
      startBlock = await this.resolveStartBlock(safeBlock);
    } catch (error) {
      // Nothing holds the lock yet, so the failure would otherwise leave no trace in the DB.
      await this.recordFailureWithoutLock(error);
      throw error;
    }

    const lock = await this.acquireIndexingLock(startBlock);
    if (!lock) {
      this.logger.warn("Indexing already running; skipping this run.");
      return {
        fromBlock: startBlock.toString(),
        toBlock: startBlock.toString(),
        targetBlock: safeBlock.toString(),
        processed: 0,
        status: "skipped"
      };
    }

    const { lockId, lastProcessedBlock } = lock;
    const fromBlock =
      lastProcessedBlock > BigInt(this.config.reorgBuffer)
        ? lastProcessedBlock - BigInt(this.config.reorgBuffer)
        : startBlock;
    const chunkSize = BigInt(this.config.indexerChunkSize);

    if (safeBlock <= fromBlock) {
      this.logger.log("No new blocks to index");
      await this.releaseIndexingLock(lockId, "success");
      return {
        fromBlock: fromBlock.toString(),
        toBlock: safeBlock.toString(),
        targetBlock: safeBlock.toString(),
        processed: 0,
        status: "success"
      };
    }

    let processed = 0;
    const totalRanges = (safeBlock - fromBlock) / chunkSize + 1n;
    let rangeIndex = 1n;
    const runStartedAt = Date.now();
    const maxRuntimeSeconds = this.config.indexerMaxRuntimeSeconds;
    const deadlineMs =
      typeof maxRuntimeSeconds === "number" && maxRuntimeSeconds > 0
        ? runStartedAt + maxRuntimeSeconds * 1000
        : null;
    let lastCheckpointBlock = lastProcessedBlock;

    try {
      this.logger.log(
        `Indexing ${totalRanges.toString()} range(s) from ${fromBlock} to ${safeBlock} (chunk ${chunkSize}).`
      );

      for (let cursor = fromBlock; cursor <= safeBlock; cursor += chunkSize) {
        if (deadlineMs && Date.now() >= deadlineMs) {
          this.logger.warn(
            `Indexer max runtime (${maxRuntimeSeconds}s) reached; stopping early at ${lastCheckpointBlock}.`
          );
          break;
        }

        const toBlock = cursor + chunkSize - 1n > safeBlock ? safeBlock : cursor + chunkSize - 1n;
        const rangeStartedAt = Date.now();
        this.logger.log(
          `Processing range ${rangeIndex.toString()}/${totalRanges.toString()}: ${cursor} -> ${toBlock}.`
        );
        const processedInRange = await this.processRange(cursor, toBlock);
        processed += processedInRange;

        this.logger.log(
          `Processed range ${cursor} -> ${toBlock}: ${processedInRange} event(s) in ${this.formatDuration(
            rangeStartedAt
          )}.`
        );

        await this.checkpointIndexingProgress(lockId, toBlock);
        lastCheckpointBlock = toBlock;
        rangeIndex += 1n;
      }

      const statsStartedAt = Date.now();
      await this.stats.refreshDailyStats(this.config.statsLookbackDays);
      this.logger.log(
        `Stats refresh (${this.config.statsLookbackDays} days) in ${this.formatDuration(
          statsStartedAt
        )}.`
      );

      const caughtUp = lastCheckpointBlock >= safeBlock;
      const status = caughtUp ? "success" : "partial";
      this.logger.log(
        `Indexing run ${status}: processed ${processed} event(s) in ${this.formatDuration(
          runStartedAt
        )}.`
      );

      await this.releaseIndexingLock(lockId, status);
      return {
        fromBlock: fromBlock.toString(),
        toBlock: lastCheckpointBlock.toString(),
        targetBlock: safeBlock.toString(),
        processed,
        status
      };
    } catch (error) {
      await this.releaseIndexingLock(lockId, "failed", error);
      throw error;
    }
  }

  private async processRange(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const rollbackStartedAt = Date.now();
    const rollbackStats = await this.rollbackRange(fromBlock, toBlock);
    this.logger.log(
      `Range ${fromBlock} -> ${toBlock} rollback: ${rollbackStats.deleted} proposals deleted, ${rollbackStats.reverted} proofs reverted in ${this.formatDuration(
        rollbackStartedAt
      )}.`
    );

    const client = this.chain.getClient();
    const proposedLogs = await this.fetchLogsWithTiming("Proposed", proposedEvent, fromBlock, toBlock);
    const provedLogs = await this.fetchLogsWithTiming("Proved", provedEvent, fromBlock, toBlock);
    const blockTimestampCache = new Map<string, Date>();

    const getBlockTimestamp = async (blockNumber: bigint) => {
      const key = blockNumber.toString();
      const cached = blockTimestampCache.get(key);
      if (cached) {
        return cached;
      }

      const block = await client.getBlock({ blockNumber });
      const timestamp = new Date(Number(block.timestamp) * 1000);
      blockTimestampCache.set(key, timestamp);
      return timestamp;
    };

    const proposedStartedAt = Date.now();
    for (const log of proposedLogs) {
      await this.handleProposed(log, getBlockTimestamp);
    }
    this.logger.log(
      `Range ${fromBlock} -> ${toBlock} handled ${proposedLogs.length} Proposed log(s) in ${this.formatDuration(
        proposedStartedAt
      )}.`
    );

    const provedStartedAt = Date.now();
    for (const log of provedLogs) {
      await this.handleProved(log, getBlockTimestamp);
    }
    this.logger.log(
      `Range ${fromBlock} -> ${toBlock} handled ${provedLogs.length} Proved log(s) in ${this.formatDuration(
        provedStartedAt
      )}.`
    );

    return proposedLogs.length + provedLogs.length;
  }

  private async resolveStartBlock(safeBlock: bigint): Promise<bigint> {
    if (typeof this.config.shastaStartBlock === "number") {
      return BigInt(this.config.shastaStartBlock);
    }

    const resolved = await this.findFirstBlockAtOrAfterTimestamp(
      SHASTA_FORK_TIMESTAMP,
      safeBlock
    );
    this.logger.log(
      `Resolved initial Shasta start block ${resolved.toString()} from fork timestamp ${SHASTA_FORK_TIMESTAMP.toString()}.`
    );
    return resolved;
  }

  private async findFirstBlockAtOrAfterTimestamp(
    targetTimestamp: bigint,
    maxBlock: bigint
  ): Promise<bigint> {
    const client = this.chain.getClient();
    const timestampCache = new Map<string, bigint>();

    const getBlockTimestamp = async (blockNumber: bigint) => {
      const key = blockNumber.toString();
      const cached = timestampCache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const block = await client.getBlock({ blockNumber });
      const timestamp = BigInt(block.timestamp);
      timestampCache.set(key, timestamp);
      return timestamp;
    };

    if ((await getBlockTimestamp(maxBlock)) < targetTimestamp) {
      return maxBlock;
    }

    let low = 0n;
    let high = maxBlock;

    while (low < high) {
      const mid = low + (high - low) / 2n;
      const timestamp = await getBlockTimestamp(mid);

      if (timestamp >= targetTimestamp) {
        high = mid;
      } else {
        low = mid + 1n;
      }
    }

    return low;
  }

  private async rollbackRange(
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<{ deleted: number; reverted: number }> {
    const proposedInRange = await this.prisma.shastaProposal.findMany({
      where: {
        proposedBlock: {
          gte: fromBlock,
          lte: toBlock
        }
      },
      select: { proposalId: true }
    });

    const provedInRange = await this.prisma.shastaProposal.findMany({
      where: {
        provenBlock: {
          gte: fromBlock,
          lte: toBlock
        }
      },
      select: { proposalId: true }
    });

    await this.prisma.shastaProposal.updateMany({
      where: {
        provenBlock: {
          gte: fromBlock,
          lte: toBlock
        }
      },
      data: {
        actualProver: null,
        provenAt: null,
        provenBlock: null,
        proofTxHash: null,
        verifierAddress: null,
        proofSystems: { set: [] },
        teeVerifiers: { set: [] },
        verifiedAt: null,
        verifiedBlock: null,
        verifiedTxHash: null,
        status: "proposed",
        transitionParentHash: null,
        transitionBlockHash: null,
        transitionStateRoot: null,
        isContested: false
      }
    });

    await this.prisma.shastaProposal.deleteMany({
      where: {
        proposedBlock: {
          gte: fromBlock,
          lte: toBlock
        }
      }
    });

    return {
      deleted: proposedInRange.length,
      reverted: provedInRange.length
    };
  }

  private async handleProposed(
    log: Log,
    getBlockTimestamp: (blockNumber: bigint) => Promise<Date>
  ) {
    if (!log.blockNumber) {
      return;
    }

    const decoded = decodeEventLog({
      abi: shastaInboxAbi,
      data: log.data,
      topics: log.topics
    });
    const { id, proposer, parentProposalHash } = decoded.args as unknown as ProposedLogArgs;
    const proposalId = BigInt(id);

    if (proposalId === 0n) {
      return;
    }

    await this.prisma.shastaProposal.upsert({
      where: { proposalId },
      create: {
        proposalId,
        proposedAt: await getBlockTimestamp(log.blockNumber),
        proposedBlock: BigInt(log.blockNumber),
        proposedTxHash: log.transactionHash ?? null,
        proposer: proposer.toLowerCase(),
        parentProposalHash,
        status: "proposed"
      },
      update: {
        proposedAt: await getBlockTimestamp(log.blockNumber),
        proposedBlock: BigInt(log.blockNumber),
        ...(log.transactionHash ? { proposedTxHash: log.transactionHash } : {}),
        proposer: proposer.toLowerCase(),
        parentProposalHash
      }
    });
  }

  private async handleProved(
    log: Log,
    getBlockTimestamp: (blockNumber: bigint) => Promise<Date>
  ) {
    if (!log.blockNumber || !log.transactionHash) {
      return;
    }

    const decoded = decodeEventLog({
      abi: shastaInboxAbi,
      data: log.data,
      topics: log.topics
    });
    const {
      firstProposalId: rawFirstProposalId,
      firstNewProposalId: rawFirstNewProposalId,
      lastProposalId: rawLastProposalId,
      actualProver
    } = decoded.args as unknown as ProvedLogArgs;
    const firstProposalId = BigInt(rawFirstProposalId);
    const firstNewProposalId = BigInt(rawFirstNewProposalId);
    const lastProposalId = BigInt(rawLastProposalId);

    if (lastProposalId < firstNewProposalId) {
      return;
    }

    const tx = await this.chain.getClient().getTransaction({
      hash: log.transactionHash
    });
    const submission = this.classifier.extractProofSubmission(tx.input as `0x${string}`);
    if (!submission) {
      return;
    }

    const proofVerifierAddress = await this.classifier.getProofVerifierAddress();
    const normalizedActualProver = actualProver.toLowerCase();
    const normalizedCommittedProver = submission.commitment.actualProver.toLowerCase();
    if (normalizedCommittedProver !== normalizedActualProver) {
      this.logger.warn(
        `Shasta proof tx ${log.transactionHash} actual prover mismatch between event and input`
      );
    }

    const { proofSystems, teeVerifiers } = this.classifier.classifyProof(
      submission.proofData
    );
    const provenAt = await getBlockTimestamp(log.blockNumber);
    const provenBlock = BigInt(log.blockNumber);
    const offset = Number(firstNewProposalId - firstProposalId);

    for (let proposalId = firstNewProposalId; proposalId <= lastProposalId; proposalId += 1n) {
      const transitionIndex = offset + Number(proposalId - firstNewProposalId);
      const transition = submission.commitment.transitions[transitionIndex];
      if (!transition) {
        this.logger.warn(
          `Missing transition for Shasta proposal ${proposalId.toString()} in tx ${log.transactionHash}`
        );
        continue;
      }

      const transitionParentHash =
        transitionIndex === 0
          ? submission.commitment.firstProposalParentBlockHash
          : submission.commitment.transitions[transitionIndex - 1]?.blockHash ?? null;
      const transitionStateRoot =
        proposalId === lastProposalId ? submission.commitment.endStateRoot : null;
      const existing = await this.prisma.shastaProposal.findUnique({
        where: { proposalId }
      });

      await this.prisma.shastaProposal.upsert({
        where: { proposalId },
        create: {
          proposalId,
          proposedAt: new Date(Number(transition.timestamp) * 1000),
          proposedBlock: provenBlock,
          proposedTxHash: null,
          proposer: existing?.proposer ?? transition.proposer.toLowerCase(),
          parentProposalHash: existing?.parentProposalHash ?? null,
          actualProver: normalizedActualProver,
          provenAt,
          provenBlock,
          proofTxHash: log.transactionHash,
          verifierAddress: proofVerifierAddress,
          proofSystems,
          teeVerifiers,
          verifiedAt: provenAt,
          verifiedBlock: provenBlock,
          verifiedTxHash: log.transactionHash,
          status: "verified",
          transitionParentHash,
          transitionBlockHash: transition.blockHash,
          transitionStateRoot,
          isContested: false
        },
        update: {
          actualProver: normalizedActualProver,
          provenAt,
          provenBlock,
          proofTxHash: log.transactionHash,
          verifierAddress: proofVerifierAddress,
          proofSystems: { set: proofSystems },
          teeVerifiers: { set: teeVerifiers },
          verifiedAt: provenAt,
          verifiedBlock: provenBlock,
          verifiedTxHash: log.transactionHash,
          status: "verified",
          transitionParentHash,
          transitionBlockHash: transition.blockHash,
          transitionStateRoot,
          isContested: false
        }
      });
    }
  }

  private async getLogsSafe(
    event: AbiEvent,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Log[]> {
    const client = this.chain.getClient();
    const address = this.config.shastaInboxAddress as `0x${string}`;
    const queue: Array<{ from: bigint; to: bigint; attempts: number }> = [
      { from: fromBlock, to: toBlock, attempts: 0 }
    ];
    const results: Log[] = [];

    while (queue.length) {
      const range = queue.shift();
      if (!range) {
        continue;
      }

      if (this.logRangeLimit && range.to - range.from + 1n > this.logRangeLimit) {
        this.enqueueRanges(queue, range.from, range.to, this.logRangeLimit);
        continue;
      }

      try {
        const logs = await client.getLogs({
          address,
          event,
          fromBlock: range.from,
          toBlock: range.to
        });
        results.push(...logs);
      } catch (error) {
        if (this.isHttpRequestError(error) || this.isTimeoutError(error)) {
          if (range.from < range.to) {
            const mid = (range.from + range.to) / 2n;
            queue.unshift({ from: mid + 1n, to: range.to, attempts: range.attempts });
            queue.unshift({ from: range.from, to: mid, attempts: range.attempts });
            continue;
          }

          if (range.attempts < 6) {
            const delayMs = Math.min(1000 * 2 ** range.attempts, 15000);
            await this.sleep(delayMs);
            queue.unshift({ ...range, attempts: range.attempts + 1 });
            continue;
          }
        }

        if (this.isLogRangeError(error) && range.from < range.to) {
          const limit = this.extractLogRangeLimit(error);
          if (limit && limit > 0n) {
            this.logRangeLimit = limit;
            this.enqueueRanges(queue, range.from, range.to, limit);
          } else {
            const mid = (range.from + range.to) / 2n;
            queue.unshift({ from: mid + 1n, to: range.to, attempts: 0 });
            queue.unshift({ from: range.from, to: mid, attempts: 0 });
          }
          continue;
        }

        if (this.isRateLimitError(error) && range.attempts < 6) {
          const delayMs = Math.min(1000 * 2 ** range.attempts, 15000);
          await this.sleep(delayMs);
          queue.unshift({ ...range, attempts: range.attempts + 1 });
          continue;
        }

        throw error;
      }
    }

    return results;
  }

  private async fetchLogsWithTiming(
    label: string,
    event: AbiEvent,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Log[]> {
    const startedAt = Date.now();
    const logs = await this.getLogsSafe(event, fromBlock, toBlock);
    this.logger.log(
      `Range ${fromBlock} -> ${toBlock} fetched ${label}: ${logs.length} log(s) in ${this.formatDuration(
        startedAt
      )}.`
    );
    return logs;
  }

  private formatDuration(startedAt: number): string {
    return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  }

  private isLogRangeError(error: unknown): boolean {
    const details = (error as { details?: string }).details;
    const message = (error as { message?: string }).message;
    const shortMessage = (error as { shortMessage?: string }).shortMessage;
    const text = [details, message, shortMessage].filter(Boolean).join(" ").toLowerCase();
    return text.includes("eth_getlogs") && text.includes("block range");
  }

  private isHttpRequestError(error: unknown): boolean {
    if (error instanceof HttpRequestError) {
      return true;
    }

    const details = (error as { details?: string }).details;
    const message = (error as { message?: string }).message;
    const shortMessage = (error as { shortMessage?: string }).shortMessage;
    const text = [details, message, shortMessage].filter(Boolean).join(" ").toLowerCase();
    return (
      text.includes("http request failed") ||
      text.includes("fetch failed") ||
      text.includes("econnreset") ||
      text.includes("econnrefused") ||
      text.includes("ehostunreach") ||
      text.includes("enotfound")
    );
  }

  private isTimeoutError(error: unknown): boolean {
    if (error instanceof TimeoutError) {
      return true;
    }

    const details = (error as { details?: string }).details;
    const message = (error as { message?: string }).message;
    const shortMessage = (error as { shortMessage?: string }).shortMessage;
    const text = [details, message, shortMessage].filter(Boolean).join(" ").toLowerCase();
    return text.includes("timed out") || text.includes("timeout");
  }

  private extractLogRangeLimit(error: unknown): bigint | null {
    const details = (error as { details?: string }).details;
    const message = (error as { message?: string }).message;
    const shortMessage = (error as { shortMessage?: string }).shortMessage;
    const text = [details, message, shortMessage].filter(Boolean).join(" ");

    const limitMatch = text.match(new RegExp("up to a (\\d+) block range", "i"));
    if (limitMatch?.[1]) {
      return BigInt(limitMatch[1]);
    }

    const rangeMatch = text.match(
      new RegExp("range should work:\\s*\\[0x([0-9a-f]+),\\s*0x([0-9a-f]+)\\]", "i")
    );
    if (rangeMatch?.[1] && rangeMatch?.[2]) {
      const from = BigInt(`0x${rangeMatch[1]}`);
      const to = BigInt(`0x${rangeMatch[2]}`);
      if (to >= from) {
        return to - from + 1n;
      }
    }

    return null;
  }

  private enqueueRanges(
    queue: Array<{ from: bigint; to: bigint; attempts: number }>,
    from: bigint,
    to: bigint,
    maxRange: bigint
  ) {
    let cursor = from;
    while (cursor <= to) {
      const end = cursor + maxRange - 1n > to ? to : cursor + maxRange - 1n;
      queue.push({ from: cursor, to: end, attempts: 0 });
      cursor = end + 1n;
    }
  }

  private isRateLimitError(error: unknown): boolean {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      return true;
    }

    const details = (error as { details?: string }).details;
    const message = (error as { message?: string }).message;
    const shortMessage = (error as { shortMessage?: string }).shortMessage;
    const text = [details, message, shortMessage].filter(Boolean).join(" ").toLowerCase();
    return (
      text.includes("429") ||
      text.includes("rate limit") ||
      text.includes("compute units") ||
      text.includes("throughput")
    );
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async acquireIndexingLock(
    startBlock: bigint
  ): Promise<{ lockId: string; lastProcessedBlock: bigint } | null> {
    const lockId = randomUUID();
    const ttlSeconds = this.config.indexerLockTtlSeconds;
    const [row] = await this.prisma.$queryRaw<{ last_processed_block: bigint }[]>`
      INSERT INTO shasta_indexing_state (
        chain_id,
        last_processed_block,
        lock_id,
        lock_expires_at,
        last_run_started_at,
        last_run_status,
        last_run_error
      )
      VALUES (
        ${this.config.chainId},
        ${startBlock},
        ${lockId}::uuid,
        NOW() + (${ttlSeconds} * INTERVAL '1 second'),
        NOW(),
        'running',
        NULL
      )
      ON CONFLICT (chain_id) DO UPDATE
      SET
        lock_id = EXCLUDED.lock_id,
        lock_expires_at = EXCLUDED.lock_expires_at,
        last_run_started_at = EXCLUDED.last_run_started_at,
        last_run_status = EXCLUDED.last_run_status,
        last_run_error = NULL
      WHERE shasta_indexing_state.lock_expires_at IS NULL
        OR shasta_indexing_state.lock_expires_at < NOW()
      RETURNING last_processed_block
    `;

    if (!row) {
      return null;
    }

    return { lockId, lastProcessedBlock: row.last_processed_block };
  }

  private async checkpointIndexingProgress(lockId: string, lastProcessedBlock: bigint) {
    const lockExpiresAt = new Date(Date.now() + this.config.indexerLockTtlSeconds * 1000);
    const result = await this.prisma.shastaIndexingState.updateMany({
      where: { chainId: this.config.chainId, lockId },
      data: {
        lastProcessedBlock,
        lockExpiresAt
      }
    });

    if (!result.count) {
      throw new Error("Indexer lock lost or expired");
    }
  }

  private async releaseIndexingLock(
    lockId: string,
    status: "success" | "partial" | "failed",
    error?: unknown
  ) {
    const errorMessage = status === "failed" ? this.formatError(error) : null;
    await this.prisma.shastaIndexingState.updateMany({
      where: { chainId: this.config.chainId, lockId },
      data: {
        lockId: null,
        lockExpiresAt: null,
        lastRunFinishedAt: new Date(),
        lastRunStatus: status,
        lastRunError: errorMessage
      }
    });
  }

  private async recordFailureWithoutLock(error: unknown) {
    const chainId = this.config.chainId;
    const now = new Date();
    const outcome = {
      lastRunFinishedAt: now,
      lastRunStatus: "failed",
      lastRunError: this.formatError(error)
    };

    try {
      const { count } = await this.prisma.shastaIndexingState.updateMany({
        where: {
          chainId,
          OR: [{ lockId: null }, { lockExpiresAt: { lt: now } }]
        },
        data: outcome
      });

      if (count === 0) {
        // Either a live run holds the lock (leave it alone) or no run has ever started.
        const existing = await this.prisma.shastaIndexingState.findUnique({ where: { chainId } });
        if (!existing) {
          await this.prisma.shastaIndexingState.create({
            data: { chainId, lastProcessedBlock: 0n, ...outcome }
          });
        }
      }
    } catch (recordError) {
      this.logger.warn(`Could not record indexer failure: ${this.formatError(recordError)}`);
    }
  }

  private formatError(error: unknown): string {
    const message =
      error instanceof Error ? error.message || error.name : String(error ?? "Unknown error");
    return redactUrlSecrets(message).slice(0, 2000);
  }
}
