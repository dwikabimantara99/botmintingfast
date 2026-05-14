import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from "viem";

import { emitTelemetrySafe } from "../telemetry.js";
import type { TargetConfig } from "../types.js";
import { probeEndpoint, rankHealthyEndpoints } from "./broadcast.js";

type ClientMethodNames =
  | "call"
  | "estimateGas"
  | "getBalance"
  | "getBlock"
  | "getBlockNumber"
  | "getBytecode"
  | "getChainId"
  | "getFeeHistory"
  | "getGasPrice"
  | "getTransactionCount"
  | "getTransactionReceipt";

export type RpcReadClient = Pick<PublicClient, ClientMethodNames>;

export type RpcMesh = RpcReadClient & {
  refreshRanking: () => Promise<string[]>;
  getRankedEndpoints: () => string[];
  getAllEndpoints: () => string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildChain(target: TargetConfig) {
  return defineChain({
    id: target.chain.id,
    name: target.chain.name,
    nativeCurrency: target.chain.nativeCurrency,
    rpcUrls: {
      default: {
        http: [target.chain.rpc.primaryHttp],
        webSocket: target.chain.rpc.webSocket ? [target.chain.rpc.webSocket] : undefined,
      },
    },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRetryableReadError(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("http request failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("enetunreach") ||
    message.includes("eai_again")
  );
}

export function createRpcMesh(target: TargetConfig): RpcMesh {
  const endpoints = Array.from(
    new Set([
      target.chain.rpc.primaryHttp,
      ...(target.chain.rpc.readHttp ?? []),
      ...target.chain.rpc.broadcastHttp,
    ]),
  );
  const chain = buildChain(target);
  const clients = new Map(
    endpoints.map((endpoint) => [
      endpoint,
      createPublicClient({
        chain,
        transport: http(endpoint),
      }),
    ]),
  );
  let rankedEndpoints = [...endpoints];

  async function refreshRanking(): Promise<string[]> {
    const probes = await Promise.all(endpoints.map((endpoint) => probeEndpoint(endpoint)));
    rankedEndpoints = rankHealthyEndpoints(probes, endpoints);
    emitTelemetrySafe("read_rpc_ranking", {
      rankedEndpoints,
      probes,
    });
    return rankedEndpoints;
  }

  async function withFallback<T>(
    action: string,
    operation: (client: PublicClient, endpoint: string) => Promise<T>,
  ): Promise<T> {
    const attemptedEndpoints = rankedEndpoints.length > 0 ? rankedEndpoints : endpoints;
    const errors: string[] = [];
    const maxAttemptsPerEndpoint = 3;

    for (const endpoint of attemptedEndpoints) {
      const client = clients.get(endpoint);
      if (!client) continue;

      for (let attempt = 1; attempt <= maxAttemptsPerEndpoint; attempt += 1) {
        try {
          return await operation(client, endpoint);
        } catch (error) {
          const retryable = isRetryableReadError(error);
          const prefix =
            maxAttemptsPerEndpoint > 1
              ? `${endpoint} [attempt ${attempt}/${maxAttemptsPerEndpoint}]`
              : endpoint;

          if (!retryable || attempt === maxAttemptsPerEndpoint) {
            errors.push(`${prefix}: ${describeError(error)}`);
            break;
          }

          emitTelemetrySafe("read_rpc_retry", {
            action,
            endpoint,
            attempt,
            maxAttemptsPerEndpoint,
            error: describeError(error),
          });
          await sleep(75 * attempt);
        }
      }
    }

    emitTelemetrySafe("read_rpc_failure", {
      action,
      attemptedEndpoints,
      errors,
    });
    throw new Error(`${action} failed across RPC mesh: ${errors.join(" | ")}`);
  }

  return {
    refreshRanking,
    getRankedEndpoints: () => [...rankedEndpoints],
    getAllEndpoints: () => [...endpoints],
    call: async (args) => withFallback("call", (client) => client.call(args)),
    estimateGas: async (args) => withFallback("estimateGas", (client) => client.estimateGas(args)),
    getBalance: async (args) => withFallback("getBalance", (client) => client.getBalance(args)),
    getBlock: async (args) => withFallback("getBlock", (client) => client.getBlock(args)),
    getBlockNumber: async (args) => withFallback("getBlockNumber", (client) => client.getBlockNumber(args)),
    getBytecode: async (args) => withFallback("getBytecode", (client) => client.getBytecode(args)),
    getChainId: async () => withFallback("getChainId", (client) => client.getChainId()),
    getFeeHistory: async (args) => withFallback("getFeeHistory", (client) => client.getFeeHistory(args)),
    getGasPrice: async () => withFallback("getGasPrice", (client) => client.getGasPrice()),
    getTransactionCount: async (args) =>
      withFallback("getTransactionCount", (client) => client.getTransactionCount(args)),
    getTransactionReceipt: async (args) =>
      withFallback("getTransactionReceipt", (client) => client.getTransactionReceipt(args)),
  };
}
