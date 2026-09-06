import { describe, expect, test } from "bun:test";
import { buildLaneReviewPrompt, routeReviewLanes } from "../pr-review/lanes";
import {
  readReviewLanePrompt,
  readSharedReviewLanePrompt,
  REVIEW_LANE_PROMPT_IDS,
} from "../pr-review/prompt-loader";
import {
  filterReviewFindings,
  filterReviewPatch,
  isExcludedReviewPath,
} from "../pr-review/review-scope";
import type { DiffHunk, PRMetadata, ReviewLanePacket } from "../pr-review/types";

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
  test("loads shared and per-lane instructions from Markdown", () => {
    expect(readSharedReviewLanePrompt()).toContain("# PR review lane agent");
    for (const laneId of REVIEW_LANE_PROMPT_IDS) {
      const prompt = readReviewLanePrompt(laneId);
      expect(prompt).toStartWith("## ");
      expect(prompt).toContain("### Report only when");
      expect(prompt).toContain("### Evidence required");
      expect(prompt).toContain("### Do not report");
    }
    expect(readReviewLanePrompt("tests")).toContain("## Tests lane");
  });

  test("rejects lanes without a Markdown prompt", () => {
    expect(() => readReviewLanePrompt("missing-lane")).toThrow(
      "No PR review prompt exists for lane: missing-lane",
    );
  });

  test("routes the relevance lane with a material scope threshold", () => {
    const lanes = routeReviewLanes({ pr, files: packet.files, hunks: [] });
    const relevanceLane = lanes.find((lane) => lane.laneId === "relevance");

    expect(relevanceLane).toBeDefined();
    expect(relevanceLane?.focus).toContain("adds meaningful review, release, or rollback risk");
    expect(relevanceLane?.focus).toContain("not a prerequisite or supporting refactor");
  });

  test("routes dedupe lane and asks it to search for reusable code", () => {
    const lanes = routeReviewLanes({ pr, files: packet.files, hunks: [] });
    const dedupeLane = lanes.find((lane) => lane.laneId === "dedupe");

    expect(dedupeLane).toBeDefined();
    expect(dedupeLane?.focus).toContain("project_index_search");
    expect(dedupeLane?.focus).toBe(readReviewLanePrompt("dedupe"));

    const prompt = buildLaneReviewPrompt(pr, {
      ...packet,
      laneId: "dedupe",
      title: dedupeLane?.title ?? "Dedupe / reuse",
      focus: dedupeLane?.focus ?? "",
    });

    expect(prompt).not.toContain("## Dedupe/reuse lane");
  });

  test("excludes drizzle files and hunks from every lane", () => {
    const files = [
      ...packet.files,
      { path: "drizzle/0099_generated.sql", status: "added" as const },
    ];
    const hunks = [
      { filePath: "src/export.ts", lines: [] },
      { filePath: "drizzle/0099_generated.sql", lines: [] },
    ] as unknown as DiffHunk[];
    const lanes = routeReviewLanes({ pr, files, hunks });

    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.every((lane) => lane.files.every((file) => !file.path.startsWith("drizzle/"))))
      .toBeTrue();
    expect(lanes.every((lane) => lane.hunks.every((hunk) => !hunk.filePath.startsWith("drizzle/"))))
      .toBeTrue();
    expect(
      filterReviewPatch(
        "diff --git a/drizzle/0099_generated.sql b/drizzle/0099_generated.sql\n+sql\n" +
          "diff --git a/src/export.ts b/src/export.ts\n+code\n",
      ),
    ).toBe("diff --git a/src/export.ts b/src/export.ts\n+code\n");
  });

  test("filters normalized findings without assuming a top-level path", () => {
    const findings = [
      { location: { filePath: "src/export.ts" }, title: "Keep" },
      { location: { filePath: "drizzle/0099_generated.sql" }, title: "Exclude" },
      { title: "No location" },
    ];

    expect(isExcludedReviewPath(undefined)).toBeFalse();
    expect(filterReviewFindings(findings).map((finding) => finding.title)).toEqual([
      "Keep",
      "No location",
    ]);
  });

  test("advertises append-only partial finding progress", () => {
    const prompt = buildLaneReviewPrompt(pr, packet, {
      sharedDir: "tmp/session/shared",
      laneDir: "tmp/session/relevance",
      sharedFiles: [],
      partialFindingsFile: "tmp/session/relevance/partial-findings.jsonl",
    });

    expect(prompt).toContain("Live partial findings: tmp/session/relevance/partial-findings.jsonl");
    expect(prompt).toContain("Artifact paths are references, not a reading checklist");
    expect(prompt).toContain("unless a specific truncated hunk requires omitted context");
    expect(prompt).not.toContain("Read shared data before using tools");
    expect(prompt).toContain("Use `read` or `read-many-files-lines`");
    expect(prompt).toContain("Reserve `get_data` for bounded cross-file investigation");
    expect(prompt).toContain("`report_pr_review_finding`");
    expect(prompt).toContain("does not replace the final JSON response");
  });

  test("includes PR body in lane prompts", () => {
    const prompt = buildLaneReviewPrompt(pr, packet);

    expect(prompt).toContain("## PR description\nExports invoices to CSV for finance users.");
  });

  test("requires concise code-first GitHub comments", () => {
    const prompt = buildLaneReviewPrompt(pr, packet);

    expect(prompt).toContain("Prefer an exact `replacement`, then an illustrative `example`");
    expect(prompt).toContain("within 400 characters and two short sentences");
    expect(prompt).toContain('"replacement":"exact raw replacement code"');
    expect(prompt).toContain('"example":{"language":"ts"');
  });
});
