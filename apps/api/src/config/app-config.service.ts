import { Injectable } from "@nestjs/common";
import { z } from "zod";

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = () => z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
const optionalNumber = () => z.preprocess(emptyStringToUndefined, z.coerce.number().optional());

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    RPC_URL: z.string().min(1),
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
    message: "SHASTA_INBOX_ADDRESS is required"
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

  get rpcUrl(): string {
    return this.config.RPC_URL;
  }

  get chainId(): number {
    return this.config.CHAIN_ID;
  }

  get shastaInboxAddress(): string {
    return this.config.SHASTA_INBOX_ADDRESS ?? this.config.TAIKO_INBOX_ADDRESS!;
  }
  get shastaStartBlock(): number | undefined {
    return this.config.SHASTA_START_BLOCK ?? this.config.START_BLOCK;
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
