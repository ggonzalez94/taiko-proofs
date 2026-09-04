import { custom, HttpRequestError, RpcRequestError, TimeoutError, type Transport } from "viem";
import {
  buildEndpointTransport,
  createRpcTransport,
  parseRpcUrls
} from "../src/chain/rpc-transport";

type RequestArgs = { method: string; params?: unknown };

function fakeEndpoint(url: string, handler: (args: RequestArgs) => Promise<unknown>) {
  const request = jest.fn(handler);
  return {
    url,
    transport: custom({ request }) as Transport,
    request
  };
}

const never = () => new Promise<never>(() => undefined);

const rateLimited = (url: string) =>
  new HttpRequestError({ body: { method: "eth_blockNumber" }, status: 429, url });

async function callPool(
  endpoints: { url: string; transport: Transport }[],
  options: {
    timeoutMs?: number;
    cooldownMs?: number;
    retryDelayMs?: number;
    now?: () => number;
  } = {}
) {
  const transport = createRpcTransport(endpoints, options)({ retryCount: 0 });
  return transport.request({ method: "eth_blockNumber" });
}

describe("parseRpcUrls", () => {
  it("splits a comma separated list, trims whitespace and drops duplicates", () => {
    expect(parseRpcUrls(" https://a.example ,wss://b.example\n,https://a.example,")).toEqual([
      "https://a.example",
      "wss://b.example"
    ]);
  });
});

describe("buildEndpointTransport", () => {
  it("uses http transports for http(s) urls and websocket transports for ws(s) urls", () => {
    expect(buildEndpointTransport("https://a.example", 1000)({}).config.type).toBe("http");
    expect(buildEndpointTransport("wss://b.example", 1000)({}).config.type).toBe("webSocket");
  });

  it("rejects unsupported url schemes", () => {
    expect(() => buildEndpointTransport("ftp://a.example", 1000)).toThrow(
      'RPC_URL must use http(s) or ws(s), got protocol "ftp:"'
    );
  });
});

describe("createRpcTransport", () => {
  it("returns the first endpoint's result without touching the fallback", async () => {
    const primary = fakeEndpoint("https://primary", async () => "0x10");
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");

    await expect(callPool([primary, secondary])).resolves.toBe("0x10");
    expect(secondary.request).not.toHaveBeenCalled();
  });

  it("fails over to the next endpoint when the first one throws", async () => {
    const primary = fakeEndpoint("https://primary", async () => {
      throw new Error("connect ETIMEDOUT");
    });
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");

    await expect(callPool([primary, secondary])).resolves.toBe("0x20");
  });

  it("abandons an endpoint that does not answer within the deadline", async () => {
    const primary = fakeEndpoint("https://primary", never);
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");
    const startedAt = Date.now();

    await expect(callPool([primary, secondary], { timeoutMs: 30 })).resolves.toBe("0x20");
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("skips an endpoint that failed recently until its cooldown expires", async () => {
    let clock = 1_000_000;
    let primaryHealthy = false;
    const primary = fakeEndpoint("https://primary", async () => {
      if (!primaryHealthy) {
        throw new Error("boom");
      }
      return "0x10";
    });
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");
    const transport = createRpcTransport([primary, secondary], {
      cooldownMs: 60_000,
      now: () => clock
    })({ retryCount: 0 });
    const call = () => transport.request({ method: "eth_blockNumber" });

    await expect(call()).resolves.toBe("0x20");
    expect(primary.request).toHaveBeenCalledTimes(1);

    clock += 1_000;
    primaryHealthy = true;
    await expect(call()).resolves.toBe("0x20");
    expect(primary.request).toHaveBeenCalledTimes(1);

    clock += 60_000;
    await expect(call()).resolves.toBe("0x10");
    expect(primary.request).toHaveBeenCalledTimes(2);
  });

  it("backs off longer each time an endpoint keeps failing", async () => {
    let clock = 1_000_000;
    const primary = fakeEndpoint("https://primary", async () => {
      throw new Error("still down");
    });
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");
    const transport = createRpcTransport([primary, secondary], {
      cooldownMs: 60_000,
      now: () => clock
    })({ retryCount: 0 });
    const call = () => transport.request({ method: "eth_blockNumber" });

    await call();
    expect(primary.request).toHaveBeenCalledTimes(1);

    clock += 61_000;
    await call();
    expect(primary.request).toHaveBeenCalledTimes(2);

    clock += 61_000;
    await call();
    expect(primary.request).toHaveBeenCalledTimes(2);

    clock += 61_000;
    await call();
    expect(primary.request).toHaveBeenCalledTimes(3);
  });

  it("rethrows a JSON-RPC error from the endpoint that answered without failing over", async () => {
    const primary = fakeEndpoint("https://primary", async () => {
      throw new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32602, message: "block range too large" },
        url: "https://primary"
      });
    });
    const secondary = fakeEndpoint("https://secondary", async () => "0x20");
    const transport = createRpcTransport([primary, secondary])({});
    const call = () => transport.request({ method: "eth_getLogs" });

    await expect(call()).rejects.toMatchObject({ code: -32602 });
    await expect(call()).rejects.toThrow("block range too large");
    expect(primary.request).toHaveBeenCalledTimes(2);
    expect(secondary.request).not.toHaveBeenCalled();
  });

  it("retries a transient server error on the same endpoint before giving up", async () => {
    let attempts = 0;
    const primary = fakeEndpoint("https://primary", async () => {
      attempts += 1;
      if (attempts < 3) {
        throw rateLimited("https://primary");
      }
      return "0x10";
    });
    const transport = createRpcTransport([primary], { retryDelayMs: 1 })({});

    await expect(transport.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
    expect(primary.request).toHaveBeenCalledTimes(3);
  });

  it("gives up on a transient server error after three retries", async () => {
    const primary = fakeEndpoint("https://primary", async () => {
      throw rateLimited("https://primary");
    });
    const transport = createRpcTransport([primary], { retryDelayMs: 1 })({});

    await expect(transport.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(
      HttpRequestError
    );
    expect(primary.request).toHaveBeenCalledTimes(4);
  });

  it("does not retry a dead endpoint within the same request", async () => {
    const primary = fakeEndpoint("https://primary", never);
    const transport = createRpcTransport([primary], { timeoutMs: 30 })({});

    await expect(transport.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(
      TimeoutError
    );
    expect(primary.request).toHaveBeenCalledTimes(1);
  });

  it("counts the failures of one request once when escalating the cooldown", async () => {
    let clock = 1_000_000;
    const primary = fakeEndpoint("https://primary", async () => {
      throw rateLimited("https://primary");
    });
    const secondary = fakeEndpoint("https://secondary", never);
    const transport = createRpcTransport([primary, secondary], {
      timeoutMs: 30,
      cooldownMs: 60_000,
      retryDelayMs: 1,
      now: () => clock
    })({});
    const call = () => transport.request({ method: "eth_blockNumber" });

    await expect(call()).rejects.toBeInstanceOf(HttpRequestError);
    expect(primary.request).toHaveBeenCalledTimes(4);

    clock += 61_000;
    await expect(call()).rejects.toBeInstanceOf(HttpRequestError);
    const lastPrimaryCall = Math.min(...primary.request.mock.invocationCallOrder.slice(4));
    const lastSecondaryCall = Math.max(...secondary.request.mock.invocationCallOrder);
    expect(lastPrimaryCall).toBeLessThan(lastSecondaryCall);
  });

  it("throws the last error when every endpoint fails", async () => {
    const primary = fakeEndpoint("https://primary", async () => {
      throw new Error("primary down");
    });
    const secondary = fakeEndpoint("https://secondary", async () => {
      throw new Error("secondary down");
    });

    await expect(callPool([primary, secondary])).rejects.toThrow("secondary down");
  });

  it("reports a deadline expiry as a viem timeout error", async () => {
    const primary = fakeEndpoint("https://primary", never);

    await expect(callPool([primary], { timeoutMs: 30 })).rejects.toBeInstanceOf(TimeoutError);
  });
});
