import { describe, expect, test } from "bun:test";
import { routeReviewLanes as routeTypedLanes } from "../pr-review/lanes.ts";
import { renderExecutiveSummary as renderTypedSummary } from "../pr-review/summary.ts";
import { routeReviewLanes } from "../pr-review/runtime/lanes.js";
import { buildReviewSkillCoverage } from "../pr-review/runtime/review-ci.js";
import { buildReviewLaneSystemPrompt, reviewAgentToolPolicy } from "../pr-review/runtime/review-agents.js";
import { renderExecutiveSummary } from "../pr-review/runtime/summary.js";

const pr = {
  ref: { owner: "acme", repo: "app", number: 42 },
  title: "Protect payroll close",
  body: "Require company-scoped authorization before closing payroll.",
  base: { ref: "main", sha: "base" },
  head: { ref: "close", sha: "head" },
};
const reviewInput = {
  pr,
  files: [{ path: "src/server/api/payroll.ts", status: "modified" }],
  hunks: [],
};
const buildCoverage = (lanes, agentResults, noAgents = false) => buildReviewSkillCoverage({
  prData: { ...reviewInput, metadata: pr, prNumber: 42 },
  ciStatus: { checked: true, status: "pass" },
  lanes,
  agentResults,
  noAgents,
  local: false,
});
const renderCoverage = (render, coverage) => render({
  pr,
  findings: [],
  reviewedLaneIds: [],
  coverage,
});

const laneIds = [
  "correctness", "pr-metadata", "relevance", "api-safety", "tests", "docs",
  "architecture", "code-quality", "dedupe", "data", "performance", "ux", "dependencies",
];

describe("API safety review contract", () => {
  test.each([
    ["typed", routeTypedLanes],
    ["runtime", routeReviewLanes],
  ])("%s routing accepts the api-safety filter and loads its route-protection checks", (_name, route) => {
    const lanes = route(reviewInput, ["api-safety"]);
    expect(lanes.map((lane) => lane.laneId)).toEqual(["api-safety"]);
    expect(lanes[0].title).toBe("API safety");
    expect(lanes[0].focus).toContain("permissions match the route's operation and resource");
    expect(lanes[0].focus).toContain("ctx is validated");
    expect(lanes[0].focus).toContain("protected by authentication and authorization");
  });

  test("allows scoped context reads to verify protection without an existing finding", () => {
    const policy = reviewAgentToolPolicy("api-safety", false);
    expect(policy.toolsEnabled).toBe(true);
    expect(policy.allowedTools.split(",")).toContain("read-many-files-lines");
    expect(policy.allowedTools.split(",")).not.toContain("bash");
    const prompt = buildReviewLaneSystemPrompt("api-safety", policy.toolsEnabled);
    expect(prompt).toContain("even before identifying a concrete candidate finding");
    expect(prompt).toContain("middleware, context construction, and permission helpers");
    expect(prompt).toContain("Use an empty findings array if there are no issues.");
  });

  test("reports a routed API safety lane with zero findings as covered like other lanes", () => {
    const lanes = routeReviewLanes(reviewInput);
    const results = lanes.map(({ laneId }) => ({ laneId, findings: [] }));
    const coverage = buildCoverage(lanes, results);
    expect(coverage.items.find(({ id }) => id === "api-safety")).toEqual({
      id: "api-safety", label: "API safety", status: "covered", details: "Lane completed.",
    });
    for (const render of [renderTypedSummary, renderExecutiveSummary]) {
      const output = renderCoverage(render, coverage);
      expect(output).toContain("| API safety | ✅ covered | Lane completed. |");
      expect(output).toContain("| Tests review | ✅ covered | Lane completed. |");
    }
  });

  test.each(laneIds)("reports %s execution errors as Failed with their reason", (laneId) => {
    const lanes = [{ laneId, title: laneId }];
    const coverage = buildCoverage(lanes, [{ laneId, findings: [], error: "Agent timed out" }]);
    expect(coverage.items.find(({ id }) => id === laneId)).toMatchObject({
      status: "failed", details: "Agent timed out",
    });
    for (const render of [renderTypedSummary, renderExecutiveSummary]) {
      expect(renderCoverage(render, coverage)).toContain("| ❌ Failed | Agent timed out |");
    }
  });

  test("reports a failed CI-analysis lane launched after initial routing", () => {
    const coverage = buildCoverage([], [{
      laneId: "ci-analysis", findings: [], error: "CI log analysis timed out",
    }]);
    expect(coverage.items.find(({ id }) => id === "ci-analysis")).toMatchObject({
      status: "failed", details: "CI log analysis timed out",
    });
    expect(renderCoverage(renderExecutiveSummary, coverage)).toContain(
      "| ❌ Failed | CI log analysis timed out |",
    );
  });

  test("does not treat recovered findings as a successful lane", () => {
    const coverage = buildCoverage([{ laneId: "api-safety", title: "API safety" }], [{
      laneId: "api-safety", error: "Agent crashed", findings: [{ partial: true }],
    }]);
    expect(coverage.items.find(({ id }) => id === "api-safety")).toMatchObject({
      status: "failed", details: "Agent crashed",
    });
  });

  test("distinguishes unrouted, explicitly skipped, and missing-result lanes", () => {
    const lanes = [{ laneId: "api-safety", title: "API safety" }];
    const status = (coverage) => coverage.items.find(({ id }) => id === "api-safety");
    expect(status(buildCoverage([], []))).toMatchObject({ status: "missing" });
    expect(status(buildCoverage(lanes, [], true))).toMatchObject({ status: "skipped" });
    expect(status(buildCoverage(lanes, []))).toMatchObject({
      status: "failed", details: "Lane did not return a result.",
    });
  });
});
