import { StatsService } from "../src/stats/stats.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AppConfigService } from "../src/config/app-config.service";

const configStub = { chainId: 1 } as AppConfigService;

const prismaStub = {
  dailyStat: {
    findMany: jest.fn(),
    upsert: jest.fn()
  },
  $queryRaw: jest.fn(),
  batch: {
    aggregate: jest.fn()
  },
  shastaIndexingState: {
    findUnique: jest.fn()
  }
};

describe("StatsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fills missing dates with zeros for zk share", async () => {
    prismaStub.dailyStat.findMany.mockResolvedValue([
      {
        date: new Date("2024-01-02T00:00:00Z"),
        provenTotal: 10,
        zkProvenTotal: 7
      }
    ]);
    prismaStub.$queryRaw.mockResolvedValue([
      {
        proven_total: 10,
        zk_proven_total: 7
      }
    ]);

    const service = new StatsService(prismaStub as unknown as PrismaService, configStub);
    const result = await service.getZkShare(
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z"),
      true
    );

    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toEqual({
      date: "2024-01-01",
      provenTotal: 0,
      zkProvenTotal: 0,
      zkPercent: null
    });
    expect(result.points[1]).toEqual({
      date: "2024-01-02",
      provenTotal: 10,
      zkProvenTotal: 7,
      zkPercent: 70
    });
    expect(result.summary).toEqual({
      provenTotal: 10,
      zkProvenTotal: 7
    });
  });

  it("maps proof system usage points", async () => {
    prismaStub.dailyStat.findMany.mockResolvedValue([
      {
        date: new Date("2024-02-01T00:00:00Z"),
        provenTotal: 6,
        teeTotal: 5,
        teeSgxGethTotal: 3,
        teeSgxRethTotal: 2,
        sp1Total: 3,
        risc0Total: 2
      }
    ]);

    const service = new StatsService(prismaStub as unknown as PrismaService, configStub);
    const result = await service.getProofSystemUsage(
      new Date("2024-02-01T00:00:00Z"),
      new Date("2024-02-01T00:00:00Z")
    );

    expect(result.points[0]).toEqual({
      date: "2024-02-01",
      provenTotal: 6,
      tee: 5,
      teeSgxGeth: 3,
      teeSgxReth: 2,
      sp1: 3,
      risc0: 2
    });
  });

  it("returns metadata across pacaya archive and shasta live data", async () => {
    prismaStub.$queryRaw.mockResolvedValue([
      {
        data_start: new Date("2026-03-31T00:00:00.000Z"),
        data_end: new Date("2026-04-02T00:00:00.000Z")
      }
    ]);

    const service = new StatsService(prismaStub as unknown as PrismaService, configStub);
    const result = await service.getMetadata();

    expect(result).toMatchObject({
      dataStart: "2026-03-31",
      dataEnd: "2026-04-02"
    });
  });

  it("includes the latest indexer run status in metadata without leaking the error text", async () => {
    prismaStub.$queryRaw.mockResolvedValue([
      {
        data_start: new Date("2026-03-31T00:00:00.000Z"),
        data_end: new Date("2026-08-24T00:00:00.000Z")
      }
    ]);
    prismaStub.shastaIndexingState.findUnique.mockResolvedValue({
      chainId: 1,
      lastProcessedBlock: 25826000n,
      lastRunStartedAt: new Date("2026-09-04T01:30:00.000Z"),
      lastRunFinishedAt: new Date("2026-09-04T01:31:00.000Z"),
      lastRunStatus: "failed",
      lastRunError: "connect ETIMEDOUT https://user:secret@rpc.example"
    });

    const service = new StatsService(prismaStub as unknown as PrismaService, configStub);
    const result = await service.getMetadata();

    expect(result.indexer).toEqual({
      lastProcessedBlock: "25826000",
      lastRunStartedAt: "2026-09-04T01:30:00.000Z",
      lastRunFinishedAt: "2026-09-04T01:31:00.000Z",
      lastRunStatus: "failed"
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(prismaStub.shastaIndexingState.findUnique).toHaveBeenCalledWith({
      where: { chainId: 1 }
    });
  });

  it("reports a null indexer status before the first indexing run", async () => {
    prismaStub.$queryRaw.mockResolvedValue([{ data_start: null, data_end: null }]);
    prismaStub.shastaIndexingState.findUnique.mockResolvedValue(null);

    const service = new StatsService(prismaStub as unknown as PrismaService, configStub);
    const result = await service.getMetadata();

    expect(result).toEqual({ dataStart: null, dataEnd: null, indexer: null });
  });
});
