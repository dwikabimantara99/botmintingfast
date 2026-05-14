import { probeEndpoint } from "./broadcast.js";

export type ClockCalibration = {
  offsetMs: number;
  observedOffsetMs: number;
  sampleCount: number;
  medianLatencyMs: number;
  sampledAtMs: number;
  source: "rpc-date-header" | "local-clock";
  confidence: "low" | "medium" | "high";
  nowMs: () => number;
  endpointSamples: Array<{
    endpoint: string;
    latencyMs: number;
    clockOffsetMs?: number;
  }>;
};

function median(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }

  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export async function calibrateClock(endpoints: string[]): Promise<ClockCalibration> {
  const uniqueEndpoints = Array.from(new Set(endpoints));
  const probes = await Promise.all(uniqueEndpoints.map((endpoint) => probeEndpoint(endpoint)));
  const healthyOffsets = probes
    .filter((probe) => probe.ok && probe.clockOffsetMs !== undefined)
    .map((probe) => probe.clockOffsetMs!);
  const healthyLatencies = probes.filter((probe) => probe.ok).map((probe) => probe.latencyMs);
  const observedOffsetMs = healthyOffsets.length > 0 ? median(healthyOffsets) : 0;
  const offsetSpreadMs =
    healthyOffsets.length > 1 ? Math.max(...healthyOffsets) - Math.min(...healthyOffsets) : 0;
  const confidence =
    healthyOffsets.length >= 3 && offsetSpreadMs <= 150 && (healthyLatencies.length > 0 ? median(healthyLatencies) : 0) <= 100
      ? "high"
      : healthyOffsets.length >= 2 && offsetSpreadMs <= 400
        ? "medium"
        : "low";
  const offsetMs = confidence === "high" ? observedOffsetMs : 0;
  const sampledAtMs = Date.now();
  const perfSampledAt = performance.now();

  return {
    offsetMs,
    observedOffsetMs,
    sampleCount: healthyOffsets.length,
    medianLatencyMs: healthyLatencies.length > 0 ? median(healthyLatencies) : 0,
    sampledAtMs,
    source: healthyOffsets.length > 0 ? "rpc-date-header" : "local-clock",
    confidence,
    nowMs: () => sampledAtMs + (performance.now() - perfSampledAt) + offsetMs,
    endpointSamples: probes.map((probe) => {
      const sample: {
        endpoint: string;
        latencyMs: number;
        clockOffsetMs?: number;
      } = {
        endpoint: probe.endpoint,
        latencyMs: probe.latencyMs,
      };

      if (probe.clockOffsetMs !== undefined) {
        sample.clockOffsetMs = probe.clockOffsetMs;
      }

      return sample;
    }),
  };
}
