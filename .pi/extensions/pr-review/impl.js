/* oxlint-disable */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const encodedImplementation = (
  await readFile(new URL("./impl.bundle.txt", import.meta.url), "utf8")
).trim();
const runtimeDirectory = new URL("../../../node_modules/.cache/pi-pr-review/", import.meta.url);
const runtimeFileName = `${createHash("sha256").update(encodedImplementation).digest("hex")}.mjs`;
const runtimeImplementationUrl = new URL(runtimeFileName, runtimeDirectory);

await mkdir(runtimeDirectory, { recursive: true });
await writeFile(runtimeImplementationUrl, Buffer.from(encodedImplementation, "base64"));

const implementation = await import(runtimeImplementationUrl.href);

export const parseAgentJson = implementation.parseAgentJson;
export const mergeRenderedIssueGroupRows = implementation.mergeRenderedIssueGroupRows;
export const inferNewLaneProposals = implementation.inferNewLaneProposals;
export const inferLaneImprovementsFromPolicyHints =
  implementation.inferLaneImprovementsFromPolicyHints;
export const extractPolicyHints = implementation.extractPolicyHints;
export const buildReviewAfterProcessPlan = implementation.buildReviewAfterProcessPlan;
export const buildReviewAfterNextActionPrompt = implementation.buildReviewAfterNextActionPrompt;
export const buildReviewAfterNextActionOptions = implementation.buildReviewAfterNextActionOptions;
export default implementation.default;
