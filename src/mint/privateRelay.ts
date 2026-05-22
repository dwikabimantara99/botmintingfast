import process from "node:process";

import { keccak256, type Hex } from "viem";

import { logger } from "../logger.js";
import type { TargetConfig } from "../types.js";

export type PrivateRelayResult = {
  ok: boolean;
  relay: string;
  hash: Hex;
  targetBlockNumber?: number;
  error?: string;
};

export type PrivateRelaySubmitter = {
  enabled: boolean;
  submitRound: (serializedTransactions: Hex[]) => Promise<PrivateRelayResult[]>;
};

function isFlashbotsEnabled(target: TargetConfig): boolean {
  return (
    target.privateRelay?.kind === "flashbots" &&
    (target.privateRelay.enabled ?? false) &&
    target.chain.id === 1
  );
}

async function loadFlashbotsRuntime() {
  const ethersModule = await import("ethers");
  const flashbotsModule = await import("@flashbots/ethers-provider-bundle");
  return {
    JsonRpcProvider: ethersModule.JsonRpcProvider,
    Wallet: ethersModule.Wallet,
    FlashbotsBundleProvider: flashbotsModule.FlashbotsBundleProvider,
  };
}

function getAuthPrivateKey(target: TargetConfig): string | null {
  const authEnv = target.privateRelay?.authKeyEnv ?? "FLASHBOTS_AUTH_PRIVATE_KEY";
  const authPrivateKey = process.env[authEnv]?.trim();

  if (authPrivateKey) {
    return authPrivateKey;
  }

  logger.warn(
    `Private relay is enabled but ${authEnv} is not set. Using an ephemeral Flashbots auth signer for this run.`,
  );
  return null;
}

export async function submitPrivateRelayRound(
  target: TargetConfig,
  serializedTransactions: Hex[],
): Promise<PrivateRelayResult[]> {
  const submitter = await createPrivateRelaySubmitter(target);
  return submitter.submitRound(serializedTransactions);
}

export async function createPrivateRelaySubmitter(target: TargetConfig): Promise<PrivateRelaySubmitter> {
  if (!isFlashbotsEnabled(target)) {
    return {
      enabled: false,
      submitRound: async () => [],
    };
  }

  const relayUrl = target.privateRelay?.relayUrl ?? "https://relay.flashbots.net";
  const maxBlocksInFuture = Math.max(1, target.privateRelay?.maxBlocksInFuture ?? 2);
  const { JsonRpcProvider, Wallet, FlashbotsBundleProvider } = await loadFlashbotsRuntime();
  const provider = new JsonRpcProvider(target.chain.rpc.primaryHttp, target.chain.id);
  const authPrivateKey = getAuthPrivateKey(target);
  const authSigner = authPrivateKey ? new Wallet(authPrivateKey) : Wallet.createRandom();
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider as never, authSigner as never, relayUrl);

  return {
    enabled: true,
    submitRound: async (serializedTransactions) => {
      if (serializedTransactions.length === 0) {
        return [];
      }

      const currentBlockNumber = await provider.getBlockNumber();
      return Promise.all(
        serializedTransactions.map(async (signedTransaction) => {
          const transactionHash = keccak256(signedTransaction);
          try {
            const response = await flashbotsProvider.sendPrivateTransaction(
              { signedTransaction },
              { maxBlockNumber: currentBlockNumber + maxBlocksInFuture },
            );

            if ("error" in response) {
              return {
                ok: false,
                relay: relayUrl,
                hash: transactionHash,
                error: response.error.message,
              };
            }

            return {
              ok: true,
              relay: relayUrl,
              hash: response.transaction.hash as Hex,
              targetBlockNumber: currentBlockNumber + maxBlocksInFuture,
            };
          } catch (error) {
            return {
              ok: false,
              relay: relayUrl,
              hash: transactionHash,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
    },
  };
}
