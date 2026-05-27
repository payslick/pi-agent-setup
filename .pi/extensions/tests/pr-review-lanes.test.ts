import { describe, expect, test } from "bun:test";
import { buildLaneReviewPrompt, routeReviewLanes } from "../pr-review/lanes";
import type { PRMetadata, ReviewLanePacket } from "../pr-review/types";

const pr: PRMetadata = {
  ref: { owner: "acme", repo: "app", number: 42 },
  title: "Add invoice export",
  body: "Exports invoices to CSV for finance users.",
  author: "octo",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  base: { ref: "main", sha: "base" },
  head: { ref: "feature/invoice-export", sha: "head" },
};

const packet: ReviewLanePacket = {
  laneId: "relevance",
  title: "Relevance",
  focus: "Check the PR description against the diff and flag unrelated changes.",
  files: [{ path: "src/export.ts", status: "modified" }],
  hunks: [],
};

describe("pr review lanes", () => {
  test("routes the relevance lane by default and asks it to flag unrelated changes", () => {
    const lanes = routeReviewLanes({ pr, files: packet.files, hunks: [] });
    const relevanceLane = lanes.find((lane) => lane.laneId === "relevance");

    expect(relevanceLane).toBeDefined();
    expect(relevanceLane?.focus).toContain("always report unrelated");
  });

  test("includes PR body in lane prompts", () => {
    const prompt = buildLaneReviewPrompt(pr, packet);

    expect(prompt).toContain("## PR description\nExports invoices to CSV for finance users.");
  });
});
