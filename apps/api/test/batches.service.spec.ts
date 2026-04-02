import { BatchesService } from "../src/batches/batches.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AppConfigService } from "../src/config/app-config.service";
import { Prisma } from "@prisma/client";

const prismaStub = {
  $queryRaw: jest.fn(),
  batch: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn()
  },
  shastaProposal: {
    findUnique: jest.fn()
  }
};

const configStub = {
  explorerBaseUrl: "https://etherscan.io"
};

describe("BatchesService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a unified pacaya archive + shasta live list with protocol metadata", async () => {
    prismaStub.$queryRaw
      .mockResolvedValueOnce([
        {
          protocol: "SHASTA",
          batchId: "42",
          proposer: "0x0000000000000000000000000000000000000042",
          status: "verified",
          proofSystems: ["SP1"],
          teeVerifiers: [],
          proposedAt: new Date("2026-04-02T13:20:00.000Z"),
          provenAt: new Date("2026-04-02T13:25:00.000Z"),
          verifiedAt: new Date("2026-04-02T13:25:00.000Z"),
          isContested: false,
          isLegacy: false,
          recordKey: "shasta:42"
        },
        {
          protocol: "PACAYA",
          batchId: "42",
          proposer: "0x0000000000000000000000000000000000000001",
          status: "verified",
          proofSystems: ["TEE"],
          teeVerifiers: ["SGX_GETH"],
          proposedAt: new Date("2026-04-02T12:55:00.000Z"),
          provenAt: new Date("2026-04-02T13:02:00.000Z"),
          verifiedAt: new Date("2026-04-02T13:04:00.000Z"),
          isContested: false,
          isLegacy: false,
          recordKey: "pacaya:42"
        }
      ])
      .mockResolvedValueOnce([{ total: 2 }]);

    prismaStub.batch.findMany.mockResolvedValue([]);
    prismaStub.batch.count.mockResolvedValue(0);

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    const result = await service.listBatches({
      start: "2026-04-02",
      end: "2026-04-02"
    });

    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      protocol: "SHASTA",
      batchId: "42",
      recordKey: "shasta:42"
    });
    expect(result.items[1]).toMatchObject({
      protocol: "PACAYA",
      batchId: "42",
      recordKey: "pacaya:42"
    });
  });

  it("returns shasta proposal detail with protocol-aware fields", async () => {
    prismaStub.shastaProposal.findUnique.mockResolvedValue({
      proposalId: 42n,
      proposer: "0x0000000000000000000000000000000000000042",
      actualProver: "0x00000000000000000000000000000000000000aa",
      parentProposalHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "verified",
      proofSystems: ["SP1"],
      teeVerifiers: [],
      proposedAt: new Date("2026-04-02T13:20:00.000Z"),
      provenAt: new Date("2026-04-02T13:25:00.000Z"),
      verifiedAt: new Date("2026-04-02T13:25:00.000Z"),
      proposedBlock: 222n,
      provenBlock: 223n,
      verifiedBlock: 223n,
      proposedTxHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      proofTxHash:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      verifiedTxHash:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      verifierAddress: "0x0000000000000000000000000000000000000abc",
      transitionParentHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      transitionBlockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      transitionStateRoot:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      isContested: false
    });

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    const result = await service.getBatch("SHASTA", "42");

    expect(result.batch).toMatchObject({
      protocol: "SHASTA",
      recordKey: "shasta:42",
      batchId: "42",
      actualProver: "0x00000000000000000000000000000000000000aa",
      parentProposalHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      proofTxHash:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      verifierAddress: "0x0000000000000000000000000000000000000abc"
    });
  });

  it("unions system and tee filters instead of intersecting them", async () => {
    prismaStub.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    await service.listBatches({
      start: "2026-04-02",
      end: "2026-04-02",
      system: ["SP1"],
      teeVerifier: ["SGX_GETH"]
    });

    const [listQuery] = prismaStub.$queryRaw.mock.calls[0] as [Prisma.Sql];
    const queryText = listQuery.strings.join(" ");

    expect(queryText).toContain('"proofSystems" && ARRAY[');
    expect(queryText).toContain(
      `OR ('TEE' = ANY("proofSystems") AND "teeVerifiers" && ARRAY[`
    );
    expect(listQuery.values).toEqual(expect.arrayContaining(["SP1", "SGX_GETH"]));
  });
});
