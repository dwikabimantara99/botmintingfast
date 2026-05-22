import { request as httpRequest, Agent as HttpAgent, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";

import type { Hex } from "viem";

import { getRequestTimeoutMs } from "../config.js";

export type BroadcastResult = {
  endpoint: string;
  ok: boolean;
  hash?: Hex;
  error?: string;
  latencyMs: number;
};

export type EndpointProbe = {
  endpoint: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  blockNumberHex?: Hex;
  serverTimeMs?: number;
  clockOffsetMs?: number;
};

type RpcDetailedResult = {
  result: unknown;
  latencyMs: number;
  serverTimeMs?: number;
  clockOffsetMs?: number;
};

type NativeRpcResponse = {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  body: string;
};

const httpAgent = new HttpAgent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
});

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
});

function getHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function postJsonRpc(endpoint: string, body: string, timeoutMs: number): Promise<NativeRpcResponse> {
  const url = new URL(endpoint);
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const agent = url.protocol === "https:" ? httpsAgent : httpAgent;

  return new Promise((resolve, reject) => {
    const request = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`RPC timeout after ${timeoutMs} ms`));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function rpcRequestDetailed(endpoint: string, method: string, params: unknown[]): Promise<RpcDetailedResult> {
  const timeoutMs = getRequestTimeoutMs();
  const localStartedAt = Date.now();
  const perfStartedAt = performance.now();

  const response = await postJsonRpc(
    endpoint,
    JSON.stringify({
      id: Date.now(),
      jsonrpc: "2.0",
      method,
      params,
    }),
    timeoutMs,
  );
  const localFinishedAt = Date.now();
  const latencyMs = Math.round(performance.now() - perfStartedAt);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
  }

  const payload = JSON.parse(response.body) as {
    error?: { code?: number; message?: string };
    result?: unknown;
  };
  const dateHeader = getHeaderValue(response.headers, "date");
  const serverTimeMs = dateHeader ? Date.parse(dateHeader) : undefined;
  const midpointLocalMs = Math.round((localStartedAt + localFinishedAt) / 2);
  const clockOffsetMs =
    serverTimeMs !== undefined && !Number.isNaN(serverTimeMs) ? serverTimeMs - midpointLocalMs : undefined;

  if (payload.error) {
    throw new Error(payload.error.message ?? `RPC error code ${payload.error.code ?? "unknown"}`);
  }

  if (payload.result === undefined) {
    throw new Error(`RPC response missing result for method ${method}`);
  }

  const result: RpcDetailedResult = {
    result: payload.result,
    latencyMs,
  };

  if (serverTimeMs !== undefined && !Number.isNaN(serverTimeMs)) {
    result.serverTimeMs = serverTimeMs;
  }

  if (clockOffsetMs !== undefined && !Number.isNaN(clockOffsetMs)) {
    result.clockOffsetMs = clockOffsetMs;
  }

  return result;
}

async function rpcRequest(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const detailed = await rpcRequestDetailed(endpoint, method, params);
  return detailed.result;
}

export async function probeEndpoint(endpoint: string): Promise<EndpointProbe> {
  try {
    const detailed = await rpcRequestDetailed(endpoint, "eth_blockNumber", []);
    const result: EndpointProbe = {
      endpoint,
      ok: true,
      blockNumberHex: detailed.result as Hex,
      latencyMs: detailed.latencyMs,
    };

    if (detailed.serverTimeMs !== undefined) {
      result.serverTimeMs = detailed.serverTimeMs;
    }

    if (detailed.clockOffsetMs !== undefined) {
      result.clockOffsetMs = detailed.clockOffsetMs;
    }

    return result;
  } catch (error) {
    return {
      endpoint,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: 0,
    };
  }
}

export function rankHealthyEndpoints(probes: EndpointProbe[], fallbackEndpoints: string[]): string[] {
  const uniqueFallback = Array.from(new Set(fallbackEndpoints));
  const healthy = probes
    .filter((probe) => probe.ok)
    .sort((left, right) => left.latencyMs - right.latencyMs)
    .map((probe) => probe.endpoint);
  const unhealthy = uniqueFallback.filter((endpoint) => !healthy.includes(endpoint));

  return healthy.length > 0 ? [...healthy, ...unhealthy] : uniqueFallback;
}

export async function pingEndpoint(endpoint: string): Promise<BroadcastResult> {
  try {
    const probe = await probeEndpoint(endpoint);
    const result: BroadcastResult = {
      endpoint,
      ok: probe.ok,
      latencyMs: probe.latencyMs,
    };

    if (probe.blockNumberHex) {
      result.hash = probe.blockNumberHex;
    }

    if (probe.error) {
      result.error = probe.error;
    }

    return result;
  } catch (error) {
    return {
      endpoint,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: 0,
    };
  }
}

export async function broadcastSignedTransaction(
  endpoints: string[],
  serializedTransaction: Hex,
): Promise<BroadcastResult[]> {
  return Promise.all(
    endpoints.map(async (endpoint) => {
      const started = performance.now();

      try {
        const result = await rpcRequest(endpoint, "eth_sendRawTransaction", [serializedTransaction]);
        return {
          endpoint,
          ok: true,
          hash: result as Hex,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          endpoint,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - started),
        };
      }
    }),
  );
}
