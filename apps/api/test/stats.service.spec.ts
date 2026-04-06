import { StatsService } from "../src/stats/stats.service";
import { PrismaService } from "../src/prisma/prisma.service";

const prismaStub = {
  dailyStat: {
    findMany: jest.fn(),
    upsert: jest.fn()
  },
  $queryRaw: jest.fn(),
  batch: {
    aggregate: jest.fn()
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

    const service = new StatsService(prismaStub as unknown as PrismaService);
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

    const service = new StatsService(prismaStub as unknown as PrismaService);
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

    const service = new StatsService(prismaStub as unknown as PrismaService);
    const result = await service.getMetadata();

    expect(result).toEqual({
      dataStart: "2026-03-31",
      dataEnd: "2026-04-02"
    });
  });
});
