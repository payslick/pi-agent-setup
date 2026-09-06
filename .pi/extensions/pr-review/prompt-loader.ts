import { readFileSync } from "node:fs";

export const REVIEW_LANE_PROMPT_IDS = [
  "correctness",
  "relevance",
  "security-api",
  "tests",
  "docs",
  "architecture",
  "code-quality",
  "dedupe",
  "data",
  "performance",
  "ux",
  "dependencies",
  "ci-analysis",
] as const;

export type ReviewLanePromptId = (typeof REVIEW_LANE_PROMPT_IDS)[number];

const SHARED_PROMPT_URL = new URL("./prompts/shared.md", import.meta.url);
const LANE_PROMPT_URLS: Record<ReviewLanePromptId, URL> = {
  correctness: new URL("./prompts/lanes/correctness.md", import.meta.url),
  relevance: new URL("./prompts/lanes/relevance.md", import.meta.url),
  "security-api": new URL("./prompts/lanes/security-api.md", import.meta.url),
  tests: new URL("./prompts/lanes/tests.md", import.meta.url),
  docs: new URL("./prompts/lanes/docs.md", import.meta.url),
  architecture: new URL("./prompts/lanes/architecture.md", import.meta.url),
  "code-quality": new URL("./prompts/lanes/code-quality.md", import.meta.url),
  dedupe: new URL("./prompts/lanes/dedupe.md", import.meta.url),
  data: new URL("./prompts/lanes/data.md", import.meta.url),
  performance: new URL("./prompts/lanes/performance.md", import.meta.url),
  ux: new URL("./prompts/lanes/ux.md", import.meta.url),
  dependencies: new URL("./prompts/lanes/dependencies.md", import.meta.url),
  "ci-analysis": new URL("./prompts/lanes/ci-analysis.md", import.meta.url),
};

export function readSharedReviewLanePrompt(): string {
  return readFileSync(SHARED_PROMPT_URL, "utf8").trim();
}

export function readReviewLanePrompt(laneId: string): string {
  if (!Object.hasOwn(LANE_PROMPT_URLS, laneId)) {
    throw new Error(`No PR review prompt exists for lane: ${laneId}`);
  }
  return readFileSync(LANE_PROMPT_URLS[laneId as ReviewLanePromptId], "utf8").trim();
}
