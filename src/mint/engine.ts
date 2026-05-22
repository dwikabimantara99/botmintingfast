import { hrtime } from "node:process";
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  keccak256,
  parseAbi,
  parseGwei,
  type Abi,
  type AccessList,
  type Account,
  type Hex,
  type TransactionSerializable,
} from "viem";

import {
  getDefaultReceiptTimeoutMs,
  getWalletProfiles,
  loadAccounts,
} from "../config.js";
import { logger } from "../logger.js";
import { emitTelemetrySafe, getTelemetryPath } from "../telemetry.js";
import type { TargetConfig, WalletProfile } from "../types.js";
import { buildTransactionPayload } from "./adapter.js";
import {
  broadcastSignedTransaction,
  pingEndpoint,
  probeEndpoint,
  rankHealthyEndpoints,
  type BroadcastResult,
} from "./broadcast.js";
import { calibrateClock, type ClockCalibration } from "./clock.js";
import { createPrivateRelaySubmitter, type PrivateRelaySubmitter } from "./privateRelay.js";
import { createRpcMesh, isRetryableReadError, type RpcReadClient } from "./rpcMesh.js";
import {
  getTimeTriggerConfig,
  logClockStatusWithCalibration,
  waitForArmWindow,
  waitForPreciseFireWindow,
  waitForTimedCheckpoint,
  waitForTrigger,
} from "./trigger.js";

type PreparedSend = {
  account: Account;
  profile: WalletProfile;
  nonce: number;
  gas: bigint;
  serializedTransaction: Hex;
  transactionHash: Hex;
};

type SigningContext = {
  account: Account;
  profile: WalletProfile;
  payload: PayloadShape;
  nonce: number;
  gasLimit: bigint;
};

type PayloadShape = {
  to: Hex;
  data: Hex;
  value: bigint;
  gas?: bigint;
  accessList?: AccessList;
};

type FeeEnvelope =
  | {
      type: "eip1559";
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }
  | {
      type: "legacy";
      gasPrice: bigint;
    };

type ValidationItem = {
  check: string;
  ok: boolean;
  severity: "block" | "risk";
  details: string;
};

type ReceiptOutcome =
  | {
      status: "success";
      hash: Hex;
    }
  | {
      status: "reverted";
      hash: Hex;
    }
  | {
      status: "pending";
      hash: Hex;
    };

type PreparedLadders = Map<number, PreparedSend[]>;

type ValidationReport = {
  results: ValidationItem[];
  readiness: "READY" | "RISKY" | "BLOCKED";
};

type LiveFeeMarket = {
  currentGasPrice: bigint;
  currentBaseFeePerGas?: bigint;
  nextBaseFeePerGas?: bigint;
  suggestedPriorityFeePerGas: bigint;
  suggestedMaxFeePerGas: bigint;
};

type VerificationResult = {
  ok: boolean;
  details: string;
  value?: unknown;
};

const feePresetDefaults = {
  safe: {
    targetUsd: 1.5,
    minFeeFloorGwei: 0.5,
    maxFeeCapGwei: 25,
    priorityFeeGwei: 0.05,
  },
  race: {
    targetUsd: 2.5,
    minFeeFloorGwei: 0.8,
    maxFeeCapGwei: 40,
    priorityFeeGwei: 0.08,
  },
  allOut: {
    targetUsd: 4,
    minFeeFloorGwei: 1.25,
    maxFeeCapGwei: 80,
    priorityFeeGwei: 0.12,
  },
} as const;

const receiptPollPresetDefaults = {
  safe: 800,
  race: 300,
  allOut: 200,
} as const;

function getReceiptPollIntervalMs(target: TargetConfig): number {
  const configured = target.execution?.receiptPollIntervalMs;
  if (configured !== undefined) {
    return Math.max(50, configured);
  }

  if (target.fees.preset) {
    return receiptPollPresetDefaults[target.fees.preset];
  }

  return 500;
}

function normalizeAbi(abi: Abi | readonly string[]): Abi {
  if (abi.length === 0) {
    return abi as Abi;
  }

  if (typeof abi[0] === "string") {
    return parseAbi(abi as readonly string[]);
  }

  return abi as Abi;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAtNs: bigint): number {
  return Number(hrtime.bigint() - startedAtNs) / 1_000_000;
}

function roundNumber(value: number, fractionDigits = 3): number {
  return Number(value.toFixed(fractionDigits));
}

function scaleBigInt(value: bigint, multiplier: number): bigint {
  const basisPoints = Math.max(1, Math.round(multiplier * 10_000));
  return (value * BigInt(basisPoints)) / 10_000n;
}

function formatGweiValue(value: bigint): string {
  return `${(Number(value) / 1e9).toFixed(4)} gwei`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isFutureTimeTrigger(target: TargetConfig): boolean {
  if (target.trigger.mode !== "time") return false;
  const startTimeMs = Date.parse(target.trigger.startTimeIso);
  return Number.isFinite(startTimeMs) && Date.now() < startTimeMs;
}

function isLikelyPreOpenRevert(target: TargetConfig, error: unknown): boolean {
  if (!isFutureTimeTrigger(target)) return false;
  return /revert|notactive|not active/i.test(describeError(error));
}

function replacePlaceholders(value: unknown, walletAddress: Hex, walletIndex: number): unknown {
  if (typeof value === "string") {
    if (value === "__WALLET__") return walletAddress;
    if (value === "__INDEX__") return walletIndex;
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, walletAddress, walletIndex));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        replacePlaceholders(nested, walletAddress, walletIndex),
      ]),
    );
  }

  return value;
}

function formatVerificationValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function compareVerificationValue(actual: unknown, operator: "eq" | "gte" | "truthy", expected?: unknown): boolean {
  if (operator === "truthy") {
    return Boolean(actual);
  }

  if (operator === "eq") {
    if (typeof actual === "bigint" || typeof expected === "bigint") {
      return BigInt(actual as bigint | number | string) === BigInt(expected as bigint | number | string);
    }

    return actual === expected;
  }

  if (typeof actual === "bigint" || typeof expected === "bigint") {
    return BigInt(actual as bigint | number | string) >= BigInt(expected as bigint | number | string);
  }

  return Number(actual) >= Number(expected);
}

async function runPostMintVerification(
  target: TargetConfig,
  client: RpcReadClient,
  account: Account,
  profile: WalletProfile,
): Promise<VerificationResult | null> {
  if (!target.verification) {
    return null;
  }

  const args = (target.verification.args ?? []).map((arg) =>
    replacePlaceholders(arg, account.address, profile.index),
  );
  const contract = target.verification.contract ?? ("to" in target.transaction ? target.transaction.to : undefined);
  if (!contract) {
    throw new Error("verification.contract is required when the transaction target is resolved dynamically.");
  }
  const abi = normalizeAbi(target.verification.abi);
  const data = encodeFunctionData({
    abi,
    functionName: target.verification.functionName,
    args,
  });
  const raw = await client.call({
    to: contract,
    data,
  });
  const decoded = decodeFunctionResult({
    abi,
    functionName: target.verification.functionName,
    data: raw.data ?? "0x",
  });
  const ok = compareVerificationValue(decoded, target.verification.operator, target.verification.expected);

  return {
    ok,
    value: decoded,
    details:
      target.verification.operator === "truthy"
        ? `verification=${formatVerificationValue(decoded)}`
        : `actual=${formatVerificationValue(decoded)}, expected=${formatVerificationValue(target.verification.expected)}`,
  };
}

function pushValidation(
  results: ValidationItem[],
  check: string,
  ok: boolean,
  details: string,
  severity: "block" | "risk" = "block",
): void {
  results.push({ check, ok, details, severity });
}

function summarizeReadiness(results: ValidationItem[]): "READY" | "RISKY" | "BLOCKED" {
  if (results.some((item) => !item.ok && item.severity === "block")) {
    return "BLOCKED";
  }

  if (results.some((item) => !item.ok && item.severity === "risk")) {
    return "RISKY";
  }

  return "READY";
}

function isRetryableRpcOperationError(error: unknown): boolean {
  return isRetryableReadError(error);
}

async function withRpcOperationRetries<T>(
  target: TargetConfig,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, target.execution?.rpcOperationRetries ?? 2);
  const retryDelayMs = Math.max(100, target.execution?.rpcOperationRetryDelayMs ?? 1200);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcOperationError(error) || attempt === maxAttempts) {
        throw error;
      }

      logger.warn(`${label} hit a retryable RPC failure. Retrying.`, {
        attempt,
        maxAttempts,
        retryDelayMs: retryDelayMs * attempt,
        error: describeError(error),
      });
      emitTelemetrySafe("rpc_operation_retry", {
        label,
        attempt,
        maxAttempts,
        retryDelayMs: retryDelayMs * attempt,
        error: describeError(error),
      });
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

function buildUnsignedRequest(
  payload: PayloadShape,
  nonce: number,
  gasLimit: bigint,
  feeEnvelope: FeeEnvelope,
  chainId: number,
): TransactionSerializable {
  const request = {
    to: payload.to,
    data: payload.data,
    value: payload.value,
    gas: gasLimit,
    nonce,
    chainId,
  };

  if (feeEnvelope.type === "eip1559") {
    return {
      ...request,
      type: "eip1559",
      accessList: payload.accessList,
      maxFeePerGas: feeEnvelope.maxFeePerGas,
      maxPriorityFeePerGas: feeEnvelope.maxPriorityFeePerGas,
    };
  }

  if (payload.accessList !== undefined) {
    return {
      ...request,
      type: "eip2930",
      accessList: payload.accessList,
      gasPrice: feeEnvelope.gasPrice,
    };
  }

  return {
    ...request,
    type: "legacy",
    gasPrice: feeEnvelope.gasPrice,
  };
}

function estimateCostNative(gas: bigint, feeEnvelope: FeeEnvelope): bigint {
  if (feeEnvelope.type === "eip1559") {
    return gas * feeEnvelope.maxFeePerGas;
  }

  return gas * feeEnvelope.gasPrice;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function medianBigInt(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }

  return (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

function isLikelyPropagatedError(message?: string): boolean {
  if (!message) return false;

  const normalized = message.toLowerCase();
  return (
    normalized.includes("already known") ||
    normalized.includes("known transaction") ||
    normalized.includes("already imported") ||
    normalized.includes("nonce too low")
  );
}

function summarizeBroadcastResults(send: PreparedSend, results: BroadcastResult[]) {
  const accepted = results.find((item) => item.ok && item.hash);
  const firstError = results.find((item) => !item.ok)?.error;

  return {
    wallet: send.account.address,
    profile: send.profile.label,
    nonce: send.nonce,
    hash: accepted?.hash,
    acceptedEndpoint: accepted?.endpoint,
    acceptedLatencyMs: accepted?.latencyMs,
    okCount: results.filter((item) => item.ok).length,
    errorCount: results.filter((item) => !item.ok).length,
    firstError,
  };
}

function getBroadcastBurstSchedule(target: TargetConfig): number[] {
  const configured = target.execution?.broadcastBurstMs;
  if (!configured || configured.length === 0) {
    return [0];
  }

  const normalized = Array.from(
    new Set(
      [0, ...configured]
        .map((delayMs) => Math.max(0, Math.floor(delayMs)))
        .filter((delayMs) => Number.isFinite(delayMs) && delayMs <= 2_000),
    ),
  ).sort((left, right) => left - right);

  return normalized.includes(0) ? normalized : [0, ...normalized];
}

async function sampleLiveFeeMarket(client: RpcReadClient, configuredPriorityFeePerGas?: bigint): Promise<LiveFeeMarket> {
  const [latestBlock, currentGasPrice, feeHistory] = await Promise.all([
    client.getBlock(),
    client.getGasPrice(),
    client
      .getFeeHistory({
        blockCount: 5,
        rewardPercentiles: [75],
      })
      .catch(() => null),
  ]);
  let nextBaseFeePerGas = latestBlock.baseFeePerGas ?? undefined;
  let prioritySamples: bigint[] = [];

  if (feeHistory) {
    const feeHistoryBase = feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1];
    if (feeHistoryBase !== undefined) {
      nextBaseFeePerGas = feeHistoryBase;
    }

    prioritySamples = (feeHistory.reward ?? [])
      .map((rewardRow) => rewardRow[0] ?? 0n)
      .filter((reward) => reward > 0n);
  }

  const minimumPriority = configuredPriorityFeePerGas ?? parseGwei("0.05");
  const suggestedPriorityFeePerGas = maxBigInt(medianBigInt(prioritySamples), minimumPriority);
  const competitiveMaxFee =
    nextBaseFeePerGas !== undefined
      ? maxBigInt(nextBaseFeePerGas * 2n + suggestedPriorityFeePerGas, currentGasPrice + suggestedPriorityFeePerGas)
      : currentGasPrice + suggestedPriorityFeePerGas;

  const market: LiveFeeMarket = {
    currentGasPrice,
    suggestedPriorityFeePerGas,
    suggestedMaxFeePerGas: competitiveMaxFee,
  };

  if (latestBlock.baseFeePerGas !== null && latestBlock.baseFeePerGas !== undefined) {
    market.currentBaseFeePerGas = latestBlock.baseFeePerGas;
  }

  if (nextBaseFeePerGas !== undefined) {
    market.nextBaseFeePerGas = nextBaseFeePerGas;
  }

  return market;
}

async function resolveFeeEnvelope(
  client: RpcReadClient,
  target: TargetConfig,
  profile: WalletProfile,
  gasLimit: bigint,
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<FeeEnvelope> {
  const fees = target.fees;
  const presetDefaults = fees.preset ? feePresetDefaults[fees.preset] : undefined;
  const replacementMultiplier =
    replacementRound > 0 ? Math.pow(target.execution?.replaceMultiplier ?? 1.125, replacementRound) : 1;
  const walletMultiplier = profile.multiplier;
  const totalMultiplier = walletMultiplier * replacementMultiplier;
  const latestBlockBaseFeePerGas =
    liveFeeMarket?.currentBaseFeePerGas ?? (await client.getBlock()).baseFeePerGas ?? undefined;

  if (fees.type === "budgetAggressive") {
    const targetUsd = fees.targetUsd ?? presetDefaults?.targetUsd ?? 2.5;
    const assumedNativePriceUsd = fees.assumedNativePriceUsd;
    if (!assumedNativePriceUsd || assumedNativePriceUsd <= 0) {
      throw new Error("fees.assumedNativePriceUsd is required for budgetAggressive mode.");
    }

    const targetGasPriceGwei = (targetUsd / assumedNativePriceUsd) * 1_000_000_000 / Number(gasLimit);
    const floorGwei = fees.minFeeFloorGwei ?? presetDefaults?.minFeeFloorGwei ?? 0.5;
    const baseTargetGwei = Math.max(targetGasPriceGwei, floorGwei);
    const adjustedBudgetGwei = baseTargetGwei * totalMultiplier;
    const liveCompetitiveMaxFee = scaleBigInt(
      liveFeeMarket?.suggestedMaxFeePerGas ?? (await client.getGasPrice()),
      totalMultiplier,
    );
    const budgetMaxFee = parseGwei(adjustedBudgetGwei.toFixed(9));
    let maxFeePerGas = maxBigInt(budgetMaxFee, liveCompetitiveMaxFee);

    const maxFeeCapGwei = fees.maxFeeCapGwei ?? presetDefaults?.maxFeeCapGwei;
    if (maxFeeCapGwei !== undefined) {
      const explicitCap = parseGwei(String(maxFeeCapGwei));
      maxFeePerGas = maxFeePerGas > explicitCap ? explicitCap : maxFeePerGas;
    }

    const priorityFeeBase =
      fees.priorityFeeGwei !== undefined || presetDefaults?.priorityFeeGwei !== undefined
        ? parseGwei(String(fees.priorityFeeGwei ?? presetDefaults?.priorityFeeGwei))
        : maxBigInt(liveFeeMarket?.suggestedPriorityFeePerGas ?? 0n, parseGwei("0.05"));
    const scaledPriorityFee = scaleBigInt(scaleBigInt(priorityFeeBase, walletMultiplier), replacementMultiplier);

    if (latestBlockBaseFeePerGas == null) {
      return {
        type: "legacy",
        gasPrice: maxFeePerGas,
      };
    }

    return {
      type: "eip1559",
      maxPriorityFeePerGas: scaledPriorityFee > maxFeePerGas ? maxFeePerGas : scaledPriorityFee,
      maxFeePerGas,
    };
  }

  if (fees.type === "legacy" || latestBlockBaseFeePerGas == null) {
    const gasPrice =
      fees.gasPriceGwei !== undefined
        ? parseGwei(String(fees.gasPriceGwei))
        : liveFeeMarket?.currentGasPrice ?? (await client.getGasPrice());

    return {
      type: "legacy",
      gasPrice: scaleBigInt(gasPrice, totalMultiplier),
    };
  }

  const chainGasPrice = liveFeeMarket?.suggestedMaxFeePerGas ?? (await client.getGasPrice());
  const priorityFee =
    fees.priorityFeeGwei !== undefined
      ? parseGwei(String(fees.priorityFeeGwei))
      : liveFeeMarket?.suggestedPriorityFeePerGas ?? 1_000_000_000n;

  const maxFeeBase =
    fees.maxFeeGwei !== undefined
      ? parseGwei(String(fees.maxFeeGwei))
      : scaleBigInt(chainGasPrice, fees.maxFeeMultiplier ?? 1.6);

  return {
    type: "eip1559",
    maxPriorityFeePerGas: scaleBigInt(priorityFee, totalMultiplier),
    maxFeePerGas: scaleBigInt(maxFeeBase, totalMultiplier),
  };
}

async function createPreparedSend(
  client: RpcReadClient,
  target: TargetConfig,
  account: Account,
  profile: WalletProfile,
  nonceOverride?: number,
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<PreparedSend> {
  const contexts = await buildSigningContexts(client, target, [account], [profile], nonceOverride !== undefined ? [nonceOverride] : undefined);
  return createPreparedSendFromContext(client, target, contexts[0]!, liveFeeMarket, replacementRound);
}

async function buildSigningContexts(
  client: RpcReadClient,
  target: TargetConfig,
  accounts: Account[],
  profiles: WalletProfile[],
  nonceOverrides?: number[],
): Promise<SigningContext[]> {
  return Promise.all(
    accounts.map(async (account, index) => {
      const profile = profiles[index]!;
      const [payload, nonce] = await Promise.all([
        buildTransactionPayload(client, target, account.address, profile.index),
        nonceOverrides?.[index] !== undefined
          ? Promise.resolve(nonceOverrides[index]!)
          : client.getTransactionCount({
              address: account.address,
              blockTag: "pending",
            }),
      ]);
      const gasLimit = payload.gas ?? (() => {
        throw new Error(
          "transaction.gasLimit is required for competition mode so the bot can pre-sign before mint opens.",
        );
      })();

      return {
        account,
        profile,
        payload,
        nonce,
        gasLimit,
      };
    }),
  );
}

async function createPreparedSendFromContext(
  client: RpcReadClient,
  target: TargetConfig,
  context: SigningContext,
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<PreparedSend> {
  const feeEnvelope = await resolveFeeEnvelope(
    client,
    target,
    context.profile,
    context.gasLimit,
    liveFeeMarket,
    replacementRound,
  );
  if (!("signTransaction" in context.account) || typeof context.account.signTransaction !== "function") {
    throw new Error(`Wallet ${context.account.address} is not a local signing account.`);
  }
  const unsignedRequest = buildUnsignedRequest(
    context.payload,
    context.nonce,
    context.gasLimit,
    feeEnvelope,
    target.chain.id,
  );
  const serializedTransaction = await context.account.signTransaction(unsignedRequest);

  return {
    account: context.account,
    profile: context.profile,
    nonce: context.nonce,
    gas: context.gasLimit,
    serializedTransaction,
    transactionHash: keccak256(serializedTransaction),
  };
}

async function prepareSends(
  client: RpcReadClient,
  target: TargetConfig,
  accounts: Account[],
  profiles: WalletProfile[],
  nonceOverrides?: number[],
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<PreparedSend[]> {
  const contexts = await buildSigningContexts(client, target, accounts, profiles, nonceOverrides);
  return Promise.all(
    contexts.map((context) => createPreparedSendFromContext(client, target, context, liveFeeMarket, replacementRound)),
  );
}

async function buildPreparedLaddersFromContexts(
  client: RpcReadClient,
  target: TargetConfig,
  signingContexts: SigningContext[],
  replacementRounds: number,
  liveFeeMarket?: LiveFeeMarket,
): Promise<PreparedLadders> {
  const sampledLiveFeeMarket =
    liveFeeMarket ??
    (await sampleLiveFeeMarket(
      client,
      target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
    ));
  emitTelemetrySafe("live_fee_market", sampledLiveFeeMarket);
  const ladders = await Promise.all(
    signingContexts.map(async (context) => {
      const prepared = await Promise.all(
        Array.from({ length: replacementRounds + 1 }, (_, round) =>
          createPreparedSendFromContext(client, target, context, sampledLiveFeeMarket, round),
        ),
      );
      return [context.profile.index, prepared] as const;
    }),
  );

  return new Map(ladders);
}

async function buildPreparedLadders(
  client: RpcReadClient,
  target: TargetConfig,
  accounts: Account[],
  profiles: WalletProfile[],
  replacementRounds: number,
): Promise<PreparedLadders> {
  const signingContexts = await buildSigningContexts(client, target, accounts, profiles);
  return buildPreparedLaddersFromContexts(client, target, signingContexts, replacementRounds);
}

async function warmBroadcastEndpoints(target: TargetConfig): Promise<string[]> {
  const rounds = Math.max(0, target.execution?.warmupRounds ?? 1);
  const delayMs = Math.max(0, target.execution?.warmupDelayMs ?? 100);
  if (rounds === 0) return target.chain.rpc.broadcastHttp;

  let rankedEndpoints = target.chain.rpc.broadcastHttp;

  for (let round = 0; round < rounds; round += 1) {
    const health = await Promise.all(target.chain.rpc.broadcastHttp.map((endpoint) => probeEndpoint(endpoint)));
    rankedEndpoints = rankHealthyEndpoints(health, target.chain.rpc.broadcastHttp);
    logger.info(`Broadcast warmup round ${round + 1}.`, {
      rankedEndpoints,
      probes: health,
    });
    emitTelemetrySafe("broadcast_warmup_round", {
      round: round + 1,
      rankedEndpoints,
      probes: health,
    });

    if (round < rounds - 1) {
      await sleep(delayMs);
    }
  }

  return rankedEndpoints;
}

async function waitForAnyReceiptOutcome(
  client: RpcReadClient,
  hashes: Hex[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ReceiptOutcome> {
  const uniqueHashes = Array.from(new Set(hashes));
  const started = Date.now();
  const fallbackHash = uniqueHashes[uniqueHashes.length - 1]!;

  while (Date.now() - started < timeoutMs) {
    for (const hash of uniqueHashes) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status === "success" ? "success" : "reverted",
          hash,
        };
      } catch {
        // Keep scanning known replacement hashes until one is mined.
      }
    }

    await sleep(pollIntervalMs);
  }

  return {
    status: "pending",
    hash: fallbackHash,
  };
}

async function runStatusCore(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const client = createRpcMesh(target);
  await client.refreshRanking();

  logger.info("Wallets loaded.", {
    count: accounts.length,
    addresses: accounts.map((account) => account.address),
  });

  const block = await client.getBlockNumber();
  logger.info(`Connected to ${target.chain.name}.`, { block: block.toString() });
  const clockCalibration = await calibrateClock([
    target.chain.rpc.primaryHttp,
    ...target.chain.rpc.broadcastHttp,
  ]);
  await logClockStatusWithCalibration(target, client, clockCalibration);

  const probes = await Promise.all(target.chain.rpc.broadcastHttp.map((endpoint) => probeEndpoint(endpoint)));
  const rankedEndpoints = rankHealthyEndpoints(probes, target.chain.rpc.broadcastHttp);
  logger.info("Broadcast endpoint health.", {
    rankedEndpoints,
    probes,
    telemetryPath: getTelemetryPath(),
  });
  emitTelemetrySafe("status", {
    chain: target.chain.name,
    rankedEndpoints,
    probes,
    clockCalibration,
  });
}

async function logLightRuntimeContext(
  target: TargetConfig,
  client: RpcReadClient,
  accounts: Account[],
): Promise<void> {
  const block = await client.getBlockNumber();
  logger.info("Runtime context.", {
    chain: target.chain.name,
    block: block.toString(),
    walletCount: accounts.length,
    addresses: accounts.map((account) => account.address),
  });
}

async function collectValidationReport(
  target: TargetConfig,
  client: RpcReadClient,
  accounts: Account[],
  profiles: WalletProfile[],
): Promise<ValidationReport> {
  const results: ValidationItem[] = [];

  const chainId = await client.getChainId();
  pushValidation(
    results,
    "Chain ID",
    chainId === target.chain.id,
    `RPC chainId=${chainId}, target chainId=${target.chain.id}`,
  );

  const endpointHealth = await Promise.all(target.chain.rpc.broadcastHttp.map((endpoint) => pingEndpoint(endpoint)));
  const healthyEndpoints = endpointHealth.filter((item) => item.ok).length;
  const requiredHealthyBroadcastRpc = Math.min(
    endpointHealth.length,
    Math.max(1, target.execution?.minHealthyBroadcastRpc ?? (endpointHealth.length > 1 ? 2 : 1)),
  );
  pushValidation(
    results,
    "Broadcast RPCs",
    healthyEndpoints >= requiredHealthyBroadcastRpc,
    `${healthyEndpoints}/${endpointHealth.length} endpoints responded successfully (required ${requiredHealthyBroadcastRpc})`,
  );

  const readProbeEndpoints = Array.from(
    new Set([target.chain.rpc.primaryHttp, ...(target.chain.rpc.readHttp ?? [])]),
  );
  const readEndpointHealth = await Promise.all(readProbeEndpoints.map((endpoint) => pingEndpoint(endpoint)));
  const healthyReadEndpoints = readEndpointHealth.filter((item) => item.ok).length;
  const requiredHealthyReadRpc = Math.min(
    readProbeEndpoints.length,
    Math.max(1, target.execution?.minHealthyReadRpc ?? Math.min(2, readProbeEndpoints.length)),
  );
  pushValidation(
    results,
    "Read RPCs",
    healthyReadEndpoints >= requiredHealthyReadRpc,
    `${healthyReadEndpoints}/${readProbeEndpoints.length} read endpoints responded successfully (required ${requiredHealthyReadRpc})`,
    "risk",
  );

  if (target.trigger.mode === "time") {
    const clockCalibration = await calibrateClock([
      target.chain.rpc.primaryHttp,
      ...target.chain.rpc.broadcastHttp,
    ]);
    const schedule = getTimeTriggerConfig(target);
    const startAt = new Date(target.trigger.startTimeIso).getTime();
    const remainingMs = startAt - clockCalibration.nowMs();
    pushValidation(
      results,
      "Mint schedule",
      Number.isFinite(startAt) && remainingMs > 0,
      Number.isFinite(startAt)
        ? `Mint opens at ${new Date(startAt).toISOString()} (${remainingMs} ms from now)`
        : "trigger.startTimeIso tidak valid",
    );
    if (schedule && schedule.repriceBeforeMs !== null) {
      pushValidation(
        results,
        "Timed reprice window",
        schedule.repriceAtMs !== null,
        schedule.repriceAtMs !== null
          ? `Final reprice scheduled ${schedule.repriceBeforeMs} ms before mint open with effective armBeforeMs=${schedule.armBeforeMs} ms.`
          : `repriceBeforeMs=${schedule.repriceBeforeMs} ms is too tight even after adaptive armBeforeMs=${schedule.armBeforeMs} ms and finalSpinWindowMs=${schedule.finalSpinWindowMs} ms.`,
        "risk",
      );
    }
    if (schedule) {
      pushValidation(
        results,
        "Adaptive arm buffer",
        schedule.armBeforeMs >= schedule.recommendedArmBeforeMs,
        `configured=${schedule.configuredArmBeforeMs} ms, effective=${schedule.armBeforeMs} ms, recommended=${schedule.recommendedArmBeforeMs} ms, estimatedPrepBudget=${schedule.prepBudgetMs} ms`,
        "risk",
      );
    }
    pushValidation(
      results,
      "Clock calibration",
      clockCalibration.sampleCount > 0 && Math.abs(clockCalibration.observedOffsetMs) <= 5000,
      `appliedOffset=${clockCalibration.offsetMs} ms, observedOffset=${clockCalibration.observedOffsetMs} ms, confidence=${clockCalibration.confidence}, samples=${clockCalibration.sampleCount}, source=${clockCalibration.source}, medianLatency=${clockCalibration.medianLatencyMs} ms`,
      "risk",
    );
  }

  if (!target.transaction.gasLimit) {
    pushValidation(
      results,
      "Gas limit",
      false,
      "transaction.gasLimit belum diisi. Untuk mode kompetisi dan pre-sign sebelum mint buka, ini wajib diisi manual.",
    );
  } else {
    pushValidation(results, "Gas limit", true, `Configured gasLimit=${target.transaction.gasLimit}`);
  }

  if (target.fees.type === "budgetAggressive") {
    const hasPriceAssumption = Boolean(target.fees.assumedNativePriceUsd && target.fees.assumedNativePriceUsd > 0);
    pushValidation(
      results,
      "USD fee budget",
      hasPriceAssumption,
      hasPriceAssumption
        ? `Target fee around $${target.fees.targetUsd ?? 2.5} with native price assumption $${target.fees.assumedNativePriceUsd}`
        : "fees.assumedNativePriceUsd wajib diisi untuk budgetAggressive",
    );
  }

  const latestNonceChecks = await Promise.all(
    accounts.map(async (account) => ({
      address: account.address,
      latestNonce: await client.getTransactionCount({
        address: account.address,
        blockTag: "latest",
      }),
      pendingNonce: await client.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
    })),
  );

  for (const nonceCheck of latestNonceChecks) {
    pushValidation(
      results,
      `Pending nonce ${nonceCheck.address.slice(0, 8)}`,
      nonceCheck.pendingNonce === nonceCheck.latestNonce,
      `latest=${nonceCheck.latestNonce}, pending=${nonceCheck.pendingNonce}`,
      "risk",
    );
  }

  const balanceChecks = await Promise.all(
    accounts.map(async (account) => ({
      address: account.address,
      balance: await client.getBalance({ address: account.address }),
    })),
  );

  for (const balance of balanceChecks) {
    pushValidation(
      results,
      `Wallet ${balance.address.slice(0, 8)}`,
      balance.balance > 0n,
      `Balance ${formatEther(balance.balance)} ${target.chain.nativeCurrency.symbol}`,
    );
  }

  const sampleAccount = accounts[0]!;
  const sampleProfile = profiles[0]!;
  const payload = await buildTransactionPayload(client, target, sampleAccount.address, sampleProfile.index);
  const gasLimit = payload.gas;

  const contractBytecode = await client.getBytecode({ address: payload.to });
  pushValidation(
    results,
    "Target contract code",
    Boolean(contractBytecode && contractBytecode !== "0x"),
    contractBytecode && contractBytecode !== "0x"
      ? `Code found at ${payload.to}`
      : `No contract bytecode found at ${payload.to}. This target will not mint.`,
  );

  if (gasLimit) {
    const latestBlock = await client.getBlock();
    const liveFeeMarket = await sampleLiveFeeMarket(
      client,
      target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
    );
    const currentGasPrice = liveFeeMarket.currentGasPrice;
    const sampleFee = await resolveFeeEnvelope(client, target, sampleProfile, gasLimit, liveFeeMarket, 0);
    const estimatedCost = estimateCostNative(gasLimit, sampleFee);
    const totalRequired = estimatedCost + payload.value;
    const feeText =
      sampleFee.type === "eip1559"
        ? `maxFee=${formatGweiValue(sampleFee.maxFeePerGas)}, priority=${formatGweiValue(sampleFee.maxPriorityFeePerGas)}`
        : `gasPrice=${formatGweiValue(sampleFee.gasPrice)}`;

    pushValidation(
      results,
      "Fee preview",
      true,
      `${feeText}, estimated max gas cost=${formatEther(estimatedCost)} ${target.chain.nativeCurrency.symbol}, tx value=${formatEther(payload.value)} ${target.chain.nativeCurrency.symbol}`,
    );

    pushValidation(
      results,
      "Wallet balance sufficiency",
      balanceChecks.every((item) => item.balance >= totalRequired),
      `Required per wallet about ${formatEther(totalRequired)} ${target.chain.nativeCurrency.symbol}`,
    );

    const feeCompetitive =
      sampleFee.type === "eip1559"
        ? sampleFee.maxFeePerGas >= currentGasPrice &&
          (latestBlock.baseFeePerGas == null || sampleFee.maxFeePerGas >= latestBlock.baseFeePerGas)
        : sampleFee.gasPrice >= currentGasPrice;

    pushValidation(
      results,
      "Fee competitiveness now",
      feeCompetitive,
      sampleFee.type === "eip1559"
        ? `Current gasPrice=${formatGweiValue(currentGasPrice)}, block baseFee=${formatGweiValue(latestBlock.baseFeePerGas ?? 0n)}, nextBaseFee=${formatGweiValue(liveFeeMarket.nextBaseFeePerGas ?? 0n)}, configured maxFee=${formatGweiValue(sampleFee.maxFeePerGas)}`
        : `Current gasPrice=${formatGweiValue(currentGasPrice)}, configured gasPrice=${formatGweiValue(sampleFee.gasPrice)}`,
      "risk",
    );

    try {
      const estimate = await client.estimateGas({
        account: sampleAccount.address,
        to: payload.to,
        data: payload.data,
        value: payload.value,
      });

      pushValidation(
        results,
        "Gas estimate simulation",
        gasLimit >= estimate,
        `estimateGas=${estimate.toString()}, configured gasLimit=${gasLimit.toString()}`,
      );
    } catch (error) {
      if (isLikelyPreOpenRevert(target, error)) {
        pushValidation(
          results,
          "Gas estimate simulation",
          true,
          `Deferred because this future time-gated mint reverts before open. configured gasLimit=${gasLimit.toString()}`,
          "risk",
        );
      } else {
        pushValidation(
          results,
          "Gas estimate simulation",
          false,
          `estimateGas failed: ${describeError(error)}`,
        );
      }
    }

    try {
      await client.call({
        account: sampleAccount.address,
        to: payload.to,
        data: payload.data,
        value: payload.value,
      });

      pushValidation(
        results,
        "eth_call simulation",
        true,
        "eth_call completed without revert at current state.",
      );
    } catch (error) {
      if (isLikelyPreOpenRevert(target, error)) {
        pushValidation(
          results,
          "eth_call simulation",
          true,
          "Deferred because the mint is time-gated and is expected to revert before open.",
          "risk",
        );
      } else {
        pushValidation(
          results,
          "eth_call simulation",
          false,
          `eth_call failed: ${describeError(error)}`,
        );
      }
    }
  }

  try {
    const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
    const ladders = await buildPreparedLadders(client, target, accounts, profiles, replacementRounds);
    const prepared = Array.from(ladders.values()).flat();
    pushValidation(
      results,
      "Local pre-sign ladder",
      prepared.length === accounts.length * (replacementRounds + 1),
      `Signed ${prepared.length} transaction(s) locally across ${replacementRounds + 1} round(s) without broadcast.`,
    );
  } catch (error) {
    pushValidation(
      results,
      "Local pre-sign ladder",
      false,
      `Failed to prepare/sign locally: ${describeError(error)}`,
    );
  }

  return {
    results,
    readiness: summarizeReadiness(results),
  };
}

function logValidationReport(report: ValidationReport): void {
  logger.info("Preflight validation summary.", {
    readiness: report.readiness,
    telemetryPath: getTelemetryPath(),
    results: report.results,
  });
}

export async function runStatus(target: TargetConfig): Promise<void> {
  await withRpcOperationRetries(target, "Status", () => runStatusCore(target));
}

export async function runValidate(target: TargetConfig): Promise<void> {
  const report = await withRpcOperationRetries(target, "Validate", async () => {
    const accounts = loadAccounts(target.execution?.walletCount ?? 5);
    const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
    const client = createRpcMesh(target);
    await client.refreshRanking();
    return collectValidationReport(target, client, accounts, profiles);
  });

  logValidationReport(report);

  if (report.readiness === "READY") {
    logger.success("Validation passed. Bot is ready for armed standby.");
    return;
  }

  if (report.readiness === "RISKY") {
    logger.warn("Validation is risky. The bot can run, but you should fix the warnings before the competition.");
    return;
  }

  logger.warn("Validation is blocked. Fix the blocking issues before the competition.");
  throw new Error("Validation is BLOCKED. Refusing to report this target as runnable.");
}

export async function runStandby(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client = createRpcMesh(target);
  await withRpcOperationRetries(target, "Standby RPC ranking", () => client.refreshRanking());
  const preflightReport = await withRpcOperationRetries(target, "Standby safety gate", () =>
    collectValidationReport(target, client, accounts, profiles),
  );
  logValidationReport(preflightReport);
  if (preflightReport.readiness === "BLOCKED") {
    throw new Error("Standby safety gate is BLOCKED. Refusing to arm until the blocking issues are fixed.");
  }

  if (preflightReport.readiness === "RISKY" && !target.execution?.allowRiskyStandby) {
    throw new Error(
      "Standby safety gate is RISKY. Set execution.allowRiskyStandby=true only if you intentionally accept the warnings.",
    );
  }

  const clockCalibration = await calibrateClock([
    target.chain.rpc.primaryHttp,
    ...target.chain.rpc.broadcastHttp,
    ...(target.chain.rpc.readHttp ?? []),
  ]);

  logger.info("Standby safety gate passed. Bot can arm when the trigger is ready.", {
    readiness: preflightReport.readiness,
    failedChecks: preflightReport.results.filter((item) => !item.ok),
  });
  const timeSchedule = getTimeTriggerConfig(target);

  if (timeSchedule) {
    const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
    logger.info("Timed standby active. Bot will arm before mint opens.");
    if (timeSchedule.armBeforeMs > timeSchedule.configuredArmBeforeMs) {
      logger.info("Adaptive arm buffer expanded the prep window for this target.", {
        configuredArmBeforeMs: timeSchedule.configuredArmBeforeMs,
        effectiveArmBeforeMs: timeSchedule.armBeforeMs,
        recommendedArmBeforeMs: timeSchedule.recommendedArmBeforeMs,
        estimatedPrepBudgetMs: timeSchedule.prepBudgetMs,
      });
    }
    await waitForArmWindow(target, clockCalibration);
    const [, refreshedClockCalibration] = await Promise.all([
      withRpcOperationRetries(target, "Standby arm RPC ranking", () => client.refreshRanking()),
      calibrateClock([
        target.chain.rpc.primaryHttp,
        ...target.chain.rpc.broadcastHttp,
        ...(target.chain.rpc.readHttp ?? []),
      ]),
    ]);
    logger.info("Arming timed fire. Preparing signed replacement ladder now.");
    emitTelemetrySafe("timed_arm", {
      initialClockOffsetMs: clockCalibration.offsetMs,
      refreshedClockOffsetMs: refreshedClockCalibration.offsetMs,
    });
    const signingContextStartedAt = hrtime.bigint();
    const signingContexts = await withRpcOperationRetries(target, "Standby signing context build", () =>
      buildSigningContexts(client, target, accounts, profiles),
    );
    const signingContextBuildMs = elapsedMs(signingContextStartedAt);
    const initialLadderStartedAt = hrtime.bigint();
    const [rankedEndpoints, initialLadders, privateRelaySubmitter] = await Promise.all([
      warmBroadcastEndpoints(target),
      withRpcOperationRetries(target, "Standby ladder build", () =>
        buildPreparedLaddersFromContexts(client, target, signingContexts, replacementRounds),
      ),
      createPrivateRelaySubmitter(target).catch((error) => {
        logger.warn("Private relay setup failed. Continuing with public RPC broadcast only.", {
          error: describeError(error),
        });
        return null;
      }),
    ]);
    const initialLadderBuildMs = elapsedMs(initialLadderStartedAt);
    let ladders = initialLadders;
    let fireCalibration = refreshedClockCalibration;

    if (timeSchedule.repriceAtMs !== null) {
      const repriceSafetyBufferMs = Math.max(
        timeSchedule.finalSpinWindowMs + 25,
        Math.ceil(initialLadderBuildMs) + 400,
      );
      const latestSafeRepriceAtMs = timeSchedule.startAtMs - repriceSafetyBufferMs;
      const effectiveRepriceAtMs = Math.min(timeSchedule.repriceAtMs, latestSafeRepriceAtMs);
      const remainingUntilRepriceMs = effectiveRepriceAtMs - fireCalibration.nowMs();
      if (remainingUntilRepriceMs > 0) {
        logger.info("Initial ladder prepared. Final fee refresh is scheduled before fire.", {
          repriceBeforeMs: timeSchedule.repriceBeforeMs,
          repriceAtIso: new Date(effectiveRepriceAtMs).toISOString(),
          configuredRepriceAtIso: new Date(timeSchedule.repriceAtMs).toISOString(),
          remainingUntilRepriceMs,
          signingContextBuildMs,
          initialLadderBuildMs,
          repriceSafetyBufferMs,
        });
        await waitForTimedCheckpoint(
          target,
          effectiveRepriceAtMs,
          "Final fee refresh window",
          fireCalibration,
          true,
        );
        const [, finalRepriceCalibration] = await Promise.all([
          withRpcOperationRetries(target, "Standby final reprice ranking", () => client.refreshRanking()),
          calibrateClock([
            target.chain.rpc.primaryHttp,
            ...target.chain.rpc.broadcastHttp,
            ...(target.chain.rpc.readHttp ?? []),
          ]),
        ]);
        const remainingAfterMaintenanceMs = timeSchedule.startAtMs - finalRepriceCalibration.nowMs();

        if (remainingAfterMaintenanceMs <= repriceSafetyBufferMs) {
          logger.warn("Skipping final reprice because it would eat the fire window. Keeping the initial ladder.", {
            remainingAfterMaintenanceMs,
            repriceSafetyBufferMs,
            configuredRepriceBeforeMs: timeSchedule.repriceBeforeMs,
          });
          emitTelemetrySafe("timed_reprice_skipped_for_deadline", {
            remainingAfterMaintenanceMs,
            repriceSafetyBufferMs,
            configuredRepriceBeforeMs: timeSchedule.repriceBeforeMs,
          });
        } else {
          logger.info("Refreshing live fee market and re-signing ladder close to mint open.");
          const repriceStartedAt = hrtime.bigint();
          try {
            ladders = await withRpcOperationRetries(target, "Standby final reprice", () =>
              buildPreparedLaddersFromContexts(client, target, signingContexts, replacementRounds),
            );
            fireCalibration = finalRepriceCalibration;
            emitTelemetrySafe("timed_reprice_success", {
              repriceBeforeMs: timeSchedule.repriceBeforeMs,
              finalClockOffsetMs: finalRepriceCalibration.offsetMs,
              finalObservedClockOffsetMs: finalRepriceCalibration.observedOffsetMs,
              finalClockConfidence: finalRepriceCalibration.confidence,
              finalRepriceDurationMs: elapsedMs(repriceStartedAt),
            });
          } catch (error) {
            logger.warn("Final reprice failed. Keeping the initial signed ladder.", {
              error: describeError(error),
            });
            emitTelemetrySafe("timed_reprice_failed", {
              repriceBeforeMs: timeSchedule.repriceBeforeMs,
              error: describeError(error),
            });
          }
        }
      } else {
        logger.warn("Final fee refresh window already passed. Using the initial ladder.", {
          repriceBeforeMs: timeSchedule.repriceBeforeMs,
          remainingUntilRepriceMs,
        });
      }
    }

    const prepared = Array.from(ladders.values()).map((ladder) => ladder[0]!);
    const fireTiming = await waitForPreciseFireWindow(target, fireCalibration);
    await executePreparedRounds(
      target,
      client,
      prepared,
      ladders,
      rankedEndpoints,
      privateRelaySubmitter ?? undefined,
      fireTiming ?? undefined,
      fireCalibration,
    );
    return;
  }

  logger.info("Standby active. Waiting for trigger.");
  await waitForTrigger(target, client, clockCalibration);
  await runFire(target, client);
}

export async function runRehearse(target: TargetConfig): Promise<void> {
  await withRpcOperationRetries(target, "Rehearsal", async () => {
    const accounts = loadAccounts(target.execution?.walletCount ?? 5);
    const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
    const client = createRpcMesh(target);
    await client.refreshRanking();
    const replacementRounds = target.execution?.maxReplacementRounds ?? 3;

    await logLightRuntimeContext(target, client, accounts);
    logger.info("Preparing rehearsal ladder without broadcasting.");
    const [ladders, rankedEndpoints] = await Promise.all([
      buildPreparedLadders(client, target, accounts, profiles, replacementRounds),
      warmBroadcastEndpoints(target),
    ]);

    const summary = Array.from(ladders.values()).map((ladder) => ({
      wallet: ladder[0]!.account.address,
      nonce: ladder[0]!.nonce,
      rounds: ladder.map((send, index) => ({
        round: index + 1,
        profile: send.profile.label,
        hash: send.transactionHash,
      })),
    }));

    logger.success("Rehearsal complete. Fire path can pre-sign all rounds.", summary);
    emitTelemetrySafe("rehearsal_complete", {
      rankedEndpoints,
      summary,
    });
  });
}

async function executePreparedRounds(
  target: TargetConfig,
  client: RpcReadClient,
  initialPrepared: PreparedSend[],
  preSignedLadders?: PreparedLadders,
  broadcastEndpoints?: string[],
  privateRelaySubmitter?: PrivateRelaySubmitter,
  fireTiming?: { targetMs: number; releasedAtMs: number; overshootMs: number },
  fireCalibration?: ClockCalibration,
): Promise<void> {
  let prepared = initialPrepared;
  let bestHashes = new Map<number, Hex>();
  const hashHistory = new Map<number, Set<Hex>>();
  const bestSends = new Map<number, PreparedSend>(
    initialPrepared.map((send) => [send.profile.index, send]),
  );
  const replacementDelay = target.execution?.replaceAfterMs ?? 4000;
  const receiptPollIntervalMs = getReceiptPollIntervalMs(target);
  const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
  const receiptTimeout = target.execution?.receiptTimeoutMs ?? getDefaultReceiptTimeoutMs();
  const terminalStates = new Map<number, ReceiptOutcome>();
  const verificationStates = new Map<number, VerificationResult | null>();
  const activeBroadcastEndpoints = broadcastEndpoints ?? target.chain.rpc.broadcastHttp;
  const broadcastBurstSchedule = getBroadcastBurstSchedule(target);

  function recordHash(walletIndex: number, hash: Hex): void {
    const history = hashHistory.get(walletIndex) ?? new Set<Hex>();
    history.add(hash);
    hashHistory.set(walletIndex, history);
    bestHashes.set(walletIndex, hash);
  }

  async function verifyConfirmedWallets(
    confirmed: Array<{ send: PreparedSend; outcome: ReceiptOutcome }>,
  ): Promise<Array<{ wallet: Hex; profile: string; verification: VerificationResult | null }>> {
    const verificationResults = await Promise.all(
      confirmed.map(async (item) => ({
        wallet: item.send.account.address,
        profile: item.send.profile.label,
        verification: await runPostMintVerification(target, client, item.send.account, item.send.profile).catch(
          (error) => ({
            ok: false,
            details: describeError(error),
          }),
        ),
      })),
    );

    for (const item of confirmed) {
      const result = verificationResults.find((verification) => verification.profile === item.send.profile.label);
      if (result) {
        verificationStates.set(item.send.profile.index, result.verification);
      }
    }

    return verificationResults;
  }

  for (let round = 0; round <= replacementRounds; round += 1) {
    if (prepared.length === 0) {
      break;
    }

    const broadcastStartedAtMs = fireCalibration?.nowMs() ?? Date.now();
    const broadcastStartedAtNs = hrtime.bigint();
    const publicBroadcastPromise = Promise.all(
      prepared.map(async (send) => {
        for (const followupDelayMs of broadcastBurstSchedule.slice(1)) {
          if (followupDelayMs <= 0) continue;
          void (async () => {
            await sleep(followupDelayMs);
            await broadcastSignedTransaction(activeBroadcastEndpoints, send.serializedTransaction);
          })().catch(() => {
            // Burst rebroadcast is best-effort; the first accepted hash is enough for tracking.
          });
        }

        const results = await broadcastSignedTransaction(activeBroadcastEndpoints, send.serializedTransaction);
        const winner = results.find((item) => item.ok && item.hash);
        const inferredHash =
          winner?.hash ??
          (results.some((item) => isLikelyPropagatedError(item.error)) ? send.transactionHash : undefined);
        return { send, results, inferredHash };
      }),
    );

    logger.info(`Broadcast round ${round + 1} started.`, {
      walletCount: prepared.length,
      ...(round === 0 && fireTiming
        ? {
            targetOpenToWaitReleaseMs: roundNumber(fireTiming.overshootMs, 3),
            targetOpenToBroadcastStartMs: roundNumber(broadcastStartedAtMs - fireTiming.targetMs, 3),
            waitReleaseToBroadcastStartMs: roundNumber(broadcastStartedAtMs - fireTiming.releasedAtMs, 3),
          }
        : {}),
    });

    if (privateRelaySubmitter?.enabled) {
      const relayTransactions = prepared.map((send) => send.serializedTransaction);
      void privateRelaySubmitter
        .submitRound(relayTransactions)
        .then((privateRelayResults) => {
          logger.info(`Private relay round ${round + 1} submitted.`, {
            okCount: privateRelayResults.filter((item) => item.ok).length,
            errorCount: privateRelayResults.filter((item) => !item.ok).length,
            results: privateRelayResults.map((item) => ({
              ok: item.ok,
              relay: item.relay,
              hash: item.hash,
              targetBlockNumber: item.targetBlockNumber,
              error: item.error,
            })),
          });
          emitTelemetrySafe("private_relay_round", {
            round: round + 1,
            privateRelayResults,
          });
        })
        .catch((error) => {
          logger.warn(`Private relay round ${round + 1} failed in background.`, {
            error: describeError(error),
          });
          emitTelemetrySafe("private_relay_round_failed", {
            round: round + 1,
            error: describeError(error),
          });
        });
    }

    const perWalletResults = await publicBroadcastPromise;

    const broadcastSummaries = perWalletResults.map((item) => summarizeBroadcastResults(item.send, item.results));
    const broadcastDurationMs = elapsedMs(broadcastStartedAtNs);
    for (const item of perWalletResults) {
      recordHash(item.send.profile.index, item.inferredHash ?? item.send.transactionHash);
      bestSends.set(item.send.profile.index, item.send);
    }
    logger.info(`Broadcast round ${round + 1} results.`, {
      durationMs: roundNumber(broadcastDurationMs, 3),
      burstScheduleMs: broadcastBurstSchedule,
      wallets: broadcastSummaries,
    });

    emitTelemetrySafe("broadcast_round", {
      round: round + 1,
      activeBroadcastEndpoints,
      durationMs: broadcastDurationMs,
      burstScheduleMs: broadcastBurstSchedule,
      fireTiming:
        round === 0 && fireTiming
          ? {
              ...fireTiming,
              targetOpenToBroadcastStartMs: broadcastStartedAtMs - fireTiming.targetMs,
              waitReleaseToBroadcastStartMs: broadcastStartedAtMs - fireTiming.releasedAtMs,
            }
          : undefined,
      perWalletResults: broadcastSummaries,
    });

    const receiptChecks = await Promise.all(
      prepared.map(async (send) => {
        const hashes = Array.from(hashHistory.get(send.profile.index) ?? new Set([send.transactionHash]));
        return {
          send,
          outcome: await waitForAnyReceiptOutcome(
            client,
            hashes,
            Math.min(replacementDelay, receiptTimeout),
            receiptPollIntervalMs,
          ),
        };
      }),
    );

    const confirmedSuccess = receiptChecks.filter((item) => item.outcome.status === "success");
    const reverted = receiptChecks.filter((item) => item.outcome.status === "reverted");
    const pending = receiptChecks.filter((item) => item.outcome.status === "pending");

    for (const item of [...confirmedSuccess, ...reverted]) {
      terminalStates.set(item.send.profile.index, item.outcome);
    }

    if (confirmedSuccess.length > 0) {
      const verificationResults = await verifyConfirmedWallets(confirmedSuccess);
      logger.success("Some wallets confirmed successfully. Pending wallets will keep racing.", {
        confirmedWallets: confirmedSuccess.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
        verificationResults,
        revertedWallets: reverted.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
        pendingWallets: pending.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
      });
      emitTelemetrySafe("mint_success", {
        confirmedWallets: confirmedSuccess.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
        verificationResults,
        revertedWallets: reverted.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
        pendingWallets: pending.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
      });
    }

    if (reverted.length > 0) {
      logger.warn("Some wallets reverted and will not be retried.", {
        revertedWallets: reverted.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
      });
      emitTelemetrySafe("wallets_reverted", {
        revertedWallets: reverted.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
      });
    }

    if (round === replacementRounds) {
      break;
    }

    if (pending.length === 0) {
      break;
    }

    logger.warn("No confirmation yet. Repricing and replacing pending transactions.");
    if (preSignedLadders) {
      const nextPrepared = pending
        .map((item) => ({
          previous: item,
          next: preSignedLadders.get(item.send.profile.index)?.[round + 1],
        }));
      const missingReplacement = nextPrepared.filter((item) => item.next === undefined);
      if (missingReplacement.length > 0) {
        logger.warn("Some pending wallets have no pre-signed replacement left.", {
          wallets: missingReplacement.map((item) => ({
            wallet: item.previous.send.account.address,
            profile: item.previous.send.profile.label,
            hash: item.previous.outcome.hash,
          })),
        });
      }
      prepared = nextPrepared
        .map((item) => item.next)
        .filter((item): item is PreparedSend => item !== undefined);
      for (const send of prepared) {
        bestSends.set(send.profile.index, send);
      }
      continue;
    }

    const liveFeeMarket = await sampleLiveFeeMarket(
      client,
      target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
    );
    prepared = await Promise.all(
      pending.map((item) =>
        createPreparedSend(
          client,
          target,
          item.send.account,
          item.send.profile,
          item.send.nonce,
          liveFeeMarket,
          round + 1,
        ),
      ),
    );
    for (const send of prepared) {
      bestSends.set(send.profile.index, send);
    }
  }

  const finalChecks = await Promise.all(
    Array.from(hashHistory.entries()).map(async ([walletIndex, hashes]) => {
      const hashList = Array.from(hashes);
      const fallbackHash = bestHashes.get(walletIndex) ?? hashList[hashList.length - 1]!;
      return {
        walletIndex,
        hash: fallbackHash,
        outcome:
          terminalStates.get(walletIndex) ??
          (await waitForAnyReceiptOutcome(client, hashList, receiptTimeout, receiptPollIntervalMs)),
      };
    }),
  );

  const lateSuccess = finalChecks.filter((item) => item.outcome.status === "success");
  if (lateSuccess.length > 0) {
    const lateVerificationResults = await Promise.all(
      lateSuccess.map(async (item) => {
        const matched = bestSends.get(item.walletIndex);
        if (!matched) {
          return {
            walletIndex: item.walletIndex,
            verification: null,
          };
        }

        return {
          walletIndex: item.walletIndex,
          verification:
            verificationStates.get(item.walletIndex) ??
            (await runPostMintVerification(target, client, matched.account, matched.profile).catch((error) => ({
              ok: false,
              details: describeError(error),
            }))),
        };
      }),
    );
    logger.success("Fire sequence completed with confirmed wallet outcomes.", {
      finalChecks,
      verificationResults: lateVerificationResults,
    });
    emitTelemetrySafe("fire_confirmed_late", {
      finalChecks,
      verificationResults: lateVerificationResults,
    });
    return;
  }

  logger.warn("Fire sequence finished without an early confirmation.", finalChecks);
  logger.info("If receipts are still pending, check explorer or rerun with a more aggressive fee config.");
  emitTelemetrySafe("fire_finished_without_early_confirmation", finalChecks);
}

export async function runFire(target: TargetConfig, providedClient?: RpcReadClient): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client = providedClient ?? createRpcMesh(target);
  if ("refreshRanking" in client && typeof client.refreshRanking === "function") {
    await client.refreshRanking();
  }

  logger.info("Preparing signed transactions.");
  const [signingContexts, liveFeeMarket, rankedEndpoints, privateRelaySubmitter] = await Promise.all([
    buildSigningContexts(client, target, accounts, profiles),
    sampleLiveFeeMarket(
      client,
      target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
    ),
    warmBroadcastEndpoints(target),
    createPrivateRelaySubmitter(target).catch((error) => {
      logger.warn("Private relay setup failed. Continuing with public RPC broadcast only.", {
        error: describeError(error),
      });
      return null;
    }),
  ]);
  const prepared = await Promise.all(
    signingContexts.map((context) => createPreparedSendFromContext(client, target, context, liveFeeMarket)),
  );
  await executePreparedRounds(target, client, prepared, undefined, rankedEndpoints, privateRelaySubmitter ?? undefined);
}
