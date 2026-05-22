import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";

import { logger } from "../logger.js";
import type { TargetConfig } from "../types.js";
import type { ClockCalibration } from "./clock.js";
import type { RpcReadClient } from "./rpcMesh.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWebSocketCtor():
  | (new (url: string | URL, protocols?: string | string[]) => WebSocket)
  | undefined {
  return typeof WebSocket === "undefined" ? undefined : WebSocket;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseHexBlockNumber(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function toComparable(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

function evaluateReadCondition(result: unknown, operator: "eq" | "gte" | "truthy", expected?: unknown): boolean {
  if (operator === "truthy") {
    return Boolean(result);
  }

  if (operator === "eq") {
    return toComparable(result) === toComparable(expected);
  }

  const left = BigInt(String(result));
  const right = BigInt(String(expected));
  return left >= right;
}

function formatRemainingMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function normalizeAbi(abi: Abi | readonly string[]): Abi {
  if (abi.length === 0) {
    return abi as Abi;
  }

  if (typeof abi[0] === "string") {
    return parseAbi(abi as readonly string[]);
  }

  return abi as Abi;
}

export function getTimeTriggerConfig(target: TargetConfig): {
  startAtMs: number;
  armAtMs: number;
  configuredArmBeforeMs: number;
  recommendedArmBeforeMs: number;
  armBeforeMs: number;
  prepBudgetMs: number;
  repriceBeforeMs: number | null;
  repriceAtMs: number | null;
  pollIntervalMs: number;
  countdownIntervalMs: number;
  finalSpinWindowMs: number;
} | null {
  const trigger = target.trigger;
  if (trigger.mode !== "time") return null;

  const startAtMs = new Date(trigger.startTimeIso).getTime();
  if (Number.isNaN(startAtMs)) {
    throw new Error("Invalid trigger.startTimeIso");
  }

  const configuredArmBeforeMs = trigger.armBeforeMs ?? 4000;
  const finalSpinWindowMs = Math.max(10, trigger.finalSpinWindowMs ?? 125);
  const walletCount = target.execution?.walletCount ?? 5;
  const replacementRounds = target.execution?.maxReplacementRounds ?? 3;
  const warmupRounds = target.execution?.warmupRounds ?? 1;
  const rawRepriceBeforeMs = trigger.repriceBeforeMs ?? 900;
  const repriceBeforeMs = rawRepriceBeforeMs > 0 ? rawRepriceBeforeMs : null;
  const prepBudgetMs =
    2000 +
    walletCount * (350 + replacementRounds * 120) +
    Math.max(0, warmupRounds) * 250;
  const recommendedArmBeforeMs = Math.max(
    4500,
    prepBudgetMs + (repriceBeforeMs ?? 0),
    finalSpinWindowMs + 200,
  );
  const armBeforeMs = Math.max(configuredArmBeforeMs, recommendedArmBeforeMs);
  const candidateRepriceAtMs = repriceBeforeMs !== null ? startAtMs - repriceBeforeMs : null;
  const repriceAtMs =
    candidateRepriceAtMs !== null &&
    candidateRepriceAtMs > startAtMs - armBeforeMs &&
    repriceBeforeMs !== null &&
    repriceBeforeMs > finalSpinWindowMs + 25
      ? candidateRepriceAtMs
      : null;

  return {
    startAtMs,
    armAtMs: startAtMs - Math.max(0, armBeforeMs),
    configuredArmBeforeMs,
    recommendedArmBeforeMs,
    armBeforeMs,
    prepBudgetMs,
    repriceBeforeMs,
    repriceAtMs,
    pollIntervalMs: trigger.pollIntervalMs ?? 200,
    countdownIntervalMs: trigger.countdownIntervalMs ?? 15000,
    finalSpinWindowMs,
  };
}

export async function logClockStatus(target: TargetConfig, client: RpcReadClient): Promise<void> {
  await logClockStatusWithCalibration(target, client);
}

export async function logClockStatusWithCalibration(
  target: TargetConfig,
  client: RpcReadClient,
  calibration?: ClockCalibration,
): Promise<void> {
  const schedule = getTimeTriggerConfig(target);
  if (!schedule) return;

  const latestBlock = await client.getBlock();
  const latestBlockTimeMs = Number(latestBlock.timestamp) * 1000;
  const localNow = Date.now();
  const calibratedNow = calibration?.nowMs() ?? localNow;

  logger.info("Clock status.", {
    localTimeIso: new Date(localNow).toISOString(),
    calibratedTimeIso: new Date(calibratedNow).toISOString(),
    targetTimeIso: new Date(schedule.startAtMs).toISOString(),
    millisecondsUntilTarget: schedule.startAtMs - calibratedNow,
    latestBlockTimestampIso: new Date(latestBlockTimeMs).toISOString(),
    chainBlockAgeMs: calibratedNow - latestBlockTimeMs,
    armWindowOpensIso: new Date(schedule.armAtMs).toISOString(),
    configuredArmBeforeMs: schedule.configuredArmBeforeMs,
    effectiveArmBeforeMs: schedule.armBeforeMs,
    recommendedArmBeforeMs: schedule.recommendedArmBeforeMs,
    prepBudgetMs: schedule.prepBudgetMs,
    clockOffsetMs: calibration?.offsetMs ?? 0,
    clockObservedOffsetMs: calibration?.observedOffsetMs ?? 0,
    clockSampleCount: calibration?.sampleCount ?? 0,
    clockSource: calibration?.source ?? "local-clock",
    clockMedianLatencyMs: calibration?.medianLatencyMs ?? 0,
    clockConfidence: calibration?.confidence ?? "low",
  });
}

async function waitUntilTimestamp(
  targetMs: number,
  pollIntervalMs: number,
  countdownIntervalMs: number,
  label: string,
  calibration?: ClockCalibration,
): Promise<void> {
  let lastNoticeAt = 0;

  while (true) {
    const remainingMs = targetMs - (calibration?.nowMs() ?? Date.now());
    if (remainingMs <= 0) {
      return;
    }

    const shouldNotice =
      lastNoticeAt === 0 ||
      remainingMs <= 5000 ||
      lastNoticeAt - remainingMs >= countdownIntervalMs;

    if (shouldNotice) {
      logger.info(`${label} in ${formatRemainingMs(remainingMs)}.`, {
        targetTimeIso: new Date(targetMs).toISOString(),
        remainingMs,
      });
      lastNoticeAt = remainingMs;
    }

    const nextSleep = Math.min(pollIntervalMs, Math.max(remainingMs - 5, 1));
    await sleep(nextSleep);
  }
}

function spinUntilTimestampWithCalibration(targetMs: number, calibration?: ClockCalibration): void {
  if ((calibration?.nowMs() ?? Date.now()) >= targetMs) return;

  while ((calibration?.nowMs() ?? Date.now()) < targetMs) {
    // Intentional short busy wait for the final timing window.
  }
}

export async function waitForArmWindow(target: TargetConfig, calibration?: ClockCalibration): Promise<void> {
  const schedule = getTimeTriggerConfig(target);
  if (!schedule) return;

  await waitUntilTimestamp(
    schedule.armAtMs,
    schedule.pollIntervalMs,
    schedule.countdownIntervalMs,
    "Arm window opens",
    calibration,
  );
  logger.success("Arm window reached.");
}

export async function waitForTimedCheckpoint(
  target: TargetConfig,
  checkpointMs: number,
  label: string,
  calibration?: ClockCalibration,
  quiet = false,
): Promise<void> {
  const schedule = getTimeTriggerConfig(target);
  if (!schedule) return;

  if (quiet) {
    while (true) {
      const remainingMs = checkpointMs - (calibration?.nowMs() ?? Date.now());
      if (remainingMs <= 0) {
        break;
      }

      const nextSleep = Math.min(schedule.pollIntervalMs, Math.max(remainingMs - 5, 1));
      await sleep(nextSleep);
    }
  } else {
    await waitUntilTimestamp(
      checkpointMs,
      schedule.pollIntervalMs,
      schedule.countdownIntervalMs,
      label,
      calibration,
    );
  }

  logger.success(`${label} reached.`);
}

export async function waitForPreciseFireWindow(
  target: TargetConfig,
  calibration?: ClockCalibration,
): Promise<{ targetMs: number; releasedAtMs: number; overshootMs: number } | null> {
  const schedule = getTimeTriggerConfig(target);
  if (!schedule) return null;

  const msUntilFinalSpin = schedule.startAtMs - (calibration?.nowMs() ?? Date.now()) - schedule.finalSpinWindowMs;
  if (msUntilFinalSpin > 0) {
    await sleep(msUntilFinalSpin);
  }

  spinUntilTimestampWithCalibration(schedule.startAtMs, calibration);
  const releasedAtMs = calibration?.nowMs() ?? Date.now();
  return {
    targetMs: schedule.startAtMs,
    releasedAtMs,
    overshootMs: releasedAtMs - schedule.startAtMs,
  };
}

async function waitForBlockTriggerByPolling(client: RpcReadClient, targetBlock: bigint, pollIntervalMs: number): Promise<void> {
  while (true) {
    const current = await client.getBlockNumber();
    if (current >= targetBlock) {
      logger.success(`Block trigger reached at block ${current.toString()}.`);
      return;
    }

    await sleep(pollIntervalMs);
  }
}

async function waitForBlockTriggerByWebSocket(
  webSocketUrl: string,
  targetBlock: bigint,
  stallTimeoutMs: number,
): Promise<void> {
  const WebSocketCtor = getWebSocketCtor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket runtime is unavailable in this Node environment.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let socketClosedByBot = false;
    let subscriptionId: string | undefined;
    let rpcRequestId = 1;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    function clearTimers(): void {
      if (stallTimer) clearTimeout(stallTimer);
      if (openTimer) clearTimeout(openTimer);
    }

    function cleanup(): void {
      clearTimers();
      if (socket) {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      }
    }

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      cleanup();

      if (socket && socket.readyState === socket.OPEN) {
        socketClosedByBot = true;
        socket.close(1000, error ? "fallback-to-polling" : "target-block-reached");
      }

      if (error) {
        reject(error);
        return;
      }

      resolve();
    }

    function refreshStallTimer(): void {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        finish(createTimeoutError(`WebSocket newHeads stalled for more than ${stallTimeoutMs} ms.`));
      }, stallTimeoutMs);
    }

    function handleOpen(): void {
      if (!socket) return;

      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }

      refreshStallTimer();
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcRequestId,
          method: "eth_subscribe",
          params: ["newHeads"],
        }),
      );
      rpcRequestId += 1;
    }

    function handleMessage(event: MessageEvent<string>): void {
      refreshStallTimer();
      const payload = safeParseJson(event.data);
      if (!payload || typeof payload !== "object") {
        return;
      }

      if ("error" in payload && payload.error) {
        finish(new Error(`WebSocket RPC error: ${JSON.stringify(payload.error)}`));
        return;
      }

      if ("result" in payload && typeof payload.result === "string" && subscriptionId === undefined) {
        subscriptionId = payload.result;
        logger.info("WebSocket newHeads subscription confirmed.", {
          subscriptionId,
          targetBlock: targetBlock.toString(),
        });
        return;
      }

      if (
        "method" in payload &&
        payload.method === "eth_subscription" &&
        "params" in payload &&
        payload.params &&
        typeof payload.params === "object"
      ) {
        const params = payload.params as {
          subscription?: unknown;
          result?: {
            number?: unknown;
          };
        };

        if (subscriptionId && params.subscription !== subscriptionId) {
          return;
        }

        const blockNumber = parseHexBlockNumber(params.result?.number);
        if (blockNumber === null) {
          return;
        }

        if (blockNumber >= targetBlock) {
          logger.success(`Block trigger reached by WebSocket at block ${blockNumber.toString()}.`);
          finish();
        }
      }
    }

    function handleError(event: Event): void {
      const message = "error" in event && typeof event.error === "object" && event.error
        ? String(event.error)
        : "WebSocket transport error.";
      finish(new Error(message));
    }

    function handleClose(event: CloseEvent): void {
      if (socketClosedByBot) {
        return;
      }

      finish(new Error(`WebSocket closed before target block. code=${event.code} reason=${event.reason || "unknown"}`));
    }

    socket = new WebSocketCtor(webSocketUrl);
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);

    openTimer = setTimeout(() => {
      finish(createTimeoutError("Timed out waiting for WebSocket connection."));
    }, Math.max(3_000, Math.min(stallTimeoutMs, 10_000)));
  });
}

export async function waitForTrigger(
  target: TargetConfig,
  client: RpcReadClient,
  calibration?: ClockCalibration,
): Promise<void> {
  const trigger = target.trigger;

  if (trigger.mode === "manual") {
    logger.info("Manual trigger selected. Fire command will execute immediately.");
    return;
  }

  if (trigger.mode === "time") {
    const schedule = getTimeTriggerConfig(target);
    if (!schedule) throw new Error("Missing time trigger schedule.");

    await waitUntilTimestamp(
      schedule.startAtMs,
      schedule.pollIntervalMs,
      schedule.countdownIntervalMs,
      "Mint opens",
      calibration,
    );

    logger.success("Time trigger reached.");
    return;
  }

  if (trigger.mode === "block") {
    const poll = trigger.pollIntervalMs ?? 500;
    const targetBlock = BigInt(trigger.blockNumber);
    const current = await client.getBlockNumber();
    if (current >= targetBlock) {
      logger.success(`Block trigger already satisfied at block ${current.toString()}.`);
      return;
    }

    if (target.chain.rpc.webSocket) {
      const stallTimeoutMs = Math.max(15_000, poll * 40);
      logger.info("Waiting for block trigger via WebSocket newHeads.", {
        currentBlock: current.toString(),
        targetBlock: targetBlock.toString(),
        webSocket: target.chain.rpc.webSocket,
        stallTimeoutMs,
      });

      try {
        await waitForBlockTriggerByWebSocket(target.chain.rpc.webSocket, targetBlock, stallTimeoutMs);
        return;
      } catch (error) {
        logger.warn("WebSocket block trigger failed. Falling back to polling.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Waiting for block trigger via polling fallback.", {
      currentBlock: current.toString(),
      targetBlock: targetBlock.toString(),
      pollIntervalMs: poll,
    });
    await waitForBlockTriggerByPolling(client, targetBlock, poll);
    return;
  }

  const poll = trigger.pollIntervalMs ?? 300;
  logger.info("Waiting for read trigger condition.");

  while (true) {
    const calldata = encodeFunctionData({
      abi: normalizeAbi(trigger.abi),
      functionName: trigger.functionName,
      args: trigger.args ?? [],
    });

    const data = await client.call({
      to: trigger.contract,
      data: calldata,
    });

    if (!data.data) {
      await sleep(poll);
      continue;
    }

    const decoded = decodeFunctionResult({
      abi: normalizeAbi(trigger.abi),
      functionName: trigger.functionName,
      data: data.data,
    });

    if (evaluateReadCondition(decoded, trigger.operator, trigger.expected)) {
      logger.success("Read trigger condition satisfied.");
      return;
    }

    await sleep(poll);
  }
}
