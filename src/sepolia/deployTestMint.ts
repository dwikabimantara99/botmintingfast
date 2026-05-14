import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
  type Abi,
  type Hex,
} from "viem";

import { loadAccounts, loadTargetConfig } from "../config.js";
import { logger } from "../logger.js";

type DeployOptions = {
  targetPath: string;
  outputPath: string;
  priceEth: string;
  maxSupply: number;
  openAtIso: string;
  walletIndex: number;
};

type SolcOutput = {
  contracts?: Record<string, Record<string, { abi: Abi; evm?: { bytecode?: { object?: string } } }>>;
  errors?: { severity: string; formattedMessage: string }[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function withRetries<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  const baseDelayMs = 1200;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }

      logger.warn(`${label} failed. Retrying.`, {
        attempt,
        maxAttempts,
        retryDelayMs: baseDelayMs * attempt,
        error: describeError(error),
      });
      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

function parseArgs(argv: string[]): DeployOptions {
  const getValue = (flag: string): string | undefined => {
    const index = argv.findIndex((item) => item === flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const targetPath = getValue("--target") ?? "./targets/sepolia-race.sample.json";
  const outputPath = getValue("--output") ?? "./targets/sepolia-race.generated.json";
  const priceEth = getValue("--priceEth") ?? "0.0001";
  const maxSupplyRaw = getValue("--maxSupply") ?? "50";
  const openAtIso = getValue("--openAtIso") ?? new Date(Date.now() + 5 * 60_000).toISOString();
  const walletIndexRaw = getValue("--walletIndex") ?? "0";

  const maxSupply = Number(maxSupplyRaw);
  const walletIndex = Number(walletIndexRaw);

  if (!Number.isInteger(maxSupply) || maxSupply <= 0) {
    throw new Error("--maxSupply must be a positive integer.");
  }

  if (!Number.isInteger(walletIndex) || walletIndex < 0) {
    throw new Error("--walletIndex must be a non-negative integer.");
  }

  if (Number.isNaN(Date.parse(openAtIso))) {
    throw new Error("--openAtIso must be a valid ISO timestamp.");
  }

  return {
    targetPath,
    outputPath,
    priceEth,
    maxSupply,
    openAtIso,
    walletIndex,
  };
}

function buildChain(target: Awaited<ReturnType<typeof loadTargetConfig>>) {
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

async function compileContract(): Promise<{ abi: Abi; bytecode: Hex }> {
  const sourcePath = path.resolve("contracts", "SepoliaRaceMint.sol");
  const source = await readFile(sourcePath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      "SepoliaRaceMint.sol": {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;
  const errors = output.errors ?? [];
  const hardErrors = errors.filter((entry) => entry.severity === "error");

  for (const entry of errors) {
    const message = entry.formattedMessage.trim();
    if (entry.severity === "error") {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  }

  if (hardErrors.length > 0) {
    throw new Error("Solidity compile failed.");
  }

  const contract = output.contracts?.["SepoliaRaceMint.sol"]?.["SepoliaRaceMint"];
  const abi = contract?.abi;
  const bytecodeObject = contract?.evm?.bytecode?.object;

  if (!abi || !bytecodeObject) {
    throw new Error("Compiled contract artifact is incomplete.");
  }

  return {
    abi,
    bytecode: `0x${bytecodeObject}` as Hex,
  };
}

async function writeGeneratedTarget(
  outputPath: string,
  baseTarget: Awaited<ReturnType<typeof loadTargetConfig>>,
  contractAddress: Hex,
  abi: Abi,
  priceEth: string,
  openAtIso: string,
): Promise<void> {
  const generatedTarget = {
    ...baseTarget,
    trigger: {
      mode: "time" as const,
      startTimeIso: openAtIso,
      pollIntervalMs: 150,
      armBeforeMs: 5000,
      repriceBeforeMs: 750,
      countdownIntervalMs: 30000,
      finalSpinWindowMs: 100,
    },
    transaction: {
      kind: "contractWrite" as const,
      to: contractAddress,
      abi,
      functionName: "mint",
      args: [1],
      valueEth: priceEth,
      gasLimit: 220000,
    },
  };

  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(generatedTarget, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = await loadTargetConfig(options.targetPath);
  const accounts = loadAccounts(options.walletIndex + 1);
  const account = accounts[options.walletIndex];

  if (!account) {
    throw new Error(`Wallet index ${options.walletIndex} is not available in PRIVATE_KEYS.`);
  }

  if (target.chain.id !== 11155111) {
    throw new Error(`Target chainId must be 11155111 for Sepolia. Received ${target.chain.id}.`);
  }

  const { abi, bytecode } = await compileContract();
  const openAtMs = Date.parse(options.openAtIso);
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

  const balance = await withRetries("Sepolia balance check", async () =>
    publicClient.getBalance({ address: account.address }),
  );
  logger.info("Sepolia deploy wallet loaded.", {
    address: account.address,
    balanceEth: formatEther(balance),
    targetPath: options.targetPath,
    outputPath: options.outputPath,
  });

  const hash = await withRetries("Sepolia contract deployment", async () =>
    walletClient.deployContract({
      account,
      abi,
      bytecode,
      args: [parseEther(options.priceEth), BigInt(options.maxSupply), BigInt(Math.floor(openAtMs / 1000))],
    }),
  );

  logger.info("Deployment transaction sent.", { hash });
  const receipt = await withRetries("Sepolia deployment receipt", async () =>
    publicClient.waitForTransactionReceipt({ hash }),
  );
  const contractAddress = receipt.contractAddress;

  if (!contractAddress) {
    throw new Error("Deployment receipt did not include a contract address.");
  }

  await writeGeneratedTarget(
    options.outputPath,
    target,
    contractAddress,
    abi,
    options.priceEth,
    options.openAtIso,
  );

  logger.success("Sepolia test mint contract deployed.", {
    contractAddress,
    blockNumber: receipt.blockNumber.toString(),
    generatedTarget: path.resolve(options.outputPath),
    nextCommands: [
      `npm.cmd run bot -- status --target ${options.outputPath}`,
      `npm.cmd run bot -- validate --target ${options.outputPath}`,
      `npm.cmd run bot -- rehearse --target ${options.outputPath}`,
      `npm.cmd run bot -- standby --target ${options.outputPath}`,
    ],
  });
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
