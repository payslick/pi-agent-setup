import { spawnSync } from "node:child_process";

const FIX_FLAG = "--fix";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const fix = args.includes(FIX_FLAG);
const targets = args.filter((arg) => arg !== FIX_FLAG);
const unsupportedArgs = targets.filter((arg) => arg.startsWith("-"));

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (unsupportedArgs.length > 0) {
  console.error(`Unsupported check argument(s): ${unsupportedArgs.join(" ")}`);
  process.exit(1);
}

const lintTargets = targets.length > 0 ? targets : [".pi/extensions", ".pi/scripts"];
run("oxlint", [...(fix ? [FIX_FLAG] : []), ...lintTargets]);

if (targets.length === 0) {
  run("bun", ["run", "typecheck"]);
}
