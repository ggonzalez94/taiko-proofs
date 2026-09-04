export type ProofSystem = "TEE" | "SP1" | "RISC0";
export type TeeVerifier = "SGX_GETH" | "TDX_GETH" | "SGX_RETH";
export type BatchProtocol = "PACAYA" | "SHASTA";

export type BatchStatus = "proposed" | "proven" | "verified";
export type BatchProofType = "all" | "zk" | "non-zk";
export type BatchDateField = "proposedAt" | "provenAt";

export interface BatchSummary {
  recordKey: string;
  protocol: BatchProtocol;
  batchId: string;
  proposer: string;
  status: BatchStatus;
  proofSystems: ProofSystem[];
  teeVerifiers?: TeeVerifier[];
  proposedAt: string;
  provenAt?: string | null;
  verifiedAt?: string | null;
  isContested?: boolean;
  isLegacy?: boolean;
}

export interface BatchDetail extends BatchSummary {
  actualProver?: string | null;
  parentProposalHash?: string | null;
  proposedBlock: string;
  provenBlock?: string | null;
  verifiedBlock?: string | null;
  proposedTxHash?: string | null;
  proofTxHash?: string | null;
  verifiedTxHash?: string | null;
  verifierAddress?: string | null;
  transitionParentHash?: string | null;
  transitionBlockHash?: string | null;
  transitionStateRoot?: string | null;
  proofLinks?: {
    tx?: string;
    proposedTx?: string;
    verifiedTx?: string;
    verifier?: string;
  };
}

export interface RangeResponse {
  start: string;
  end: string;
}

export interface ZkSharePoint {
  date: string;
  provenTotal: number;
  zkProvenTotal: number;
  zkPercent: number | null;
}

export interface ZkShareResponse {
  range: RangeResponse;
  points: ZkSharePoint[];
  summary?: {
    provenTotal: number;
    zkProvenTotal: number;
  };
}

export interface ProofSystemPoint {
  date: string;
  provenTotal: number;
  tee: number;
  teeSgxGeth: number;
  teeSgxReth: number;
  sp1: number;
  risc0: number;
}

export interface ProofSystemResponse {
  range: RangeResponse;
  points: ProofSystemPoint[];
}

export interface LatencyStats {
  avgSeconds: number;
  medianSeconds: number;
  p90Seconds: number;
  p95Seconds: number;
  p99Seconds: number;
}

export interface LatencySeriesPoint {
  date: string;
  avgSeconds: number;
  medianSeconds?: number;
}

export interface LatencyResponse {
  range: RangeResponse;
  stats: LatencyStats;
  series: LatencySeriesPoint[];
}

export type IndexerRunStatus = "running" | "success" | "partial" | "failed";

export interface IndexerStatus {
  lastProcessedBlock: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: IndexerRunStatus | null;
}

export interface StatsMetadataResponse {
  dataStart: string | null;
  dataEnd: string | null;
  /** Latest live-indexer run; absent on API builds that predate it, null before the first run. */
  indexer?: IndexerStatus | null;
}

export interface BatchesResponse {
  range: RangeResponse;
  page: number;
  pageSize: number;
  total: number;
  items: BatchSummary[];
}

export interface BatchDetailResponse {
  batch: BatchDetail;
}
