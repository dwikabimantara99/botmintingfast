import process from "node:process";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  parseGwei,
  type Hex,
} from "viem";

import { loadAccounts, loadTargetConfig } from "../config.js";
import { logger } from "../logger.js";
import type { TargetConfig } from "../types.js";

type TimingSample = {
  ok: boolean;
  durationMs: number;
  error?: string;
};

type MetricName =
  | "getBlockNumber"
  | "getBlock"
  | "getGasPrice"
  | "getFeeHistory"
  | "getTransactionCountPending"
  | "prepareAndSign"
  | "webSocketConnect";

type TargetBenchmark = {
  label: string;
  primaryHttp: string;
  webSocket?: string;
  metrics: Record<MetricName, TimingSample[]>;
};

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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function timeOperation<T>(operation: () => Promise<T>): Promise<TimingSample> {
  const started = Date.now();
  try {
    await operation();
    return {
      ok: true,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: toErrorMessage(error),
    };
  }
}

async function testWebSocketConnect(url?: string): Promise<TimingSample> {
  if (!url) {
    return {
      ok: false,
      durationMs: 0,
      error: "No webSocket configured.",
    };
  }

  if (typeof WebSocket === "undefined") {
    return {
      ok: false,
      durationMs: 0,
      error: "WebSocket runtime unavailable.",
    };
  }

  return new Promise<TimingSample>((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => finish(false, "Timed out waiting for WSS open."), 10_000);

    function finish(ok: boolean, error?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket.readyState === socket.OPEN) {
          socket.close(1000, "done");
        }
      } catch {
        // Ignore close failures during benchmark.
      }

      const result: TimingSample = {
        ok,
        durationMs: Date.now() - started,
      };

      if (error !== undefined) {
        result.error = error;
      }

      resolve(result);
    }

    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false, "WebSocket error"));
    socket.addEventListener("close", (event) => {
      if (!settled && event.code !== 1000) {
        finish(false, `Closed before open. code=${event.code}`);
      }
    });
  });
}

function buildTransactionData(target: TargetConfig): { to: Hex; data: Hex; value: bigint; gas: bigint } {
  if (target.transaction.kind === "rawTransaction") {
    return {
      to: target.transaction.to,
      data: target.transaction.data,
      value: target.transaction.valueEth ? parseEther(target.transaction.valueEth) : 0n,
      gas: BigInt(target.transaction.gasLimit ?? 220000),
    };
  }

  const abi = target.transaction.abi.length > 0 && typeof target.transaction.abi[0] === "string"
    ? parseAbi(target.transaction.abi as unknown as readonly string[])
    : target.transaction.abi;

  return {
    to: target.transaction.to,
    data: encodeFunctionData({
      abi,
      functionName: target.transaction.functionName,
      args: target.transaction.args ?? [],
    }),
    value: target.transaction.valueEth ? parseEther(target.transaction.valueEth) : 0n,
    gas: BigInt(target.transaction.gasLimit ?? 220000),
  };
}

async function benchmarkTarget(label: string, target: TargetConfig): Promise<TargetBenchmark> {
  const account = loadAccounts(1)[0]!;
  const chain = buildChain(target);
  const publicClient = createPublicClient({
    chain,
    transport: http(target.chain.rpc.primaryHttp),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(target.chain.rpc.primaryHttp),
  });
  const txData = buildTransactionData(target);
  const metrics: Record<MetricName, TimingSample[]> = {
    getBlockNumber: [],
    getBlock: [],
    getGasPrice: [],
    getFeeHistory: [],
    getTransactionCountPending: [],
    prepareAndSign: [],
    webSocketConnect: [],
  };

  for (let round = 0; round < 5; round += 1) {
    metrics.getBlockNumber.push(await timeOperation(() => publicClient.getBlockNumber()));
    metrics.getBlock.push(await timeOperation(() => publicClient.getBlock()));
    metrics.getGasPrice.push(await timeOperation(() => publicClient.getGasPrice()));
    metrics.getFeeHistory.push(
      await timeOperation(() =>
        publicClient.getFeeHistory({
          blockCount: 5,
          rewardPercentiles: [75],
        })),
    );
    metrics.getTransactionCountPending.push(
      await timeOperation(() =>
        publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        })),
    );

    metrics.prepareAndSign.push(
      await timeOperation(async () => {
        const nonce = await publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        const gasPrice = await publicClient.getGasPrice();
        const request = await walletClient.prepareTransactionRequest({
          account,
          to: txData.to,
          data: txData.data,
          value: txData.value,
          gas: txData.gas,
          nonce,
          maxPriorityFeePerGas: parseGwei("0.08"),
          maxFeePerGas: gasPrice * 2n,
          parameters: ["gas", "type"],
          chain,
        });
        await walletClient.signTransaction(request);
      }),
    );

    metrics.webSocketConnect.push(await testWebSocketConnect(target.chain.rpc.webSocket));
  }

  const benchmark: TargetBenchmark = {
    label,
    primaryHttp: target.chain.rpc.primaryHttp,
    metrics,
  };

  if (target.chain.rpc.webSocket !== undefined) {
    benchmark.webSocket = target.chain.rpc.webSocket;
  }

  return benchmark;
}

function summarizeBenchmark(benchmark: TargetBenchmark) {
  return {
    label: benchmark.label,
    primaryHttp: benchmark.primaryHttp,
    webSocket: benchmark.webSocket,
    metrics: Object.fromEntries(
      Object.entries(benchmark.metrics).map(([metric, samples]) => {
        const successes = samples.filter((sample) => sample.ok);
        const failures = samples.filter((sample) => !sample.ok);
        return [
          metric,
          {
            successCount: successes.length,
            failureCount: failures.length,
            medianMs: median(successes.map((sample) => sample.durationMs)),
            failures: failures.map((sample) => sample.error ?? "unknown error"),
          },
        ];
      }),
    ),
  };
}

async function main(): Promise<void> {
  const alchemyTargetPath = process.argv[2] ?? "./targets/alchemy-rpc-stack.sample.json";
  const drpcTargetPath = process.argv[3] ?? "./targets/drpc-rpc-stack.sample.json";

  const alchemyTarget = await loadTargetConfig(alchemyTargetPath);
  const drpcTarget = await loadTargetConfig(drpcTargetPath);

  logger.info("Running RPC primary comparison benchmark.", {
    alchemyTargetPath,
    drpcTargetPath,
  });

  const alchemy = await benchmarkTarget("alchemy-primary", alchemyTarget);
  const drpc = await benchmarkTarget("drpc-primary", drpcTarget);

  console.log(
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        summary: [summarizeBenchmark(alchemy), summarizeBenchmark(drpc)],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
