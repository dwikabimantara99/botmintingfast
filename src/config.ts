import { readFile } from "node:fs/promises";
import process from "node:process";
import { config as loadEnv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

import type { BotCommand, TargetConfig, WalletProfile } from "./types.js";

loadEnv();

const DEFAULT_PROFILE_MULTIPLIERS = [1.5, 1.35, 1.2, 1.1, 1.0];
const DEFAULT_PROFILE_LABELS = ["alpha", "bravo", "charlie", "delta", "echo"];

export async function loadTargetConfig(targetPath: string): Promise<TargetConfig> {
  const raw = await readFile(targetPath, "utf8");
  return JSON.parse(raw) as TargetConfig;
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

  const keys = serialized
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, walletCount);

  if (keys.length === 0) {
    throw new Error("No valid private keys found in PRIVATE_KEYS.");
  }

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
