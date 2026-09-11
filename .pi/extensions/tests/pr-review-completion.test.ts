import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const {
  countPartialFindings,
  countSessionMessages,
  formatReviewAgentProgress,
  formatReviewAgentProgressWidget,
  promptReviewNextAction,
  refreshReviewProgressCounts,
  sessionMessageProgress,
} = await import("../pr-review/runtime/review.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { renderExecutiveSummary } = await import("../pr-review/runtime/summary.js");

const summaryInput = (overrides = {}) => ({
  pr: {
    ref: { owner: "acme", repo: "app", number: 42 },
    title: "Safe change",
    body: "Keeps behavior correct.",
  },
  findings: [],
  reviewedLaneIds: ["correctness"],
  omittedLaneIds: [],
  omittedLaneReasons: [],
  ...overrides,
});

describe("PR review completion", () => {
  test("renders aligned, width-aware live agent progress without truncation", () => {
    const lanes = [
      { laneId: "correctness", title: "Correctness" },
      { laneId: "tests", title: "Tests" },
    ];
    const progress = new Map([
      [
        "correctness",
        {
          phase: "working",
          startedAt: 10_000,
          timeoutStartedAt: 10_000,
          finishedAt: undefined,
          sessionPath: "/tmp/session.jsonl",
          messageCount: 12,
          findingCount: 2,
        },
      ],
      ["tests", { phase: "done", startedAt: 15_000, finishedAt: 25_000, findingCount: 1 }],
    ]);

    expect(formatReviewAgentProgress(lanes, progress, 10_000, 70_000)).toBe(
      "Review 1/2 • 1 active • 0 failed • 01:00",
    );
    const narrow = formatReviewAgentProgressWidget(
      lanes,
      progress,
      10_000,
      1_800_000,
      70_000,
      70,
    );
    expect(narrow).toHaveLength(4);
    expect(narrow[2]?.indexOf("working")).toBe(narrow[3]?.indexOf("done"));
    expect(narrow[2]).toContain("01:00(12)");
    expect(narrow[2]).not.toContain("msg:");
    expect(narrow[2]).toContain("found:2");
    expect(narrow.join("\n")).not.toContain("left");

    const wide = formatReviewAgentProgressWidget(
      lanes,
      progress,
      10_000,
      1_800_000,
      1_550_000,
      240,
    );
    expect(wide).toHaveLength(3);
    expect(wide[2]).toContain("Correctness");
    expect(wide[2]).toContain("Tests");
    expect(wide[2]).toContain("25:40(12)");
    expect(wide[2]).toContain("timeout 04:20");
    expect(wide[2]?.trimEnd()).toBe(wide[2]);
    expect(wide.join("\n")).not.toContain("widget truncated");

    progress.set("correctness", {
      ...progress.get("correctness"),
      timeoutStartedAt: 10_000,
      lastMessageAt: 1_540_000,
    });
    const extended = formatReviewAgentProgressWidget(
      lanes,
      progress,
      10_000,
      1_800_000,
      1_550_000,
      240,
      600_000,
    );
    expect(extended.join("\n")).not.toContain("timeout");

    const fourLanes = [
      ...lanes,
      { laneId: "data", title: "Data" },
      { laneId: "docs", title: "Docs" },
    ];
    const fourProgress = new Map(
      fourLanes.map((lane) => [lane.laneId, { phase: "queued", startedAt: 10_000 }]),
    );
    expect(
      formatReviewAgentProgressWidget(
        fourLanes,
        fourProgress,
        10_000,
        1_800_000,
        70_000,
        400,
      ),
    ).toHaveLength(3);
  });

  test("does not let partial-file polling overwrite an authoritative final count", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pr-review-progress-"));
    try {
      const partialFindingsPath = path.join(temporaryDirectory, "partial-findings.jsonl");
      await writeFile(partialFindingsPath, "", "utf8");
      const progress = new Map([
        ["tests", { phase: "working", findingCount: 0, partialFindingsPath }],
      ]);
      const refresh = refreshReviewProgressCounts(progress);
      progress.set("tests", { phase: "done", findingCount: 3, partialFindingsPath });
      await refresh;
      expect(progress.get("tests")?.findingCount).toBe(3);
      await refreshReviewProgressCounts(progress);
      expect(progress.get("tests")?.findingCount).toBe(3);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("counts complete session messages and unique partial findings", () => {
    const session = [
      { type: "session" },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ];
    const timestampedSession = [
      { ...session[0], timestamp: "2026-09-04T10:00:00.000Z" },
      { ...session[1], timestamp: "2026-09-04T10:01:00.000Z" },
      { ...session[2], timestamp: "2026-09-04T10:02:00.000Z" },
    ];
    const sessionContent = `${timestampedSession.map(JSON.stringify).join("\n")}\n{"partial"`;
    expect(countSessionMessages(sessionContent)).toBe(2);
    expect(sessionMessageProgress(sessionContent)).toEqual({
      messageCount: 2,
      lastMessageAt: Date.parse("2026-09-04T10:02:00.000Z"),
    });
    expect(
      countPartialFindings(
        [
          { path: "src/a.ts", line: 1, title: "First" },
          { path: "src/a.ts", line: 1, title: "First" },
          { path: "src/b.ts", line: 2, title: "Second" },
          { title: "Metadata-only finding" },
        ]
          .map((finding) => JSON.stringify(finding))
          .join("\n"),
      ),
    ).toBe(3);
  });

  test("recommends approval and skips the action picker when a complete review finds no issues", async () => {
    let selectCalls = 0;
    const input = summaryInput();
    const summary = renderExecutiveSummary(input);

    await promptReviewNextAction(
      {},
      {
        hasUI: true,
        ui: {
          select: async () => {
            selectCalls += 1;
            return undefined;
          },
        },
      },
      {},
      input,
    );

    expect(summary).toContain("No issues found. Recommendation: approve the PR.");
    expect(selectCalls).toBe(0);
  });

  test("does not recommend approval or offer finding actions when review lanes were omitted", async () => {
    let selectCalls = 0;
    const input = summaryInput({
      reviewedLaneIds: [],
      omittedLaneIds: ["correctness"],
      omittedLaneReasons: [{ laneId: "correctness", reason: "startup failed" }],
    });
    const summary = renderExecutiveSummary(input);

    await promptReviewNextAction(
      {},
      {
        hasUI: true,
        ui: {
          select: async () => {
            selectCalls += 1;
            return undefined;
          },
        },
      },
      {},
      input,
    );

    expect(summary).toContain("Review incomplete: 1 lane(s) were omitted or failed.");
    expect(summary).not.toContain("Recommendation: approve the PR.");
    expect(selectCalls).toBe(0);
  });
});
