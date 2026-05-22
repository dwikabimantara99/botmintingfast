import { readFile } from "node:fs/promises";
import process from "node:process";
import { config as loadEnv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

import type { BotCommand, TargetConfig, WalletProfile } from "./types.js";

loadEnv();

const DEFAULT_PROFILE_MULTIPLIERS = [1.5, 1.35, 1.2, 1.1, 1.0];
const DEFAULT_PROFILE_LABELS = ["alpha", "bravo", "charlie", "delta", "echo"];

export async function loadTargetConfig(targetPath: string): Promise<TargetConfig> {
  const raw = await readFile(targetPath, "utf8");
  const parsed = JSON.parse(raw) as TargetConfig;
  validateTargetConfig(parsed, targetPath);
  return parsed;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAddress(value: string, label: string): void {
  try {
    getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid EVM address: ${value}`);
  }
}

function validateRpcConfig(target: TargetConfig): void {
  assert(isNonEmptyString(target.chain.rpc.primaryHttp), "chain.rpc.primaryHttp is required");
  assert(
    Array.isArray(target.chain.rpc.broadcastHttp) && target.chain.rpc.broadcastHttp.length > 0,
    "chain.rpc.broadcastHttp must contain at least one endpoint",
  );
  for (const endpoint of target.chain.rpc.broadcastHttp) {
    assert(isNonEmptyString(endpoint), "Every chain.rpc.broadcastHttp entry must be a non-empty string");
  }
  if (target.chain.rpc.readHttp) {
    for (const endpoint of target.chain.rpc.readHttp) {
      assert(isNonEmptyString(endpoint), "Every chain.rpc.readHttp entry must be a non-empty string");
    }
  }
  if (target.chain.rpc.webSocket !== undefined) {
    assert(isNonEmptyString(target.chain.rpc.webSocket), "chain.rpc.webSocket must be a non-empty string");
  }
}

function validateTransactionConfig(target: TargetConfig): void {
  const transaction = target.transaction;

  if (transaction.kind === "contractWrite") {
    validateAddress(transaction.to, "transaction.to");
    assert(transaction.abi.length > 0, "transaction.abi is required for contractWrite");
    assert(isNonEmptyString(transaction.functionName), "transaction.functionName is required for contractWrite");
  }

  if (transaction.kind === "rawTransaction") {
    validateAddress(transaction.to, "transaction.to");
    assert(isNonEmptyString(transaction.data), "transaction.data is required for rawTransaction");
  }

  if (transaction.kind === "omnihubCollectionMint") {
    validateAddress(transaction.to, "transaction.to");
    assert(transaction.quantity > 0, "transaction.quantity must be greater than 0");
    if (transaction.referralAddress) {
      validateAddress(transaction.referralAddress, "transaction.referralAddress");
    }
  }

  if (transaction.kind === "openseaDropMint") {
    assert(isNonEmptyString(transaction.collectionSlug), "transaction.collectionSlug is required for openseaDropMint");
    if (transaction.quantity !== undefined) {
      assert(transaction.quantity > 0, "transaction.quantity must be greater than 0");
    }
    if (transaction.apiKeyEnv !== undefined) {
      assert(isNonEmptyString(transaction.apiKeyEnv), "transaction.apiKeyEnv must be a non-empty string");
    }
  }

  if (transaction.kind === "seaDropPublicMint") {
    validateAddress(transaction.nftContract, "transaction.nftContract");
    if (transaction.seaDrop !== undefined) {
      validateAddress(transaction.seaDrop, "transaction.seaDrop");
    }
    if (transaction.feeRecipient !== undefined) {
      validateAddress(transaction.feeRecipient, "transaction.feeRecipient");
    }
    if (transaction.minterIfNotPayer !== undefined) {
      validateAddress(transaction.minterIfNotPayer, "transaction.minterIfNotPayer");
    }
    if (transaction.quantity !== undefined) {
      assert(transaction.quantity > 0, "transaction.quantity must be greater than 0");
    }
  }

  if (transaction.gasLimit !== undefined) {
    assert(transaction.gasLimit > 0, "transaction.gasLimit must be greater than 0");
  }
}

function validateFeesConfig(target: TargetConfig): void {
  const fees = target.fees;
  if (fees.type === "budgetAggressive") {
    assert(
      fees.assumedNativePriceUsd !== undefined && fees.assumedNativePriceUsd > 0,
      "fees.assumedNativePriceUsd must be greater than 0 for budgetAggressive",
    );
  }

  if (fees.profileMultipliers) {
    assert(fees.profileMultipliers.length > 0, "fees.profileMultipliers cannot be empty");
    for (const multiplier of fees.profileMultipliers) {
      assert(multiplier > 0, "fees.profileMultipliers must all be greater than 0");
    }
  }
}

function validateTriggerConfig(target: TargetConfig): void {
  if (target.trigger.mode === "time") {
    assert(
      Number.isFinite(new Date(target.trigger.startTimeIso).getTime()),
      "trigger.startTimeIso must be a valid ISO timestamp",
    );
  }

  if (target.trigger.mode === "block") {
    assert(target.trigger.blockNumber > 0, "trigger.blockNumber must be greater than 0");
  }

  if (target.trigger.mode === "read") {
    validateAddress(target.trigger.contract, "trigger.contract");
    assert(target.trigger.abi.length > 0, "trigger.abi cannot be empty");
    assert(isNonEmptyString(target.trigger.functionName), "trigger.functionName is required");
  }
}

function validateVerificationConfig(target: TargetConfig): void {
  const verification = target.verification;
  if (!verification) return;

  if (verification.contract) {
    validateAddress(verification.contract, "verification.contract");
  }
  assert(verification.abi.length > 0, "verification.abi cannot be empty");
  assert(isNonEmptyString(verification.functionName), "verification.functionName is required");
}

function validatePrivateRelayConfig(target: TargetConfig): void {
  const privateRelay = target.privateRelay;
  if (!privateRelay) return;

  if (privateRelay.kind === "flashbots") {
    assert(target.chain.id === 1, "Flashbots private relay is only supported on Ethereum mainnet");
    if (privateRelay.relayUrl !== undefined) {
      assert(isNonEmptyString(privateRelay.relayUrl), "privateRelay.relayUrl must be a non-empty string");
    }
    if (privateRelay.maxBlocksInFuture !== undefined) {
      assert(privateRelay.maxBlocksInFuture > 0, "privateRelay.maxBlocksInFuture must be greater than 0");
    }
  }
}

function validateExecutionConfig(target: TargetConfig): void {
  const execution = target.execution;
  if (!execution) return;

  const positiveIntegerFields = [
    ["walletCount", execution.walletCount],
    ["replaceAfterMs", execution.replaceAfterMs],
    ["receiptPollIntervalMs", execution.receiptPollIntervalMs],
    ["maxReplacementRounds", execution.maxReplacementRounds],
    ["receiptTimeoutMs", execution.receiptTimeoutMs],
    ["warmupRounds", execution.warmupRounds],
    ["warmupDelayMs", execution.warmupDelayMs],
    ["minHealthyBroadcastRpc", execution.minHealthyBroadcastRpc],
    ["minHealthyReadRpc", execution.minHealthyReadRpc],
    ["rpcOperationRetries", execution.rpcOperationRetries],
    ["rpcOperationRetryDelayMs", execution.rpcOperationRetryDelayMs],
    ["rpcRecoveryPasses", execution.rpcRecoveryPasses],
    ["rpcRecoveryDelayMs", execution.rpcRecoveryDelayMs],
    ["rpcEndpointCooldownMs", execution.rpcEndpointCooldownMs],
  ] as const;

  for (const [name, value] of positiveIntegerFields) {
    if (value !== undefined) {
      assert(value > 0, `execution.${name} must be greater than 0`);
    }
  }

  if (execution.replaceMultiplier !== undefined) {
    assert(execution.replaceMultiplier > 1, "execution.replaceMultiplier should be greater than 1");
  }
}

function validateTargetConfig(target: TargetConfig, targetPath: string): void {
  if (target.mintQuantityPerWallet !== undefined) {
    assert(target.mintQuantityPerWallet > 0, `mintQuantityPerWallet must be greater than 0 in ${targetPath}`);
  }
  assert(target.chain.id > 0, `chain.id must be greater than 0 in ${targetPath}`);
  assert(isNonEmptyString(target.chain.name), `chain.name is required in ${targetPath}`);
  assert(isNonEmptyString(target.chain.nativeCurrency.symbol), `chain.nativeCurrency.symbol is required in ${targetPath}`);
  validateRpcConfig(target);
  validateTransactionConfig(target);
  validateFeesConfig(target);
  validateTriggerConfig(target);
  validateVerificationConfig(target);
  validatePrivateRelayConfig(target);
  validateExecutionConfig(target);
}

export function parseCommand(argv: string[]): { command: BotCommand; targetPath: string } {
  const [, , rawCommand, ...rest] = argv;
  if (
    rawCommand !== "status" &&
    rawCommand !== "standby" &&
    rawCommand !== "fire" &&
    rawCommand !== "validate" &&
    rawCommand !== "rehearse"
  ) {
    throw new Error("Command must be one of: status, standby, fire, validate, rehearse");
  }

  const targetIndex = rest.findIndex((item) => item === "--target");
  if (targetIndex === -1 || !rest[targetIndex + 1]) {
    throw new Error("Missing required flag: --target <path>");
  }

  const targetPath = rest[targetIndex + 1]!;

  return {
    command: rawCommand,
    targetPath,
  };
}

export function loadAccounts(walletCount = 5) {
  const serialized = process.env.PRIVATE_KEYS?.trim();
  if (!serialized) {
    throw new Error("PRIVATE_KEYS is empty. Fill your .env first.");
  }

  const requestedWalletCount = Number.isFinite(walletCount) && walletCount > 0 ? Math.floor(walletCount) : 5;
  const availableKeys = serialized
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  if (availableKeys.length === 0) {
    throw new Error("No valid private keys found in PRIVATE_KEYS.");
  }

  if (availableKeys.length < requestedWalletCount) {
    throw new Error(
      `PRIVATE_KEYS only contains ${availableKeys.length} wallet(s), but execution.walletCount requires ${requestedWalletCount}.`,
    );
  }

  const keys = availableKeys.slice(0, requestedWalletCount);

  return keys.map((key) => privateKeyToAccount(key as `0x${string}`));
}

export function getWalletProfiles(walletCount: number, profileMultipliers?: number[]): WalletProfile[] {
  return Array.from({ length: walletCount }, (_, index) => ({
    index,
    label: DEFAULT_PROFILE_LABELS[index] ?? `wallet-${index + 1}`,
    multiplier: profileMultipliers?.[index] ?? DEFAULT_PROFILE_MULTIPLIERS[index] ?? 1,
  }));
}

export function getRequestTimeoutMs(): number {
  const value = Number(process.env.RPC_REQUEST_TIMEOUT_MS ?? 2500);
  return Number.isFinite(value) && value > 0 ? value : 2500;
}

export function getDefaultReceiptTimeoutMs(): number {
  const value = Number(process.env.RECEIPT_TIMEOUT_MS ?? 120000);
  return Number.isFinite(value) && value > 0 ? value : 120000;
}
