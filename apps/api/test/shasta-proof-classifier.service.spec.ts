import { encodeAbiParameters, encodeFunctionData } from "viem";
import { ShastaProofClassifierService } from "../src/indexer/shasta-proof-classifier.service";
import { shastaInboxAbi } from "../src/chain/shastaInboxAbi";
import { ChainService } from "../src/chain/chain.service";
import { AppConfigService } from "../src/config/app-config.service";

const chainStub = {
  getClient: jest.fn()
};

const configStub = {
  shastaInboxAddress: "0x00000000000000000000000000000000000000ff"
};

const toHex = (value: bigint | number, bytes: number) =>
  value.toString(16).padStart(bytes * 2, "0");

const packAddress = (value: string) => value.toLowerCase().replace(/^0x/, "").padStart(40, "0");

const packBytes32 = (value: string) => value.replace(/^0x/, "").padStart(64, "0");

const encodeProveInput = () =>
  (`0x${
    toHex(41n, 6) +
    packBytes32("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") +
    packBytes32("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") +
    packAddress("0x00000000000000000000000000000000000000aa") +
    toHex(9001n, 6) +
    packBytes32("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc") +
    toHex(2, 2) +
    packAddress("0x0000000000000000000000000000000000000001") +
    toHex(1775136000n, 6) +
    packBytes32("0x1111111111111111111111111111111111111111111111111111111111111111") +
    packAddress("0x0000000000000000000000000000000000000002") +
    toHex(1775136012n, 6) +
    packBytes32("0x2222222222222222222222222222222222222222222222222222222222222222")
  }`) as `0x${string}`;

describe("ShastaProofClassifierService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("extracts the packed Shasta prove input and proof payload", () => {
    const encodedInput = encodeProveInput();
    const proofPayload = encodeAbiParameters(
      [
        {
          name: "subProofs",
          type: "tuple[]",
          components: [
            { name: "verifierId", type: "uint8" },
            { name: "proof", type: "bytes" }
          ]
        }
      ],
      [[{ verifierId: 1, proof: "0x1234" }, { verifierId: 6, proof: "0x5678" }]]
    );

    const txInput = encodeFunctionData({
      abi: shastaInboxAbi,
      functionName: "prove",
      args: [encodedInput, proofPayload]
    });

    const service = new ShastaProofClassifierService(
      chainStub as unknown as ChainService,
      configStub as AppConfigService
    );
    const result = service.extractProofSubmission(txInput);

    expect(result?.proofData).toBe(proofPayload);
    expect(result?.commitment).toMatchObject({
      firstProposalId: 41n,
      actualProver: "0x00000000000000000000000000000000000000aa",
      endBlockNumber: 9001n
    });
    expect(result?.commitment.transitions).toHaveLength(2);
    expect(result?.commitment.transitions[1]).toMatchObject({
      proposer: "0x0000000000000000000000000000000000000002",
      timestamp: 1775136012n
    });
  });

  it("classifies Shasta verifier ids into proof systems and tee verifiers", () => {
    const proofPayload = encodeAbiParameters(
      [
        {
          name: "subProofs",
          type: "tuple[]",
          components: [
            { name: "verifierId", type: "uint8" },
            { name: "proof", type: "bytes" }
          ]
        }
      ],
      [[{ verifierId: 1, proof: "0x" }, { verifierId: 6, proof: "0x" }]]
    );

    const service = new ShastaProofClassifierService(
      chainStub as unknown as ChainService,
      configStub as AppConfigService
    );

    expect(service.classifyProof(proofPayload)).toEqual({
      proofSystems: ["TEE", "SP1"],
      teeVerifiers: ["SGX_GETH"]
    });
  });

  it("loads the proof verifier address from inbox config", async () => {
    const readContract = jest.fn().mockResolvedValue({
      proofVerifier: "0x0000000000000000000000000000000000000ABC"
    });
    chainStub.getClient.mockReturnValue({ readContract });

    const service = new ShastaProofClassifierService(
      chainStub as unknown as ChainService,
      configStub as AppConfigService
    );

    await expect(service.getProofVerifierAddress()).resolves.toBe(
      "0x0000000000000000000000000000000000000abc"
    );
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("accepts tuple-style config payloads from viem", async () => {
    const readContract = jest.fn().mockResolvedValue([
      {
        proofVerifier: "0x0000000000000000000000000000000000000DEF"
      }
    ]);
    chainStub.getClient.mockReturnValue({ readContract });

    const service = new ShastaProofClassifierService(
      chainStub as unknown as ChainService,
      configStub as AppConfigService
    );

    await expect(service.getProofVerifierAddress()).resolves.toBe(
      "0x0000000000000000000000000000000000000def"
    );
  });
});
