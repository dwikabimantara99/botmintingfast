import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
const telemetryDir = join(process.cwd(), "telemetry");
const telemetryFile = join(telemetryDir, `session-${sessionId}.jsonl`);

export async function emitTelemetry(event: string, data?: unknown): Promise<void> {
  await mkdir(telemetryDir, { recursive: true });
  await appendFile(
    telemetryFile,
    JSON.stringify({
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
