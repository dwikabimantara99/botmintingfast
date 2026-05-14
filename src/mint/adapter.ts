import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  parseEther,
  type Abi,
  type AccessList,
  type Hex,
} from "viem";

import type { TargetConfig } from "../types.js";
import type { RpcReadClient } from "./rpcMesh.js";

type ResolvedTransaction = {
  to: Hex;
  data: Hex;
  value: bigint;
  gas?: bigint;
  accessList?: AccessList;
};

type OmnihubPhase = {
  title: string;
  from: bigint;
  to: bigint;
  price: bigint;
  maxPerAddress: bigint;
  merkleRoot: Hex;
};

const zeroMerkleRoot = `0x${"00".repeat(32)}` as Hex;
const zeroAddress = "0x0000000000000000000000000000000000000000" as Hex;
const millisecondsThreshold = 100_000_000_000n;

const omnihubAbi = parseAbi([
  "function version() view returns (string)",
  "function phaseCount() view returns (uint256)",
  "function phases(uint256) view returns (string title, uint256 from, uint256 to, uint256 price, uint256 maxPerAddress, bytes32 merkleRoot)",
  "function calculateMintFee(uint256 _phaseId, uint256 _quantity) view returns (uint256)",
  "function mint(uint256 _phaseId, uint256 _quantity, address _referral, bytes32[] _merkleProof) payable",
]);

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

function buildResolvedTransaction(
  to: Hex,
  data: Hex,
  value: bigint,
  gasLimit?: number,
  accessList?: AccessList,
): ResolvedTransaction {
  const result: ResolvedTransaction = {
    to,
    data,
    value,
  };

  if (gasLimit) result.gas = BigInt(gasLimit);
  if (accessList) result.accessList = accessList;

  return result;
}

function normalizePhaseTimestamp(value: bigint): bigint {
  if (value > millisecondsThreshold) {
    return value / 1000n;
  }

  return value;
}

async function readContractResult<T>(
  client: RpcReadClient,
  targetAddress: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const data = encodeFunctionData({
    abi: omnihubAbi as Abi,
    functionName: functionName as never,
    args: args as never,
  });
  const raw = await client.call({
    to: targetAddress,
    data,
  });

  return decodeFunctionResult({
    abi: omnihubAbi as Abi,
    functionName: functionName as never,
    data: raw.data ?? "0x",
  }) as T;
}

async function resolveOmnihubMintPayload(
  client: RpcReadClient,
  target: Extract<TargetConfig["transaction"], { kind: "omnihubCollectionMint" }>,
  walletAddress: Hex,
): Promise<ResolvedTransaction> {
  const contractVersion = await readContractResult<string>(client, target.to, "version");
  const quantity = BigInt(target.quantity);
  const referralAddress = target.referralAddress ?? zeroAddress;
  const block = await client.getBlock();
  const nowSeconds = block.timestamp;

  let selectedPhaseId = target.preferredPhaseId;
  let selectedPhase: OmnihubPhase | undefined;

  if (selectedPhaseId !== undefined) {
    selectedPhase = await readContractResult<OmnihubPhase>(client, target.to, "phases", [BigInt(selectedPhaseId)]);
  } else {
    const phaseCount = Number(await readContractResult<bigint>(client, target.to, "phaseCount"));

    for (let index = 0; index < phaseCount; index += 1) {
      const phase = await readContractResult<OmnihubPhase>(client, target.to, "phases", [BigInt(index)]);
      const phaseFrom = normalizePhaseTimestamp(phase.from);
      const phaseTo = normalizePhaseTimestamp(phase.to);
      if (nowSeconds >= phaseFrom && nowSeconds <= phaseTo) {
        selectedPhaseId = index;
        selectedPhase = {
          ...phase,
          from: phaseFrom,
          to: phaseTo,
        };
        break;
      }
    }
  }

  if (selectedPhaseId === undefined || selectedPhase === undefined) {
    throw new Error(
      `No active OmniHub phase found at block timestamp ${nowSeconds.toString()}. The mint may not be open yet.`,
    );
  }

  const merkleProof = target.merkleProof ?? [];
  if (selectedPhase.merkleRoot !== zeroMerkleRoot && merkleProof.length === 0) {
    throw new Error(
      `Active OmniHub phase ${selectedPhaseId} requires a merkle proof (${selectedPhase.merkleRoot}), but no merkleProof was configured for ${walletAddress}.`,
    );
  }

  const value = await readContractResult<bigint>(client, target.to, "calculateMintFee", [
    BigInt(selectedPhaseId),
    quantity,
  ]);

  const data = encodeFunctionData({
    abi: omnihubAbi,
    functionName: "mint",
    args: [BigInt(selectedPhaseId), quantity, referralAddress, merkleProof],
  });

  if (contractVersion !== "v1.0.0" && contractVersion !== "v1.0.1") {
    throw new Error(`Unsupported OmniHub contract version "${contractVersion}".`);
  }

  return buildResolvedTransaction(target.to, data, value, target.gasLimit, target.accessList);
}

export async function buildTransactionPayload(
  client: RpcReadClient,
  target: TargetConfig,
  walletAddress: Hex,
  walletIndex: number,
): Promise<ResolvedTransaction> {
  const tx = target.transaction;

  if (tx.kind === "contractWrite") {
    const resolvedArgs = (tx.args ?? []).map((arg) => replacePlaceholders(arg, walletAddress, walletIndex));
    const data = encodeFunctionData({
      abi: normalizeAbi(tx.abi),
      functionName: tx.functionName,
      args: resolvedArgs,
    });

    return buildResolvedTransaction(
      tx.to,
      data,
      tx.valueEth ? parseEther(tx.valueEth) : 0n,
      tx.gasLimit,
      tx.accessList,
    );
  }

  if (tx.kind === "omnihubCollectionMint") {
    return resolveOmnihubMintPayload(client, tx, walletAddress);
  }

  return buildResolvedTransaction(
    tx.to,
    tx.data,
    tx.valueEth ? parseEther(tx.valueEth) : 0n,
    tx.gasLimit,
    tx.accessList,
  );
}
