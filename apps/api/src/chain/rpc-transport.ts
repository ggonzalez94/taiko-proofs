import {
  createTransport,
  http,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  TimeoutError,
  webSocket,
  withTimeout,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport
} from "viem";

export const DEFAULT_RPC_TIMEOUT_MS = 20_000;
export const DEFAULT_RPC_COOLDOWN_MS = 60_000;
export const DEFAULT_RPC_RETRY_DELAY_MS = 150;
/** The cooldown doubles on every consecutive failure, up to this multiple of the base cooldown. */
export const MAX_RPC_COOLDOWN_MULTIPLIER = 16;
/** Extra passes after a transient server error, mirroring viem's default retry count. */
export const MAX_TRANSIENT_RETRIES = 3;

const TRANSIENT_HTTP_STATUSES = new Set([408, 413, 429, 500, 502, 503, 504]);
/** viem's `RpcError` code for a failure that never produced a JSON-RPC response (network errors). */
const UNKNOWN_RPC_ERROR_CODE = -1;
const TRANSIENT_RPC_CODES = new Set<number>([InternalRpcError.code, LimitExceededRpcError.code]);
const ENDPOINT_FAULT_RPC_CODES = new Set<number>([UNKNOWN_RPC_ERROR_CODE, ...TRANSIENT_RPC_CODES]);

export type RpcEndpoint = {
  url: string;
  transport: Transport;
};

export type RpcTransportOptions = {
  /** Hard deadline per endpoint attempt, covering connection setup as well as the request. */
  timeoutMs?: number;
  /** Base demotion window for a failed endpoint; doubles on consecutive failures. */
  cooldownMs?: number;
  /** Base delay before retrying a transient server error; doubles per retry. */
  retryDelayMs?: number;
  now?: () => number;
};

type EndpointHealth = {
  url: string;
  failedAt: number | null;
  consecutiveFailures: number;
};

export function parseRpcUrls(value: string): string[] {
  const urls: string[] = [];
  for (const candidate of value.split(/[\s,]+/)) {
    const url = candidate.trim();
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

export function buildEndpointTransport(url: string, timeoutMs: number): Transport {
  const { protocol } = new URL(url);
  if (protocol === "ws:" || protocol === "wss:") {
    return webSocket(url, { timeout: timeoutMs });
  }

  if (protocol === "http:" || protocol === "https:") {
    return http(url, { timeout: timeoutMs });
  }

  throw new Error(`RPC_URL must use http(s) or ws(s), got protocol "${protocol}"`);
}

function rpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * True when the failure says something about the endpoint (unreachable, timed out, overloaded)
 * rather than about the request. A JSON-RPC error is the endpoint answering, so it is returned
 * to the caller as-is instead of being replayed elsewhere.
 */
export function isEndpointFault(error: unknown): boolean {
  const code = rpcCode(error);
  return code === undefined || ENDPOINT_FAULT_RPC_CODES.has(code);
}

/** Endpoint faults worth retrying after a short delay: viem's retry policy minus timeouts. */
export function isTransientFault(error: unknown): boolean {
  if (error instanceof HttpRequestError) {
    return error.status !== undefined && TRANSIENT_HTTP_STATUSES.has(error.status);
  }

  const code = rpcCode(error);
  return code !== undefined && TRANSIENT_RPC_CODES.has(code);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds a transport that tries the configured endpoints in order, moving on to the next one when
 * an endpoint is unreachable, exceeds the deadline or reports a server-side problem. Endpoints
 * that failed recently are tried last, so a dead endpoint costs at most one deadline per cooldown
 * window instead of one per request, and the window doubles while it keeps failing.
 */
export function createRpcTransport(
  endpoints: RpcEndpoint[],
  options: RpcTransportOptions = {}
): Transport {
  if (!endpoints.length) {
    throw new Error("At least one RPC endpoint is required");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RPC_COOLDOWN_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RPC_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const health: EndpointHealth[] = endpoints.map(({ url }) => ({
    url,
    failedAt: null,
    consecutiveFailures: 0
  }));

  const cooldownFor = (entry: EndpointHealth) =>
    cooldownMs *
    Math.min(2 ** Math.max(entry.consecutiveFailures - 1, 0), MAX_RPC_COOLDOWN_MULTIPLIER);

  const orderedIndexes = () => {
    const current = now();
    const isHealthy = (entry: EndpointHealth) =>
      entry.failedAt === null || current - entry.failedAt >= cooldownFor(entry);
    const indexes = health.map((_, index) => index);
    return [
      ...indexes.filter((index) => isHealthy(health[index])),
      ...indexes.filter((index) => !isHealthy(health[index]))
    ];
  };

  return (config) => {
    const clients = endpoints.map(({ transport }) =>
      transport({ ...config, retryCount: 0, timeout: timeoutMs })
    );

    const attempt = (index: number, body: EIP1193Parameters) =>
      withTimeout(() => clients[index].request(body), {
        timeout: timeoutMs,
        errorInstance: new TimeoutError({ body, url: health[index].url })
      });

    const request = async ({ method, params }: EIP1193Parameters) => {
      const body = { method, params } as EIP1193Parameters;
      // Failures are counted once per request, however many passes retry the endpoint.
      const failedThisRequest = new Map<number, unknown>();
      let candidates = orderedIndexes();
      let lastError: unknown;

      for (let pass = 0; pass <= MAX_TRANSIENT_RETRIES; pass += 1) {
        if (pass > 0) {
          await wait(retryDelayMs * 2 ** (pass - 1));
        }

        for (const index of candidates) {
          const endpoint = health[index];
          try {
            const result = await attempt(index, body);
            endpoint.failedAt = null;
            endpoint.consecutiveFailures = 0;
            return result;
          } catch (error) {
            if (!isEndpointFault(error)) {
              throw error;
            }

            if (!failedThisRequest.has(index)) {
              endpoint.consecutiveFailures += 1;
            }
            failedThisRequest.set(index, error);
            endpoint.failedAt = now();
            lastError = error;
          }
        }

        candidates = candidates.filter((index) => isTransientFault(failedThisRequest.get(index)));
        if (!candidates.length) {
          break;
        }
      }

      throw lastError;
    };

    return createTransport(
      {
        key: "rpc-pool",
        name: "RPC endpoint pool",
        request: request as EIP1193RequestFn,
        // Failover and transient retries live in the pool; viem must not repeat whole passes.
        retryCount: 0,
        type: "rpc-pool"
      },
      { endpoints: endpoints.map(({ url }) => url) }
    );
  };
}
