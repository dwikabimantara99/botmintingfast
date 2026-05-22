import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
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
const defaultOpenSeaApiBaseUrl = "https://api.opensea.io/api/v2";
const defaultSeaDropAddress = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5" as Hex;
const defaultSeaDropFeeRecipient = "0x0000a26b00c1F0DF003000390027140000fAa719" as Hex;

const omnihubAbi = parseAbi([
  "function version() view returns (string)",
  "function phaseCount() view returns (uint256)",
  "function phases(uint256) view returns (string title, uint256 from, uint256 to, uint256 price, uint256 maxPerAddress, bytes32 merkleRoot)",
  "function calculateMintFee(uint256 _phaseId, uint256 _quantity) view returns (uint256)",
  "function mint(uint256 _phaseId, uint256 _quantity, address _referral, bytes32[] _merkleProof) payable",
]);

const seaDropAbi = parseAbi([
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function getPublicDrop(address nftContract) view returns ((uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

type SeaDropPublicDrop = {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
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

function replacePlaceholders(
  value: unknown,
  walletAddress: Hex,
  walletIndex: number,
  mintQuantityPerWallet: number,
): unknown {
  if (typeof value === "string") {
    if (value === "__WALLET__") return walletAddress;
    if (value === "__INDEX__") return walletIndex;
    if (value === "__MINT_QUANTITY__") return mintQuantityPerWallet;
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, walletAddress, walletIndex, mintQuantityPerWallet));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        replacePlaceholders(nested, walletAddress, walletIndex, mintQuantityPerWallet),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseWeiValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`OpenSea mint transaction returned invalid wei value: ${String(value)}`);
}

function assertHex(value: unknown, label: string): Hex {
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) {
    return value as Hex;
  }

  throw new Error(`OpenSea mint transaction returned invalid ${label}.`);
}

function getOpenSeaApiKey(envName: string): string {
  const apiKey = process.env[envName]?.trim();
  if (!apiKey) {
    throw new Error(`${envName} is empty. Fill it in .env before using openseaDropMint.`);
  }

  return apiKey;
}

function normalizeOpenSeaMintResponse(responseBody: unknown): { to: Hex; data: Hex; value: bigint } {
  if (!isRecord(responseBody)) {
    throw new Error("OpenSea mint endpoint returned a non-object response.");
  }

  const transaction = isRecord(responseBody.transaction) ? responseBody.transaction : responseBody;
  const target = transaction.target ?? transaction.to;
  const calldata = transaction.calldata ?? transaction.data;
  const value = transaction.value ?? 0;

  return {
    to: getAddress(assertHex(target, "target contract")) as Hex,
    data: assertHex(calldata, "calldata"),
    value: parseWeiValue(value),
  };
}

async function fetchOpenSeaDropMintPayload(
  apiBaseUrl: string,
  collectionSlug: string,
  apiKey: string,
  walletAddress: Hex,
  quantity: number,
): Promise<{ to: Hex; data: Hex; value: bigint }> {
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/drops/${encodeURIComponent(collectionSlug)}/mint`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        minter: walletAddress,
        quantity,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(`OpenSea mint endpoint returned invalid JSON: ${responseText.slice(0, 200)}`);
    }

    if (!response.ok) {
      const detail = isRecord(payload)
        ? String(payload.message ?? payload.error ?? responseText.slice(0, 200))
        : responseText.slice(0, 200);
      throw new Error(`OpenSea mint endpoint HTTP ${response.status}: ${detail}`);
    }

    return normalizeOpenSeaMintResponse(payload);
  } finally {
    clearTimeout(timeout);
  }
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
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const data = encodeFunctionData({
    abi,
    functionName: functionName as never,
    args: args as never,
  });
  const raw = await client.call({
    to: targetAddress,
    data,
  });

  return decodeFunctionResult({
    abi,
    functionName: functionName as never,
    data: raw.data ?? "0x",
  }) as T;
}

async function readOmnihubContractResult<T>(
  client: RpcReadClient,
  targetAddress: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return readContractResult(client, targetAddress, omnihubAbi as Abi, functionName, args);
}

async function readSeaDropContractResult<T>(
  client: RpcReadClient,
  seaDropAddress: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return readContractResult(client, seaDropAddress, seaDropAbi as Abi, functionName, args);
}

async function resolveOmnihubMintPayload(
  client: RpcReadClient,
  rootTarget: TargetConfig,
  target: Extract<TargetConfig["transaction"], { kind: "omnihubCollectionMint" }>,
  walletAddress: Hex,
): Promise<ResolvedTransaction> {
  const contractVersion = await readOmnihubContractResult<string>(client, target.to, "version");
  const quantity = BigInt(target.quantity ?? rootTarget.mintQuantityPerWallet ?? 1);
  const referralAddress = target.referralAddress ?? zeroAddress;
  const block = await client.getBlock();
  const nowSeconds = block.timestamp;

  let selectedPhaseId = target.preferredPhaseId;
  let selectedPhase: OmnihubPhase | undefined;

  if (selectedPhaseId !== undefined) {
    selectedPhase = await readOmnihubContractResult<OmnihubPhase>(client, target.to, "phases", [BigInt(selectedPhaseId)]);
  } else {
    const phaseCount = Number(await readOmnihubContractResult<bigint>(client, target.to, "phaseCount"));

    for (let index = 0; index < phaseCount; index += 1) {
      const phase = await readOmnihubContractResult<OmnihubPhase>(client, target.to, "phases", [BigInt(index)]);
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

  const value = await readOmnihubContractResult<bigint>(client, target.to, "calculateMintFee", [
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

async function resolveSeaDropPublicMintPayload(
  client: RpcReadClient,
  rootTarget: TargetConfig,
  target: Extract<TargetConfig["transaction"], { kind: "seaDropPublicMint" }>,
): Promise<ResolvedTransaction> {
  const seaDropAddress = target.seaDrop ?? defaultSeaDropAddress;
  const quantity = BigInt(target.quantity ?? rootTarget.mintQuantityPerWallet ?? 1);
  if (quantity <= 0n) {
    throw new Error(`Invalid SeaDrop quantity: ${quantity.toString()}`);
  }

  const publicDrop = await readSeaDropContractResult<SeaDropPublicDrop>(
    client,
    seaDropAddress,
    "getPublicDrop",
    [target.nftContract],
  );

  if (publicDrop.maxTotalMintableByWallet > 0 && quantity > BigInt(publicDrop.maxTotalMintableByWallet)) {
    throw new Error(
      `SeaDrop quantity ${quantity.toString()} exceeds maxTotalMintableByWallet ${publicDrop.maxTotalMintableByWallet}.`,
    );
  }

  let feeRecipient = target.feeRecipient;
  if (!feeRecipient && publicDrop.restrictFeeRecipients) {
    const allowedFeeRecipients = await readSeaDropContractResult<Hex[]>(
      client,
      seaDropAddress,
      "getAllowedFeeRecipients",
      [target.nftContract],
    );
    feeRecipient = allowedFeeRecipients[0];
    if (!feeRecipient) {
      throw new Error("SeaDrop public mint restricts fee recipients, but no allowed fee recipient was found.");
    }
  }

  const data = encodeFunctionData({
    abi: seaDropAbi,
    functionName: "mintPublic",
    args: [
      target.nftContract,
      feeRecipient ?? defaultSeaDropFeeRecipient,
      target.minterIfNotPayer ?? zeroAddress,
      quantity,
    ],
  });

  return buildResolvedTransaction(
    seaDropAddress,
    data,
    publicDrop.mintPrice * quantity,
    target.gasLimit,
    target.accessList,
  );
}

export async function buildTransactionPayload(
  client: RpcReadClient,
  target: TargetConfig,
  walletAddress: Hex,
  walletIndex: number,
): Promise<ResolvedTransaction> {
  const tx = target.transaction;

  if (tx.kind === "contractWrite") {
    const mintQuantityPerWallet = target.mintQuantityPerWallet ?? 1;
    const resolvedArgs = (tx.args ?? []).map((arg) =>
      replacePlaceholders(arg, walletAddress, walletIndex, mintQuantityPerWallet),
    );
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
    return resolveOmnihubMintPayload(client, target, tx, walletAddress);
  }

  if (tx.kind === "openseaDropMint") {
    const quantity = tx.quantity ?? target.mintQuantityPerWallet ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid OpenSea mint quantity: ${quantity}`);
    }

    const payload = await fetchOpenSeaDropMintPayload(
      tx.apiBaseUrl ?? defaultOpenSeaApiBaseUrl,
      tx.collectionSlug,
      getOpenSeaApiKey(tx.apiKeyEnv ?? "OPENSEA_API_KEY"),
      walletAddress,
      quantity,
    );

    return buildResolvedTransaction(payload.to, payload.data, payload.value, tx.gasLimit, tx.accessList);
  }

  if (tx.kind === "seaDropPublicMint") {
    return resolveSeaDropPublicMintPayload(client, target, tx);
  }

  return buildResolvedTransaction(
    tx.to,
    tx.data,
    tx.valueEth ? parseEther(tx.valueEth) : 0n,
    tx.gasLimit,
    tx.accessList,
  );
}
