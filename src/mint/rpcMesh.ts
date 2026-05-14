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

type EndpointState = {
  consecutiveFailures: number;
  cooldownUntilMs: number;
  lastError?: string;
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

export function isRetryableReadError(error: unknown): boolean {
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
  const endpointStates = new Map<string, EndpointState>(
    endpoints.map((endpoint) => [
      endpoint,
      {
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
      },
    ]),
  );
  let rankedEndpoints = [...endpoints];
  const recoveryPasses = Math.max(1, target.execution?.rpcRecoveryPasses ?? 2);
  const recoveryDelayMs = Math.max(50, target.execution?.rpcRecoveryDelayMs ?? 250);
  const endpointCooldownMs = Math.max(100, target.execution?.rpcEndpointCooldownMs ?? 1500);

  function markEndpointSuccess(endpoint: string): void {
    const state = endpointStates.get(endpoint);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownUntilMs = 0;
    delete state.lastError;
  }

  function markEndpointFailure(endpoint: string, error: unknown): void {
    const state = endpointStates.get(endpoint);
    if (!state || !isRetryableReadError(error)) return;
    state.consecutiveFailures += 1;
    state.lastError = describeError(error);
    const cooldownMs = Math.min(endpointCooldownMs * state.consecutiveFailures, 10_000);
    state.cooldownUntilMs = Date.now() + cooldownMs;
  }

  function getEligibleEndpoints(): string[] {
    const nowMs = Date.now();
    const cooled = rankedEndpoints.filter((endpoint) => {
      const state = endpointStates.get(endpoint);
      return !state || state.cooldownUntilMs <= nowMs;
    });

    return cooled.length > 0 ? cooled : rankedEndpoints;
  }

  async function refreshRanking(): Promise<string[]> {
    const probes = await Promise.all(endpoints.map((endpoint) => probeEndpoint(endpoint)));
    rankedEndpoints = rankHealthyEndpoints(probes, endpoints);
    for (const probe of probes) {
      if (probe.ok) {
        markEndpointSuccess(probe.endpoint);
      } else {
        markEndpointFailure(probe.endpoint, probe.error ?? "probe failed");
      }
    }
    emitTelemetrySafe("read_rpc_ranking", {
      rankedEndpoints,
      probes,
      endpointStates: Object.fromEntries(
        Array.from(endpointStates.entries()).map(([endpoint, state]) => [
          endpoint,
          {
            consecutiveFailures: state.consecutiveFailures,
            cooldownUntilMs: state.cooldownUntilMs,
            lastError: state.lastError,
          },
        ]),
      ),
    });
    return rankedEndpoints;
  }

  async function withFallback<T>(
    action: string,
    operation: (client: PublicClient, endpoint: string) => Promise<T>,
  ): Promise<T> {
    const errors: string[] = [];
    const maxAttemptsPerEndpoint = 3;
    let lastAttemptedEndpoints: string[] = [];

    for (let recoverySweep = 1; recoverySweep <= recoveryPasses; recoverySweep += 1) {
      const attemptedEndpoints = rankedEndpoints.length > 0 ? getEligibleEndpoints() : endpoints;
      lastAttemptedEndpoints = attemptedEndpoints;

      for (const endpoint of attemptedEndpoints) {
        const client = clients.get(endpoint);
        if (!client) continue;

        for (let attempt = 1; attempt <= maxAttemptsPerEndpoint; attempt += 1) {
          try {
            const result = await operation(client, endpoint);
            markEndpointSuccess(endpoint);
            return result;
          } catch (error) {
            const retryable = isRetryableReadError(error);
            const prefix =
              maxAttemptsPerEndpoint > 1
                ? `${endpoint} [attempt ${attempt}/${maxAttemptsPerEndpoint}]`
                : endpoint;

            markEndpointFailure(endpoint, error);

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

      if (recoverySweep < recoveryPasses) {
        emitTelemetrySafe("read_rpc_recovery_sweep", {
          action,
          recoverySweep,
          recoveryPasses,
          attemptedEndpoints,
        });
        await sleep(recoveryDelayMs * recoverySweep);
        await refreshRanking().catch(() => {
          // Ranking refresh failures should not hide the original errors.
        });
      }
    }

    emitTelemetrySafe("read_rpc_failure", {
      action,
      attemptedEndpoints: lastAttemptedEndpoints,
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
