import { spawn } from "node:child_process";
import process from "node:process";

type StageResult = {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
};

type StageDefinition = {
  name: string;
  args: string[];
  timeoutMs: number;
};

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

async function runStage(stage: StageDefinition): Promise<StageResult> {
  const npmCommand = getNpmCommand();
  const command = [npmCommand, ...stage.args].map(quoteArg).join(" ");
  const startedAt = Date.now();
  let timedOut = false;

  console.log(`\n=== ${stage.name} ===`);
  console.log(command);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
            stdio: "inherit",
            shell: false,
            cwd: process.cwd(),
            env: process.env,
          })
        : spawn(npmCommand, stage.args, {
            stdio: "inherit",
            shell: false,
            cwd: process.cwd(),
            env: process.env,
          });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, stage.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(-1);
    });
  });

  return {
    name: stage.name,
    command,
    ok: exitCode === 0 && !timedOut,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}

async function main(): Promise<void> {
  const targetPath = process.argv[2] ?? "./targets/alchemy-rpc-stack.sample.json";
  const stages: StageDefinition[] = [
    {
      name: "Build",
      args: ["run", "build"],
      timeoutMs: 30_000,
    },
    {
      name: "Status",
      args: ["run", "bot", "--", "status", "--target", targetPath],
      timeoutMs: 55_000,
    },
    {
      name: "Validate",
      args: ["run", "bot", "--", "validate", "--target", targetPath],
      timeoutMs: 70_000,
    },
    {
      name: "Rehearse",
      args: ["run", "bot", "--", "rehearse", "--target", targetPath],
      timeoutMs: 70_000,
    },
    {
      name: "Trigger Smoke",
      args: ["run", "smoke:trigger"],
      timeoutMs: 55_000,
    },
  ];

  const results: StageResult[] = [];

  for (const stage of stages) {
    results.push(await runStage(stage));
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;

  console.log("\n=== Battle Test Summary ===");
  console.log(
    JSON.stringify(
      {
        targetPath,
        passed,
        failed,
        results,
      },
      null,
      2,
    ),
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
