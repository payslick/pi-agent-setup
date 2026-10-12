import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2).filter((argument) => argument !== "--");
const result = spawnSync("bun", ["test", ...(targets.length ? targets : ["./.pi/extensions"])], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
