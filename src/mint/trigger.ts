import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
import type { PublicClient } from "viem";

import { logger } from "../logger.js";
import type { TargetConfig } from "../types.js";
import type { ClockCalibration } from "./clock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const armBeforeMs = trigger.armBeforeMs ?? 4000;

  return {
    startAtMs,
    armAtMs: startAtMs - Math.max(0, armBeforeMs),
    pollIntervalMs: trigger.pollIntervalMs ?? 200,
    countdownIntervalMs: trigger.countdownIntervalMs ?? 15000,
    finalSpinWindowMs: Math.max(10, trigger.finalSpinWindowMs ?? 125),
  };
}

export async function logClockStatus(target: TargetConfig, client: PublicClient): Promise<void> {
  await logClockStatusWithCalibration(target, client);
}

export async function logClockStatusWithCalibration(
  target: TargetConfig,
  client: PublicClient,
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

function spinUntilTimestamp(targetMs: number): void {
  spinUntilTimestampWithCalibration(targetMs);
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

export async function waitForPreciseFireWindow(target: TargetConfig, calibration?: ClockCalibration): Promise<void> {
  const schedule = getTimeTriggerConfig(target);
  if (!schedule) return;

  const msUntilFinalSpin = schedule.startAtMs - (calibration?.nowMs() ?? Date.now()) - schedule.finalSpinWindowMs;
  if (msUntilFinalSpin > 0) {
    await sleep(msUntilFinalSpin);
  }

  const remainingBeforeSpin = schedule.startAtMs - (calibration?.nowMs() ?? Date.now());
  if (remainingBeforeSpin > 0) {
    logger.info("Final timing window active.", {
      targetTimeIso: new Date(schedule.startAtMs).toISOString(),
      remainingMs: remainingBeforeSpin,
      spinWindowMs: schedule.finalSpinWindowMs,
    });
  }

  spinUntilTimestampWithCalibration(schedule.startAtMs, calibration);
  logger.success("Exact fire time reached.");
}

export async function waitForTrigger(
  target: TargetConfig,
  client: PublicClient,
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

    while (true) {
      const current = await client.getBlockNumber();
      if (current >= BigInt(trigger.blockNumber)) {
        logger.success(`Block trigger reached at block ${current.toString()}.`);
        return;
      }

      await sleep(poll);
    }
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
