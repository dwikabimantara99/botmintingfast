import {
  encodeFunctionData,
  parseEther,
  parseAbi,
  type Abi,
  type AccessList,
  type Hex,
} from "viem";

import type { TargetConfig } from "../types.js";

type ResolvedTransaction = {
  to: Hex;
  data: Hex;
  value: bigint;
  gas?: bigint;
  accessList?: AccessList;
};

function normalizeAbi(abi: Abi | readonly string[]): Abi {
  if (abi.length === 0) {
    return abi as Abi;
  }

  if (typeof abi[0] === "string") {
    return parseAbi(abi as readonly string[]);
  }

  return abi as Abi;
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

export function buildTransactionPayload(
  target: TargetConfig,
  walletAddress: Hex,
  walletIndex: number,
): ResolvedTransaction {
  const tx = target.transaction;

  if (tx.kind === "contractWrite") {
    const resolvedArgs = (tx.args ?? []).map((arg) => replacePlaceholders(arg, walletAddress, walletIndex));

    const result: ResolvedTransaction = {
      to: tx.to,
      data: encodeFunctionData({
        abi: normalizeAbi(tx.abi),
        functionName: tx.functionName,
        args: resolvedArgs,
      }),
      value: tx.valueEth ? parseEther(tx.valueEth) : 0n,
    };

    if (tx.gasLimit) result.gas = BigInt(tx.gasLimit);
    if (tx.accessList) result.accessList = tx.accessList;

    return result;
  }

  const result: ResolvedTransaction = {
    to: tx.to,
    data: tx.data,
    value: tx.valueEth ? parseEther(tx.valueEth) : 0n,
  };

  if (tx.gasLimit) result.gas = BigInt(tx.gasLimit);
  if (tx.accessList) result.accessList = tx.accessList;

  return result;
}
