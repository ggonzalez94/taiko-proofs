import { AppConfigService } from "../src/config/app-config.service";

const ORIGINAL_ENV = process.env;

function buildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost:5432/taikoproofs",
    RPC_URL: "https://rpc.example",
    CHAIN_ID: "1",
    SHASTA_INBOX_ADDRESS: "0x6f21C543a4aF5189eBdb0723827577e1EF57ef1f",
    CONFIRMATIONS: "6",
    REORG_BUFFER: "100",
    STATS_LOOKBACK_DAYS: "90",
    INDEXER_CHUNK_SIZE: "2000",
    INDEXER_LOCK_TTL_SECONDS: "600",
    ...overrides
  };
}

describe("AppConfigService", () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("treats blank optional start-block env vars as undefined", () => {
    process.env = buildEnv({
      SHASTA_START_BLOCK: "",
      START_BLOCK: ""
    });

    const service = new AppConfigService();

    expect(service.shastaStartBlock).toBeUndefined();
  });

  it("ignores deprecated START_BLOCK when SHASTA_START_BLOCK is unset", () => {
    process.env = buildEnv({
      SHASTA_START_BLOCK: "",
      START_BLOCK: "19773965"
    });

    const service = new AppConfigService();

    expect(service.shastaStartBlock).toBeUndefined();
  });

  it("accepts a blank deprecated inbox alias when the Shasta inbox is set", () => {
    process.env = buildEnv({
      TAIKO_INBOX_ADDRESS: ""
    });

    const service = new AppConfigService();

    expect(service.shastaInboxAddress).toBe("0x6f21C543a4aF5189eBdb0723827577e1EF57ef1f");
  });

  it("uses the deprecated inbox alias only when the Shasta inbox value is absent", () => {
    process.env = buildEnv({
      SHASTA_INBOX_ADDRESS: "",
      TAIKO_INBOX_ADDRESS: "0x00000000000000000000000000000000000000aa"
    });

    const service = new AppConfigService();

    expect(service.shastaInboxAddress).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("reports both inbox env names when neither value is set", () => {
    process.env = buildEnv({
      SHASTA_INBOX_ADDRESS: "",
      TAIKO_INBOX_ADDRESS: ""
    });

    expect(() => new AppConfigService()).toThrow(
      "SHASTA_INBOX_ADDRESS or TAIKO_INBOX_ADDRESS is required"
    );
  });
});
