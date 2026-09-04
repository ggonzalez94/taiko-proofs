import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { DEFAULT_RPC_TIMEOUT_MS, parseRpcUrls } from "../chain/rpc-transport";

const trimString = (value: unknown) => (typeof value === "string" ? value.trim() : value);

const emptyStringToUndefined = (value: unknown) =>
  trimString(value) === "" ? undefined : trimString(value);

const requiredString = () => z.preprocess(trimString, z.string().min(1));
const optionalString = () => z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
const optionalNumber = () => z.preprocess(emptyStringToUndefined, z.coerce.number().optional());
const optionalPositiveInteger = () =>
  z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional());

const EnvSchema = z
  .object({
    DATABASE_URL: requiredString(),
    RPC_URL: requiredString(),
    RPC_TIMEOUT_MS: optionalPositiveInteger(),
    CHAIN_ID: z.coerce.number(),
    SHASTA_INBOX_ADDRESS: optionalString(),
    TAIKO_INBOX_ADDRESS: optionalString(),
    SHASTA_START_BLOCK: optionalNumber(),
    START_BLOCK: optionalNumber(),
    CONFIRMATIONS: z.coerce.number().default(6),
    REORG_BUFFER: z.coerce.number().default(100),
    STATS_LOOKBACK_DAYS: z.coerce.number().default(90),
    INDEXER_CHUNK_SIZE: z.coerce.number().default(2000),
    INDEXER_LOG_RANGE_LIMIT: optionalNumber(),
    INDEXER_LOCK_TTL_SECONDS: z.coerce.number().default(600),
    INDEXER_MAX_RUNTIME_SECONDS: optionalNumber(),
    L1_EXPLORER_BASE_URL: optionalString()
  })
  .refine((config) => Boolean(config.SHASTA_INBOX_ADDRESS ?? config.TAIKO_INBOX_ADDRESS), {
    message: "SHASTA_INBOX_ADDRESS or TAIKO_INBOX_ADDRESS is required"
  })
  .refine((config) => parseRpcUrls(config.RPC_URL).length > 0, {
    message: "RPC_URL must contain at least one endpoint"
  });

export type AppConfig = z.infer<typeof EnvSchema>;

@Injectable()
export class AppConfigService {
  private readonly config: AppConfig;

  constructor() {
    this.config = EnvSchema.parse(process.env);
  }

  get databaseUrl(): string {
    return this.config.DATABASE_URL;
  }

  /** Every configured RPC endpoint, in priority order. */
  get rpcUrls(): string[] {
    return parseRpcUrls(this.config.RPC_URL);
  }

  /** The primary RPC endpoint. */
  get rpcUrl(): string {
    return this.rpcUrls[0];
  }

  get rpcTimeoutMs(): number {
    return this.config.RPC_TIMEOUT_MS ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  get chainId(): number {
    return this.config.CHAIN_ID;
  }

  get shastaInboxAddress(): string {
    const inboxAddress = this.config.SHASTA_INBOX_ADDRESS ?? this.config.TAIKO_INBOX_ADDRESS;
    if (!inboxAddress) {
      throw new Error("SHASTA_INBOX_ADDRESS or TAIKO_INBOX_ADDRESS is required");
    }

    return inboxAddress;
  }
  get shastaStartBlock(): number | undefined {
    return this.config.SHASTA_START_BLOCK;
  }

  get confirmations(): number {
    return this.config.CONFIRMATIONS;
  }

  get reorgBuffer(): number {
    return this.config.REORG_BUFFER;
  }

  get statsLookbackDays(): number {
    return this.config.STATS_LOOKBACK_DAYS;
  }

  get indexerChunkSize(): number {
    return this.config.INDEXER_CHUNK_SIZE;
  }

  get indexerLogRangeLimit(): number | undefined {
    return this.config.INDEXER_LOG_RANGE_LIMIT;
  }

  get indexerLockTtlSeconds(): number {
    return this.config.INDEXER_LOCK_TTL_SECONDS;
  }

  get indexerMaxRuntimeSeconds(): number | undefined {
    return this.config.INDEXER_MAX_RUNTIME_SECONDS;
  }

  get explorerBaseUrl(): string | undefined {
    return this.config.L1_EXPLORER_BASE_URL;
  }
}
