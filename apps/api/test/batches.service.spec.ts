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

  it("returns pacaya batch detail with legacy archive fields", async () => {
    prismaStub.batch.findUnique.mockResolvedValue({
      batchId: 7n,
      proposer: "0x0000000000000000000000000000000000000007",
      status: "verified",
      proofSystems: ["TEE"],
      teeVerifiers: ["SGX_GETH"],
      proposedAt: new Date("2026-04-01T10:00:00.000Z"),
      provenAt: new Date("2026-04-01T10:05:00.000Z"),
      verifiedAt: new Date("2026-04-01T10:10:00.000Z"),
      proposedBlock: 100n,
      provenBlock: 101n,
      verifiedBlock: 102n,
      proposedTxHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      proofTxHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      verifiedTxHash:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      verifierAddress: "0x0000000000000000000000000000000000000abc",
      transitionParentHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      transitionBlockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      transitionStateRoot:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      isContested: false,
      isLegacy: true
    });

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    const result = await service.getBatch("PACAYA", "7");

    expect(result.batch).toMatchObject({
      protocol: "PACAYA",
      recordKey: "pacaya:7",
      batchId: "7",
      actualProver: null,
      parentProposalHash: null,
      isLegacy: true,
      proofLinks: {
        tx: "https://etherscan.io/tx/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        proposedTx:
          "https://etherscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        verifiedTx:
          "https://etherscan.io/tx/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        verifier: "https://etherscan.io/address/0x0000000000000000000000000000000000000abc"
      }
    });
  });

  it("throws NotFoundException when a pacaya batch does not exist", async () => {
    prismaStub.batch.findUnique.mockResolvedValue(null);

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    await expect(service.getBatch("PACAYA", "404")).rejects.toThrow("Batch not found");
  });

  it("throws NotFoundException when a shasta proposal does not exist", async () => {
    prismaStub.shastaProposal.findUnique.mockResolvedValue(null);

    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    await expect(service.getBatch("SHASTA", "404")).rejects.toThrow("Batch not found");
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

  it("rejects unsupported date fields inside the service", async () => {
    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    await expect(
      service.listBatches({
        start: "2026-04-02",
        end: "2026-04-02",
        dateField: "verifiedAt" as never
      })
    ).rejects.toThrow("Invalid dateField");

    expect(prismaStub.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects non-numeric batch ids inside the service", async () => {
    const service = new BatchesService(
      prismaStub as unknown as PrismaService,
      configStub as AppConfigService
    );

    await expect(service.getBatch("SHASTA", "not-a-number")).rejects.toThrow(
      "batchId must be a number"
    );

    expect(prismaStub.shastaProposal.findUnique).not.toHaveBeenCalled();
  });
});
