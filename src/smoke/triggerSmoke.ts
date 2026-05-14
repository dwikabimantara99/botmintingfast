import process from "node:process";

import type { Abi } from "viem";

import { loadTargetConfig } from "../config.js";
import { logger } from "../logger.js";
import { calibrateClock } from "../mint/clock.js";
import { createRpcMesh } from "../mint/rpcMesh.js";
import { waitForTrigger } from "../mint/trigger.js";
import type { TargetConfig } from "../types.js";

const WETH_MAINNET = "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2" as const;

function cloneTarget(target: TargetConfig): TargetConfig {
  return structuredClone(target);
}

async function main(): Promise<void> {
  const targetPath = process.argv[2] ?? "./targets/manual-contract.sample.json";
  const baseTarget = await loadTargetConfig(targetPath);
  const client = createRpcMesh(baseTarget);
  await client.refreshRanking();

  const calibration = await calibrateClock([
    baseTarget.chain.rpc.primaryHttp,
    ...baseTarget.chain.rpc.broadcastHttp,
    ...(baseTarget.chain.rpc.readHttp ?? []),
  ]);

  logger.info("Starting trigger smoke test.", {
    targetPath,
    clockConfidence: calibration.confidence,
    clockObservedOffsetMs: calibration.observedOffsetMs,
    rankedReadEndpoints: client.getRankedEndpoints(),
  });

  {
    const manualTarget = cloneTarget(baseTarget);
    manualTarget.trigger = { mode: "manual" };
    const startedAt = Date.now();
    await waitForTrigger(manualTarget, client, calibration);
    logger.success("Manual trigger smoke test passed.", {
      durationMs: Date.now() - startedAt,
    });
  }

  {
    const timeTarget = cloneTarget(baseTarget);
    const startAtMs = Date.now() + 1_500;
    timeTarget.trigger = {
      mode: "time",
      startTimeIso: new Date(startAtMs).toISOString(),
      pollIntervalMs: 100,
      countdownIntervalMs: 500,
      armBeforeMs: 0,
      finalSpinWindowMs: 25,
    };
    const startedAt = Date.now();
    await waitForTrigger(timeTarget, client, calibration);
    logger.success("Time trigger smoke test passed.", {
      scheduledDelayMs: startAtMs - startedAt,
      actualDurationMs: Date.now() - startedAt,
    });
  }

  {
    try {
      const continuityBlock = await client.getBlockNumber();
      logger.success("Shared RPC mesh continuity check passed.", {
        block: continuityBlock.toString(),
      });
    } catch (error) {
      logger.warn("Shared RPC mesh continuity check failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const blockClient = createRpcMesh(baseTarget);
    await blockClient.refreshRanking();
    const currentBlock = await blockClient.getBlockNumber();
    const blockTarget = cloneTarget(baseTarget);
    blockTarget.trigger = {
      mode: "block",
      blockNumber: Number(currentBlock + 1n),
      pollIntervalMs: 250,
    };
    const startedAt = Date.now();
    await waitForTrigger(blockTarget, blockClient, calibration);
    logger.success("Block trigger smoke test passed.", {
      startedFromBlock: currentBlock.toString(),
      targetBlock: String(blockTarget.trigger.blockNumber),
      actualDurationMs: Date.now() - startedAt,
      usedWebSocket: Boolean(blockTarget.chain.rpc.webSocket),
    });
  }

  {
    const readClient = createRpcMesh(baseTarget);
    await readClient.refreshRanking();
    const readTarget = cloneTarget(baseTarget);
    readTarget.trigger = {
      mode: "read",
      contract: WETH_MAINNET,
      abi: ["function decimals() view returns (uint8)"] as unknown as Abi,
      functionName: "decimals",
      operator: "gte",
      expected: 18,
      pollIntervalMs: 250,
    };
    const startedAt = Date.now();
    await waitForTrigger(readTarget, readClient, calibration);
    logger.success("Read trigger smoke test passed.", {
      contract: WETH_MAINNET,
      actualDurationMs: Date.now() - startedAt,
    });
  }

  logger.success("All trigger smoke tests passed.");
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
