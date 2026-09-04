import { ChainService } from "../src/chain/chain.service";
import { AppConfigService } from "../src/config/app-config.service";

describe("ChainService", () => {
  it("builds a pooled client over every configured RPC endpoint", () => {
    const configStub = {
      rpcUrls: ["https://a.example", "wss://b.example"],
      rpcTimeoutMs: 1000
    };

    const service = new ChainService(configStub as AppConfigService);

    expect(service.getClient().transport.key).toBe("rpc-pool");
    expect(service.getClient().transport.endpoints).toEqual([
      "https://a.example",
      "wss://b.example"
    ]);
  });

  it("rejects unsupported RPC url schemes at construction", () => {
    const configStub = {
      rpcUrls: ["ftp://a.example"],
      rpcTimeoutMs: 1000
    };

    expect(() => new ChainService(configStub as AppConfigService)).toThrow(
      'RPC_URL must use http(s) or ws(s), got protocol "ftp:"'
    );
  });
});
