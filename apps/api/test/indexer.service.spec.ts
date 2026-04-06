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
});
