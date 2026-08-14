import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { silentReviewTabArgs } from "./herdr-agent";
import type {
  PRMetadata,
  ReviewPolicy,
  ReviewPolicyActionKind,
  ReviewPolicyDecision,
} from "./types";

export const POLICY_ACTION_LABELS = [
  "1. Open an issue to add a lint rule",
  "2. Create worktree + Herdr tab and spawn a lint-rule creation agent",
  "3. Create worktree + Herdr tab in the Pi repo and spawn a local-Pi refinement agent",
  "4. Refine or override the proposed policy",
  "5. Defer / take no policy action",
] as const;

const policyAction = (choice: string): ReviewPolicyActionKind => {
  if (choice.startsWith("1.")) return "open_lint_issue";
  if (choice.startsWith("2.")) return "spawn_lint_rule_agent";
  if (choice.startsWith("3.")) return "spawn_local_pi_agent";
  if (choice.startsWith("4.")) return "refine_policy";
  return "defer";
};

const policyActionLabels = (statement: string): string[] => [
  POLICY_ACTION_LABELS[0],
  POLICY_ACTION_LABELS[1],
  `${POLICY_ACTION_LABELS[2]} — ${buildLocalPiRefinement(statement)}`,
  POLICY_ACTION_LABELS[3],
  POLICY_ACTION_LABELS[4],
];

interface HerdrCreation {
  result?: unknown;
}

interface CreatedAgentTab {
  tabId: string;
  paneId: string;
}

export const choosePolicyAction = async (
  ctx: ExtensionCommandContext,
  policy: ReviewPolicy,
): Promise<{ action: ReviewPolicyActionKind; statement: string }> => {
  if (!ctx.hasUI || !ctx.ui.select) return { action: "defer", statement: policy.statement };
  let statement = policy.statement;
  for (;;) {
    const choice = await ctx.ui.select(
      policyQuestion(policy, statement),
      policyActionLabels(statement),
    );
    if (!choice) return { action: "defer", statement };
    const action = policyAction(choice);
    if (action !== "refine_policy") return { action, statement };
    const refined = await ctx.ui.editor("Refine or override this ALWAYS/NEVER policy", statement);
    if (refined?.trim()) statement = normalizePolicyStatement(refined, policy.marker);
  }
};

export const executePolicyDecision = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  policy: ReviewPolicy,
  decision: ReviewPolicyDecision,
): Promise<string | undefined> => {
  if (decision.action === "defer" || decision.action === "refine_policy") return undefined;
  const effectivePolicy = {
    ...policy,
    marker: policyMarker(decision.statement),
    statement: decision.statement,
    explanation: explainPolicyStatement(decision.statement),
    localPiRefinement: buildLocalPiRefinement(decision.statement),
  };
  if (decision.action === "open_lint_issue") return openLintRuleIssue(pi, ctx, pr, effectivePolicy);
  if (decision.action === "spawn_lint_rule_agent")
    return spawnPolicyAgent(
      pi,
      ctx,
      ctx.cwd,
      effectivePolicy,
      lintRuleAgentPrompt(pr, effectivePolicy),
      "lint",
    );
  return spawnPolicyAgent(
    pi,
    ctx,
    piRepositoryRoot(),
    effectivePolicy,
    localPiAgentPrompt(pr, effectivePolicy),
    "pi-policy",
  );
};

export const normalizePolicyStatement = (
  value: string,
  fallbackMarker: ReviewPolicy["marker"] = "ALWAYS",
): string => {
  const compact = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  if (/^(ALWAYS|NEVER)\b/.test(compact)) return compact;
  return `${fallbackMarker} ${compact}`;
};

export const explainPolicyStatement = (statement: string): string => {
  const clause = statement.replace(/^(ALWAYS|NEVER)\s+/i, "").trim();
  return policyMarker(statement) === "NEVER"
    ? `The codebase must not ${lowercaseStart(clause)}.`
    : `The codebase must consistently ${lowercaseStart(clause)}.`;
};

export const buildLocalPiRefinement = (statement: string): string =>
  `Teach local Pi review prompts and post-review classification to detect semantic equivalents of “${statement}”, explain the concrete risk, and require an immediate fix before offering long-term enforcement.`;

export const policyAgentPiArgs = (): string[] => [
  "--model",
  process.env.PI_REVIEW_PROCESS_WORKSPACE_MODEL || "openai-codex/gpt-5.6-sol",
  "--thinking",
  "high",
];

export const linkPiConfig = async (
  worktree: string,
  source = join(homedir(), "payslick", "pi", ".pi"),
): Promise<void> => {
  const target = join(worktree, ".pi");
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, "dir");
};

const policyQuestion = (policy: ReviewPolicy, statement: string): string =>
  [
    `${policyMarker(statement)} policy: ${statement}`,
    `Meaning: ${explainPolicyStatement(statement)}`,
    `Why: ${policy.rationale}`,
    `Immediate PR fix: mandatory — ${policy.immediateFix}`,
    `Estimated instances: ${policy.estimate.confirmedCount} confirmed, ${policy.estimate.probableCount} probable (${Math.round(policy.estimate.confidence * 100)}% confidence).`,
    `Lint-rule path: ${policy.lintRuleGuidance}`,
    `Local-Pi refinement: ${buildLocalPiRefinement(statement)}`,
    "Choose:",
  ].join("\n");

const openLintRuleIssue = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  policy: ReviewPolicy,
): Promise<string> => {
  const bodyPath = join(ctx.cwd, ".pi", "tmp", "pr-review-process", `lint-issue-${policy.id}.md`);
  await mkdir(dirname(bodyPath), { recursive: true });
  await writeFile(bodyPath, lintIssueBody(pr, policy), "utf8");
  const result = await pi.exec(
    "gh",
    [
      "issue",
      "create",
      "--title",
      truncate(`Lint rule: ${policy.statement}`, 120),
      "--body-file",
      bodyPath,
    ],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 60_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh issue create failed");
  return result.stdout.trim();
};

const lintIssueBody = (pr: PRMetadata, policy: ReviewPolicy): string =>
  [
    "## Proposed lint policy",
    "",
    policy.statement,
    "",
    "## Meaning",
    "",
    policy.explanation,
    "",
    "## Evidence",
    "",
    `- Source PR: ${pr.url || `#${pr.ref.number}`}`,
    `- Review comments: ${policy.commentIds.join(", ")}`,
    `- Locations: ${policy.locations.join(", ") || "general"}`,
    `- Estimated instances: ${policy.estimate.confirmedCount} confirmed, ${policy.estimate.probableCount} probable`,
    `- Search scope: ${policy.estimate.searchScope}`,
    "",
    "## Acceptance criteria",
    "",
    "- Add a project lint rule using the repository's existing lint infrastructure.",
    "- Prove the rule detects the original reviewed instance.",
    "- Add focused rule tests for matching and non-matching cases.",
    "- Document the confirmed repository-wide occurrence count.",
    "",
  ].join("\n");

const spawnPolicyAgent = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repository: string,
  policy: ReviewPolicy,
  prompt: string,
  branchPrefix: string,
): Promise<string> => {
  const slug = policySlug(policy.statement);
  const suffix = Date.now().toString(36);
  const branch = `chore/${branchPrefix}/${slug}-${suffix}`;
  const repositoryRoot = await requiredOutput(
    pi,
    ctx,
    "git",
    ["rev-parse", "--show-toplevel"],
    repository,
  );
  const worktree = join(dirname(repositoryRoot), `${basename(repositoryRoot)}-${slug}-${suffix}`);
  await requiredOutput(
    pi,
    ctx,
    "git",
    ["worktree", "add", "-b", branch, worktree, "HEAD"],
    repositoryRoot,
    120_000,
  );
  await linkPiConfig(worktree);
  const agentName = `${branchPrefix}-${slug.slice(0, 20)}-${suffix.slice(-6)}`.slice(0, 32);
  const tab = await createAgentTab(
    pi,
    ctx,
    worktree,
    `${branchPrefix}-${slug}`,
    `${branchPrefix}-${suffix}`,
    agentName,
  );
  await requiredOutput(
    pi,
    ctx,
    "herdr",
    [
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      tab.paneId,
      "--timeout",
      "60000",
      "--",
      ...policyAgentPiArgs(),
    ],
    worktree,
    75_000,
  );
  await requiredOutput(
    pi,
    ctx,
    "herdr",
    ["agent", "prompt", tab.paneId, prompt, "--wait", "--until", "working", "--timeout", "5000"],
    worktree,
    10_000,
  );
  return `Started ${agentName} in Herdr tab ${tab.tabId} at ${worktree}.`;
};

const createAgentTab = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  label: string,
  subagentId: string,
  agentName: string,
): Promise<CreatedAgentTab> => {
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (process.env.HERDR_ENV !== "1" || !workspaceId)
    throw new Error("Policy agents require Pi to run inside a Herdr workspace.");
  const result = await requiredOutput(
    pi,
    ctx,
    "herdr",
    silentReviewTabArgs(workspaceId, cwd, label, subagentId, agentName),
    cwd,
  );
  const parsed = JSON.parse(result) as HerdrCreation;
  const tabId = nestedString(parsed.result, "tab_id");
  const paneId = nestedString(parsed.result, "pane_id");
  if (!tabId || !paneId) throw new Error("Herdr did not return a policy-agent tab and pane.");
  return { tabId, paneId };
};

const requiredOutput = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
  args: string[],
  cwd: string,
  timeout = 60_000,
): Promise<string> => {
  const result = await pi.exec(command, args, { cwd, signal: ctx.signal, timeout });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`,
    );
  return result.stdout.trim();
};

const nestedString = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const match = nestedString(child, key);
    if (match) return match;
  }
  return undefined;
};

const lintRuleAgentPrompt = (pr: PRMetadata, policy: ReviewPolicy): string =>
  [
    `Create a project lint rule for this approved policy: ${policy.statement}`,
    `Source PR: ${pr.url || `#${pr.ref.number}`}`,
    `Meaning: ${policy.explanation}`,
    `Known pattern: ${policy.estimate.pattern}`,
    `Estimated scope: ${policy.estimate.confirmedCount} confirmed and ${policy.estimate.probableCount} probable instances across ${policy.estimate.searchScope}.`,
    "Inspect and use the repository's existing lint infrastructure. This is a lint rule; do not assume or introduce ESLint.",
    "First add a focused failing rule test for the original reviewed pattern, then implement the rule and make matching/non-matching tests pass.",
    "Run the rule across the repository, report confirmed occurrences, and keep unrelated occurrence fixes outside this branch unless required to validate the rule.",
  ].join("\n");

const localPiAgentPrompt = (pr: PRMetadata, policy: ReviewPolicy): string =>
  [
    `Improve the local Pi setup for this approved policy: ${policy.statement}`,
    `Source PR: ${pr.url || `#${pr.ref.number}`}`,
    `Meaning: ${policy.explanation}`,
    `Requested refinement: ${policy.localPiRefinement}`,
    "Update the smallest relevant Pi prompts, review workflow, design guidance, or extension logic so future agents detect and explain this policy consistently.",
    "Do not create a project lint rule in this Pi repository. Add focused extension tests for the refined behavior.",
  ].join("\n");

const piRepositoryRoot = (): string =>
  resolve(fileURLToPath(new URL("../../../", import.meta.url)));

const policyMarker = (statement: string): ReviewPolicy["marker"] =>
  /^NEVER\b/i.test(statement) ? "NEVER" : "ALWAYS";

const lowercaseStart = (value: string): string =>
  value ? `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}` : "repeat the reviewed behavior";

const policySlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^(always|never)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "review-policy";

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
