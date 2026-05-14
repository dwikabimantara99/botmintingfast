type Level = "INFO" | "WARN" | "ERROR" | "SUCCESS";

function stamp(): string {
  return new Date().toISOString();
}

export function log(level: Level, message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[${stamp()}] [${level}] ${message}`);
    return;
  }

  console.log(`[${stamp()}] [${level}] ${message}`);
  console.log(JSON.stringify(data, null, 2));
}

export const logger = {
  info: (message: string, data?: unknown) => log("INFO", message, data),
  warn: (message: string, data?: unknown) => log("WARN", message, data),
  error: (message: string, data?: unknown) => log("ERROR", message, data),
  success: (message: string, data?: unknown) => log("SUCCESS", message, data),
};
