import { runPrCreateCommand as runCreate } from "./pr-create.js";
import { fixPrUpdateStaleDocs, runPrUpdateCommand as runUpdate } from "./pr-update.js";

export async function runPrCreateCommand(pi, ctx, args) {
  return runCreate(pi, ctx, args, fixPrUpdateStaleDocs);
}

export async function runPrUpdateCommand(pi, ctx, args) {
  return runUpdate(pi, ctx, args);
}
