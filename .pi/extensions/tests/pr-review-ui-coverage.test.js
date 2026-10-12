import { expect, test } from "bun:test";
import { routeReviewLanes } from "../pr-review/runtime/lanes.js";
import { buildReviewSkillCoverage } from "../pr-review/runtime/review-ci.js";
import { renderExecutiveSummary } from "../pr-review/runtime/summary.js";

test("UI reviews retain static UX coverage without an unimplemented browser-testing warning", () => {
  const pr = {
    ref: { owner: "acme", repo: "app", number: 42 },
    title: "Update dialog",
    body: "Improve dialog focus.",
    base: { ref: "main", sha: "base" },
    head: { ref: "dialog", sha: "head" },
  };
  const files = [{ path: "src/components/dialog.tsx", status: "modified" }];
  const lanes = routeReviewLanes({ pr, files, hunks: [] });
  const coverage = buildReviewSkillCoverage({
    prData: { metadata: pr, prNumber: 42, files, hunks: [] },
    lanes,
    agentResults: lanes.map(({ laneId }) => ({ laneId, findings: [] })),
    ciStatus: { checked: true, status: "pass" },
    local: false,
    noAgents: false,
  });
  expect(coverage.items.find(({ id }) => id === "ux")).toMatchObject({ status: "covered" });
  const report = renderExecutiveSummary({
    pr,
    findings: [],
    reviewedLaneIds: lanes.map(({ laneId }) => laneId),
    coverage,
  });
  expect(report).toContain("UX/accessibility");
  expect(report).not.toContain("Conditional live UI testing");
  expect(report).not.toContain("exploratory/browser agents are not launched");
});
