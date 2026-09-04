import { IndexerService } from "../src/indexer/indexer.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChainService } from "../src/chain/chain.service";
import { AppConfigService } from "../src/config/app-config.service";
import { ShastaProofClassifierService } from "../src/indexer/shasta-proof-classifier.service";
import { StatsService } from "../src/stats/stats.service";

const prismaStub = {} as PrismaService;
const classifierStub = {} as ShastaProofClassifierService;
const statsStub = {} as StatsService;

describe("IndexerService", () => {
  it("uses the configured Shasta start block when present", async () => {
    const getBlock = jest.fn();
    const chainStub = {
      getClient: jest.fn().mockReturnValue({ getBlock })
    };
    const configStub = {
      shastaStartBlock: 123456,
      indexerLogRangeLimit: undefined
    };

    const service = new IndexerService(
      prismaStub,
      chainStub as unknown as ChainService,
      configStub as AppConfigService,
      classifierStub,
      statsStub
    );
    await expect(
      (
        service as unknown as { resolveStartBlock: (safeBlock: bigint) => Promise<bigint> }
      ).resolveStartBlock(999999n)
    ).resolves.toBe(123456n);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("derives the first Shasta block from the fork timestamp on a fresh database", async () => {
    const blockTimestamps = new Map<bigint, bigint>([
      [0n, 1775135600n],
      [2n, 1775135650n],
      [3n, 1775135700n],
      [4n, 1775135725n],
      [5n, 1775135750n]
    ]);
    const getBlock = jest.fn().mockImplementation(({ blockNumber }: { blockNumber: bigint }) => {
      const timestamp = blockTimestamps.get(blockNumber);
      if (timestamp === undefined) {
        throw new Error(`unexpected block lookup: ${blockNumber.toString()}`);
      }

      return Promise.resolve({ timestamp });
    });
    const chainStub = {
      getClient: jest.fn().mockReturnValue({ getBlock })
    };
    const configStub = {
      shastaStartBlock: undefined,
      indexerLogRangeLimit: undefined
    };

    const service = new IndexerService(
      prismaStub,
      chainStub as unknown as ChainService,
      configStub as AppConfigService,
      classifierStub,
      statsStub
    );
    await expect(
      (
        service as unknown as { resolveStartBlock: (safeBlock: bigint) => Promise<bigint> }
      ).resolveStartBlock(5n)
    ).resolves.toBe(3n);
  });

  describe("when the RPC fails before the indexing lock is taken", () => {
    const rpcError = new Error("connect ETIMEDOUT 10.0.0.1:8546");
    const configStub = {
      chainId: 1,
      confirmations: 6,
      reorgBuffer: 100,
      indexerChunkSize: 2000,
      indexerLockTtlSeconds: 600,
      shastaStartBlock: 1,
      indexerLogRangeLimit: undefined
    };

    function buildService(
      updateMany: jest.Mock,
      overrides: { findUnique?: jest.Mock; create?: jest.Mock; error?: Error } = {}
    ) {
      const chainStub = {
        getClient: jest.fn().mockReturnValue({
          getBlockNumber: jest.fn().mockRejectedValue(overrides.error ?? rpcError)
        })
      };
      const prisma = {
        shastaIndexingState: {
          updateMany,
          findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue({ chainId: 1 }),
          create: overrides.create ?? jest.fn()
        }
      };

      return new IndexerService(
        prisma as unknown as PrismaService,
        chainStub as unknown as ChainService,
        configStub as unknown as AppConfigService,
        classifierStub,
        statsStub
      );
    }

    it("records the failure on the indexing state and rethrows", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = buildService(updateMany);

      await expect(service.runIndexing()).rejects.toBe(rpcError);
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany.mock.calls[0][0].data).toEqual({
        lastRunFinishedAt: expect.any(Date),
        lastRunStatus: "failed",
        lastRunError: "connect ETIMEDOUT 10.0.0.1:8546"
      });
    });

    it("leaves the state of a run that still holds the lock untouched", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const create = jest.fn();
      const service = buildService(updateMany, {
        findUnique: jest.fn().mockResolvedValue({ chainId: 1, lockId: "live-lock" }),
        create
      });

      await expect(service.runIndexing()).rejects.toBe(rpcError);
      expect(updateMany.mock.calls[0][0].where).toEqual({
        chainId: 1,
        OR: [{ lockId: null }, { lockExpiresAt: { lt: expect.any(Date) } }]
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("creates the indexing state row when the first ever run fails before the lock", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const create = jest.fn().mockResolvedValue({});
      const service = buildService(updateMany, {
        findUnique: jest.fn().mockResolvedValue(null),
        create
      });

      await expect(service.runIndexing()).rejects.toBe(rpcError);
      expect(create).toHaveBeenCalledWith({
        data: {
          chainId: 1,
          lastProcessedBlock: 0n,
          lastRunFinishedAt: expect.any(Date),
          lastRunStatus: "failed",
          lastRunError: "connect ETIMEDOUT 10.0.0.1:8546"
        }
      });
    });

    it("redacts credentials and paths of RPC urls in the recorded error", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = buildService(updateMany, {
        error: new Error(
          "HTTP request failed.\nURL: https://user:pw@rpc.example/v2/secret-key?token=abc\nws://10.0.0.1:8546/"
        )
      });

      await expect(service.runIndexing()).rejects.toThrow("HTTP request failed");
      const recorded = updateMany.mock.calls[0][0].data.lastRunError as string;
      expect(recorded).toContain("https://rpc.example");
      expect(recorded).toContain("ws://10.0.0.1:8546");
      expect(recorded).not.toMatch(/secret-key|token=abc|user:pw/);
    });

    it("surfaces the RPC error even when the failure cannot be recorded", async () => {
      const updateMany = jest.fn().mockRejectedValue(new Error("database unavailable"));
      const service = buildService(updateMany);

      await expect(service.runIndexing()).rejects.toBe(rpcError);
    });
  });
});
