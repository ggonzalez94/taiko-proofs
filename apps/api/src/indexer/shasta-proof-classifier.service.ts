import { Injectable, Logger } from "@nestjs/common";
import { ProofSystem, TeeVerifier } from "@taikoproofs/shared";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import { shastaInboxAbi } from "../chain/shastaInboxAbi";
import { ChainService } from "../chain/chain.service";
import { AppConfigService } from "../config/app-config.service";

type ShastaTransition = {
  proposer: string;
  timestamp: bigint;
  blockHash: `0x${string}`;
};

export type ShastaCommitment = {
  firstProposalId: bigint;
  firstProposalParentBlockHash: `0x${string}`;
  lastProposalHash: `0x${string}`;
  actualProver: string;
  endBlockNumber: bigint;
  endStateRoot: `0x${string}`;
  transitions: ShastaTransition[];
};

export type ShastaProofSubmission = {
  commitment: ShastaCommitment;
  proofData: `0x${string}`;
};

const TEE_GETH_VERIFIER_ID = 1;
const TDX_GETH_VERIFIER_ID = 2;
const SGX_RETH_VERIFIER_ID = 4;
const RISC0_RETH_VERIFIER_ID = 5;
const SP1_RETH_VERIFIER_ID = 6;

@Injectable()
export class ShastaProofClassifierService {
  private readonly logger = new Logger(ShastaProofClassifierService.name);
  private proofVerifierAddress?: string;

  constructor(
    private readonly chain: ChainService,
    private readonly config: AppConfigService
  ) {}

  extractProofSubmission(txInput: `0x${string}`): ShastaProofSubmission | null {
    try {
      const decoded = decodeFunctionData({
        abi: shastaInboxAbi,
        data: txInput
      });

      if (decoded.functionName !== "prove") {
        return null;
      }

      const [encodedInput, proofData] = decoded.args as [`0x${string}`, `0x${string}`];
      return {
        commitment: this.decodeProveInput(encodedInput),
        proofData
      };
    } catch (error) {
      this.logger.warn("Failed to decode Shasta prove tx input", error as Error);
      return null;
    }
  }

  decodeVerifierIds(proofData: `0x${string}`): number[] {
    try {
      const [subProofs] = decodeAbiParameters(
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
        proofData
      );

      return (subProofs as readonly { verifierId: number }[]).map((proof) =>
        Number(proof.verifierId)
      );
    } catch {
      return [];
    }
  }

  classifyProof(proofData: `0x${string}`): {
    proofSystems: ProofSystem[];
    teeVerifiers: TeeVerifier[];
  } {
    const proofSystems = new Set<ProofSystem>();
    const teeVerifiers = new Set<TeeVerifier>();

    for (const verifierId of this.decodeVerifierIds(proofData)) {
      if (verifierId === TEE_GETH_VERIFIER_ID) {
        proofSystems.add("TEE");
        teeVerifiers.add("SGX_GETH");
        continue;
      }

      if (verifierId === TDX_GETH_VERIFIER_ID) {
        proofSystems.add("TEE");
        continue;
      }

      if (verifierId === SGX_RETH_VERIFIER_ID) {
        proofSystems.add("TEE");
        teeVerifiers.add("SGX_RETH");
        continue;
      }

      if (verifierId === RISC0_RETH_VERIFIER_ID) {
        proofSystems.add("RISC0");
        continue;
      }

      if (verifierId === SP1_RETH_VERIFIER_ID) {
        proofSystems.add("SP1");
      }
    }

    if (!proofSystems.size) {
      this.logger.warn("No Shasta proof system mapping found for proof payload");
    }

    return {
      proofSystems: Array.from(proofSystems),
      teeVerifiers: Array.from(teeVerifiers)
    };
  }

  async getProofVerifierAddress(): Promise<string> {
    if (this.proofVerifierAddress) {
      return this.proofVerifierAddress;
    }

    const configResult = await this.chain.getClient().readContract({
      address: this.config.shastaInboxAddress as `0x${string}`,
      abi: shastaInboxAbi,
      functionName: "getConfig"
    });

    const proofVerifierAddress = this.extractProofVerifierAddress(configResult);
    if (!proofVerifierAddress) {
      throw new Error("Failed to resolve Shasta proof verifier address from inbox config");
    }

    this.proofVerifierAddress = proofVerifierAddress.toLowerCase();
    return this.proofVerifierAddress;
  }

  decodeProveInput(data: `0x${string}`): ShastaCommitment {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    let offset = 0;

    const readBytes = (byteLength: number) => {
      const end = offset + byteLength * 2;
      if (end > hex.length) {
        throw new Error("Invalid prove input length");
      }

      const value = hex.slice(offset, end);
      offset = end;
      return value;
    };

    const readUint = (byteLength: number) => {
      const value = readBytes(byteLength);
      return BigInt(`0x${value || "0"}`);
    };

    const readBytes32 = () => `0x${readBytes(32)}` as `0x${string}`;
    const readAddress = () => `0x${readBytes(20)}`.toLowerCase();

    const firstProposalId = readUint(6);
    const firstProposalParentBlockHash = readBytes32();
    const lastProposalHash = readBytes32();
    const actualProver = readAddress();
    const endBlockNumber = readUint(6);
    const endStateRoot = readBytes32();
    const transitionCount = Number(readUint(2));
    const transitions: ShastaTransition[] = [];

    for (let index = 0; index < transitionCount; index += 1) {
      transitions.push({
        proposer: readAddress(),
        timestamp: readUint(6),
        blockHash: readBytes32()
      });
    }

    if (offset !== hex.length) {
      throw new Error("Invalid prove input length");
    }

    return {
      firstProposalId,
      firstProposalParentBlockHash,
      lastProposalHash,
      actualProver,
      endBlockNumber,
      endStateRoot,
      transitions
    };
  }

  private extractProofVerifierAddress(configResult: unknown): string | null {
    if (
      typeof configResult === "object" &&
      configResult !== null &&
      "proofVerifier" in configResult &&
      typeof (configResult as { proofVerifier?: unknown }).proofVerifier === "string"
    ) {
      return (configResult as { proofVerifier: string }).proofVerifier;
    }

    if (
      typeof configResult === "object" &&
      configResult !== null &&
      "config_" in configResult &&
      typeof (configResult as { config_?: { proofVerifier?: unknown } }).config_?.proofVerifier ===
        "string"
    ) {
      return (configResult as { config_: { proofVerifier: string } }).config_.proofVerifier;
    }

    if (
      Array.isArray(configResult) &&
      configResult.length > 0 &&
      typeof configResult[0] === "object" &&
      configResult[0] !== null &&
      "proofVerifier" in configResult[0] &&
      typeof (configResult[0] as { proofVerifier?: unknown }).proofVerifier === "string"
    ) {
      return (configResult[0] as { proofVerifier: string }).proofVerifier;
    }

    return null;
  }
}
