import type { Abi, AccessList, Hex } from "viem";

export type TriggerConfig =
  | {
      mode: "manual";
    }
  | {
      mode: "time";
      startTimeIso: string;
      pollIntervalMs?: number;
      armBeforeMs?: number;
      countdownIntervalMs?: number;
      finalSpinWindowMs?: number;
    }
  | {
      mode: "block";
      blockNumber: number;
      pollIntervalMs?: number;
    }
  | {
      mode: "read";
      contract: Hex;
      abi: Abi;
      functionName: string;
      args?: unknown[];
      operator: "eq" | "gte" | "truthy";
      expected?: unknown;
      pollIntervalMs?: number;
    };

export type TransactionConfig =
  | {
      kind: "contractWrite";
      to: Hex;
      abi: Abi;
      functionName: string;
      args?: unknown[];
      valueEth?: string;
      gasLimit?: number;
      accessList?: AccessList;
    }
  | {
      kind: "rawTransaction";
      to: Hex;
      data: Hex;
      valueEth?: string;
      gasLimit?: number;
      accessList?: AccessList;
    };

export type FeesConfig = {
  type: "auto" | "eip1559" | "legacy" | "budgetAggressive";
  maxFeeMultiplier?: number;
  priorityFeeGwei?: number;
  maxFeeGwei?: number;
  gasPriceGwei?: number;
  profileMultipliers?: number[];
  targetUsd?: number;
  assumedNativePriceUsd?: number;
  minFeeFloorGwei?: number;
  maxFeeCapGwei?: number;
};

export type ExecutionConfig = {
  walletCount?: number;
  replaceAfterMs?: number;
  replaceMultiplier?: number;
  maxReplacementRounds?: number;
  receiptTimeoutMs?: number;
  warmupRounds?: number;
  warmupDelayMs?: number;
};

export type TargetConfig = {
  chain: {
    id: number;
    name: string;
    nativeCurrency: {
      name: string;
      symbol: string;
      decimals: number;
    };
    rpc: {
      primaryHttp: string;
      broadcastHttp: string[];
      webSocket?: string;
    };
  };
  trigger: TriggerConfig;
  transaction: TransactionConfig;
  fees: FeesConfig;
  execution?: ExecutionConfig;
};

export type WalletProfile = {
  index: number;
  label: string;
  multiplier: number;
};

export type BotCommand = "status" | "standby" | "fire" | "validate" | "rehearse";
