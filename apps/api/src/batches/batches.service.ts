import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { BatchesQueryDto } from "./batches.dto";
import { addDays, parseDateRange } from "../common/date";
import {
  BatchDetail,
  BatchDateField,
  BatchProtocol,
  BatchDetailResponse,
  BatchesResponse,
  BatchSummary,
  ProofSystem,
  TeeVerifier
} from "@taikoproofs/shared";
import { AppConfigService } from "../config/app-config.service";
import { Prisma } from "@prisma/client";
import { combinedProtocolRecordsSql } from "../common/protocol-records.sql";

const zkProofSystems: ProofSystem[] = ["SP1", "RISC0"];
const dateColumns: Record<BatchDateField, Prisma.Sql> = {
  proposedAt: Prisma.sql`"proposedAt"`,
  provenAt: Prisma.sql`"provenAt"`
};

function combineSql(parts: Prisma.Sql[], operator: "AND" | "OR"): Prisma.Sql | null {
  return parts.reduce<Prisma.Sql | null>((combined, part) => {
    if (!combined) {
      return part;
    }

    return operator === "AND"
      ? Prisma.sql`${combined} AND ${part}`
      : Prisma.sql`${combined} OR ${part}`;
  }, null);
}

type CombinedBatchRow = {
  recordKey: string;
  protocol: "PACAYA" | "SHASTA";
  batchId: string;
  proposer: string;
  status: "proposed" | "proven" | "verified";
  proofSystems: ProofSystem[];
  teeVerifiers: string[];
  proposedAt: Date;
  provenAt: Date | null;
  verifiedAt: Date | null;
  isContested: boolean;
  isLegacy: boolean;
};

function parseBatchId(batchId: string): bigint {
  if (!/^[0-9]+$/.test(batchId)) {
    throw new BadRequestException("batchId must be a number");
  }

  return BigInt(batchId);
}

@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService
  ) {}

  async listBatches(query: BatchesQueryDto): Promise<BatchesResponse> {
    const maxPageSize = 100;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(1, query.pageSize ?? 25), maxPageSize);
    const { startDate, endDate, endIsDateOnly } = parseDateRange(
      query.start,
      query.end,
      7
    );
    const dateField = query.dateField ?? "proposedAt";
    const dateColumn = dateColumns[dateField];
    if (!dateColumn) {
      throw new BadRequestException("Invalid dateField");
    }

    const endBoundary = endIsDateOnly ? addDays(endDate, 1) : endDate;
    const filters: Prisma.Sql[] = [Prisma.sql`${dateColumn} >= ${startDate}`];

    if (endIsDateOnly) {
      filters.push(Prisma.sql`${dateColumn} < ${endBoundary}`);
    } else {
      filters.push(Prisma.sql`${dateColumn} <= ${endBoundary}`);
    }

    if (query.status) {
      filters.push(Prisma.sql`status = ${query.status}`);
    }

    if (query.contested === false) {
      filters.push(Prisma.sql`"isContested" = false`);
    }

    if (query.hasProof) {
      filters.push(Prisma.sql`"provenAt" IS NOT NULL`);
    }

    const proofFacetFilters: Prisma.Sql[] = [];

    if (query.system?.length) {
      const systems = Prisma.sql`ARRAY[${Prisma.join(query.system)}]::"ProofSystem"[]`;
      proofFacetFilters.push(Prisma.sql`"proofSystems" && ${systems}`);
    }

    if (query.teeVerifier?.length) {
      const teeValues = Prisma.sql`ARRAY[${Prisma.join(query.teeVerifier)}]::text[]`;
      proofFacetFilters.push(
        Prisma.sql`('TEE' = ANY("proofSystems") AND "teeVerifiers" && ${teeValues})`
      );
    }

    const proofFacetWhere = combineSql(proofFacetFilters, "OR");
    if (proofFacetWhere) {
      filters.push(Prisma.sql`(${proofFacetWhere})`);
      filters.push(Prisma.sql`"provenAt" IS NOT NULL`);
    }

    if (query.proofType === "zk") {
      const systems = Prisma.sql`ARRAY[${Prisma.join(zkProofSystems)}]::"ProofSystem"[]`;
      filters.push(Prisma.sql`"proofSystems" && ${systems}`);
    }

    if (query.proofType === "non-zk") {
      const systems = Prisma.sql`ARRAY[${Prisma.join(zkProofSystems)}]::"ProofSystem"[]`;
      filters.push(Prisma.sql`NOT ("proofSystems" && ${systems})`);
    }

    if (query.search) {
      try {
        const batchId = BigInt(query.search).toString();
        filters.push(Prisma.sql`"batchId" = ${batchId}`);
      } catch {
        // ignore invalid input
      }
    }

    const whereConditions = combineSql(filters, "AND");
    const whereClause = whereConditions
      ? Prisma.sql`WHERE ${whereConditions}`
      : Prisma.empty;
    const offset = (page - 1) * pageSize;
    const combinedRecordsSql = combinedProtocolRecordsSql;
    const listQuery = Prisma.sql`
      WITH combined AS (${combinedRecordsSql})
      SELECT *
      FROM combined
      ${whereClause}
      ORDER BY ${dateColumn} DESC NULLS LAST, "batchId"::bigint DESC, "protocol" ASC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `;
    const countQuery = Prisma.sql`
      WITH combined AS (${combinedRecordsSql})
      SELECT COUNT(*)::int AS total
      FROM combined
      ${whereClause}
    `;

    const [items, countRows] = await Promise.all([
      this.prisma.$queryRaw<CombinedBatchRow[]>(listQuery),
      this.prisma.$queryRaw<{ total: number }[]>(countQuery)
    ]);

    const total = countRows[0]?.total ?? 0;
    const mapped: BatchSummary[] = items.map((batch) => ({
      recordKey: batch.recordKey,
      protocol: batch.protocol,
      batchId: batch.batchId,
      proposer: batch.proposer,
      status: batch.status,
      proofSystems: batch.proofSystems,
      teeVerifiers: batch.teeVerifiers as TeeVerifier[],
      proposedAt: batch.proposedAt.toISOString(),
      provenAt: batch.provenAt?.toISOString() ?? null,
      verifiedAt: batch.verifiedAt?.toISOString() ?? null,
      isContested: batch.isContested,
      isLegacy: batch.isLegacy
    }));

    return {
      range: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
      page,
      pageSize,
      total,
      items: mapped
    };
  }

  async getBatch(protocol: BatchProtocol, batchId: string): Promise<BatchDetailResponse> {
    const parsedBatchId = parseBatchId(batchId);

    if (protocol === "PACAYA") {
      const batch = await this.prisma.batch.findUnique({
        where: { batchId: parsedBatchId }
      });

      if (!batch) {
        throw new NotFoundException("Batch not found");
      }

      return {
        batch: this.buildDetail({
          recordKey: `pacaya:${batch.batchId.toString()}`,
          protocol: "PACAYA",
          batchId: batch.batchId.toString(),
          proposer: batch.proposer,
          status: batch.status,
          proofSystems: batch.proofSystems,
          teeVerifiers: batch.teeVerifiers as TeeVerifier[],
          actualProver: null,
          parentProposalHash: null,
          proposedAt: batch.proposedAt,
          provenAt: batch.provenAt,
          verifiedAt: batch.verifiedAt,
          proposedBlock: batch.proposedBlock.toString(),
          provenBlock: batch.provenBlock?.toString() ?? null,
          verifiedBlock: batch.verifiedBlock?.toString() ?? null,
          proposedTxHash: batch.proposedTxHash,
          proofTxHash: batch.proofTxHash,
          verifiedTxHash: batch.verifiedTxHash,
          verifierAddress: batch.verifierAddress,
          transitionParentHash: batch.transitionParentHash,
          transitionBlockHash: batch.transitionBlockHash,
          transitionStateRoot: batch.transitionStateRoot,
          isContested: batch.isContested,
          isLegacy: batch.isLegacy
        })
      };
    }

    const proposal = await this.prisma.shastaProposal.findUnique({
      where: { proposalId: parsedBatchId }
    });

    if (!proposal) {
      throw new NotFoundException("Batch not found");
    }

    return {
      batch: this.buildDetail({
        recordKey: `shasta:${proposal.proposalId.toString()}`,
        protocol: "SHASTA",
        batchId: proposal.proposalId.toString(),
        proposer: proposal.proposer,
        status: proposal.status,
        proofSystems: proposal.proofSystems,
        teeVerifiers: proposal.teeVerifiers as TeeVerifier[],
        actualProver: proposal.actualProver,
        parentProposalHash: proposal.parentProposalHash,
        proposedAt: proposal.proposedAt,
        provenAt: proposal.provenAt,
        verifiedAt: proposal.verifiedAt,
        proposedBlock: proposal.proposedBlock.toString(),
        provenBlock: proposal.provenBlock?.toString() ?? null,
        verifiedBlock: proposal.verifiedBlock?.toString() ?? null,
        proposedTxHash: proposal.proposedTxHash,
        proofTxHash: proposal.proofTxHash,
        verifiedTxHash: proposal.verifiedTxHash,
        verifierAddress: proposal.verifierAddress,
        transitionParentHash: proposal.transitionParentHash,
        transitionBlockHash: proposal.transitionBlockHash,
        transitionStateRoot: proposal.transitionStateRoot,
        isContested: proposal.isContested,
        isLegacy: false
      })
    };
  }

  async getLegacyBatch(batchId: string): Promise<BatchDetailResponse> {
    return this.getBatch("PACAYA", batchId);
  }

  private buildDetail(batch: {
    recordKey: string;
    protocol: BatchProtocol;
    batchId: string;
    proposer: string;
    status: "proposed" | "proven" | "verified";
    proofSystems: ProofSystem[];
    teeVerifiers: TeeVerifier[];
    actualProver: string | null;
    parentProposalHash: string | null;
    proposedAt: Date;
    provenAt: Date | null;
    verifiedAt: Date | null;
    proposedBlock: string;
    provenBlock: string | null;
    verifiedBlock: string | null;
    proposedTxHash: string | null;
    proofTxHash: string | null;
    verifiedTxHash: string | null;
    verifierAddress: string | null;
    transitionParentHash: string | null;
    transitionBlockHash: string | null;
    transitionStateRoot: string | null;
    isContested: boolean;
    isLegacy: boolean;
  }): BatchDetail {
    const explorerBase = this.config.explorerBaseUrl?.replace(/\/$/, "");
    const proofLinks = explorerBase
      ? {
          tx: batch.proofTxHash ? `${explorerBase}/tx/${batch.proofTxHash}` : undefined,
          proposedTx: batch.proposedTxHash
            ? `${explorerBase}/tx/${batch.proposedTxHash}`
            : undefined,
          verifiedTx: batch.verifiedTxHash
            ? `${explorerBase}/tx/${batch.verifiedTxHash}`
            : undefined,
          verifier: batch.verifierAddress
            ? `${explorerBase}/address/${batch.verifierAddress}`
            : undefined
        }
      : undefined;

    return {
      recordKey: batch.recordKey,
      protocol: batch.protocol,
      batchId: batch.batchId,
      proposer: batch.proposer,
      status: batch.status,
      proofSystems: batch.proofSystems,
      teeVerifiers: batch.teeVerifiers,
      actualProver: batch.actualProver,
      parentProposalHash: batch.parentProposalHash,
      proposedAt: batch.proposedAt.toISOString(),
      provenAt: batch.provenAt?.toISOString() ?? null,
      verifiedAt: batch.verifiedAt?.toISOString() ?? null,
      proposedBlock: batch.proposedBlock,
      provenBlock: batch.provenBlock,
      verifiedBlock: batch.verifiedBlock,
      proposedTxHash: batch.proposedTxHash,
      proofTxHash: batch.proofTxHash,
      verifiedTxHash: batch.verifiedTxHash,
      verifierAddress: batch.verifierAddress,
      transitionParentHash: batch.transitionParentHash,
      transitionBlockHash: batch.transitionBlockHash,
      transitionStateRoot: batch.transitionStateRoot,
      proofLinks,
      isContested: batch.isContested,
      isLegacy: batch.isLegacy
    };
  }
}
