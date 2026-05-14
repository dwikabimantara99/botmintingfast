import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  keccak256,
  parseGwei,
  type AccessList,
  type Account,
  type Hex,
  type PublicClient,
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
import { broadcastSignedTransaction, pingEndpoint, probeEndpoint, rankHealthyEndpoints } from "./broadcast.js";
import { calibrateClock, type ClockCalibration } from "./clock.js";
import {
  getTimeTriggerConfig,
  logClockStatusWithCalibration,
  waitForArmWindow,
  waitForPreciseFireWindow,
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

type LiveFeeMarket = {
  currentGasPrice: bigint;
  currentBaseFeePerGas?: bigint;
  nextBaseFeePerGas?: bigint;
  suggestedPriorityFeePerGas: bigint;
  suggestedMaxFeePerGas: bigint;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function pushValidation(results: ValidationItem[], check: string, ok: boolean, details: string): void {
  results.push({ check, ok, details });
}

function buildUnsignedRequest(
  account: Account,
  payload: PayloadShape,
  nonce: number,
  feeEnvelope: FeeEnvelope,
) {
  const request = {
    account,
    to: payload.to,
    data: payload.data,
    value: payload.value,
    gas: payload.gas,
    accessList: payload.accessList,
    nonce,
  };

  if (feeEnvelope.type === "eip1559") {
    return {
      ...request,
      maxFeePerGas: feeEnvelope.maxFeePerGas,
      maxPriorityFeePerGas: feeEnvelope.maxPriorityFeePerGas,
    };
  }

  return {
    ...request,
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

async function sampleLiveFeeMarket(client: PublicClient, configuredPriorityFeePerGas?: bigint): Promise<LiveFeeMarket> {
  const latestBlock = await client.getBlock();
  const currentGasPrice = await client.getGasPrice();
  let nextBaseFeePerGas = latestBlock.baseFeePerGas ?? undefined;
  let prioritySamples: bigint[] = [];

  try {
    const feeHistory = await client.getFeeHistory({
      blockCount: 5,
      rewardPercentiles: [75],
    });

    const feeHistoryBase = feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1];
    if (feeHistoryBase !== undefined) {
      nextBaseFeePerGas = feeHistoryBase;
    }

    prioritySamples = (feeHistory.reward ?? [])
      .map((rewardRow) => rewardRow[0] ?? 0n)
      .filter((reward) => reward > 0n);
  } catch {
    // Fallback to current gas data if fee history is unavailable.
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
  client: PublicClient,
  target: TargetConfig,
  profile: WalletProfile,
  gasLimit: bigint,
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<FeeEnvelope> {
  const latestBlock = await client.getBlock();
  const fees = target.fees;
  const replacementMultiplier =
    replacementRound > 0 ? Math.pow(target.execution?.replaceMultiplier ?? 1.125, replacementRound) : 1;
  const walletMultiplier = profile.multiplier;
  const totalMultiplier = walletMultiplier * replacementMultiplier;

  if (fees.type === "budgetAggressive") {
    const targetUsd = fees.targetUsd ?? 2.5;
    const assumedNativePriceUsd = fees.assumedNativePriceUsd;
    if (!assumedNativePriceUsd || assumedNativePriceUsd <= 0) {
      throw new Error("fees.assumedNativePriceUsd is required for budgetAggressive mode.");
    }

    const targetGasPriceGwei = (targetUsd / assumedNativePriceUsd) * 1_000_000_000 / Number(gasLimit);
    const floorGwei = fees.minFeeFloorGwei ?? 0.5;
    const baseTargetGwei = Math.max(targetGasPriceGwei, floorGwei);
    const adjustedBudgetGwei = baseTargetGwei * totalMultiplier;
    const liveCompetitiveMaxFee = scaleBigInt(
      liveFeeMarket?.suggestedMaxFeePerGas ?? (await client.getGasPrice()),
      totalMultiplier,
    );
    const budgetMaxFee = parseGwei(adjustedBudgetGwei.toFixed(9));
    let maxFeePerGas = maxBigInt(budgetMaxFee, liveCompetitiveMaxFee);

    if (fees.maxFeeCapGwei !== undefined) {
      const explicitCap = parseGwei(String(fees.maxFeeCapGwei));
      maxFeePerGas = maxFeePerGas > explicitCap ? explicitCap : maxFeePerGas;
    }

    const priorityFeeBase =
      fees.priorityFeeGwei !== undefined
        ? parseGwei(String(fees.priorityFeeGwei))
        : maxBigInt(liveFeeMarket?.suggestedPriorityFeePerGas ?? 0n, parseGwei("0.05"));
    const scaledPriorityFee = scaleBigInt(scaleBigInt(priorityFeeBase, walletMultiplier), replacementMultiplier);

    if (latestBlock.baseFeePerGas == null) {
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

  if (fees.type === "legacy" || latestBlock.baseFeePerGas == null) {
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
  client: PublicClient,
  target: TargetConfig,
  account: Account,
  profile: WalletProfile,
  nonceOverride?: number,
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<PreparedSend> {
  const chain = buildChain(target);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(target.chain.rpc.primaryHttp),
  });

  const payload = buildTransactionPayload(target, account.address, profile.index);
  const nonce =
    nonceOverride ??
    (await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    }));
  const gasLimit = payload.gas ?? (() => {
    throw new Error(
      "transaction.gasLimit is required for competition mode so the bot can pre-sign before mint opens.",
    );
  })();
  const feeEnvelope = await resolveFeeEnvelope(client, target, profile, gasLimit, liveFeeMarket, replacementRound);
  const unsignedRequest = buildUnsignedRequest(account, payload, nonce, feeEnvelope);

  const request =
    feeEnvelope.type === "eip1559"
      ? await walletClient.prepareTransactionRequest({
          ...unsignedRequest,
          chain,
          parameters: ["gas", "type"],
        })
      : await walletClient.prepareTransactionRequest({
          ...unsignedRequest,
          chain,
          parameters: ["gas", "type"],
        });

  const serializedTransaction = await walletClient.signTransaction(request);

  return {
    account,
    profile,
    nonce,
    gas: request.gas ?? payload.gas ?? 0n,
    serializedTransaction,
    transactionHash: keccak256(serializedTransaction),
  };
}

async function prepareSends(
  client: PublicClient,
  target: TargetConfig,
  accounts: Account[],
  profiles: WalletProfile[],
  nonceOverrides?: number[],
  liveFeeMarket?: LiveFeeMarket,
  replacementRound = 0,
): Promise<PreparedSend[]> {
  return Promise.all(
    accounts.map((account, index) =>
      createPreparedSend(
        client,
        target,
        account,
        profiles[index]!,
        nonceOverrides?.[index],
        liveFeeMarket,
        replacementRound,
      ),
    ),
  );
}

async function buildPreparedLadders(
  client: PublicClient,
  target: TargetConfig,
  accounts: Account[],
  profiles: WalletProfile[],
  replacementRounds: number,
): Promise<PreparedLadders> {
  const liveFeeMarket = await sampleLiveFeeMarket(
    client,
    target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
  );
  emitTelemetrySafe("live_fee_market", liveFeeMarket);
  const ladders = await Promise.all(
    accounts.map(async (account, index) => {
      const profile = profiles[index]!;
      const first = await createPreparedSend(client, target, account, profile, undefined, liveFeeMarket);
      const prepared = [first];

      for (let round = 1; round <= replacementRounds; round += 1) {
        prepared.push(await createPreparedSend(client, target, account, profile, first.nonce, liveFeeMarket, round));
      }

      return [profile.index, prepared] as const;
    }),
  );

  return new Map(ladders);
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

async function waitForReceiptOutcome(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number,
): Promise<ReceiptOutcome> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return {
        status: receipt.status === "success" ? "success" : "reverted",
        hash,
      };
    } catch {
      await sleep(800);
    }
  }

  return {
    status: "pending",
    hash,
  };
}

export async function runStatus(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const client = createPublicClient({
    chain: buildChain(target),
    transport: http(target.chain.rpc.primaryHttp),
  });

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

export async function runValidate(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client = createPublicClient({
    chain: buildChain(target),
    transport: http(target.chain.rpc.primaryHttp),
  });
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
  pushValidation(
    results,
    "Broadcast RPCs",
    healthyEndpoints > 0,
    `${healthyEndpoints}/${endpointHealth.length} endpoints responded successfully`,
  );

  if (target.trigger.mode === "time") {
    const clockCalibration = await calibrateClock([
      target.chain.rpc.primaryHttp,
      ...target.chain.rpc.broadcastHttp,
    ]);
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
    pushValidation(
      results,
      "Clock calibration",
      clockCalibration.sampleCount > 0 && Math.abs(clockCalibration.observedOffsetMs) <= 5000,
      `appliedOffset=${clockCalibration.offsetMs} ms, observedOffset=${clockCalibration.observedOffsetMs} ms, confidence=${clockCalibration.confidence}, samples=${clockCalibration.sampleCount}, source=${clockCalibration.source}, medianLatency=${clockCalibration.medianLatencyMs} ms`,
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
  const payload = buildTransactionPayload(target, sampleAccount.address, sampleProfile.index);
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
      pushValidation(
        results,
        "Gas estimate simulation",
        false,
        `estimateGas failed: ${describeError(error)}`,
      );
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
      pushValidation(
        results,
        "eth_call simulation",
        false,
        `eth_call failed: ${describeError(error)}`,
      );
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

  const allPassed = results.every((item) => item.ok);
  logger.info("Preflight validation summary.", results);

  if (allPassed) {
    logger.success("Validation passed. Bot is ready for armed standby.");
  } else {
    logger.warn("Validation found issues. Fix the failed checks before the competition.");
  }
}

export async function runStandby(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client = createPublicClient({
    chain: buildChain(target),
    transport: http(target.chain.rpc.primaryHttp),
  });
  const clockCalibration = await calibrateClock([
    target.chain.rpc.primaryHttp,
    ...target.chain.rpc.broadcastHttp,
  ]);

  await runStatus(target);
  const timeSchedule = getTimeTriggerConfig(target);

  if (timeSchedule) {
    const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
    logger.info("Timed standby active. Bot will arm before mint opens.");
    await waitForArmWindow(target, clockCalibration);
    const refreshedClockCalibration = await calibrateClock([
      target.chain.rpc.primaryHttp,
      ...target.chain.rpc.broadcastHttp,
    ]);
    logger.info("Arming timed fire. Preparing signed replacement ladder now.");
    emitTelemetrySafe("timed_arm", {
      initialClockOffsetMs: clockCalibration.offsetMs,
      refreshedClockOffsetMs: refreshedClockCalibration.offsetMs,
    });
    const rankedEndpoints = await warmBroadcastEndpoints(target);
    const ladders = await buildPreparedLadders(client, target, accounts, profiles, replacementRounds);
    const prepared = Array.from(ladders.values()).map((ladder) => ladder[0]!);
    await waitForPreciseFireWindow(target, refreshedClockCalibration);
    await executePreparedRounds(target, client, prepared, ladders, rankedEndpoints);
    return;
  }

  logger.info("Standby active. Waiting for trigger.");
  await waitForTrigger(target, client, clockCalibration);
  await runFire(target, client);
}

export async function runRehearse(target: TargetConfig): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client = createPublicClient({
    chain: buildChain(target),
    transport: http(target.chain.rpc.primaryHttp),
  });
  const replacementRounds = target.execution?.maxReplacementRounds ?? 3;

  await runStatus(target);
  logger.info("Preparing rehearsal ladder without broadcasting.");
  const ladders = await buildPreparedLadders(client, target, accounts, profiles, replacementRounds);
  const rankedEndpoints = await warmBroadcastEndpoints(target);

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
}

async function executePreparedRounds(
  target: TargetConfig,
  client: PublicClient,
  initialPrepared: PreparedSend[],
  preSignedLadders?: PreparedLadders,
  broadcastEndpoints?: string[],
): Promise<void> {
  let prepared = initialPrepared;
  let bestHashes = new Map<number, Hex>();
  const replacementDelay = target.execution?.replaceAfterMs ?? 4000;
  const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
  const receiptTimeout = target.execution?.receiptTimeoutMs ?? getDefaultReceiptTimeoutMs();
  const terminalStates = new Map<number, ReceiptOutcome>();
  const activeBroadcastEndpoints = broadcastEndpoints ?? target.chain.rpc.broadcastHttp;

  for (let round = 0; round <= replacementRounds; round += 1) {
    if (prepared.length === 0) {
      break;
    }

    logger.info(`Broadcast round ${round + 1} started.`);

    const perWalletResults = await Promise.all(
      prepared.map(async (send) => {
        const results = await broadcastSignedTransaction(activeBroadcastEndpoints, send.serializedTransaction);
        const winner = results.find((item) => item.ok && item.hash);
        const inferredHash = winner?.hash ?? (results.some((item) => isLikelyPropagatedError(item.error)) ? send.transactionHash : undefined);
        return { send, results, inferredHash };
      }),
    );

    for (const item of perWalletResults) {
      logger.info(`Wallet ${item.send.profile.label} broadcast results.`, {
        wallet: item.send.account.address,
        nonce: item.send.nonce,
        results: item.results,
      });

      if (item.inferredHash) {
        bestHashes.set(item.send.profile.index, item.inferredHash);
      }
    }

    emitTelemetrySafe("broadcast_round", {
      round: round + 1,
      activeBroadcastEndpoints,
      perWalletResults: perWalletResults.map((item) => ({
        wallet: item.send.account.address,
        profile: item.send.profile.label,
        nonce: item.send.nonce,
        inferredHash: item.inferredHash,
        results: item.results,
      })),
    });

    const receiptChecks = await Promise.all(
      prepared.map(async (send) => {
        const hash = bestHashes.get(send.profile.index) ?? send.transactionHash;
        return {
          send,
          outcome: await waitForReceiptOutcome(client, hash, Math.min(replacementDelay, receiptTimeout)),
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
      logger.success("At least one wallet confirmed successfully.", {
        confirmedWallets: confirmedSuccess.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
        revertedWallets: reverted.map((item) => ({
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
        revertedWallets: reverted.map((item) => ({
          wallet: item.send.account.address,
          profile: item.send.profile.label,
          hash: item.outcome.hash,
        })),
      });
      return;
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
      prepared = pending
        .map((item) => preSignedLadders.get(item.send.profile.index)?.[round + 1])
        .filter((item): item is PreparedSend => item !== undefined);
      continue;
    }

    const liveFeeMarket = await sampleLiveFeeMarket(
      client,
      target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
    );
    prepared = await Promise.all(
      pending.map((item) =>
        createPreparedSend(client, target, item.send.account, item.send.profile, item.send.nonce, liveFeeMarket, round + 1),
      ),
    );
  }

  const finalChecks = await Promise.all(
    Array.from(bestHashes.entries()).map(async ([walletIndex, hash]) => ({
      walletIndex,
      hash,
      outcome: terminalStates.get(walletIndex) ?? (await waitForReceiptOutcome(client, hash, receiptTimeout)),
    })),
  );

  logger.warn("Fire sequence finished without an early confirmation.", finalChecks);
  logger.info("If receipts are still pending, check explorer or rerun with a more aggressive fee config.");
  emitTelemetrySafe("fire_finished_without_early_confirmation", finalChecks);
}

export async function runFire(target: TargetConfig, providedClient?: PublicClient): Promise<void> {
  const accounts = loadAccounts(target.execution?.walletCount ?? 5);
  const profiles = getWalletProfiles(accounts.length, target.fees.profileMultipliers);
  const client =
    providedClient ??
    createPublicClient({
      chain: buildChain(target),
      transport: http(target.chain.rpc.primaryHttp),
    });

  logger.info("Preparing signed transactions.");
  const liveFeeMarket = await sampleLiveFeeMarket(
    client,
    target.fees.priorityFeeGwei !== undefined ? parseGwei(String(target.fees.priorityFeeGwei)) : undefined,
  );
  const rankedEndpoints = await warmBroadcastEndpoints(target);
  const prepared = await prepareSends(client, target, accounts, profiles, undefined, liveFeeMarket);
  await executePreparedRounds(target, client, prepared, undefined, rankedEndpoints);
}
