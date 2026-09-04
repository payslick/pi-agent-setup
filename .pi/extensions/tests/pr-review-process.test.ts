import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reviewProcessAnalysisTimeout,
  reviewProcessPatternTimeout,
} from "../pr-review/process-agents";
import {
  buildImmediateFixPrompt,
  buildPrioritizedReviewPlan,
  buildReviewDiscussions,
  buildReviewPolicies,
  formatProcessProgress,
  renderPostReviewReport,
} from "../pr-review/process";
import {
  buildLocalPiRefinement,
  linkPiConfig,
  policyAgentPiArgs,
  POLICY_ACTION_LABELS,
} from "../pr-review/policy-actions";
import type {
  PostReviewAnalysis,
  PRMetadata,
  PrReviewComments,
  ReviewComment,
} from "../pr-review/types";

const pr: PRMetadata = {
  ref: { owner: "acme", repo: "app", number: 42 },
  title: "Protect invoice export",
  body: "Prevents invoice data from crossing tenant boundaries.",
  author: "octo",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  base: { ref: "main", sha: "base" },
  head: { ref: "feature/invoice-export", sha: "head" },
};

const comment = (id: string, body: string, path = "src/invoices.ts", line = 20): ReviewComment => ({
  id,
  databaseId: Number(id.replace(/\D/g, "")) || 1,
  body,
  path,
  line,
  author: { login: "reviewer" },
  authorAssociation: "MEMBER",
  url: `https://github.com/acme/app/pull/42#discussion_r${id}`,
});

const reviewComments: PrReviewComments = {
  viewerLogin: "owner",
  reviewThreads: [
    {
      id: "thread-1",
      isResolved: false,
      comments: [
        comment("c1", "NEVER expose invoice IDs in validation errors."),
        comment("c2", "Agreed; the message can be generic."),
      ],
    },
    {
      id: "thread-2",
      isResolved: false,
      comments: [comment("c3", "This typo should be corrected.", "src/copy.ts", 8)],
    },
    {
      id: "thread-3",
      isResolved: false,
      comments: [
        comment("c4", "NEVER expose invoice IDs in validation errors.", "src/export.ts", 31),
      ],
    },
    {
      id: "thread-4",
      isResolved: false,
      comments: [comment("c5", "ANTIPATTERN: forms duplicate API schema types.")],
    },
  ],
  comments: [],
};

const analysis = (
  discussionId: string,
  priority: PostReviewAnalysis["priority"],
  overrides: Partial<PostReviewAnalysis> = {},
): PostReviewAnalysis => ({
  discussionId,
  priority,
  category: "correctness",
  theme: "Behavior correctness",
  summary: `Summary for ${discussionId}`,
  risk: `Risk for ${discussionId}`,
  priorityRationale: `Rationale for ${priority}`,
  disposition: priority === "P3" ? "defer" : "fix",
  suggestedSolution: `Fix ${discussionId}`,
  confidence: 0.9,
  ...overrides,
});

describe("terminal-first PR review process", () => {
  test("uses ten-minute analysis and policy timeouts unless configured", () => {
    expect(reviewProcessAnalysisTimeout({})).toBe(600_000);
    expect(reviewProcessPatternTimeout({})).toBe(600_000);
    expect(
      reviewProcessAnalysisTimeout({ PI_REVIEW_PROCESS_ANALYSIS_TIMEOUT_MS: "900000" }),
    ).toBe(900_000);
    expect(
      reviewProcessPatternTimeout({ PI_REVIEW_PROCESS_PATTERN_TIMEOUT_MS: "1200000" }),
    ).toBe(1_200_000);

    expect(
      reviewProcessAnalysisTimeout({ PI_REVIEW_PROCESS_ANALYSIS_TIMEOUT_MS: "invalid" }),
    ).toBe(600_000);
    expect(
      reviewProcessPatternTimeout({ PI_REVIEW_PROCESS_PATTERN_TIMEOUT_MS: "invalid" }),
    ).toBe(600_000);
  });

  test("shows elapsed phase and active review-agent count", () => {
    expect(formatProcessProgress("classifying", 65_000, 1, "14 discussions")).toBe(
      "⏳:classifying 1:05 14 discussions review-agents:1",
    );
  });

  test("sorts discussions by merge risk instead of GitHub order", () => {
    const discussions = buildReviewDiscussions(reviewComments);
    const plan = buildPrioritizedReviewPlan(
      discussions,
      [
        analysis("thread-1", "P1"),
        analysis("thread-2", "P3"),
        analysis("thread-3", "P0"),
        analysis("thread-4", "P2"),
      ],
      [],
      reviewComments.viewerLogin,
    );

    expect(plan.analyses.map(({ priority }) => priority)).toEqual(["P0", "P1", "P2", "P3"]);
  });

  test("deduplicates ALWAYS and NEVER policies without promoting ANTIPATTERN", () => {
    const discussions = buildReviewDiscussions(reviewComments);
    const analyses = discussions.map(({ id }) => analysis(id, "P1"));
    const policies = buildReviewPolicies(discussions, analyses);

    expect(policies).toHaveLength(1);
    expect(policies[0]?.statement).toBe("NEVER expose invoice IDs in validation errors");
    expect(policies[0]?.commentIds).toEqual(["c1", "c4"]);
    expect(policies[0]?.discussionIds).toEqual(["thread-1", "thread-3"]);
  });

  test("renders reviewer context, risk, disposition, and pattern estimates", () => {
    const discussions = buildReviewDiscussions(reviewComments);
    const analyses = discussions.map(({ id }, index) => analysis(id, index ? "P2" : "P0"));
    const policies = buildReviewPolicies(discussions, analyses).map((policy) => ({
      ...policy,
      estimate: {
        confirmedCount: 4,
        probableCount: 7,
        searchScope: "all source files",
        confidence: 0.88,
        pattern: "validation errors containing raw IDs",
        matches: [],
      },
    }));
    const report = renderPostReviewReport(
      pr,
      buildPrioritizedReviewPlan(discussions, analyses, policies, reviewComments.viewerLogin),
      {
        currentBranch: "feature/invoice-export",
        prBranch: "feature/invoice-export",
        matches: true,
      },
    );

    expect(report).toContain(
      "| Priority | Reviewer | Handling | Location | Risk | Disposition | Summary |",
    );
    expect(report).toContain("[reviewer](https://github.com/acme/app/pull/42#discussion_rc1)");
    expect(report).toContain("Risk for thread-1");
    expect(report).toContain("4 confirmed");
    expect(report).toContain("7 probable");
  });

  test("includes mandatory policy fixes when long-term policy action is deferred", () => {
    const discussions = buildReviewDiscussions(reviewComments);
    const analyses = discussions.map(({ id }) => analysis(id, "P2"));
    const policies = buildReviewPolicies(discussions, analyses);
    const plan = buildPrioritizedReviewPlan(
      discussions,
      analyses,
      policies,
      reviewComments.viewerLogin,
    );
    const prompt = buildImmediateFixPrompt(
      pr,
      plan,
      {
        approvedDiscussionIds: [],
        policyDecisions: policies.map((policy) => ({
          policyId: policy.id,
          action: "defer",
          statement: policy.statement,
        })),
      },
      [],
      {
        currentBranch: "feature/invoice-export",
        prBranch: "feature/invoice-export",
        matches: true,
      },
    );

    expect(prompt).toContain("mandatory immediate fixes");
    expect(prompt).toContain("NEVER expose invoice IDs in validation errors");
    expect(prompt).toContain("Long-term choice: defer");
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain("thread-3");
  });

  test("treats viewer comments as mandatory commands and excludes AI-IGNORE", () => {
    const viewerCommand = {
      ...comment("c6", "Rename this helper to describe its side effect."),
      author: { login: "OWNER" },
    };
    const ignoredCommand = {
      ...comment("c7", "  AI-IGNORE keep this note for humans."),
      author: { login: "owner" },
    };
    const discussions = buildReviewDiscussions({
      viewerLogin: "owner",
      reviewThreads: [
        { id: "thread-command", isResolved: false, comments: [viewerCommand] },
        { id: "thread-ignored", isResolved: false, comments: [ignoredCommand] },
      ],
      comments: [],
    });
    const plan = buildPrioritizedReviewPlan(
      discussions,
      [analysis("thread-command", "P3", { disposition: "defer" })],
      [],
      "owner",
    );
    const prompt = buildImmediateFixPrompt(
      pr,
      plan,
      { approvedDiscussionIds: [], policyDecisions: [] },
      [],
      {
        currentBranch: "feature/invoice-export",
        prBranch: "feature/invoice-export",
        matches: true,
      },
    );

    expect(discussions.map(({ id }) => id)).toEqual(["thread-command"]);
    expect(plan.commandCommentIds).toEqual(["c6"]);
    expect(plan.analyses[0]?.disposition).toBe("fix");
    expect(prompt).toContain("Every included comment by @owner is an actionable command");
    expect(prompt).toContain("review comment databaseId=6 id=c6");
    expect(prompt).toContain("summary intended to replace each @owner command comment");
    expect(prompt).toContain("Do not edit the original comment yet");
    expect(prompt).toContain("pulls/comments/{databaseId}");
    expect(prompt).toContain("Reply normally to comments by every other author");
    expect(prompt).toContain("Before committing, pushing, editing comments, posting replies");
    expect(prompt).toContain("present a pre-publish summary");
    expect(prompt).toContain("run `hunk diff`");
    expect(prompt).toContain("tracked and untracked changes");
    expect(prompt).toContain("ask exactly once whether you may commit and push the changes");
    expect(prompt).toContain(
      "do not perform any of those publication actions before explicit approval",
    );
    expect(prompt).toContain("Verify that GitHub reports the PR head SHA equal to local HEAD");
    expect(prompt).toContain("stop without mutating GitHub comments or threads");
    expect(prompt).toContain("Only after the verified push");
    expect(prompt).toContain("Refetch the PR comments after publication");
    expect(prompt).toContain("End the process with a clear final summary");
    expect(prompt).toContain(
      "Never report a planned, queued, unverified, or failed action as completed",
    );
  });

  test("requires a predicted failing regression test before correctness or security fixes", () => {
    const discussions = buildReviewDiscussions(reviewComments);
    const analyses = discussions.map(({ id }) =>
      analysis(id, "P0", { category: id === "thread-2" ? "other" : "security" }),
    );
    const plan = buildPrioritizedReviewPlan(discussions, analyses, [], reviewComments.viewerLogin);
    const prompt = buildImmediateFixPrompt(
      pr,
      plan,
      { approvedDiscussionIds: ["thread-1"], policyDecisions: [] },
      [],
      {
        currentBranch: "feature/invoice-export",
        prBranch: "feature/invoice-export",
        matches: true,
      },
    );

    expect(prompt).toContain("## Pre-edit all-comment pattern review");
    expect(prompt).toContain(
      "Do not make any code, test, configuration, documentation, or generated-file change",
    );
    expect(prompt).toContain("reviewed every comment in the complete included PR comment inventory");
    expect(prompt).toContain("inspect the full PR diff and all PR-changed files");
    expect(prompt).toContain("every place it applies within the PR");
    expect(prompt).toContain("including uncommented occurrences");
    expect(prompt).toContain("### thread-2 — context only—not independently approved");
    expect(prompt).toContain("This typo should be corrected");
    expect(prompt).toContain("## Correctness and security test-first protocol");
    expect(prompt).toContain("do not edit related production code");
    expect(prompt).toContain("Immediately before running it, tell the user");
    expect(prompt).toContain("concrete failure you expect to observe");
    expect(prompt).toContain("only when the test fails for the predicted reason");
    expect(prompt).toContain("If the test passes, fails for a different reason");
    expect(prompt).toContain("Category: security");
    expect(prompt).toContain("Keep the regression test as permanent coverage");
  });

  test("starts policy agents with normal package and theme setup", () => {
    expect(policyAgentPiArgs()).not.toContain("--offline");
    expect(policyAgentPiArgs()).not.toContain("--no-themes");
  });

  test("links the main Pi config into a new policy worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-review-policy-"));
    const source = join(root, "source");
    const worktree = join(root, "worktree");
    try {
      await mkdir(source);
      await mkdir(join(worktree, ".pi"), { recursive: true });
      await writeFile(join(worktree, ".pi", "stale"), "stale");

      await linkPiConfig(worktree, source);

      expect(await readlink(join(worktree, ".pi"))).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("offers generic lint and policy-specific Herdr actions", () => {
    expect(POLICY_ACTION_LABELS).toEqual([
      "1. Open an issue to add a lint rule",
      "2. Create worktree + Herdr tab and spawn a lint-rule creation agent",
      "3. Create worktree + Herdr tab in the Pi repo and spawn a local-Pi refinement agent",
      "4. Refine or override the proposed policy",
      "5. Defer / take no policy action",
    ]);
    expect(POLICY_ACTION_LABELS.join(" ").toLowerCase()).not.toContain("eslint");
    expect(buildLocalPiRefinement("ALWAYS scope invoice queries by tenant")).toContain(
      "semantic equivalents",
    );
  });
});
