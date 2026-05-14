import process from "node:process";

import { loadTargetConfig, parseCommand } from "./config.js";
import { logger } from "./logger.js";
import { runFire, runRehearse, runStandby, runStatus, runValidate } from "./mint/engine.js";

async function main(): Promise<void> {
  const { command, targetPath } = parseCommand(process.argv);
  const target = await loadTargetConfig(targetPath);

  if (command === "status") {
    await runStatus(target);
    return;
  }

  if (command === "standby") {
    await runStandby(target);
    return;
  }

  if (command === "validate") {
    await runValidate(target);
    return;
  }

  if (command === "rehearse") {
    await runRehearse(target);
    return;
  }

  await runFire(target);
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
