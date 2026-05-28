import { describe, expect, test } from "bun:test";
import {
  buildReviewAfterNextActionOptions,
  buildReviewAfterNextActionPrompt,
  buildReviewAfterProcessPlan,
  extractPolicyHints,
  inferLaneImprovementsFromPolicyHints,
  inferNewLaneProposals,
} from "../pr-review/index";
import type { AfterReviewAnalysisResult, PRMetadata, ReviewComment } from "../pr-review/types";

const comments: ReviewComment[] = [
  {
    id: "c1",
    databaseId: 1,
    body: "NEVER return raw IDs in validation errors.",
    path: "src/api/user.ts",
    line: 42,
    author: { login: "reviewer" },
    url: "https://example.com/c1",
  },
  {
    id: "c2",
    databaseId: 2,
    body: "ALWAYS add a regression test to guard this behavior from recurring.",
    path: "tests/user.test.ts",
    line: 10,
    author: { login: "reviewer" },
    url: "https://example.com/c2",
  },
  {
    id: "c3",
    databaseId: 3,
    body: "ANTIPATTERN: schema constraints drift from API validation.",
    path: "src/server/schema.ts",
    line: 88,
    author: { login: "reviewer" },
    url: "https://example.com/c3",
  },
];

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

function afterAnalysis(
  overrides: Partial<AfterReviewAnalysisResult> = {},
): AfterReviewAnalysisResult {
  return {
    prNumber: 42,
    analyzedAt: "2026-01-01T00:00:00.000Z",
    threadsAnalyzed: 2,
    commentsAnalyzed: 3,
    analyses: [],
    laneImprovements: [],
    newLaneProposals: [],
    designRuleProposals: [],
    policyHints: [],
    ...overrides,
  };
}

describe("pr review after", () => {
  test("extracts only all-caps policy hints from reviewer language", () => {
    const hints = extractPolicyHints(comments);
    const patterns = hints.map((hint) => hint.pattern);

    expect(patterns).toContain("NEVER");
    expect(patterns).toContain("ALWAYS");
    expect(patterns).toContain("ANTIPATTERN");
    expect(hints.some((hint) => hint.commentId === "c1")).toBeTrue();
  });

  test("ignores lowercase, mixed-case, and retired policy wording", () => {
    const hints = extractPolicyHints([
      {
        id: "ignored",
        databaseId: 4,
        body: "never, Always, Antipattern, must, should, and prevent this behavior are not policy markers.",
        author: { login: "reviewer" },
        url: "https://example.com/ignored",
      },
    ]);

    expect(hints).toEqual([]);
  });

  test("infers practical lane improvements from policy hints", () => {
    const hints = extractPolicyHints(comments);
    const improvements = inferLaneImprovementsFromPolicyHints(hints);
    const laneIds = improvements.map((item) => item.laneId);

    expect(laneIds).toContain("security-api");
    expect(laneIds).toContain("tests");
    expect(laneIds).toContain("data");
  });

  test("proposes regression-guards lane when repeated all-caps policy hints appear", () => {
    const hints = extractPolicyHints(comments);
    const proposals = inferNewLaneProposals(hints);

    expect(proposals.length).toBe(1);
    expect(proposals[0]?.proposedLaneId).toBe("regression-guards");
    expect(proposals[0]?.evidenceCommentIds.length).toBeGreaterThanOrEqual(3);
  });

  test("builds post-review next-action options from available improvements", () => {
    expect(buildReviewAfterNextActionOptions(afterAnalysis())).toEqual(["fix reviewer issues"]);

    const options = buildReviewAfterNextActionOptions(
      afterAnalysis({
        laneImprovements: [
          {
            laneId: "security-api",
            proposedImprovement: "Check validation error payloads for raw ID exposure.",
            rationale: "Reviewer flagged raw IDs.",
            affectedCommentIds: ["c1"],
          },
        ],
        newLaneProposals: [
          {
            proposedLaneId: "regression-guards",
            title: "Regression guards",
            focus: "Require explicit guardrails for recurring reviewer concerns.",
            relevantPattern: "Repeated policy comments.",
            rationale: "Multiple comments ask to prevent recurrence.",
            evidenceCommentIds: ["c1", "c2", "c3"],
          },
        ],
        designRuleProposals: [
          {
            ruleId: "no-inline-render-iife",
            title: "Avoid inline render IIFEs",
            antipattern: "Inline render IIFEs hide control flow.",
            suggestion: "Use a named helper or component.",
            severity: "warning",
            category: "react",
            implementation: "eslint-rule",
            targetPath: "dev/eslint/rules/no-inline-render-iife.ts",
            evidenceCommentIds: ["c3"],
          },
        ],
      }),
    );

    expect(options).toContain("update review lanes");
    expect(options).toContain("update design/eslint rules");
  });

  test("builds post-review process plan for rule comments and non-rule groups", () => {
    const hints = extractPolicyHints(comments);
    const plan = buildReviewAfterProcessPlan({
      comments,
      policyHints: hints,
      designRuleProposals: [
        {
          ruleId: "review-no-raw-ids",
          title: "Do not expose raw IDs",
          antipattern: "NEVER return raw IDs in validation errors.",
          suggestion: "Return safe validation messages.",
          severity: "error",
          category: "eslint",
          implementation: "eslint-rule",
          targetPath: "dev/eslint/rules/review-no-raw-ids.ts",
          evidenceCommentIds: ["c1"],
        },
      ],
      preferEslintRules: true,
      analyses: comments.map((comment) => ({
        commentId: comment.id,
        priority: "action_required",
        theme: comment.id === "c3" ? "Data and types" : "Security/API safety",
        summary: comment.body,
        confidence: 0.9,
      })),
    });

    expect(plan.ruleTasks.map((task) => task.commentId)).toEqual(["c1", "c2"]);
    expect(plan.ruleTasks[0]?.targetPathHint).toBe("dev/eslint/rules/review-no-raw-ids.ts");
    expect(plan.commentGroups.flatMap((group) => group.commentIds)).toContain("c3");

    const options = buildReviewAfterNextActionOptions(afterAnalysis(), plan);
    expect(options[0]).toBe("start post-review workflow");
  });

  test("builds post-review next-action prompts", () => {
    const fixPrompt = buildReviewAfterNextActionPrompt("fix reviewer issues", pr, afterAnalysis());

    expect(fixPrompt).toContain("fix reviewer-requested issues");
    expect(fixPrompt).toContain("PR #42");
    expect(fixPrompt).toContain("Do not update review lanes or rules");

    const lanePrompt = buildReviewAfterNextActionPrompt(
      "update review lanes",
      pr,
      afterAnalysis({
        laneImprovements: [
          {
            laneId: "security-api",
            proposedImprovement: "Check validation error payloads for raw ID exposure.",
            rationale: "Reviewer flagged raw IDs.",
            affectedCommentIds: ["c1"],
          },
        ],
        newLaneProposals: [
          {
            proposedLaneId: "regression-guards",
            title: "Regression guards",
            focus: "Require explicit guardrails for recurring reviewer concerns.",
            relevantPattern: "Repeated policy comments.",
            rationale: "Multiple comments ask to prevent recurrence.",
            evidenceCommentIds: ["c1", "c2", "c3"],
          },
        ],
      }),
    );

    expect(lanePrompt).toContain("security-api");
    expect(lanePrompt).toContain("regression-guards");

    const rulePrompt = buildReviewAfterNextActionPrompt(
      "update design/eslint rules",
      pr,
      afterAnalysis({
        designRuleProposals: [
          {
            ruleId: "no-inline-render-iife",
            title: "Avoid inline render IIFEs",
            antipattern: "Inline render IIFEs hide control flow.",
            suggestion: "Use a named helper or component.",
            severity: "warning",
            category: "react",
            implementation: "eslint-rule",
            targetPath: "dev/eslint/rules/no-inline-render-iife.ts",
            evidenceCommentIds: ["c3"],
          },
        ],
      }),
    );

    expect(rulePrompt).toContain("no-inline-render-iife");
    expect(rulePrompt).toContain("ESLint");
  });
});
