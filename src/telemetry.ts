import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
const telemetryDir = join(process.cwd(), "telemetry");
const telemetryFile = join(telemetryDir, `session-${sessionId}.jsonl`);

function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) =>
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
  );
}

export async function emitTelemetry(event: string, data?: unknown): Promise<void> {
  await mkdir(telemetryDir, { recursive: true });
  await appendFile(
    telemetryFile,
    stringifySafe({
      at: new Date().toISOString(),
      event,
      data,
    }) + "\n",
    "utf8",
  );
}

export function emitTelemetrySafe(event: string, data?: unknown): void {
  void emitTelemetry(event, data).catch(() => {
    // Telemetry should never block the fire path.
  });
}

export function getTelemetryPath(): string {
  return telemetryFile;
}
