import type { Hex } from "viem";

import { getRequestTimeoutMs } from "../config.js";

export type BroadcastResult = {
  endpoint: string;
  ok: boolean;
  hash?: Hex;
  error?: string;
  latencyMs: number;
};

async function rpcRequest(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const timeoutMs = getRequestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: Date.now(),
        jsonrpc: "2.0",
        method,
        params,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const payload = JSON.parse(responseText) as {
      error?: { code?: number; message?: string };
      result?: unknown;
    };

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (payload.error) {
      throw new Error(payload.error.message ?? `RPC error code ${payload.error.code ?? "unknown"}`);
    }

    if (payload.result === undefined) {
      throw new Error(`RPC response missing result for method ${method}`);
    }

    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function pingEndpoint(endpoint: string): Promise<BroadcastResult> {
  const started = performance.now();

  try {
    const result = await rpcRequest(endpoint, "eth_blockNumber", []);
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
