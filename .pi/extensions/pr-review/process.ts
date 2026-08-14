import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import { fetchPrData, fetchPrReviewComments, resolvePrNumber, type PiExec } from "./github";
import {
  analyzeReviewDiscussions,
  estimatePolicyPattern,
  type ReviewCodeExcerpt,
} from "./process-agents";
import {
  buildLocalPiRefinement,
  choosePolicyAction,
  executePolicyDecision,
  explainPolicyStatement,
} from "./policy-actions";
import type {
  PolicyHint,
  PostReviewAnalysis,
  PostReviewPlan,
  PostReviewPriority,
  PostReviewSelection,
  PRMetadata,
  PrReviewComments,
  ReviewComment,
  ReviewDiscussion,
  ReviewPolicy,
  ReviewPolicyDecision,
} from "./types";

interface BranchStatus {
  currentBranch?: string;
  prBranch?: string;
  matches: boolean;
  prWorktree?: string;
}

interface PolicyCandidate {
  marker: ReviewPolicy["marker"];
  clause: string;
  comment: ReviewComment;
  discussionId: string;
}

export interface ProcessProgress {
  complete(status: string): void;
  update(phase: string, agentCount?: number, detail?: string): void;
}

interface ProcessSnapshot {
  version: 2;
  generatedAt: string;
  pr: PRMetadata;
  branch: BranchStatus;
  plan: PostReviewPlan;
  selection?: PostReviewSelection;
}

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

const REPORT_MESSAGE_TYPE = "pr-review-report";
const COMMAND_NAME = "pr-review-process";
const AI_IGNORE_PREFIX = "AI-IGNORE";
const PRIORITY_RANK: Readonly<Record<PostReviewPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};
const GENERAL_ACTIONS = [
  "Fix P0/P1 items plus mandatory ALWAYS/NEVER fixes",
  "Fix every actionable item plus mandatory ALWAYS/NEVER fixes",
  "Choose queue numbers plus mandatory ALWAYS/NEVER fixes",
  "Fix mandatory ALWAYS/NEVER issues only",
  "Stop after analysis",
] as const;

export const formatProcessProgress = (
  phase: string,
  elapsedMs: number,
  agentCount = 0,
  detail?: string,
): string => {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const elapsed = `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
  return [`⏳:${phase}`, elapsed, detail, agentCount ? `review-agents:${agentCount}` : undefined]
    .filter(isText)
    .join(" ");
};

const createProcessProgress = (ctx: ExtensionCommandContext): ProcessProgress => {
  const startedAt = Date.now();
  let phase = "starting";
  let agentCount = 0;
  let detail: string | undefined;
  const render = () =>
    setStatus(ctx, formatProcessProgress(phase, Date.now() - startedAt, agentCount, detail));
  const timer = setInterval(render, 1_000);
  timer.unref?.();
  return {
    update(nextPhase, nextAgentCount = 0, nextDetail) {
      phase = nextPhase;
      agentCount = nextAgentCount;
      detail = nextDetail;
      render();
    },
    complete(status) {
      clearInterval(timer);
      setStatus(ctx, status);
    },
  };
};

export const createPrReviewProcessProxy = (pi: ExtensionAPI): ExtensionAPI => {
  const registerCommand = (name: string, options: CommandOptions): void => {
    if (name !== COMMAND_NAME) {
      pi.registerCommand(name, options);
      return;
    }
    pi.registerCommand(name, {
      description:
        "Prioritize and process PR review discussions with human approval and per-policy ALWAYS/NEVER handling (usage: /pr-review-process [pr-number] [--include-resolved])",
      handler: async (args, ctx) => runPrReviewProcess(pi, ctx, args),
    });
  };
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand") return registerCommand;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export const runPrReviewProcess = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> => {
  const progress = createProcessProgress(ctx);
  try {
    progress.update("fetching", 0, "PR and comments");
    const tokens = parseArgs(args);
    const includeResolved = tokens.includes("--include-resolved");
    const explicitPr = tokens.find((token) => /^\d+$/.test(token));
    const exec: PiExec = (command, commandArgs = [], options) =>
      pi.exec(command, [...commandArgs], options);
    const prNumber = await resolvePrNumber(exec, ctx.cwd, explicitPr);
    const [prData, reviewComments] = await Promise.all([
      fetchPrData(exec, ctx.cwd, prNumber),
      fetchPrReviewComments(exec, ctx.cwd, prNumber, {
        includeResolvedThreads: includeResolved,
      }),
    ]);
    const discussions = buildReviewDiscussions(reviewComments);
    if (!discussions.length) {
      sendReport(pi, noCommentsReport(prData.metadata));
      progress.complete("✅:empty");
      return;
    }
    progress.update("reading", 0, `${discussions.length} discussions`);
    const excerpts = await readDiscussionExcerpts(pi, ctx, prNumber, discussions);
    progress.update("classifying", 1, `${discussions.length} discussions`);
    const analyses = await analyzeReviewDiscussions(
      pi,
      ctx,
      prData.metadata,
      discussions,
      excerpts,
    );
    const policies = buildReviewPolicies(discussions, analyses);
    if (policies.length)
      progress.update("estimating", policies.length, `${policies.length} policies`);
    const estimatedPolicies = await Promise.all(
      policies.map(async (policy) => ({
        ...policy,
        estimate: await estimatePolicyPattern(pi, ctx, policy, prData.metadata, excerpts),
      })),
    );
    progress.update("planning");
    const plan = buildPrioritizedReviewPlan(
      discussions,
      analyses,
      estimatedPolicies,
      reviewComments.viewerLogin,
    );
    const branch = await inspectBranch(pi, ctx, prData.metadata);
    const report = renderPostReviewReport(prData.metadata, plan, branch, includeResolved);
    const snapshotPath = await saveSnapshot(ctx, {
      version: 2,
      generatedAt: new Date().toISOString(),
      pr: prData.metadata,
      branch,
      plan,
    });
    sendReport(pi, `${report}\n\nSaved queue: ${snapshotPath}`);
    if (!branch.matches) {
      notify(
        ctx,
        `Switch to ${branch.prWorktree || branch.prBranch || "the PR worktree"} before applying review fixes.`,
        "warning",
      );
      progress.complete("⚠️:branch");
      return;
    }
    progress.update("policy-choices", 0, `${plan.policies.length} policies`);
    const policyDecisions = await processPolicyChoices(pi, ctx, prData.metadata, plan.policies);
    progress.update("selecting", 0, `${plan.analyses.length} discussions`);
    const approvedDiscussionIds = await selectApprovedDiscussions(ctx, plan);
    const selection = { approvedDiscussionIds, policyDecisions } satisfies PostReviewSelection;
    await saveSnapshot(ctx, {
      version: 2,
      generatedAt: new Date().toISOString(),
      pr: prData.metadata,
      branch,
      plan,
      selection,
    });
    progress.update("dispatching");
    const prompt = buildImmediateFixPrompt(prData.metadata, plan, selection, excerpts, branch);
    await deliverFollowUp(pi, prompt);
    progress.complete("✅:ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `PR review process failed: ${message}`, "error");
    progress.complete("❌:failed");
  }
};

export const buildReviewDiscussions = (input: PrReviewComments): ReviewDiscussion[] => {
  const includedComments = (comments: readonly ReviewComment[]): ReviewComment[] =>
    comments.filter((comment) => !isIgnoredViewerComment(comment, input.viewerLogin));
  const discussions: ReviewDiscussion[] = input.reviewThreads.flatMap((thread) => {
    const comments = includedComments(thread.comments).map((comment) => ({
      ...comment,
      threadId: thread.id,
    }));
    const rootComment = comments[0];
    return rootComment
      ? [
          {
            id: thread.id,
            threadId: thread.id,
            isResolved: thread.isResolved,
            rootComment,
            comments,
          },
        ]
      : [];
  });
  const threadedIds = new Set(discussions.flatMap(({ comments }) => comments.map(({ id }) => id)));
  for (const comment of includedComments(input.comments)) {
    if (threadedIds.has(comment.id)) continue;
    discussions.push({
      id: `comment-${comment.id}`,
      isResolved: false,
      rootComment: comment,
      comments: [comment],
    });
  }
  return discussions;
};

export const extractAlwaysNeverPolicyHints = (comments: readonly ReviewComment[]): PolicyHint[] =>
  comments.flatMap((comment) =>
    policyCandidatesFromComment(comment, "").map(({ marker, clause }) => ({
      pattern: marker,
      rawText: `${marker} ${clause}`,
      commentId: comment.id,
      confidence: 0.95,
    })),
  );

export const buildReviewPolicies = (
  discussions: readonly ReviewDiscussion[],
  analyses: readonly PostReviewAnalysis[],
): ReviewPolicy[] => {
  const analysisByDiscussion = new Map(
    analyses.map((analysis) => [analysis.discussionId, analysis]),
  );
  const groups = new Map<string, PolicyCandidate[]>();
  for (const discussion of discussions) {
    for (const comment of discussion.comments) {
      for (const candidate of policyCandidatesFromComment(comment, discussion.id)) {
        const key = policyKey(candidate.marker, candidate.clause);
        groups.set(key, [...(groups.get(key) ?? []), candidate]);
      }
    }
  }
  return [...groups.entries()].map(([key, candidates]) => {
    const first = candidates[0];
    if (!first) throw new Error("Policy group is empty.");
    const statement = `${first.marker} ${first.clause}`;
    const locations = unique(candidates.map(({ comment }) => commentLocation(comment)));
    const discussionIds = unique(
      candidates.map(({ discussionId }) => discussionId).filter(Boolean),
    );
    const themes = unique(
      discussionIds.map((id) => analysisByDiscussion.get(id)?.theme).filter(isText),
    );
    return {
      id: `policy-${stableId(key)}`,
      marker: first.marker,
      statement,
      explanation: explainPolicyStatement(statement),
      rationale: themes.length
        ? `Reviewer policy language identifies a recurring ${themes.join(" / ")} expectation.`
        : "Reviewer policy language indicates this behavior should be consistent beyond one line.",
      immediateFix: `Fix the reviewed instance at ${locations.join(", ") || "the referenced discussion"} regardless of the long-term choice.`,
      lintRuleGuidance: `Investigate a project lint rule that detects semantic violations of “${statement}” using the repository's existing lint infrastructure.`,
      localPiRefinement: buildLocalPiRefinement(statement),
      commentIds: unique(candidates.map(({ comment }) => comment.id)),
      discussionIds,
      locations,
      estimate: {
        confirmedCount: locations.length ? 1 : 0,
        probableCount: 0,
        searchScope: "Pattern search pending",
        confidence: 0,
        pattern: statement,
        matches: [],
      },
    };
  });
};

export const buildPrioritizedReviewPlan = (
  discussions: readonly ReviewDiscussion[],
  analyses: readonly PostReviewAnalysis[],
  policies: readonly ReviewPolicy[],
  viewerLogin: string,
): PostReviewPlan => {
  const commandCommentIds = discussions.flatMap(({ comments }) =>
    comments.filter((comment) => isViewerComment(comment, viewerLogin)).map(({ id }) => id),
  );
  const commandDiscussionIds = discussionIdsForComments(discussions, commandCommentIds);
  return {
    viewerLogin,
    commandCommentIds,
    discussions: [...discussions],
    analyses: analyses
      .map((analysis) =>
        commandDiscussionIds.has(analysis.discussionId)
          ? { ...analysis, disposition: "fix" as const }
          : analysis,
      )
      .sort(compareAnalyses),
    policies: [...policies],
  };
};

export const renderPostReviewReport = (
  pr: PRMetadata,
  plan: PostReviewPlan,
  branch: BranchStatus,
  includeResolved = false,
): string => {
  const discussionById = new Map(plan.discussions.map((discussion) => [discussion.id, discussion]));
  const counts = priorityCounts(plan.analyses);
  const lines = [
    "## Prioritized post-review queue",
    "",
    `PR: #${pr.ref.number} ${pr.title}`,
    `URL: ${pr.url}`,
    `Branch: current=${branch.currentBranch || "unknown"}, PR=${branch.prBranch || "unknown"}, matches=${branch.matches ? "yes" : "no"}${branch.prWorktree ? `, worktree=${branch.prWorktree}` : ""}`,
    `Scope: ${includeResolved ? "all" : "unresolved"} threads · ${plan.discussions.length} discussions · ${plan.commandCommentIds.length} @${plan.viewerLogin} commands · P0=${counts.P0}, P1=${counts.P1}, P2=${counts.P2}, P3=${counts.P3}`,
    "",
    "| # | Priority | Reviewer | Handling | Location | Risk | Disposition | Summary |",
    "|---:|---|---|---|---|---|---|---|",
  ];
  for (const [index, analysis] of plan.analyses.entries()) {
    const discussion = discussionById.get(analysis.discussionId);
    const root = discussion?.rootComment;
    const reviewer = root ? `[${root.author.login}](${root.url})` : "unknown";
    const handling = discussionHasCommand(discussion, plan.commandCommentIds)
      ? "replace command with action summary"
      : "reply normally";
    lines.push(
      `| ${index + 1} | ${analysis.priority} | ${reviewer} | ${handling} | ${escapeCell(root ? commentLocation(root) : "general")} | ${escapeCell(analysis.risk)} | ${analysis.disposition} | ${escapeCell(analysis.summary)} |`,
    );
  }
  lines.push("", "### ALWAYS/NEVER policies", "");
  if (!plan.policies.length) lines.push("No uppercase ALWAYS/NEVER policies detected.");
  for (const [index, policy] of plan.policies.entries()) {
    lines.push(
      `#### A${index + 1}. ${policy.statement}`,
      "",
      `- Meaning: ${policy.explanation}`,
      `- Why: ${policy.rationale}`,
      `- Immediate fix: **mandatory** — ${policy.immediateFix}`,
      `- Estimated repository instances: **${policy.estimate.confirmedCount} confirmed**, **${policy.estimate.probableCount} probable** (${Math.round(policy.estimate.confidence * 100)}% confidence).`,
      `- Search: ${policy.estimate.pattern}; scope: ${policy.estimate.searchScope}.`,
      `- Lint-rule option: ${policy.lintRuleGuidance}`,
      `- Local-Pi option: ${policy.localPiRefinement}`,
      `- Evidence: ${policy.locations.join(", ") || "general"}; comments ${policy.commentIds.join(", ")}.`,
      "",
    );
  }
  lines.push(
    "The queue is sorted by merge risk. Long-term policy actions require a separate terminal choice for every policy.",
  );
  return lines.join("\n");
};

export const buildImmediateFixPrompt = (
  pr: PRMetadata,
  plan: PostReviewPlan,
  selection: PostReviewSelection,
  excerpts: readonly ReviewCodeExcerpt[],
  branch: BranchStatus,
): string | undefined => {
  const selectedIds = new Set(selection.approvedDiscussionIds);
  const mandatoryPolicyIds = new Set(plan.policies.flatMap(({ discussionIds }) => discussionIds));
  const commandDiscussionIds = discussionIdsForComments(plan.discussions, plan.commandCommentIds);
  const workIds = new Set([...selectedIds, ...mandatoryPolicyIds, ...commandDiscussionIds]);
  if (!workIds.size) return undefined;
  const analysisById = new Map(plan.analyses.map((analysis) => [analysis.discussionId, analysis]));
  const discussions = plan.discussions.filter(({ id }) => workIds.has(id));
  return [
    `Process approved review work for PR #${pr.ref.number} (${pr.title}).`,
    `Expected branch: ${branch.prBranch}; current branch was verified before planning. Recheck the PR head SHA and branch before editing.`,
    "",
    `Authenticated GitHub user: @${plan.viewerLogin}.`,
    `Every included comment by @${plan.viewerLogin} is an actionable command. Implement it regardless of its analyzed priority; comments beginning with ${AI_IGNORE_PREFIX} were excluded.`,
    "ALWAYS/NEVER comments are mandatory immediate fixes regardless of their long-term policy decisions. Fix each commented instance and add focused regression coverage when behavior changes.",
    "Pattern estimates are context only; do not expand this PR into unrelated repository-wide cleanup.",
    "Do not create lint rules or modify the local Pi setup in this fix pass; selected long-term actions were handled separately.",
    "",
    "## Correctness and security test-first protocol",
    "For every included discussion categorized as correctness or security, do not edit related production code until you have demonstrated the reported issue with a focused failing automated test.",
    "Write the regression test first. Immediately before running it, tell the user the concrete failure you expect to observe, including the relevant test name and assertion, error, or output (for example, an array-length assertion should fail with the actual and expected lengths).",
    "Run that focused test and inspect its output. Proceed to production code only when the test fails for the predicted reason and therefore demonstrates the review issue.",
    "If the test passes, fails for a different reason, or cannot practically be written, do not change the related production code. Refine the test or analysis and repeat the prediction-and-run step; if the issue still cannot be demonstrated, report it as blocked or explain why the comment is not actionable.",
    "After the expected failure is confirmed, make the smallest related production change, rerun the new regression test until it passes, then run the relevant broader validation. Keep the regression test as permanent coverage and do not weaken it to fit the implementation.",
    "This protocol is mandatory even when the requested production fix appears obvious or small.",
    "",
    "## Mandatory commands",
    ...plan.discussions.flatMap((discussion) =>
      discussion.comments
        .filter(({ id }) => plan.commandCommentIds.includes(id))
        .map(
          (comment) =>
            `- ${comment.threadId ? "review" : "issue"} comment databaseId=${comment.databaseId} id=${comment.id} url=${comment.url} :: ${compact(comment.body)}`,
        ),
    ),
    "",
    "## Mandatory policies",
    ...plan.policies.flatMap((policy) => {
      const decision = selection.policyDecisions.find(({ policyId }) => policyId === policy.id);
      return [
        `- ${decision?.statement || policy.statement}`,
        `  Fix: ${policy.immediateFix}`,
        `  Estimated pattern: ${policy.estimate.confirmedCount} confirmed, ${policy.estimate.probableCount} probable.`,
        `  Long-term choice: ${decision?.action || "defer"}${decision?.result ? ` — ${decision.result}` : ""}.`,
      ];
    }),
    "",
    "## Approved discussions in priority order",
    ...discussions.flatMap((discussion) => {
      const analysis = analysisById.get(discussion.id);
      return [
        `### ${analysis?.priority || "P2"} ${discussion.id} — ${analysis?.summary || discussion.rootComment.body}`,
        `Category: ${analysis?.category || "other"}`,
        `Reviewer: ${discussion.rootComment.author.login} · ${discussion.rootComment.url}`,
        `Location: ${commentLocation(discussion.rootComment)}`,
        `Risk: ${analysis?.risk || "Review required"}`,
        `Disposition: ${analysis?.disposition || "fix"}`,
        `Suggested solution: ${analysis?.suggestedSolution || "Address the reviewer request with the smallest focused change."}`,
        `Conversation: ${discussion.comments.map((comment) => `${plan.commandCommentIds.includes(comment.id) ? "COMMAND " : ""}${comment.author.login}: ${compact(comment.body)}`).join(" | ")}`,
        "",
      ];
    }),
    "## Related code excerpts",
    ...excerpts
      .filter(({ discussionId }) => workIds.has(discussionId))
      .flatMap((excerpt) => [
        `### ${excerpt.discussionId} ${excerpt.path}${excerpt.line ? `:${excerpt.line}` : ""}`,
        excerpt.error ? `Unavailable: ${excerpt.error}` : "```",
        ...(excerpt.error ? [] : [excerpt.content || "(empty)", "```"]),
      ]),
    "",
    `After implementing and validating, draft a short action-taken summary intended to replace each @${plan.viewerLogin} command comment instead of receiving a reply. Keep the summary concrete, omit the original command text, and end it with the required lowercase model signature. Do not edit the original comment yet; publication requires the approval and verified-push gate below.`,
    `Use PATCH /repos/${pr.ref.owner}/${pr.ref.repo}/pulls/comments/{databaseId} for review comments and PATCH /repos/${pr.ref.owner}/${pr.ref.repo}/issues/comments/{databaseId} for issue comments.`,
    `Reply normally to comments by every other author. Do not act on, edit, or reply to an @${plan.viewerLogin} comment beginning with ${AI_IGNORE_PREFIX}.`,
    "Before committing, pushing, editing comments, posting replies, or resolving threads, present a pre-publish summary containing: changed files and fixes; validation results and blockers; exact command-comment replacements; exact reviewer reply drafts; and each thread intended for resolution, skipping, or blocking with its reason.",
    "Then suggest inspecting the working-tree changes with Hunk before publication. Explain: from a second terminal in this PR worktree, run `hunk diff`; it opens an interactive file-by-file and hunk-by-hunk review of tracked and untracked changes. After reviewing, exit Hunk and return here to approve or request edits. Do not run the interactive Hunk command for the user.",
    "After the pre-publish summary and Hunk explanation, ask exactly once whether you may commit and push the changes, then edit command comments, post reviewer replies, and resolve completed review threads. Do not treat silence or an ambiguous response as approval, and do not perform any of those publication actions before explicit approval.",
    `When approved, recheck that the current branch is ${branch.prBranch}, create a focused commit that references the addressed review comments if changes remain uncommitted, and push the current HEAD to the PR branch without force. Verify that GitHub reports the PR head SHA equal to local HEAD before editing or replying to any comment. If commit, push, or SHA verification fails, stop without mutating GitHub comments or threads and report the blocker.`,
    "Only after the verified push, edit each command comment by its database ID and comment kind, reply to every completed discussion from other authors, and resolve only completed review threads. General issue comments have no review thread to resolve. Preserve any failed or incomplete thread as unresolved.",
    "Refetch the PR comments after publication and verify each intended replacement or reply exists and each intended review thread is resolved. Report API failures and verification mismatches as incomplete rather than completed.",
    "End the process with a clear final summary containing: overall status; commit and verified pushed SHA; changed files and fixes; validation results; each verified command-comment replacement; each verified reviewer reply; each resolved, skipped, or blocked thread with its reason; every policy action and agent status; artifacts; and remaining blockers. Never report a planned, queued, unverified, or failed action as completed.",
  ].join("\n");
};

const processPolicyChoices = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  policies: readonly ReviewPolicy[],
): Promise<ReviewPolicyDecision[]> => {
  const decisions: ReviewPolicyDecision[] = [];
  for (const policy of policies) {
    const choice = await choosePolicyAction(ctx, policy);
    const decision: ReviewPolicyDecision = { policyId: policy.id, ...choice };
    try {
      decision.result = await executePolicyDecision(pi, ctx, pr, policy, decision);
      if (decision.result) notify(ctx, decision.result, "info");
    } catch (error) {
      decision.result = `Failed: ${error instanceof Error ? error.message : String(error)}`;
      notify(ctx, decision.result, "error");
    }
    decisions.push(decision);
  }
  return decisions;
};

const selectApprovedDiscussions = async (
  ctx: ExtensionCommandContext,
  plan: PostReviewPlan,
): Promise<string[]> => {
  const mandatoryDiscussionIds = new Set([
    ...plan.policies.flatMap(({ discussionIds }) => discussionIds),
    ...discussionIdsForComments(plan.discussions, plan.commandCommentIds),
  ]);
  const candidates = plan.analyses.filter(
    ({ discussionId }) => !mandatoryDiscussionIds.has(discussionId),
  );
  if (!candidates.length || !ctx.hasUI || !ctx.ui.select) return [];
  const choice = await ctx.ui.select(
    `Choose review work from other authors. @${plan.viewerLogin} commands and ALWAYS/NEVER instances will be fixed regardless.`,
    [...GENERAL_ACTIONS],
  );
  if (!choice || choice === GENERAL_ACTIONS[4] || choice === GENERAL_ACTIONS[3]) return [];
  if (choice === GENERAL_ACTIONS[0])
    return candidates
      .filter(
        ({ priority, disposition }) =>
          (priority === "P0" || priority === "P1") && disposition !== "no_action",
      )
      .map(({ discussionId }) => discussionId);
  if (choice === GENERAL_ACTIONS[1])
    return candidates
      .filter(({ disposition }) => disposition !== "no_action" && disposition !== "defer")
      .map(({ discussionId }) => discussionId);
  const numbers = await ctx.ui.editor(
    "Queue numbers to process, separated by spaces or commas",
    candidates
      .filter(({ priority }) => priority === "P0" || priority === "P1")
      .map((analysis) => String(plan.analyses.indexOf(analysis) + 1))
      .join(", "),
  );
  return selectedDiscussionIds(plan, numbers || "", mandatoryDiscussionIds);
};

const selectedDiscussionIds = (
  plan: PostReviewPlan,
  value: string,
  excluded: ReadonlySet<string>,
): string[] =>
  unique(
    [...value.matchAll(/\d+/g)].flatMap((match) => {
      const analysis = plan.analyses[Number(match[0]) - 1];
      return analysis && !excluded.has(analysis.discussionId) ? [analysis.discussionId] : [];
    }),
  );

const readDiscussionExcerpts = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
  discussions: readonly ReviewDiscussion[],
): Promise<ReviewCodeExcerpt[]> => {
  const script = await resolveScript(ctx.cwd, "readPrFile.ts");
  return Promise.all(
    discussions.slice(0, 120).flatMap((discussion) => {
      const root = discussion.rootComment;
      if (!root.path) return [];
      return [readDiscussionExcerpt(pi, ctx, prNumber, discussion.id, root, script)];
    }),
  );
};

const readDiscussionExcerpt = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
  discussionId: string,
  comment: ReviewComment,
  script: string,
): Promise<ReviewCodeExcerpt> => {
  const range = comment.line
    ? `${comment.path}:${Math.max(1, comment.line - 8)}-${comment.line + 8}`
    : comment.path || "";
  const result = await pi.exec("bun", [script, String(prNumber), range], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 30_000,
  });
  if (result.code !== 0)
    return {
      discussionId,
      path: comment.path || "",
      line: comment.line,
      error: result.stderr.trim() || result.stdout.trim() || "readPrFile failed",
    };
  return {
    discussionId,
    path: comment.path || "",
    line: comment.line,
    content: result.stdout.trimEnd(),
  };
};

const inspectBranch = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
): Promise<BranchStatus> => {
  const [branchResult, worktreesResult] = await Promise.all([
    pi.exec("git", ["branch", "--show-current"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 10_000,
    }),
    pi.exec("git", ["worktree", "list", "--porcelain"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 10_000,
    }),
  ]);
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
  const prBranch = pr.head.ref || undefined;
  return {
    currentBranch,
    prBranch,
    matches: Boolean(currentBranch && prBranch && currentBranch === prBranch),
    prWorktree: prBranch ? worktreeForBranch(worktreesResult.stdout, prBranch) : undefined,
  };
};

const worktreeForBranch = (output: string, branch: string): string | undefined => {
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split(/\r?\n/);
    if (!lines.includes(`branch refs/heads/${branch}`)) continue;
    return lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  }
  return undefined;
};

const policyCandidatesFromComment = (
  comment: ReviewComment,
  discussionId: string,
): PolicyCandidate[] => {
  const matches = comment.body.matchAll(/\b(ALWAYS|NEVER)\b\s*[:，-]?\s*([^.!?\n]{2,240})/g);
  return [...matches].flatMap((match) => {
    const marker = match[1] as ReviewPolicy["marker"] | undefined;
    const clause = match[2]?.replace(/\s+/g, " ").trim();
    return marker && clause ? [{ marker, clause, comment, discussionId }] : [];
  });
};

const policyKey = (marker: ReviewPolicy["marker"], clause: string): string =>
  `${marker}:${clause
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}`;

const compareAnalyses = (left: PostReviewAnalysis, right: PostReviewAnalysis): number =>
  PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
  right.confidence - left.confidence ||
  left.discussionId.localeCompare(right.discussionId);

const priorityCounts = (
  analyses: readonly PostReviewAnalysis[],
): Record<PostReviewPriority, number> => {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const { priority } of analyses) counts[priority] += 1;
  return counts;
};

const resolveScript = async (cwd: string, name: string): Promise<string> => {
  const envDirectory = process.env.PI_FINITO_SCRIPTS_DIR?.trim();
  const directories = [
    envDirectory ? path.resolve(cwd, envDirectory) : undefined,
    path.join(cwd, ".pi", "finito-scripts", "scripts"),
    path.join(cwd, "skills", "skills", "finito-scripts", "scripts"),
  ].filter(isText);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`Could not find finito script: ${name}`);
};

const saveSnapshot = async (
  ctx: ExtensionCommandContext,
  snapshot: ProcessSnapshot,
): Promise<string> => {
  const directory = path.join(ctx.cwd, ".pi", "tmp", "pr-review-process");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `pr-${snapshot.pr.ref.number}-latest.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return path.relative(ctx.cwd, file);
};

const parseArgs = (args: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (const character of args) {
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
};

const noCommentsReport = (pr: PRMetadata): string =>
  `## Prioritized post-review queue\n\nPR: #${pr.ref.number} ${pr.title}\n\nNo reviewer discussions found.`;

const isViewerComment = (comment: ReviewComment, viewerLogin: string): boolean =>
  comment.author.login.toLowerCase() === viewerLogin.toLowerCase();

const isIgnoredViewerComment = (comment: ReviewComment, viewerLogin: string): boolean =>
  isViewerComment(comment, viewerLogin) && comment.body.trimStart().startsWith(AI_IGNORE_PREFIX);

const discussionIdsForComments = (
  discussions: readonly ReviewDiscussion[],
  commentIds: readonly string[],
): Set<string> => {
  const ids = new Set(commentIds);
  return new Set(
    discussions
      .filter(({ comments }) => comments.some(({ id }) => ids.has(id)))
      .map(({ id }) => id),
  );
};

const discussionHasCommand = (
  discussion: ReviewDiscussion | undefined,
  commandCommentIds: readonly string[],
): boolean => {
  if (!discussion) return false;
  const ids = new Set(commandCommentIds);
  return discussion.comments.some(({ id }) => ids.has(id));
};

const commentLocation = (comment: ReviewComment): string =>
  comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "general";

const stableId = (value: string): string => {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36);
};

const deliverFollowUp = async (pi: ExtensionAPI, prompt: string | undefined): Promise<void> => {
  if (!prompt) return;
  if (!pi.sendUserMessage) {
    sendReport(pi, prompt);
    return;
  }
  await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
};

const sendReport = (pi: ExtensionAPI, markdown: string): void => {
  pi.sendMessage({
    customType: REPORT_MESSAGE_TYPE,
    content: markdown,
    display: true,
    details: { markdown },
  });
};

const setStatus = (ctx: ExtensionCommandContext, status: string): void => {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(COMMAND_NAME, status);
};

const notify = (
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  if (ctx.hasUI) ctx.ui.notify(message, level);
};

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
const escapeCell = (value: string): string => compact(value).replace(/\|/g, "\\|");
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const isText = (value: string | undefined): value is string => Boolean(value?.trim());
