import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-ignore Runtime-provided Pi package may be resolved only by the Pi runtime.
import { getMarkdownTheme as runtimeGetMarkdownTheme } from "@earendil-works/pi-coding-agent";
// @ts-ignore Runtime-provided Pi package may be resolved only by the Pi runtime.
import * as runtimePiTui from "@earendil-works/pi-tui";
import {
  fetchLocalData,
  fetchPrData,
  fetchPrReviewComments,
  resolvePrNumber,
  type GithubPrData,
} from "./github";
import { buildLaneReviewPrompt, routeReviewLanes } from "./lanes";
import { prepareDryRunPosting } from "./posting";
import { formatLaneList, laneIcon, renderExecutiveSummary } from "./summary";
import type { VisualReviewRunDetails } from "./visual";
import { renderVisualReviewReport } from "./visual";
import type {
  AfterReviewAnalysisResult,
  DesignRuleProposal,
  ExecutiveSummaryInput,
  IssueConsolidation,
  NewLaneProposal,
  PolicyHint,
  PRMetadata,
  PrReviewComments,
  ReviewCiCheck,
  ReviewCiStatus,
  ReviewComment,
  ReviewCoverageItem,
  ReviewFinding,
  ReviewFindingType,
  ReviewLaneImprovementSuggestion,
  ReviewLaneId,
  ReviewLanePacket,
  ReviewSeverity,
  ReviewSkillCoverage,
} from "./types";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExtensionCommandContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI: boolean;
  sessionManager?: {
    getSessionFile?: () => string | null;
  };
  model?: {
    provider: string;
    id: string;
  };
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
    setWidget: (key: string, lines: string[]) => void;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
  };
}

interface ExtensionAPI {
  exec: (
    command: string,
    args?: readonly string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
  ) => Promise<ExecResult>;
  sendMessage: (message: {
    type?: string;
    customType?: string;
    content?: string;
    display?: boolean;
    details?: unknown;
  }) => void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void | Promise<void>;
  registerMessageRenderer: (
    type: string,
    renderer: (message: { content?: unknown; details?: unknown }) => unknown,
  ) => void;
  registerCommand: (
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    },
  ) => void;
}

type MarkdownComponent = {
  render: (width: number) => string[];
};

type MarkdownConstructor = new (
  text: string,
  x: number,
  y: number,
  theme: unknown,
) => MarkdownComponent;

const getMarkdownTheme = runtimeGetMarkdownTheme as () => unknown;
const Markdown = runtimePiTui.Markdown as MarkdownConstructor;
const visibleWidth = runtimePiTui.visibleWidth as (text: string) => number;
const wrapTextWithAnsi = runtimePiTui.wrapTextWithAnsi as (text: string, width: number) => string[];

const REVIEW_REPORT_MESSAGE_TYPE = "pr-review-report";
const STATUS_KEY = "pr-review";
const WIDGET_KEY = "pr-review";
const REVIEW_REPORT_DIR = path.join("reports");
const LATEST_REVIEW_RESULTS_FILE = "latest-results.json";
const FINITO_SCRIPTS_DIR = path.join("skills", "skills", "finito-scripts", "scripts");
const PR_CREATE_AGENT_TIMEOUT_MS = Number(process.env.PI_PR_CREATE_AGENT_TIMEOUT_MS ?? 180_000);
const PR_CREATE_SCREENSHOT_TIMEOUT_MS = Number(
  process.env.PI_PR_CREATE_SCREENSHOT_TIMEOUT_MS ?? 300_000,
);

const REVIEW_AGENT_ALLOWED_TOOLS = [
  "read",
  "read-many-files-lines",
  "web_search",
  "web_extract",
  "web_research",
  "web_research_status",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
  "project_index_impact",
  "edit",
].join(",");
const DEDUPE_REVIEW_AGENT_ALLOWED_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
].join(",");
const REVIEW_AGENT_TIMEOUT_MS = Number(process.env.PI_REVIEW_AGENT_TIMEOUT_MS ?? 300_000);
const REVIEW_AGENT_REPAIR_TIMEOUT_MS = Number(
  process.env.PI_REVIEW_AGENT_REPAIR_TIMEOUT_MS ?? 60_000,
);
const REVIEW_AGENT_DISABLE_REPAIR = process.env.PI_REVIEW_DISABLE_REPAIR === "1";
const REVIEW_AGENT_ENABLE_TOOLS = process.env.PI_REVIEW_AGENT_ENABLE_TOOLS === "1";
const REVIEW_AGENT_MODEL = process.env.PI_REVIEW_AGENT_MODEL;
const REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS = [
  "You are a focused PR review lane agent.",
  "Use only the enabled tools. Bash is intentionally unavailable. When calling tools, pass arguments as JSON objects, never as stringified JSON.",
  "If you edit files, edit only your lane directory or the shared review directory.",
  "Return JSON only, with this shape:",
  '{"findings":[{"severity":"blocker|high|medium|low|nit","type":"bug|security|performance|maintainability|test|documentation|style|question","path":"file","line":123,"functionName":"name","title":"one line","body":"rationale","confidence":0.8,"suggestion":"fix"}]}',
  "Use an empty findings array if there are no issues.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");
const REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS = [
  "You are a focused PR review lane agent.",
  "Tools are intentionally disabled. Review only the prompt content and return JSON; do not emit tool calls.",
  "If you edit files, edit only your lane directory or the shared review directory.",
  "Return JSON only, with this shape:",
  '{"findings":[{"severity":"blocker|high|medium|low|nit","type":"bug|security|performance|maintainability|test|documentation|style|question","path":"file","line":123,"functionName":"name","title":"one line","body":"rationale","confidence":0.8,"suggestion":"fix"}]}',
  "Use an empty findings array if there are no issues.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");
const REVIEW_AGENT_SYSTEM_PROMPT = REVIEW_AGENT_ENABLE_TOOLS
  ? REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS
  : REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS;
const REVIEW_AFTER_AGENT_TIMEOUT_MS = Number(
  process.env.PI_REVIEW_AFTER_AGENT_TIMEOUT_MS ?? 180_000,
);
const REVIEW_AFTER_AGENT_SYSTEM_PROMPT = [
  "You are a PR post-review analysis agent.",
  "You receive human reviewer comments after the initial review pass.",
  "For each comment: explain the issue briefly and suggest a practical fix.",
  "Identify lane improvements only when confidence is high and the improvement is actionable.",
  "Only treat all-caps NEVER, ALWAYS, and ANTIPATTERN as policy-pattern markers; ignore lowercase or mixed-case variants.",
  "Propose a new lane only when repeated comments reveal a clear missing review capability.",
  "Return JSON only with this shape:",
  '{"analyses":[{"commentId":"id","priority":"action_required|suggestion|informational|nit","theme":"short theme","summary":"what reviewer means","suggestedSolution":"practical fix","confidence":0.0}],"laneImprovements":[{"laneId":"existing-lane-id","currentRule":"optional current rule","proposedImprovement":"specific rule addition","rationale":"why this will catch future issues","affectedCommentIds":["id"]}],"newLaneProposals":[{"proposedLaneId":"kebab-id","title":"Lane title","focus":"what the lane checks","relevantPattern":"repeating pattern","rationale":"why this lane is justified","evidenceCommentIds":["id"]}]}',
  "If unsure, return empty laneImprovements/newLaneProposals arrays rather than guessing.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");

const KNOWN_REVIEW_LANES = [
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
] as const;

function getReviewSessionDir(ctx: ExtensionCommandContext): { sessionId: string; baseDir: string } {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionId = sessionFile ? path.basename(sessionFile, ".jsonl") : "default";
  return { sessionId, baseDir: path.join("tmp", sessionId) };
}

function getSharedDir(ctx: ExtensionCommandContext): string {
  return path.join(getReviewSessionDir(ctx).baseDir, "shared");
}

function getLaneDir(ctx: ExtensionCommandContext, laneId: ReviewLaneId): string {
  const safeLaneId = String(laneId)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return path.join(getReviewSessionDir(ctx).baseDir, safeLaneId || "lane");
}

interface ReviewRenderSnapshot {
  version: 1;
  generatedAt: string;
  targetLabel?: string;
  canPostComments?: boolean;
  summaryInput: ExecutiveSummaryInput;
  runDetailsHeading: string;
  runDetailLines: readonly string[];
  visualRunDetails?: Omit<VisualReviewRunDetails, "markdownReportPath">;
  commentPayload?: unknown;
}

interface ReviewReportPaths {
  markdownPath?: string;
  visualPath?: string;
  commentPayloadPath?: string;
  resultsPath?: string;
}

interface PrCreateDiscoveryPr {
  number: number;
  title?: string;
  url?: string;
  headRefName?: string;
}

interface PrCreateDiscovery {
  status: "found" | "none" | "multiple";
  currentBranch?: string;
  source?: string;
  pr?: PrCreateDiscoveryPr;
  prs?: readonly PrCreateDiscoveryPr[];
}

interface PrCreateBranchValidation {
  prNumber: number;
  prBranch: string;
  baseBranch: string;
  currentBranch: string;
  currentDir?: string;
  isMatch: boolean;
  prWorktree?: string | null;
}

interface PrCreateContextData {
  baseBranch: string;
  branch: string;
  existingPrNumber?: number;
  existingPrTitle?: string;
  existingPrBody?: string;
  commits: string;
  diffStat: string;
  diff: string;
  status: string;
  changedFiles: readonly string[];
  prAnalysis?: Record<string, unknown>;
}

interface PrCreateDraft {
  title: string;
  body: string;
}

interface PrCreateGhResult {
  number: number;
  url?: string;
  title?: string;
}

interface PrUpdateRebaseSummary {
  result: "clean" | "conflicts-resolved";
  migrationRegenerated: boolean;
  conflictAgentRan: boolean;
  iterations: number;
}

interface PrUpdateMetadataSummary {
  updated: boolean;
  reason: string;
  bodyPath?: string;
  title?: string;
}

interface LastStatus {
  prNumber?: number;
  targetLabel?: string;
  title?: string;
  updatedAt?: string;
  summary?: string;
  reportPath?: string;
  visualReportPath?: string;
  commentPayloadPath?: string;
  resultsPath?: string;
  laneCount?: number;
  findingCount?: number;
}

type LaneAgentProgress = "waiting" | "running" | "done" | "error" | "skipped";

interface SharedReviewArtifacts {
  sessionId: string;
  baseDir: string;
  sharedDir: string;
  files: readonly string[];
}

interface LaneAgentResult {
  laneId: ReviewLaneId;
  findings: ReviewFinding[];
  error?: string;
  rawOutput?: string;
  artifactDir?: string;
  artifactFiles?: readonly string[];
}

type LaneArtifactWriter = (fileName: string, content: string) => Promise<void>;

let lastStatus: LastStatus = {};

class ReviewReportMarkdown {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    const markdown = new Markdown(this.text, 0, 0, getMarkdownTheme());
    return colorRenderedIssueFileCells(mergeRenderedIssueGroupRows(markdown.render(width)));
  }

  invalidate(): void {
    // Rendering is delegated to a fresh Markdown component each time.
  }
}

export function mergeRenderedIssueGroupRows(lines: readonly string[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (!isRenderedGroupRowStart(line)) {
      merged.push(line);
      continue;
    }

    const block = [line];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const cursorLine = lines[cursor];
      if (cursorLine === undefined || !isRenderedTableDataLine(cursorLine)) break;
      block.push(cursorLine);
      cursor += 1;
    }
    merged.push(...mergeRenderedGroupBlock(block));
    index = cursor - 1;
  }
  return merged;
}

function isRenderedGroupRowStart(line: string): boolean {
  const parts = splitRenderedTableLine(line);
  return Boolean(
    parts &&
    /^G\d+$/.test(stripAnsi(parts.cells[0] ?? "").trim()) &&
    parts.cells.length >= 3 &&
    parts.cells.slice(1, -1).every((cell) => ["", "—"].includes(stripAnsi(cell).trim())),
  );
}

function isRenderedTableDataLine(line: string): boolean {
  return Boolean(splitRenderedTableLine(line));
}

function splitRenderedTableLine(
  line: string,
): { prefix: string; cells: string[]; suffix: string; visibleWidth: number } | undefined {
  const match = /^(\s*)│(.*)│(\s*)$/.exec(line);
  if (!match) return undefined;
  const body = match[2] ?? "";
  return {
    prefix: match[1] ?? "",
    cells: body.split("│"),
    suffix: match[3] ?? "",
    visibleWidth: visibleTextWidth(line),
  };
}

function colorRenderedIssueFileCells(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const parsed = splitRenderedTableLine(line);
    if (!parsed || parsed.cells.length < 3) return line;
    const severity = /^(🔴|🟠|🟡|⚪)\s*\d+$/u.exec(stripAnsi(parsed.cells[0] ?? "").trim())?.[1];
    const color = severity ? severityAnsiColor(severity) : undefined;
    if (!color) return line;
    const cells = [...parsed.cells];
    cells[1] = colorizeRenderedCell(cells[1] ?? "", color);
    return `${parsed.prefix}│${cells.join("│")}│${parsed.suffix}`;
  });
}

function severityAnsiColor(icon: string): string | undefined {
  const colors: Record<string, string> = {
    "🔴": "\u001B[31m",
    "🟠": "\u001B[38;5;208m",
    "🟡": "\u001B[33m",
    "⚪": "\u001B[37m",
  };
  return colors[icon];
}

function colorizeRenderedCell(cell: string, color: string): string {
  const match = /^(\s*)(.*?)(\s*)$/s.exec(cell);
  if (!match) return cell;
  const [, leading = "", value = "", trailing = ""] = match;
  if (!stripAnsi(value).trim()) return cell;
  return `${leading}${color}${value}\u001B[0m${trailing}`;
}

function mergeRenderedGroupBlock(block: readonly string[]): string[] {
  const parsed = splitRenderedTableLine(block[0] ?? "");
  if (!parsed || parsed.cells.length < 3) return [...block];
  const firstCell = parsed.cells[0] ?? "";
  const fixedVisibleWidth = visibleTextWidth(`${parsed.prefix}│${firstCell}││`);
  const mergedCellWidth = Math.max(1, parsed.visibleWidth - fixedVisibleWidth);
  const textWidth = Math.max(1, mergedCellWidth - 2);
  const groupText = extractRenderedGroupText(block);
  const wrapped = wrapTextWithAnsi(groupText, textWidth);
  const lines = wrapped.length ? wrapped : [""];
  return lines.map((text, lineIndex) =>
    renderMergedGroupLine(
      parsed.prefix,
      lineIndex === 0 ? firstCell : blankCellLike(firstCell),
      text,
      mergedCellWidth,
    ),
  );
}

function extractRenderedGroupText(block: readonly string[]): string {
  return block
    .flatMap((line) => {
      const parsed = splitRenderedTableLine(line);
      if (!parsed || parsed.cells.length < 3) return [];
      const text = parsed.cells.at(-1)?.trim() ?? "";
      return stripAnsi(text).trim() ? [text] : [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderMergedGroupLine(
  prefix: string,
  firstCell: string,
  text: string,
  mergedCellWidth: number,
): string {
  const mergedText = stripAnsi(text).trim() ? ` ${text} ` : " ";
  return `${prefix}│${firstCell}│${padVisibleRight(mergedText, mergedCellWidth)}│`;
}

function blankCellLike(cell: string): string {
  return " ".repeat(visibleTextWidth(cell));
}

function padVisibleRight(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleTextWidth(text)))}`;
}

function visibleTextWidth(text: string): number {
  return visibleWidth(text);
}

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") index += 1;
      continue;
    }
    output += value[index];
  }
  return output;
}

async function prefixTmuxWindowTitleWithPrNumber(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<void> {
  if (prNumber <= 0) return;
  try {
    const current = await pi.exec("tmux", ["display-message", "-p", "#W"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 5_000,
    });
    if (current.code !== 0) return;
    const currentTitle = current.stdout.trim().replace(/\s+/g, " ");
    if (!currentTitle) return;
    const baseTitle = currentTitle.replace(/^(?:#\d+:\s*)+/, "").trim() || currentTitle;
    const nextTitle = `#${prNumber}: ${baseTitle}`;
    if (currentTitle === nextTitle) return;
    await pi.exec("tmux", ["rename-window", nextTitle], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 5_000,
    });
  } catch {
    // Ignore non-tmux environments or transient tmux failures.
  }
}

async function runReviewCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  local: boolean,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const noAgents = hasFlag(tokens, "--no-agents");
  const openVisual = hasFlag(tokens, "--open-visual");
  const laneIds = flagValue(tokens, "--lanes")
    ?.split(",")
    .map((lane) => lane.trim())
    .filter(Boolean);
  const positional = tokens.filter(
    (token) => !token.startsWith("--") && !isFlagValue(tokens, token),
  );

  setStatus(ctx, "⏳:loading");
  showWidget(ctx, [local ? "Preparing local review…" : "Preparing PR review…"]);

  const prData = local
    ? await fetchLocalData(pi.exec, ctx.cwd, positional[0] || "origin/main")
    : await fetchPrData(pi.exec, ctx.cwd, await resolvePrNumber(pi.exec, ctx.cwd, positional[0]));
  if (!local) await prefixTmuxWindowTitleWithPrNumber(pi, ctx, prData.prNumber);
  const targetLabel = local ? `local:${prData.metadata.base.ref}` : `#${prData.prNumber}`;
  const lanes = routeReviewLanes(
    { pr: prData.metadata, files: prData.files, hunks: prData.hunks },
    laneIds,
  );
  const sharedArtifacts = await writeSharedReviewArtifacts(ctx, prData, lanes);
  const ciStatusPromise = runCiWatcher(pi, ctx, local, prData.prNumber, sharedArtifacts);
  const laneProgress = new Map<ReviewLaneId, LaneAgentProgress>(
    lanes.map((lane) => [lane.laneId, "waiting"]),
  );
  const updateLaneProgress = (laneId: ReviewLaneId, progress: LaneAgentProgress) => {
    laneProgress.set(laneId, progress);
    setStatus(ctx, formatReviewAgentProgress(lanes, laneProgress));
  };
  setStatus(ctx, formatReviewAgentProgress(lanes, laneProgress));
  let agentResults: LaneAgentResult[] = noAgents
    ? lanes.map((lane): LaneAgentResult => {
        updateLaneProgress(lane.laneId, "skipped");
        return {
          laneId: lane.laneId,
          findings: [],
          error: "review agents skipped (--no-agents)",
        };
      })
    : await Promise.all(
        lanes.map((lane) =>
          runLaneAgent(pi, ctx, prData.metadata, lane, sharedArtifacts, (progress) =>
            updateLaneProgress(lane.laneId, progress),
          ),
        ),
      );
  const ciStatus = await ciStatusPromise;
  if (!noAgents && ciStatus.status === "fail") {
    agentResults = [
      ...agentResults,
      await runCiAnalysisLaneAgent(pi, ctx, prData.metadata, ciStatus, sharedArtifacts),
    ];
  }
  const errors = agentResults.filter((result) => result.error);
  const findings = agentResults.flatMap((result) => result.findings);
  const issueConsolidations = buildIssueConsolidations(findings);
  const reviewedLaneIds = agentResults
    .filter((result) => !result.error)
    .map((result) => result.laneId);
  const omittedLaneReasons = errors.map((result) => ({
    laneId: result.laneId,
    reason: result.error ?? "review failed",
  }));
  const omittedLaneIds = omittedLaneReasons.map((reason) => reason.laneId);
  const posting = prepareDryRunPosting({
    findings,
    hunks: prData.hunks,
    commitId: prData.metadata.head.sha || undefined,
  });

  const summaryInput: ExecutiveSummaryInput = {
    pr: prData.metadata,
    findings,
    reviewedLaneIds,
    omittedLaneIds,
    omittedLaneReasons,
    issueConsolidations,
    ciStatus,
    coverage: buildReviewSkillCoverage({
      local,
      noAgents,
      prData,
      lanes,
      agentResults,
      ciStatus,
      requestedLaneIds: laneIds,
    }),
  };
  const summary = renderExecutiveSummary(summaryInput);
  const runDetailLines = [
    `Target: ${targetLabel}`,
    `Changed files: ${prData.files.length}. Diff hunks: ${prData.hunks.length}.`,
    `Review lanes: ${formatLaneList(lanes.map((lane) => lane.laneId)) || "none"}.`,
    noAgents
      ? "Review agents skipped (--no-agents)."
      : `Review agents completed: ${reviewedLaneIds.length}/${lanes.length}.`,
    `CI status: ${formatCiStatusLine(ciStatus)}.`,
    `Review agent artifacts: tmp/${getReviewSessionDir(ctx).sessionId}/<lane>/.`,
  ];
  const visualRunDetails = {
    lanePacketCount: lanes.length,
    inlineDraftCount: posting.drafts.length,
    agentArtifacts: agentResults.flatMap((result) =>
      result.artifactDir ? [{ laneId: result.laneId, path: result.artifactDir }] : [],
    ),
    agentErrors: errors.map((result) => ({
      laneId: result.laneId,
      error: result.error,
      rawOutput: result.rawOutput,
    })),
  } satisfies Omit<VisualReviewRunDetails, "markdownReportPath">;
  const snapshot: ReviewRenderSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    targetLabel,
    canPostComments: !local,
    summaryInput,
    runDetailsHeading: "## Review run details",
    runDetailLines,
    visualRunDetails,
    commentPayload: !local ? posting.payload : undefined,
  };
  const reportBody = buildReviewReportBody(snapshot, summary);
  const reportPaths = await writeReviewReports(ctx, prData.prNumber, reportBody, snapshot);
  publishReviewReport(pi, reportBody);

  lastStatus = {
    prNumber: prData.prNumber,
    targetLabel,
    title: prData.metadata.title,
    updatedAt: new Date().toISOString(),
    summary,
    reportPath: reportPaths.markdownPath,
    visualReportPath: reportPaths.visualPath,
    commentPayloadPath: reportPaths.commentPayloadPath,
    resultsPath: reportPaths.resultsPath,
    laneCount: lanes.length,
    findingCount: findings.length,
  };
  setStatus(ctx, errors.length ? "⚠️:done" : "✅:done");
  showWidget(ctx, [statusLine(lastStatus)]);
  if (openVisual && reportPaths.visualPath)
    await openVisualReport(pi, ctx.cwd, reportPaths.visualPath, ctx.signal);
  await promptReviewNextAction(pi, ctx, reportPaths, summaryInput);
}

async function promptReviewNextAction(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reportPaths: ReviewReportPaths,
  summaryInput: ExecutiveSummaryInput,
): Promise<void> {
  if (!ctx.hasUI || !ctx.ui.select) return;
  const options = [
    "post critical/important comments",
    "post all comments",
    "fix critical/important",
    "fix all issues",
  ];
  const choice = await ctx.ui.select(
    "Review complete. What would you like to do? (Esc to type something else)",
    options,
  );
  if (!choice) return;
  const prompt = buildReviewNextActionPrompt(choice, reportPaths, summaryInput);
  if (pi.sendUserMessage) {
    await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return;
  }
  showWidget(ctx, ["Selected review action:", choice, "", prompt]);
}

function buildReviewNextActionPrompt(
  choice: string,
  reportPaths: ReviewReportPaths,
  summaryInput: ExecutiveSummaryInput,
): string {
  const artifactLines = [
    reportPaths.resultsPath ? `Cached review results: ${reportPaths.resultsPath}` : undefined,
    reportPaths.markdownPath ? `Markdown report: ${reportPaths.markdownPath}` : undefined,
    reportPaths.commentPayloadPath
      ? `Prepared comment payload: ${reportPaths.commentPayloadPath}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  const target = `PR #${summaryInput.pr.ref.number} (${summaryInput.pr.title})`;
  const criticalCount = summaryInput.findings.filter(
    (finding) => finding.severity === "blocker" || finding.severity === "high",
  ).length;
  const totalCount = summaryInput.findings.length;

  if (choice === "post critical/important comments") {
    return [
      `For ${target}, post only critical/important review comments (severity blocker/high).`,
      `There are ${criticalCount} critical/important finding(s).`,
      ...artifactLines,
      "Do not post medium/low/nit comments. Do not add a summary-only comment.",
    ].join("\n");
  }
  if (choice === "post all comments") {
    return [
      `For ${target}, post all prepared actionable review comments.`,
      `There are ${totalCount} finding(s).`,
      ...artifactLines,
      "Do not add a summary-only comment unless there is a cross-cutting concern not covered by line comments.",
    ].join("\n");
  }
  if (choice === "fix critical/important") {
    return [
      `For ${target}, fix only critical/important review issues (severity blocker/high).`,
      `There are ${criticalCount} critical/important finding(s).`,
      ...artifactLines,
      "Read the cached review results first, then edit only files needed for those issues. Do not opportunistically fix lower-severity findings.",
    ].join("\n");
  }
  return [
    `For ${target}, fix all review issues from the completed review.`,
    `There are ${totalCount} finding(s).`,
    ...artifactLines,
    "Read the cached review results first, then edit only files needed for the review findings.",
  ].join("\n");
}

async function runPrCreateCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const positional = positionalArgs(tokens, ["--base", "--screenshots"]);
  const providedTarget = positional[0];
  const explicitPrNumber =
    providedTarget && /^\d+$/.test(providedTarget) ? Number(providedTarget) : undefined;
  const branchOverride =
    providedTarget && explicitPrNumber === undefined ? providedTarget : undefined;
  const baseBranchOverride = flagValue(tokens, "--base");
  const screenshotPath = flagValue(tokens, "--screenshots");
  const noSync = hasFlag(tokens, "--no-sync");
  const noChecks = hasFlag(tokens, "--no-checks");
  const noPush = hasFlag(tokens, "--no-push");
  const noCiWatch = hasFlag(tokens, "--no-ci-watch");
  const skipScreenshots = hasFlag(tokens, "--skip-screenshots");
  const ready = hasFlag(tokens, "--ready");

  setStatus(ctx, "⏳:pr-create");
  showWidget(ctx, ["Preparing PR creation workflow…"]);

  try {
    const discovery = await discoverPrForCreate(pi, ctx, explicitPrNumber, branchOverride);
    if (discovery.status === "multiple")
      throw new Error(formatMultiplePrCreateDiscovery(discovery));

    const currentBranch = await getCurrentGitBranch(pi, ctx);
    let baseBranch = baseBranchOverride || "main";
    let branch = branchOverride || currentBranch;
    let existingPrNumber: number | undefined;
    let existingPrTitle: string | undefined;
    let existingPrBody: string | undefined;

    if (discovery.status === "found" && discovery.pr) {
      existingPrNumber = discovery.pr.number;
      existingPrTitle = discovery.pr.title;
      const validation = await validatePrCreateBranch(pi, ctx, existingPrNumber);
      baseBranch = baseBranchOverride || validation.baseBranch || baseBranch;
      branch = validation.prBranch || discovery.pr.headRefName || branch;
      if (!validation.isMatch) throw new Error(formatPrBranchMismatch(validation));
      existingPrBody = await fetchExistingPrBody(pi, ctx, existingPrNumber);
      await prefixTmuxWindowTitleWithPrNumber(pi, ctx, existingPrNumber);
    }

    if (!branch) throw new Error("Could not determine the current branch for PR creation.");
    if (branch !== currentBranch)
      throw new Error(
        `Current branch is ${currentBranch}, but PR branch is ${branch}. Switch worktrees before running /pr-create.`,
      );
    if (!existingPrNumber && branch === baseBranch)
      throw new Error(`Refusing to create a PR from the base branch (${baseBranch}).`);

    if (!noSync) {
      showWidget(ctx, [`Syncing ${branch} with origin/${baseBranch}…`]);
      await execRequired(pi, ctx, "git", ["fetch", "origin"], "git fetch origin", 120_000);
      await execRequired(
        pi,
        ctx,
        "git",
        ["rebase", `origin/${baseBranch}`],
        `git rebase origin/${baseBranch}`,
        300_000,
      );
    }

    if (!noChecks) {
      showWidget(ctx, [
        "Running PR preflight checks…",
        "bun check --fix",
        "bun format",
        "bun run typecheck",
      ]);
      await execRequired(pi, ctx, "bun", ["check", "--fix"], "bun check --fix", 300_000);
      await execRequired(pi, ctx, "bun", ["format"], "bun format", 300_000);
      await execRequired(pi, ctx, "bun", ["run", "typecheck"], "bun run typecheck", 300_000);
    }

    const contextData = await gatherPrCreateContext(pi, ctx, {
      baseBranch,
      branch,
      existingPrNumber,
      existingPrTitle,
      existingPrBody,
    });
    const labels = determinePrCreateLabels(contextData.changedFiles);
    const screenshotMarkdown = await getPrCreateScreenshotMarkdown(pi, ctx, {
      contextData,
      screenshotPath,
      skipScreenshots,
    });
    const draft = await draftPrCreateTitleAndBody(pi, ctx, contextData, labels, screenshotMarkdown);
    const bodyPath = await writePrCreateArtifact(
      ctx,
      `${safeFileName(branch)}-pr-body.md`,
      draft.body,
    );

    if (!noPush) {
      showWidget(ctx, [`Pushing ${branch} to origin…`]);
      await execRequired(
        pi,
        ctx,
        "git",
        ["push", "-u", "origin", branch],
        `git push -u origin ${branch}`,
        300_000,
      );
    }

    showWidget(ctx, [
      existingPrNumber ? `Updating PR #${existingPrNumber}…` : "Creating draft PR…",
    ]);
    const ghResult = existingPrNumber
      ? await updateExistingPr(pi, ctx, existingPrNumber, draft, bodyPath, labels)
      : await createNewPr(pi, ctx, branch, baseBranch, draft, bodyPath, labels, ready);

    await prefixTmuxWindowTitleWithPrNumber(pi, ctx, ghResult.number);
    const report = renderPrCreateReport({
      action: existingPrNumber ? "updated" : "created",
      pr: ghResult,
      branch,
      baseBranch,
      labels,
      bodyPath,
      noSync,
      noChecks,
      noPush,
      screenshotMarkdown,
    });
    publishReviewReport(pi, report);
    setStatus(ctx, `✅:pr #${ghResult.number}`);
    showWidget(ctx, [
      `PR #${ghResult.number} ${existingPrNumber ? "updated" : "created"}.`,
      ...(ghResult.url ? [ghResult.url] : []),
    ]);

    if (!noCiWatch) startPrCreateCiWatcher(pi, ctx, ghResult.number);
    await promptPrCreateSelfReview(pi, ctx, ghResult.number);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(ctx, "❌:pr-create");
    showWidget(ctx, ["PR creation failed:", message]);
    if (ctx.hasUI) ctx.ui.notify(`PR creation failed: ${message}`, "error");
  }
}

async function discoverPrForCreate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  explicitPrNumber: number | undefined,
  branchOverride: string | undefined,
): Promise<PrCreateDiscovery> {
  if (explicitPrNumber !== undefined) {
    const result = await pi.exec(
      "bun",
      [path.join(FINITO_SCRIPTS_DIR, "getPrNumber.ts"), String(explicitPrNumber)],
      { cwd: ctx.cwd, signal: ctx.signal, timeout: 30_000 },
    );
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `PR #${explicitPrNumber} was not found.`);
    return normalizePrCreateDiscovery(parseJsonObjectFromOutput(result.stdout));
  }

  if (branchOverride) {
    const result = await execRequired(
      pi,
      ctx,
      "gh",
      [
        "pr",
        "list",
        "--head",
        branchOverride,
        "--state",
        "open",
        "--json",
        "number,title,url,headRefName",
        "--limit",
        "10",
      ],
      `gh pr list --head ${branchOverride}`,
      30_000,
    );
    const parsed = parseJsonArrayFromOutput(result.stdout);
    const prs = parsed.flatMap(normalizePrCreateDiscoveryPr);
    return {
      status: prs.length > 1 ? "multiple" : prs.length === 1 ? "found" : "none",
      currentBranch: await getCurrentGitBranch(pi, ctx).catch(() => undefined),
      source: "branch",
      pr: prs[0],
      prs,
    };
  }

  const result = await pi.exec("bun", [path.join(FINITO_SCRIPTS_DIR, "getPrNumber.ts")], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 30_000,
  });
  const parsed = parseJsonObjectFromOutput(result.stdout);
  if (!parsed && result.code !== 0)
    throw new Error(result.stderr.trim() || "Failed to determine PR status.");
  return normalizePrCreateDiscovery(parsed);
}

function normalizePrCreateDiscovery(value: Record<string, unknown> | undefined): PrCreateDiscovery {
  const status = stringValue(value?.status);
  const pr = normalizePrCreateDiscoveryPr(value?.pr)[0];
  const prsValue = value?.prs ?? value?.list;
  const prs = Array.isArray(prsValue) ? prsValue.flatMap(normalizePrCreateDiscoveryPr) : [];
  if (status === "found" && pr) {
    return {
      status: "found",
      currentBranch: stringValue(value?.currentBranch),
      source: stringValue(value?.source),
      pr,
      prs,
    };
  }
  if (status === "multiple") {
    return {
      status: "multiple",
      currentBranch: stringValue(value?.currentBranch),
      source: stringValue(value?.source),
      prs,
    };
  }
  return {
    status: "none",
    currentBranch: stringValue(value?.currentBranch),
    source: stringValue(value?.source),
    prs,
  };
}

function normalizePrCreateDiscoveryPr(value: unknown): PrCreateDiscoveryPr[] {
  if (!isRecord(value)) return [];
  const number = numberValue(value.number);
  if (number === undefined) return [];
  return [
    {
      number,
      title: stringValue(value.title),
      url: stringValue(value.url),
      headRefName: stringValue(value.headRefName),
    },
  ];
}

function formatMultiplePrCreateDiscovery(discovery: PrCreateDiscovery): string {
  const prs = discovery.prs ?? [];
  if (!prs.length) return "Multiple PRs matched. Pass a PR number or branch name to /pr-create.";
  return [
    "Multiple PRs matched. Pass a PR number or branch name to /pr-create:",
    ...prs.map(
      (pr) =>
        `- #${pr.number}${pr.title ? ` ${pr.title}` : ""}${pr.headRefName ? ` (${pr.headRefName})` : ""}`,
    ),
  ].join("\n");
}

async function validatePrCreateBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<PrCreateBranchValidation> {
  const result = await pi.exec(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "validatePrBranch.ts"), String(prNumber)],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 30_000 },
  );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const validation = normalizePrCreateBranchValidation(parsed);
  if (result.code !== 0 && !validation) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Branch validation failed for PR #${prNumber}.`,
    );
  }
  if (!validation) throw new Error(`Branch validation returned no data for PR #${prNumber}.`);
  return validation;
}

function normalizePrCreateBranchValidation(
  value: Record<string, unknown> | undefined,
): PrCreateBranchValidation | undefined {
  const prNumber = numberValue(value?.prNumber);
  const prBranch = stringValue(value?.prBranch);
  const baseBranch = stringValue(value?.baseBranch);
  const currentBranch = stringValue(value?.currentBranch);
  if (prNumber === undefined || !prBranch || !baseBranch || !currentBranch) return undefined;
  return {
    prNumber,
    prBranch,
    baseBranch,
    currentBranch,
    currentDir: stringValue(value?.currentDir),
    isMatch: Boolean(value?.isMatch),
    prWorktree: stringValue(value?.prWorktree) ?? null,
  };
}

function formatPrBranchMismatch(validation: PrCreateBranchValidation): string {
  return [
    `Branch mismatch for PR #${validation.prNumber}.`,
    `PR branch: ${validation.prBranch}`,
    `Current branch: ${validation.currentBranch}`,
    validation.prWorktree ? `Use worktree: ${validation.prWorktree}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function getCurrentGitBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const result = await execRequired(
    pi,
    ctx,
    "git",
    ["branch", "--show-current"],
    "git branch --show-current",
    10_000,
  );
  const branch = result.stdout.trim();
  if (!branch) throw new Error("Current git branch is detached or unknown.");
  return branch;
}

async function fetchExistingPrBody(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<string | undefined> {
  const result = await pi.exec("gh", ["pr", "view", String(prNumber), "--json", "body"], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 30_000,
  });
  if (result.code !== 0) return undefined;
  return stringValue(parseJsonObjectFromOutput(result.stdout)?.body);
}

async function gatherPrCreateContext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: {
    baseBranch: string;
    branch: string;
    existingPrNumber?: number;
    existingPrTitle?: string;
    existingPrBody?: string;
  },
): Promise<PrCreateContextData> {
  const range = `origin/${input.baseBranch}...HEAD`;
  const commitRange = `origin/${input.baseBranch}..HEAD`;
  const [commits, diffStat, diff, status, changedFilesRaw] = await Promise.all([
    execRequired(pi, ctx, "git", ["log", "--pretty=format:%h %s", commitRange], "git log", 30_000),
    execRequired(pi, ctx, "git", ["diff", "--stat", range], "git diff --stat", 30_000),
    execRequired(pi, ctx, "git", ["diff", "--find-renames", range], "git diff", 60_000),
    execRequired(pi, ctx, "git", ["status", "--short"], "git status --short", 30_000),
    execRequired(pi, ctx, "git", ["diff", "--name-only", range], "git diff --name-only", 30_000),
  ]);
  const prAnalysis = input.existingPrNumber
    ? await runPrCreateAnalysis(pi, ctx, input.existingPrNumber)
    : undefined;
  return {
    baseBranch: input.baseBranch,
    branch: input.branch,
    existingPrNumber: input.existingPrNumber,
    existingPrTitle: input.existingPrTitle,
    existingPrBody: input.existingPrBody,
    commits: commits.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    diff: diff.stdout,
    status: status.stdout.trim(),
    changedFiles: changedFilesRaw.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    prAnalysis,
  };
}

async function runPrCreateAnalysis(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<Record<string, unknown> | undefined> {
  const result = await pi.exec(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "prAnalysis.ts"), String(prNumber)],
    {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 60_000,
    },
  );
  await writePrCreateArtifact(ctx, "pr-analysis.stdout.json", result.stdout || "");
  if (result.stderr.trim())
    await writePrCreateArtifact(ctx, "pr-analysis.stderr.txt", result.stderr);
  if (result.code !== 0) return undefined;
  return parseJsonObjectFromOutput(result.stdout);
}

function determinePrCreateLabels(changedFiles: readonly string[]): string[] {
  const hasUi = changedFiles.some(isUiPath);
  const hasServer = changedFiles.some((file) =>
    /(^|\/)(server|trpc)(\/|$)|(^|\/)api(\/|$)/i.test(file),
  );
  const hasDb = changedFiles.some((file) =>
    /(^|\/)(drizzle|migrations)(\/|$)|(^|\/)db\/schema(\/|$)/i.test(file),
  );
  const hasDeployedCode = changedFiles.some((file) => !isNoDeployOnlyPath(file));
  if (!hasDeployedCode) return ["no-deploy"];
  return [
    hasUi ? "ui" : undefined,
    hasServer ? "server" : undefined,
    hasDb ? "db" : undefined,
  ].filter((label): label is string => Boolean(label));
}

function isNoDeployOnlyPath(filePath: string): boolean {
  return (
    filePath.endsWith(".md") ||
    filePath.startsWith(".claude/") ||
    filePath.startsWith(".github/") ||
    filePath.startsWith(".pi/") ||
    filePath.startsWith("docs/") ||
    filePath.startsWith("scripts/") ||
    filePath.startsWith("skills/") ||
    /(^|\/)(tsconfig|biome|eslint|prettier|package|bunfig|vite|vitest|turbo|oxlint|oxfmt)[^/]*\.(json|jsonc|js|ts|mjs|cjs)$/i.test(
      filePath,
    )
  );
}

async function getPrCreateScreenshotMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: {
    contextData: PrCreateContextData;
    screenshotPath?: string;
    skipScreenshots: boolean;
  },
): Promise<string> {
  if (input.screenshotPath) return readProjectTextFile(ctx, input.screenshotPath);
  const uiFiles = input.contextData.changedFiles.filter(isUiPath);
  if (!uiFiles.length || input.skipScreenshots) return "";
  showWidget(ctx, ["UI changes detected; capturing PR screenshots…", ...uiFiles.slice(0, 5)]);
  const result = await runPrCreateScreenshotAgent(pi, ctx, input.contextData, uiFiles);
  if (result.failures.length) {
    throw new Error(
      [
        "Screenshot capture failed. Re-run /pr-create with --screenshots <file> after capturing them, or --skip-screenshots to override.",
        ...result.failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
  }
  return result.markdown;
}

async function readProjectTextFile(
  ctx: ExtensionCommandContext,
  requestedPath: string,
): Promise<string> {
  const absolutePath = path.resolve(ctx.cwd, requestedPath);
  const relativeCheck = path.relative(ctx.cwd, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck))
    throw new Error(`Path is outside project: ${requestedPath}`);
  return readFile(absolutePath, "utf8");
}

async function formatProjectFilesForPrompt(
  ctx: ExtensionCommandContext,
  filePaths: readonly string[],
  maxLength: number,
): Promise<string> {
  const sections: string[] = [];
  for (const filePath of filePaths) {
    const content = await readProjectTextFile(ctx, filePath).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      return `<<failed to read: ${message}>>`;
    });
    sections.push([`### ${filePath}`, "```", content, "```"].join("\n"));
  }
  return truncateForPrompt(sections.join("\n\n"), maxLength);
}

async function applyAgentFileWrites(
  ctx: ExtensionCommandContext,
  parsed: Record<string, unknown> | undefined,
  allowPath: (filePath: string) => boolean = () => true,
): Promise<string[]> {
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  const written: string[] = [];
  for (const file of files) {
    if (!isRecord(file)) continue;
    const filePath = stringValue(file.path);
    const content = typeof file.content === "string" ? file.content : undefined;
    if (!filePath || content === undefined || !allowPath(filePath)) continue;
    const absolutePath = path.resolve(ctx.cwd, filePath);
    const relativeCheck = path.relative(ctx.cwd, absolutePath);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) continue;
    await writeFile(absolutePath, content, "utf8");
    written.push(relativePath(ctx.cwd, absolutePath));
  }
  return written;
}

async function runPrCreateScreenshotAgent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  contextData: PrCreateContextData,
  uiFiles: readonly string[],
): Promise<{ markdown: string; failures: string[] }> {
  const prompt = [
    "Plan screenshots for UI changes before PR creation.",
    "Read skills/skills/pr/visual.md for screenshot requirements and selector guidance.",
    "Do not call bash or run screenshot commands; bash is intentionally unavailable. Return the screenshot commands a human or caller should run.",
    "Return JSON only with this shape:",
    '{"markdown":"### Page\\n![description](github-url)","failures":["failure reason or required screenshot command"]}',
    "Use an empty failures array on success. Do not silently skip failures.",
    "",
    "## Changed UI files",
    ...uiFiles.map((file) => `- ${file}`),
    "",
    "## Diff stat",
    contextData.diffStat || "(none)",
    "",
    "## Relevant diff (truncated)",
    truncateForPrompt(contextData.diff, 40_000),
  ].join("\n");
  const args = [
    "--print",
    "--mode",
    "text",
    ...(REVIEW_AGENT_MODEL ? ["--model", REVIEW_AGENT_MODEL] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    "You are a focused screenshot planning agent for PR creation. Bash is unavailable; return JSON only.",
    prompt,
  ];
  const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: PR_CREATE_SCREENSHOT_TIMEOUT_MS,
  });
  await writePrCreateArtifact(ctx, "screenshots-stdout.txt", result.stdout);
  await writePrCreateArtifact(ctx, "screenshots-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `screenshot agent exited ${result.code}`,
    );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const failures = Array.isArray(parsed?.failures)
    ? parsed.failures.map((failure) => String(failure)).filter(Boolean)
    : [];
  return { markdown: stringValue(parsed?.markdown) ?? "", failures };
}

async function draftPrCreateTitleAndBody(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  contextData: PrCreateContextData,
  labels: readonly string[],
  screenshotMarkdown: string,
): Promise<PrCreateDraft> {
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const prompt = buildPrCreateDraftPrompt(contextData, labels, screenshotMarkdown);
  await writePrCreateArtifact(ctx, "draft-prompt.md", prompt);
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    [
      "You draft pull request titles and descriptions from complete branch context.",
      "Use Conventional Commits with capitalized type, for example Feat(scope): add thing.",
      "The body must contain ## Why, ## What, ## Testing, and ## Affected Routes.",
      'Return JSON only with this shape: {"title":"Feat(scope): concise title","body":"markdown body"}.',
    ].join("\n"),
    prompt,
  ];
  const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: PR_CREATE_AGENT_TIMEOUT_MS,
  });
  await writePrCreateArtifact(ctx, "draft-stdout.txt", result.stdout);
  await writePrCreateArtifact(ctx, "draft-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `draft agent exited ${result.code}`,
    );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const fallback = fallbackPrCreateDraft(contextData);
  return normalizePrCreateDraft(
    {
      title: stringValue(parsed?.title) ?? fallback.title,
      body: stringValue(parsed?.body) ?? fallback.body,
    },
    screenshotMarkdown,
  );
}

function buildPrCreateDraftPrompt(
  contextData: PrCreateContextData,
  labels: readonly string[],
  screenshotMarkdown: string,
): string {
  return [
    "# PR creation context",
    "",
    `Mode: ${contextData.existingPrNumber ? `update PR #${contextData.existingPrNumber}` : "create new draft PR"}`,
    `Branch: ${contextData.branch}`,
    `Base branch: ${contextData.baseBranch}`,
    `Labels: ${labels.join(", ") || "none"}`,
    contextData.existingPrTitle ? `Existing title: ${contextData.existingPrTitle}` : undefined,
    contextData.existingPrBody
      ? `Existing body:\n${truncateForPrompt(contextData.existingPrBody, 8_000)}`
      : undefined,
    "",
    "## Required title style",
    "Use <Type>(<scope>): <description> with capitalized type. Valid types: Feat, Fix, Refactor, Perf, Docs, Test, Chore, Style, CI, Build.",
    "Reflect the whole branch, not only the latest commit.",
    "",
    "## Required body sections",
    "## Why — 1-2 bullets with business/user value, not implementation details.",
    "## What — high-level summary of changed behavior.",
    "## Testing — behavior coverage and known gaps; do not paste command output.",
    "## Affected Routes — list impacted routes; mark uncovered routes with ⚠️ when known.",
    screenshotMarkdown ? `## Screenshot markdown to embed\n${screenshotMarkdown}` : undefined,
    "",
    "## Commits since base",
    contextData.commits || "(no commits listed)",
    "",
    "## Changed files",
    contextData.changedFiles.map((file) => `- ${file}`).join("\n") || "(none)",
    "",
    "## Git status",
    contextData.status || "clean",
    "",
    "## Diff stat",
    contextData.diffStat || "(none)",
    "",
    contextData.prAnalysis
      ? `## PR pre-analysis JSON\n${JSON.stringify(contextData.prAnalysis, null, 2)}`
      : undefined,
    "",
    "## Complete diff (truncated)",
    truncateForPrompt(contextData.diff, 80_000),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function fallbackPrCreateDraft(contextData: PrCreateContextData): PrCreateDraft {
  const firstCommit = contextData.commits
    .split(/\r?\n/)
    .find(Boolean)
    ?.replace(/^\S+\s+/, "");
  return {
    title: sentenceCaseConventionalTitle(firstCommit || `update ${contextData.branch}`),
    body: [
      "## Why",
      "- This branch updates the project behavior described by the changed files.",
      "",
      "## What",
      ...contextData.changedFiles.slice(0, 20).map((file) => `- Updated ${file}`),
      contextData.changedFiles.length > 20
        ? `- Updated ${contextData.changedFiles.length - 20} additional file(s)`
        : undefined,
      "",
      "## Testing",
      "- Not covered: summarize behavior-specific automated coverage before marking ready for review.",
      "",
      "## Affected Routes",
      "- Not determined",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
}

function sentenceCaseConventionalTitle(value: string): string {
  const normalized = value
    .replace(/^(feat|fix|docs|test|chore|refactor|perf|style|ci|build)(\(.+?\))?:\s*/i, "")
    .trim();
  return `Chore: ${normalized || "update project"}`;
}

function normalizePrCreateDraft(draft: PrCreateDraft, screenshotMarkdown: string): PrCreateDraft {
  const title = draft.title.replace(/\s+/g, " ").trim() || "Chore: update project";
  let body = draft.body.trim();
  for (const heading of ["## Why", "## What", "## Testing", "## Affected Routes"]) {
    if (!new RegExp(`^${escapeRegExp(heading)}\\b`, "m").test(body))
      body += `\n\n${heading}\n- Not determined`;
  }
  if (screenshotMarkdown && !body.includes(screenshotMarkdown.trim())) {
    body = body.replace(/(## Affected Routes\s*\n)/, `$1${screenshotMarkdown.trim()}\n`);
  }
  return { title, body: `${body.trim()}\n` };
}

async function writePrCreateArtifact(
  ctx: ExtensionCommandContext,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = path.join(ctx.cwd, getReviewSessionDir(ctx).baseDir, "pr-create");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

async function updateExistingPr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
  draft: PrCreateDraft,
  bodyPath: string,
  labels: readonly string[],
): Promise<PrCreateGhResult> {
  const args = ["pr", "edit", String(prNumber), "--title", draft.title, "--body-file", bodyPath];
  if (labels.length) args.push("--add-label", labels.join(","));
  await execRequired(pi, ctx, "gh", args, `gh pr edit ${prNumber}`, 60_000);
  return fetchPrCreateGhResult(pi, ctx, String(prNumber));
}

async function createNewPr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  branch: string,
  baseBranch: string,
  draft: PrCreateDraft,
  bodyPath: string,
  labels: readonly string[],
  ready: boolean,
): Promise<PrCreateGhResult> {
  const args = [
    "pr",
    "create",
    ...(ready ? [] : ["--draft"]),
    "--head",
    branch,
    "--base",
    baseBranch,
    "--title",
    draft.title,
    "--body-file",
    bodyPath,
  ];
  if (labels.length) args.push("--label", labels.join(","));
  const result = await execRequired(pi, ctx, "gh", args, "gh pr create", 60_000);
  const url = result.stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => /^https?:\/\//.test(line.trim()))
    ?.trim();
  return fetchPrCreateGhResult(pi, ctx, url || branch);
}

async function fetchPrCreateGhResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  selector: string,
): Promise<PrCreateGhResult> {
  const result = await execRequired(
    pi,
    ctx,
    "gh",
    ["pr", "view", selector, "--json", "number,url,title"],
    `gh pr view ${selector}`,
    30_000,
  );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const number = numberValue(parsed?.number);
  if (number === undefined) throw new Error(`Could not determine PR number for ${selector}.`);
  return { number, url: stringValue(parsed?.url), title: stringValue(parsed?.title) };
}

function renderPrCreateReport(input: {
  action: "created" | "updated";
  pr: PrCreateGhResult;
  branch: string;
  baseBranch: string;
  labels: readonly string[];
  bodyPath: string;
  noSync: boolean;
  noChecks: boolean;
  noPush: boolean;
  screenshotMarkdown: string;
}): string {
  return [
    "## PR creation",
    "",
    `PR #${input.pr.number} ${input.action}.`,
    input.pr.url ? `URL: ${input.pr.url}` : undefined,
    input.pr.title ? `Title: ${input.pr.title}` : undefined,
    `Branch: ${input.branch} → ${input.baseBranch}`,
    `Labels: ${input.labels.join(", ") || "none"}`,
    `Body file: ${input.bodyPath}`,
    input.noSync ? "Sync skipped (--no-sync)." : "Branch synced with base before PR update.",
    input.noChecks
      ? "Checks skipped (--no-checks)."
      : "Preflight checks completed: bun check --fix, bun format, bun run typecheck.",
    input.noPush ? "Push skipped (--no-push)." : "Branch pushed to origin.",
    input.screenshotMarkdown ? "Screenshots were embedded in the PR body." : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function startPrCreateCiWatcher(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): void {
  void runCiWatcher(pi, ctx, false, prNumber, {
    sessionId: getReviewSessionDir(ctx).sessionId,
    baseDir: getReviewSessionDir(ctx).baseDir,
    sharedDir: getSharedDir(ctx),
    files: [],
  })
    .then((status) => {
      const message = `PR #${prNumber} CI: ${formatCiStatusLine(status)}`;
      showWidget(ctx, [message]);
      if (ctx.hasUI) ctx.ui.notify(message, status.status === "fail" ? "warning" : "info");
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`CI watcher failed for PR #${prNumber}: ${message}`, "warning");
    });
}

async function promptPrCreateSelfReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<void> {
  if (!ctx.hasUI || !ctx.ui.select) return;
  const choice = await ctx.ui.select("PR created. Want me to self-review it?", ["yes", "no"]);
  if (choice !== "yes") return;
  if (pi.sendUserMessage)
    await pi.sendUserMessage(`/pr-review ${prNumber}`, { deliverAs: "followUp" });
  else showWidget(ctx, [`Run /pr-review ${prNumber} to self-review this PR.`]);
}

async function runPrUpdateCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const positional = positionalArgs(tokens);
  const prNumberArg = positional[0];
  const explicitPrNumber =
    prNumberArg && /^\d+$/.test(prNumberArg) ? Number(prNumberArg) : undefined;
  const noChecks = hasFlag(tokens, "--no-checks");
  const noPush = hasFlag(tokens, "--no-push");
  const noCiWatch = hasFlag(tokens, "--no-ci-watch");
  const noMetadata = hasFlag(tokens, "--no-metadata");

  setStatus(ctx, "⏳:pr-update");
  showWidget(ctx, ["Preparing PR update workflow…"]);

  try {
    const discovery = await discoverPrForCreate(pi, ctx, explicitPrNumber, undefined);
    if (discovery.status === "multiple")
      throw new Error(formatMultiplePrCreateDiscovery(discovery));
    if (discovery.status !== "found" || !discovery.pr)
      throw new Error("No open PR found for the current branch. Pass a PR number to /pr-update.");

    const prNumber = discovery.pr.number;
    const validation = await validatePrCreateBranch(pi, ctx, prNumber);
    if (!validation.isMatch) throw new Error(formatPrBranchMismatch(validation));
    await prefixTmuxWindowTitleWithPrNumber(pi, ctx, prNumber);

    showWidget(ctx, [`Updating PR #${prNumber} from origin/${validation.baseBranch}…`]);
    const rebase = await rebasePrUpdateBranch(pi, ctx, validation.baseBranch, prNumber);
    const docsFixed = await fixPrUpdateStaleDocs(pi, ctx, prNumber);

    if (!noChecks) {
      showWidget(ctx, [
        "Running PR update checks…",
        "bun check --fix",
        "bun format",
        "bun run typecheck",
      ]);
      await execRequired(pi, ctx, "bun", ["check", "--fix"], "bun check --fix", 300_000);
      await execRequired(pi, ctx, "bun", ["format"], "bun format", 300_000);
      await execRequired(pi, ctx, "bun", ["run", "typecheck"], "bun run typecheck", 300_000);
    }

    const existingPrBody = await fetchExistingPrBody(pi, ctx, prNumber);
    const contextData = await gatherPrCreateContext(pi, ctx, {
      baseBranch: validation.baseBranch,
      branch: validation.prBranch,
      existingPrNumber: prNumber,
      existingPrTitle: discovery.pr.title,
      existingPrBody,
    });
    const labels = determinePrCreateLabels(contextData.changedFiles);
    const pushResult = noPush ? "skipped" : await pushPrUpdateBranch(pi, ctx);
    const metadata = noMetadata
      ? { updated: false, reason: "metadata skipped (--no-metadata)" }
      : await maybeUpdatePrMetadata(pi, ctx, prNumber, contextData, labels);
    const pr = await fetchPrCreateGhResult(pi, ctx, String(prNumber));

    const report = renderPrUpdateReport({
      pr,
      branch: validation.prBranch,
      baseBranch: validation.baseBranch,
      rebase,
      docsFixed,
      checksSkipped: noChecks,
      pushResult,
      metadata,
      labels,
    });
    publishReviewReport(pi, report);
    setStatus(ctx, `✅:updated #${prNumber}`);
    showWidget(ctx, [`PR #${prNumber} updated.`, ...(pr.url ? [pr.url] : [])]);
    if (!noCiWatch) startPrCreateCiWatcher(pi, ctx, prNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(ctx, "❌:pr-update");
    showWidget(ctx, ["PR update failed:", message]);
    if (ctx.hasUI) ctx.ui.notify(`PR update failed: ${message}`, "error");
  }
}

async function rebasePrUpdateBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  baseBranch: string,
  prNumber: number,
): Promise<PrUpdateRebaseSummary> {
  await execRequired(pi, ctx, "git", ["fetch", "origin"], "git fetch origin", 120_000);
  const rebase = await pi.exec("git", ["rebase", `origin/${baseBranch}`], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 300_000,
  });
  if (rebase.code === 0) {
    await writePrUpdateArtifact(ctx, "rebase.txt", rebase.stdout || "Rebase completed cleanly.\n");
    return { result: "clean", migrationRegenerated: false, conflictAgentRan: false, iterations: 0 };
  }
  await writePrUpdateArtifact(
    ctx,
    "rebase-conflict.txt",
    [rebase.stdout, rebase.stderr].join("\n"),
  );
  return resolvePrUpdateRebaseConflicts(pi, ctx, baseBranch, prNumber);
}

async function resolvePrUpdateRebaseConflicts(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  baseBranch: string,
  prNumber: number,
): Promise<PrUpdateRebaseSummary> {
  let migrationRegenerated = false;
  let conflictAgentRan = false;
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    const conflicted = await getPrUpdateConflictedFiles(pi, ctx);
    if (!conflicted.length) {
      return {
        result: "conflicts-resolved",
        migrationRegenerated,
        conflictAgentRan,
        iterations: iteration - 1,
      };
    }

    const migrationConflicts = conflicted.filter(isPrUpdateMigrationPath);
    if (migrationConflicts.length) {
      migrationRegenerated = true;
      await execRequired(
        pi,
        ctx,
        "git",
        ["checkout", `origin/${baseBranch}`, "--", "drizzle/"],
        "restore migration files from base",
        60_000,
      );
      await execRequired(pi, ctx, "bun", ["db:seed", "--unsafe"], "bun db:seed --unsafe", 300_000);
      await execRequired(pi, ctx, "bun", ["db:generate"], "bun db:generate", 300_000);
    }

    const remaining = (await getPrUpdateConflictedFiles(pi, ctx)).filter(
      (file) => !isPrUpdateMigrationPath(file),
    );
    if (remaining.length) {
      conflictAgentRan = true;
      await runPrUpdateConflictAgent(pi, ctx, prNumber, baseBranch, remaining);
    }

    await assertNoPrUpdateConflictMarkers(ctx, conflicted);
    await execRequired(pi, ctx, "git", ["add", "-A"], "git add -A", 60_000);

    const unresolved = await getPrUpdateConflictedFiles(pi, ctx);
    if (unresolved.length) {
      throw new Error(
        `Unresolved rebase conflicts remain:\n${unresolved.map((file) => `- ${file}`).join("\n")}`,
      );
    }
    const continued = await pi.exec("git", ["-c", "core.editor=true", "rebase", "--continue"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 300_000,
    });
    await writePrUpdateArtifact(
      ctx,
      `rebase-continue-${iteration}.txt`,
      [continued.stdout, continued.stderr].join("\n"),
    );
    if (continued.code === 0) {
      return {
        result: "conflicts-resolved",
        migrationRegenerated,
        conflictAgentRan,
        iterations: iteration,
      };
    }
    if (!(await getPrUpdateConflictedFiles(pi, ctx)).length) {
      throw new Error(
        continued.stderr.trim() || continued.stdout.trim() || "git rebase --continue failed.",
      );
    }
  }
  throw new Error("Rebase still has conflicts after 5 resolution attempts.");
}

async function getPrUpdateConflictedFiles(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string[]> {
  const result = await execRequired(
    pi,
    ctx,
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    "git diff conflicts",
    30_000,
  );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPrUpdateMigrationPath(filePath: string): boolean {
  return filePath === "drizzle" || filePath.startsWith("drizzle/");
}

async function assertNoPrUpdateConflictMarkers(
  ctx: ExtensionCommandContext,
  filePaths: readonly string[],
): Promise<void> {
  const filesWithMarkers: string[] = [];
  for (const filePath of filePaths) {
    const absolutePath = path.resolve(ctx.cwd, filePath);
    const relativeCheck = path.relative(ctx.cwd, absolutePath);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) continue;
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    if (/^(<<<<<<<|=======|>>>>>>>) /m.test(content)) filesWithMarkers.push(filePath);
  }
  if (filesWithMarkers.length) {
    throw new Error(
      `Conflict markers remain in:\n${filesWithMarkers.map((file) => `- ${file}`).join("\n")}`,
    );
  }
}

async function runPrUpdateConflictAgent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
  baseBranch: string,
  conflictedFiles: readonly string[],
): Promise<void> {
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const fileContents = await formatProjectFilesForPrompt(ctx, conflictedFiles, 120_000);
  const prompt = [
    `Resolve git rebase conflicts for PR #${prNumber}.`,
    `Base branch: origin/${baseBranch}`,
    "Tools are disabled. Return the complete resolved file contents as JSON; the caller will write them.",
    "Rules:",
    "- Never force-push.",
    "- Do not run git rebase --continue; the caller will do that.",
    "- Resolve only files with conflict markers unless a direct import/type fallout is required to make the conflict resolution coherent.",
    "- Preserve the PR intent while incorporating upstream changes from the base branch.",
    "- The returned content must not contain conflict markers.",
    "Return JSON only with this shape:",
    '{"files":[{"path":"file.ts","content":"complete resolved file content"}],"summary":"what changed"}',
    "",
    "## Conflicted files",
    fileContents,
  ].join("\n");
  await writePrUpdateArtifact(ctx, "conflict-agent-prompt.md", prompt);
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    "You are a careful rebase-conflict resolver. Tools are disabled; return JSON only and never emit tool calls.",
    prompt,
  ];
  const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 300_000,
  });
  await writePrUpdateArtifact(ctx, "conflict-agent-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "conflict-agent-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `conflict agent exited ${result.code}`,
    );
  const written = await applyAgentFileWrites(ctx, parseJsonObjectFromOutput(result.stdout));
  if (!written.length) throw new Error("Conflict resolver did not return any file contents.");
}

async function fixPrUpdateStaleDocs(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<boolean> {
  const analysis = await runPrUpdateAnalysis(pi, ctx, prNumber);
  const docsValidity = extractPrUpdateDocsValidity(analysis);
  if (!docsValidity.length) return false;
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const docFiles = [...new Set(docsValidity.map((item) => item.docFile))];
  const fileContents = await formatProjectFilesForPrompt(ctx, docFiles, 80_000);
  const prompt = [
    `Fix stale documentation references for PR #${prNumber}.`,
    "Tools are disabled. Return complete updated documentation files as JSON; the caller will write them.",
    "Only update README.md and files under docs/.",
    "Remove or update stale file paths, renamed commands, or changed config keys. Preserve unrelated wording.",
    "Return JSON only with this shape:",
    '{"files":[{"path":"README.md","content":"complete updated file content"}],"summary":"what changed"}',
    "",
    "## Stale references",
    ...docsValidity.map(
      (item) => `- ${item.docFile}:${item.lineNumber} references ${item.reference}`,
    ),
    "",
    "## Current documentation files",
    fileContents,
  ].join("\n");
  await writePrUpdateArtifact(ctx, "docs-fix-prompt.md", prompt);
  const result = await pi.exec(
    process.env.PI_REVIEW_PI_BIN || "pi",
    [
      "--print",
      "--mode",
      "text",
      ...(model ? ["--model", model] : []),
      "--thinking",
      "off",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "--system-prompt",
      "You fix only stale documentation references. Tools are disabled; return JSON only and never emit tool calls.",
      prompt,
    ],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 180_000 },
  );
  await writePrUpdateArtifact(ctx, "docs-fix-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "docs-fix-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `docs fix agent exited ${result.code}`,
    );
  await applyAgentFileWrites(
    ctx,
    parseJsonObjectFromOutput(result.stdout),
    (filePath) => filePath === "README.md" || filePath.startsWith("docs/"),
  );
  const changedDocs = await getPrUpdateChangedDocs(pi, ctx);
  if (!changedDocs.length) return false;
  await execRequired(pi, ctx, "git", ["add", "README.md", "docs/"], "git add docs", 60_000);
  await execRequired(
    pi,
    ctx,
    "git",
    ["commit", "-m", "docs: correct stale references"],
    "commit stale docs fixes",
    60_000,
  );
  return true;
}

async function runPrUpdateAnalysis(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
): Promise<Record<string, unknown> | undefined> {
  const result = await pi.exec(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "prAnalysis.ts"), String(prNumber)],
    {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 60_000,
    },
  );
  await writePrUpdateArtifact(ctx, "pr-analysis.stdout.json", result.stdout || "");
  if (result.stderr.trim())
    await writePrUpdateArtifact(ctx, "pr-analysis.stderr.txt", result.stderr);
  if (result.code !== 0) return undefined;
  return parseJsonObjectFromOutput(result.stdout);
}

function extractPrUpdateDocsValidity(
  analysis: Record<string, unknown> | undefined,
): Array<{ docFile: string; lineNumber: number; reference: string }> {
  const raw = analysis?.docsValidity;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const docFile = stringValue(item.docFile);
    const lineNumber = numberValue(item.lineNumber);
    const reference = stringValue(item.reference);
    return docFile && lineNumber !== undefined && reference
      ? [{ docFile, lineNumber, reference }]
      : [];
  });
}

async function getPrUpdateChangedDocs(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string[]> {
  const result = await execRequired(
    pi,
    ctx,
    "git",
    ["status", "--short", "--", "README.md", "docs/"],
    "git status docs",
    30_000,
  );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function pushPrUpdateBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<"pushed" | "force-pushed"> {
  const result = await pi.exec("git", ["push"], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 300_000,
  });
  if (result.code === 0) return "pushed";
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  if (!/non-fast-forward|fetch first|rejected|stale info/i.test(output)) {
    throw new Error(`git push failed:\n${truncateForPrompt(output, 2_000)}`);
  }
  if (!ctx.hasUI || !ctx.ui.select) {
    throw new Error(
      `git push was rejected and force-push requires confirmation:\n${truncateForPrompt(output, 2_000)}`,
    );
  }
  const choice = await ctx.ui.select("git push was rejected. Force-push with --force-with-lease?", [
    "yes",
    "no",
  ]);
  if (choice !== "yes") throw new Error("Push rejected and force-push was not approved.");
  await execRequired(
    pi,
    ctx,
    "git",
    ["push", "--force-with-lease"],
    "git push --force-with-lease",
    300_000,
  );
  return "force-pushed";
}

async function maybeUpdatePrMetadata(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prNumber: number,
  contextData: PrCreateContextData,
  labels: readonly string[],
): Promise<PrUpdateMetadataSummary> {
  const decision = await decidePrUpdateMetadata(pi, ctx, contextData, labels);
  if (!decision.shouldUpdate)
    return { updated: false, reason: decision.reason || "PR scope unchanged" };
  const draft = normalizePrCreateDraft({ title: decision.title, body: decision.body }, "");
  const bodyPath = await writePrUpdateArtifact(
    ctx,
    `${safeFileName(contextData.branch)}-pr-body.md`,
    draft.body,
  );
  await updateExistingPr(pi, ctx, prNumber, draft, bodyPath, labels);
  return {
    updated: true,
    reason: decision.reason || "PR metadata refreshed",
    bodyPath,
    title: draft.title,
  };
}

async function decidePrUpdateMetadata(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  contextData: PrCreateContextData,
  labels: readonly string[],
): Promise<{ shouldUpdate: boolean; reason?: string; title: string; body: string }> {
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const prompt = [
    "Decide whether PR title/body should be updated after syncing this branch with its base.",
    "Only set shouldUpdate=true if the scope meaningfully changed, the existing metadata is stale, or required sections are missing.",
    "If updating, use Conventional Commits with capitalized type and include ## Why, ## What, ## Testing, and ## Affected Routes.",
    "Return JSON only with this shape:",
    '{"shouldUpdate":true,"reason":"why","title":"Feat(scope): title","body":"markdown body"}',
    "",
    buildPrCreateDraftPrompt(contextData, labels, ""),
  ].join("\n");
  await writePrUpdateArtifact(ctx, "metadata-decision-prompt.md", prompt);
  const result = await pi.exec(
    process.env.PI_REVIEW_PI_BIN || "pi",
    [
      "--print",
      "--mode",
      "text",
      ...(model ? ["--model", model] : []),
      "--thinking",
      "off",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "--system-prompt",
      "You make conservative PR metadata update decisions. Return JSON only.",
      prompt,
    ],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: PR_CREATE_AGENT_TIMEOUT_MS },
  );
  await writePrUpdateArtifact(ctx, "metadata-decision-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "metadata-decision-stderr.txt", result.stderr);
  if (result.code !== 0)
    return {
      shouldUpdate: false,
      reason: "metadata decision agent failed",
      ...fallbackPrCreateDraft(contextData),
    };
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const fallback = fallbackPrCreateDraft(contextData);
  return {
    shouldUpdate: parsed?.shouldUpdate === true,
    reason: stringValue(parsed?.reason),
    title: stringValue(parsed?.title) ?? fallback.title,
    body: stringValue(parsed?.body) ?? fallback.body,
  };
}

async function writePrUpdateArtifact(
  ctx: ExtensionCommandContext,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = path.join(ctx.cwd, getReviewSessionDir(ctx).baseDir, "pr-update");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

function renderPrUpdateReport(input: {
  pr: PrCreateGhResult;
  branch: string;
  baseBranch: string;
  rebase: PrUpdateRebaseSummary;
  docsFixed: boolean;
  checksSkipped: boolean;
  pushResult: "pushed" | "force-pushed" | "skipped";
  metadata: PrUpdateMetadataSummary;
  labels: readonly string[];
}): string {
  return [
    "## PR update",
    "",
    `PR #${input.pr.number} updated.`,
    input.pr.url ? `URL: ${input.pr.url}` : undefined,
    input.pr.title ? `Title: ${input.pr.title}` : undefined,
    `Branch: ${input.branch} → ${input.baseBranch}`,
    `Rebase: ${input.rebase.result}${input.rebase.iterations ? ` (${input.rebase.iterations} conflict pass(es))` : ""}`,
    `Migration regeneration: ${input.rebase.migrationRegenerated ? "yes" : "no"}`,
    `Conflict resolver agent: ${input.rebase.conflictAgentRan ? "ran" : "not needed"}`,
    `Docs stale-reference fixes: ${input.docsFixed ? "committed" : "not needed"}`,
    input.checksSkipped
      ? "Checks skipped (--no-checks)."
      : "Checks completed: bun check --fix, bun format, bun run typecheck.",
    `Push: ${input.pushResult}`,
    `Labels: ${input.labels.join(", ") || "none"}`,
    input.metadata.updated
      ? `PR metadata updated: ${input.metadata.reason}${input.metadata.bodyPath ? ` (${input.metadata.bodyPath})` : ""}`
      : `PR metadata unchanged: ${input.metadata.reason}`,
    "CI watcher started in the background unless --no-ci-watch was used.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function execRequired(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
  args: readonly string[],
  label: string,
  timeout: number,
): Promise<ExecResult> {
  const result = await pi.exec(command, args, { cwd: ctx.cwd, signal: ctx.signal, timeout });
  if (result.code !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${label} failed${output ? `:\n${truncateForPrompt(output, 2_000)}` : "."}`);
  }
  return result;
}

function parseJsonObjectFromOutput(output: string): Record<string, unknown> | undefined {
  for (const candidate of collectAnyJsonCandidates(stripAnsi(output).trim())) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function parseJsonArrayFromOutput(output: string): unknown[] {
  for (const candidate of collectAnyJsonCandidates(stripAnsi(output).trim())) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

function collectAnyJsonCandidates(text: string): string[] {
  return uniqueStrings([text, ...extractAnyBalancedJson(text)]).filter(Boolean);
}

function extractAnyBalancedJson(text: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let opener = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) {
        start = index;
        opener = char;
      }
      depth += 1;
      continue;
    }
    const expectedCloser = opener === "[" ? "]" : "}";
    if (char === expectedCloser && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        values.push(text.slice(start, index + 1).trim());
        start = -1;
        opener = "";
      }
    }
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runReviewAfterCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const includeResolved = hasFlag(tokens, "--include-resolved");
  const positional = tokens.filter((token) => !token.startsWith("--"));

  setStatus(ctx, "⏳:post-review");
  showWidget(ctx, ["Collecting reviewer comments…"]);

  const prNumber = await resolvePrNumber(pi.exec, ctx.cwd, positional[0]);
  await prefixTmuxWindowTitleWithPrNumber(pi, ctx, prNumber);
  const [prData, commentsData] = await Promise.all([
    fetchPrData(pi.exec, ctx.cwd, prNumber),
    fetchPrReviewComments(pi.exec, ctx.cwd, prNumber, {
      includeResolvedThreads: includeResolved,
    }),
  ]);

  const comments = flattenReviewComments(commentsData);
  if (!comments.length) {
    const report = [
      "## Post-review analysis",
      "",
      `PR: #${prNumber} ${prData.metadata.title}`,
      "",
      "No reviewer comments were found for analysis.",
    ].join("\n");
    publishReviewReport(pi, report);
    setStatus(ctx, "✅:post-review");
    showWidget(ctx, [`#${prNumber}: no review comments found.`]);
    return;
  }

  const policyHints = extractPolicyHints(comments);
  const preferEslintRules = await hasDevEslintDirectory(ctx.cwd);
  const agentOutput = await runReviewAfterAgent(pi, ctx, prData.metadata, comments, {
    preferEslintRules,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`pr-review-process agent failed: ${message}`, "warning");
    return undefined;
  });

  const analyses = normalizeAfterReviewCommentAnalyses(
    agentOutput?.analyses,
    comments,
    policyHints,
  );
  const laneImprovements = mergeLaneImprovements(
    filterLaneImprovementsForEslintPreference(
      normalizeLaneImprovements(agentOutput?.laneImprovements),
      policyHints,
      preferEslintRules,
    ),
    inferLaneImprovementsFromPolicyHints(policyHints, { preferEslintRules }),
  );
  const newLaneProposals = mergeNewLaneProposals(
    normalizeNewLaneProposals(agentOutput?.newLaneProposals),
    inferNewLaneProposals(policyHints),
  );
  const designRuleProposals = inferDesignRuleProposals(policyHints, { preferEslintRules });

  const result: AfterReviewAnalysisResult = {
    prNumber,
    analyzedAt: new Date().toISOString(),
    threadsAnalyzed: commentsData.reviewThreads.length,
    commentsAnalyzed: comments.length,
    analyses,
    laneImprovements,
    newLaneProposals,
    designRuleProposals,
    policyHints,
  };

  const report = renderAfterReviewReport(prData.metadata, result, includeResolved);
  publishReviewReport(pi, report);
  setStatus(ctx, "✅:post-review");
  showWidget(ctx, [
    `Post-review #${prNumber}: ${result.commentsAnalyzed} comments analyzed.`,
    `Policy-style comments: ${result.policyHints.length}.`,
    `Lane improvements: ${result.laneImprovements.length}. New lane ideas: ${result.newLaneProposals.length}.`,
    `Design rule proposals: ${result.designRuleProposals.length}.`,
  ]);
}

function flattenReviewComments(input: PrReviewComments): ReviewComment[] {
  const merged = [...input.reviewThreads.flatMap((thread) => thread.comments), ...input.comments];
  const unique = new Map<string, ReviewComment>();
  for (const comment of merged) {
    const key = comment.id || `${comment.databaseId}`;
    if (!unique.has(key)) unique.set(key, comment);
  }
  return [...unique.values()];
}

async function runReviewAfterAgent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  comments: readonly ReviewComment[],
  options: PolicyInferenceOptions,
): Promise<Record<string, unknown>> {
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const prompt = [
    `# Post-review analysis for PR #${pr.ref.number}`,
    "",
    `Title: ${pr.title}`,
    `URL: ${pr.url || "(local)"}`,
    "",
    "## Current review lanes",
    ...KNOWN_REVIEW_LANES.map((lane) => `- ${lane}`),
    "",
    "## Enforcement preference",
    options.preferEslintRules
      ? "This project has `dev/eslint/`; for policy-style comments that can be checked syntactically, prefer suggesting a simple ESLint rule instead of a review lane change."
      : "This project does not have `dev/eslint/`; use design-rule or lane suggestions as appropriate.",
    "",
    "## Reviewer comments",
    ...comments.slice(0, 120).map((comment, index) => formatReviewCommentForPrompt(comment, index)),
    comments.length > 120
      ? `- (truncated) ${comments.length - 120} additional comment(s) omitted.`
      : "",
    "",
    "Focus on concrete solutions and practical lane improvements only when confidence is high.",
  ]
    .filter(Boolean)
    .join("\n");

  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    REVIEW_AFTER_AGENT_SYSTEM_PROMPT,
    prompt,
  ];

  const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: REVIEW_AFTER_AGENT_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `pr-review-process agent exited ${result.code}`,
    );
  }
  return parseAfterReviewAgentJson(result.stdout);
}

function formatReviewCommentForPrompt(comment: ReviewComment, index: number): string {
  const location = comment.path
    ? `${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`
    : "general";
  const preview = comment.body.replace(/\s+/g, " ").trim();
  return `- [${index + 1}] id=${comment.id} author=${comment.author.login} location=${location} :: ${preview}`;
}

function parseAfterReviewAgentJson(stdout: string): Record<string, unknown> {
  const trimmed = stripAnsi(stdout).trim();
  if (!trimmed) return {};

  const keys = ["analyses", "laneImprovements", "newLaneProposals"];
  for (const candidateText of collectAgentCandidateTexts(trimmed)) {
    for (const candidate of collectJsonCandidatesForKeys(candidateText, keys)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // try next candidate
      }
    }
  }

  throw new Error(
    `pr-review-process agent did not return parseable JSON. Output starts with: ${formatOutputSnippet(trimmed)}`,
  );
}

function collectJsonCandidatesForKeys(text: string, keys: readonly string[]): string[] {
  return uniqueStrings([text.trim(), ...extractBalancedJsonObjectsForKeys(text, keys)]).filter(
    Boolean,
  );
}

function extractBalancedJsonObjectsForKeys(text: string, keys: readonly string[]): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, index + 1).trim();
        if (keys.some((key) => candidate.includes(key))) objects.push(candidate);
        start = -1;
      }
    }
  }

  return objects;
}

function normalizeAfterReviewCommentAnalyses(
  raw: unknown,
  comments: readonly ReviewComment[],
  policyHints: readonly PolicyHint[],
): AfterReviewAnalysisResult["analyses"] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const analyses = Array.isArray(raw)
    ? raw.flatMap((item) => normalizeAfterReviewCommentAnalysis(item, byId) ?? [])
    : [];

  const existing = new Set(analyses.map((analysis) => analysis.commentId));
  for (const comment of comments) {
    if (existing.has(comment.id)) continue;
    analyses.push(inferFallbackAnalysis(comment, policyHints));
  }

  return analyses;
}

function normalizeAfterReviewCommentAnalysis(
  value: unknown,
  byId: ReadonlyMap<string, ReviewComment>,
): AfterReviewAnalysisResult["analyses"][number] | undefined {
  if (!isRecord(value)) return undefined;
  const commentId = stringValue(value.commentId);
  if (!commentId || !byId.has(commentId)) return undefined;

  const priorityValue = stringValue(value.priority)?.toLowerCase();
  const priority =
    priorityValue === "action_required" ||
    priorityValue === "suggestion" ||
    priorityValue === "informational" ||
    priorityValue === "nit"
      ? priorityValue
      : "suggestion";
  const theme = stringValue(value.theme) || inferCommentTheme(byId.get(commentId)?.body ?? "");
  const summary =
    stringValue(value.summary) || summarizeCommentBody(byId.get(commentId)?.body ?? "");
  const suggestedSolution = stringValue(value.suggestedSolution);
  const confidence = clampConfidence(numberValue(value.confidence) ?? 0.65);

  return {
    commentId,
    priority,
    theme,
    summary,
    suggestedSolution,
    confidence,
  };
}

function normalizeLaneImprovements(raw: unknown): ReviewLaneImprovementSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const laneId = stringValue(item.laneId);
    const proposedImprovement = stringValue(item.proposedImprovement);
    const rationale = stringValue(item.rationale);
    if (!laneId || !proposedImprovement || !rationale) return [];
    if (!KNOWN_REVIEW_LANES.includes(laneId as (typeof KNOWN_REVIEW_LANES)[number])) return [];

    const affectedCommentIds = Array.isArray(item.affectedCommentIds)
      ? item.affectedCommentIds
          .map((value) => stringValue(value))
          .filter((value): value is string => Boolean(value))
      : [];

    return [
      {
        laneId,
        currentRule: stringValue(item.currentRule),
        proposedImprovement,
        rationale,
        affectedCommentIds,
      },
    ];
  });
}

function normalizeNewLaneProposals(raw: unknown): NewLaneProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const proposedLaneId = stringValue(item.proposedLaneId);
    const title = stringValue(item.title);
    const focus = stringValue(item.focus);
    const relevantPattern = stringValue(item.relevantPattern);
    const rationale = stringValue(item.rationale);
    if (!proposedLaneId || !title || !focus || !relevantPattern || !rationale) return [];

    const evidenceCommentIds = Array.isArray(item.evidenceCommentIds)
      ? item.evidenceCommentIds
          .map((value) => stringValue(value))
          .filter((value): value is string => Boolean(value))
      : [];

    return [
      {
        proposedLaneId,
        title,
        focus,
        relevantPattern,
        rationale,
        evidenceCommentIds,
      },
    ];
  });
}

function inferFallbackAnalysis(
  comment: ReviewComment,
  policyHints: readonly PolicyHint[],
): AfterReviewAnalysisResult["analyses"][number] {
  return {
    commentId: comment.id,
    priority: inferCommentPriority(comment.body),
    theme: inferCommentTheme(comment.body),
    summary: summarizeCommentBody(comment.body),
    suggestedSolution: inferCommentSolution(comment.body),
    confidence: policyHints.some((hint) => hint.commentId === comment.id) ? 0.78 : 0.62,
  };
}

function inferCommentPriority(
  body: string,
): AfterReviewAnalysisResult["analyses"][number]["priority"] {
  if (
    /(never|always|prevent|must|critical|security|broken|regression|bug|incorrect|unsafe)/i.test(
      body,
    )
  )
    return "action_required";
  if (/(consider|could|suggest|prefer|maybe|should)/i.test(body)) return "suggestion";
  if (/(nit|typo|style|wording|format)/i.test(body)) return "nit";
  return "informational";
}

function inferCommentTheme(body: string): string {
  if (/(auth|permission|security|secret|pii|scope|tenant|validate|saniti[sz]e)/i.test(body))
    return "Security/API safety";
  if (/(test|coverage|spec|regression|e2e|unit)/i.test(body)) return "Test coverage";
  if (/(schema|drizzle|db|migration|type|zod|null|optional)/i.test(body)) return "Data and types";
  if (/(docs|readme|guide|comment)/i.test(body)) return "Documentation";
  if (/(performance|slow|n\+1|cache|query|render)/i.test(body)) return "Performance";
  if (/(name|naming|readability|duplicate|refactor|complex|dead code)/i.test(body))
    return "Code quality";
  return "Behavior correctness";
}

function summarizeCommentBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}…`;
}

function inferCommentSolution(body: string): string {
  if (/(test|coverage|regression|spec|e2e|unit)/i.test(body))
    return "Add or adjust focused tests for the described behavior, including the failing edge case.";
  if (/(validate|schema|zod|input|saniti[sz]e|auth|permission|tenant|scope)/i.test(body))
    return "Tighten validation/authorization at the boundary and return a safe, explicit error for invalid input.";
  if (/(name|naming|readability|duplicate|refactor|dead code|abstraction)/i.test(body))
    return "Refactor the changed code to reduce duplication and use precise naming that matches behavior.";
  if (/(docs|readme|guide|comment)/i.test(body))
    return "Update the relevant documentation to reflect the final behavior and any important caveats.";
  return "Implement the reviewer-requested behavior change and add a regression check to prevent recurrence.";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function extractPolicyHints(comments: readonly ReviewComment[]): PolicyHint[] {
  const hints: PolicyHint[] = [];
  for (const comment of comments)
    hints.push(...extractPolicyHintsFromBody(comment.id, comment.body));
  return hints;
}

function extractPolicyHintsFromBody(commentId: string, body: string): PolicyHint[] {
  const definitions: Array<{ pattern: PolicyHint["pattern"]; regex: RegExp; confidence: number }> =
    [
      { pattern: "NEVER", regex: /\bNEVER\b[^.!?\n]{0,200}/g, confidence: 0.92 },
      { pattern: "ALWAYS", regex: /\bALWAYS\b[^.!?\n]{0,200}/g, confidence: 0.9 },
      { pattern: "ANTIPATTERN", regex: /\bANTIPATTERN\b[^.!?\n]{0,200}/g, confidence: 0.88 },
    ];

  const hints: PolicyHint[] = [];
  for (const definition of definitions) {
    for (const match of body.matchAll(definition.regex)) {
      const rawText = match[0]?.trim();
      if (!rawText) continue;
      hints.push({
        pattern: definition.pattern,
        rawText,
        commentId,
        confidence: definition.confidence,
      });
    }
  }
  return hints;
}

interface PolicyInferenceOptions {
  preferEslintRules?: boolean;
}

export function inferLaneImprovementsFromPolicyHints(
  policyHints: readonly PolicyHint[],
  options: PolicyInferenceOptions = {},
): ReviewLaneImprovementSuggestion[] {
  const byLane = new Map<string, { hints: PolicyHint[]; rationale: string; improvement: string }>();

  const add = (
    laneId: string,
    hint: PolicyHint,
    proposedImprovement: string,
    rationale: string,
  ): void => {
    const existing = byLane.get(laneId);
    if (existing) {
      existing.hints.push(hint);
      return;
    }
    byLane.set(laneId, { hints: [hint], rationale, improvement: proposedImprovement });
  };

  for (const hint of policyHints) {
    if (hint.confidence < 0.8) continue;
    const text = hint.rawText;
    if (options.preferEslintRules && isLikelyEslintRuleCandidate(text)) continue;
    if (/(schema|db|drizzle|type|zod|null|optional|constraint|migration)/i.test(text)) {
      add(
        "data",
        hint,
        "Add an explicit lane checkpoint for nullability/constraint drift between DB schema, API schema, and UI types.",
        "Policy comments indicate recurring data-contract drift.",
      );
      continue;
    }
    if (
      /(auth|permission|tenant|scope|validate|validation|saniti[sz]e|secret|pii|expos|xss|sql|raw\s+id)/i.test(
        text,
      )
    ) {
      add(
        "security-api",
        hint,
        "Add a mandatory lane check for boundary validation/auth scope issues and require a concrete exploit/failure scenario in findings.",
        "Policy-style security comments repeat; codifying this check will catch boundary leaks earlier.",
      );
      continue;
    }
    if (/(test|coverage|regression|spec|e2e|unit)/i.test(text)) {
      add(
        "tests",
        hint,
        "Add a lane rule that any behavior-level finding must name the missing regression test shape (input → expected output).",
        "Reviewer comments repeatedly ask to prevent repeat bugs with tests.",
      );
      continue;
    }
    if (/(docs|readme|guide)/i.test(text)) {
      add(
        "docs",
        hint,
        "Add a docs-lane rule that behavior-affecting changes must include exact docs delta suggestions (section + sentence intent).",
        "Policy language suggests repeated documentation misses.",
      );
      continue;
    }
    if (
      /(duplicate|duplicated|copy[-\s]?paste|reuse|reusable|shared\s+(helper|util|component)|existing\s+(helper|util|component)|refactor)/i.test(
        text,
      )
    ) {
      add(
        "dedupe",
        hint,
        "Add a dedupe-lane rule to search project_index_search for similar or identical code before recommending reuse or extraction.",
        "Policy comments point to recurring missed code reuse opportunities.",
      );
      continue;
    }
    if (/(name|naming|readability|dead code|complex)/i.test(text)) {
      add(
        "code-quality",
        hint,
        "Add a code-quality rule requiring explicit identification of misleading names or duplicated logic and a minimal refactor path.",
        "Policy comments point to recurring maintainability issues.",
      );
    }
  }

  return [...byLane.entries()]
    .filter(([, value]) => value.hints.length >= 1)
    .map(([laneId, value]) => ({
      laneId,
      proposedImprovement: value.improvement,
      rationale: value.rationale,
      affectedCommentIds: [...new Set(value.hints.map((hint) => hint.commentId))],
    }));
}

export function inferNewLaneProposals(policyHints: readonly PolicyHint[]): NewLaneProposal[] {
  const policyPatternHints = policyHints.filter((hint) => hint.confidence >= 0.85);
  const uniqueCommentIds = [...new Set(policyPatternHints.map((hint) => hint.commentId))];
  if (uniqueCommentIds.length < 3) return [];

  return [
    {
      proposedLaneId: "regression-guards",
      title: "Regression guards",
      focus:
        "Detect repeated reviewer concerns that ask to prevent recurring behavior and require explicit guardrails (tests, schema constraints, or runtime checks).",
      relevantPattern:
        "Reviewer comments repeatedly use all-caps policy markers such as NEVER/ALWAYS/ANTIPATTERN.",
      rationale:
        "Multiple independent comments indicate recurrence-prevention expectations that are not consistently captured by existing lanes.",
      evidenceCommentIds: uniqueCommentIds,
    },
  ];
}

function filterLaneImprovementsForEslintPreference(
  improvements: readonly ReviewLaneImprovementSuggestion[],
  policyHints: readonly PolicyHint[],
  preferEslintRules: boolean,
): ReviewLaneImprovementSuggestion[] {
  if (!preferEslintRules) return [...improvements];

  const eslintCandidateCommentIds = new Set(
    policyHints
      .filter((hint) => isLikelyEslintRuleCandidate(hint.rawText))
      .map((hint) => hint.commentId),
  );

  return improvements.filter((improvement) => {
    if (improvement.laneId !== "code-quality" && improvement.laneId !== "dedupe") return true;
    return !improvement.affectedCommentIds.some((commentId) =>
      eslintCandidateCommentIds.has(commentId),
    );
  });
}

function isLikelyEslintRuleCandidate(text: string): boolean {
  return /(if[-\s]?else|else\s+if|function|component|hook|jsx|tsx|ts|js|import|export|literal|ternary|promise|async|await|array|object|prop|props|variable|const|let|class|method|callback|useEffect|useMemo|useCallback)/i.test(
    text,
  );
}

function mergeLaneImprovements(
  ...groups: ReadonlyArray<readonly ReviewLaneImprovementSuggestion[]>
): ReviewLaneImprovementSuggestion[] {
  const merged = new Map<string, ReviewLaneImprovementSuggestion>();
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.laneId}:${item.proposedImprovement}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...item,
          affectedCommentIds: [...new Set(item.affectedCommentIds)],
        });
        continue;
      }
      existing.affectedCommentIds = [
        ...new Set([...existing.affectedCommentIds, ...item.affectedCommentIds]),
      ];
    }
  }
  return [...merged.values()];
}

function mergeNewLaneProposals(
  ...groups: ReadonlyArray<readonly NewLaneProposal[]>
): NewLaneProposal[] {
  const merged = new Map<string, NewLaneProposal>();
  for (const group of groups) {
    for (const proposal of group) {
      const key = proposal.proposedLaneId;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...proposal,
          evidenceCommentIds: [...new Set(proposal.evidenceCommentIds)],
        });
        continue;
      }
      existing.evidenceCommentIds = [
        ...new Set([...existing.evidenceCommentIds, ...proposal.evidenceCommentIds]),
      ];
    }
  }
  return [...merged.values()];
}

function renderAfterReviewReport(
  pr: PRMetadata,
  analysis: AfterReviewAnalysisResult,
  includeResolved: boolean,
): string {
  const lines = [
    "## Post-review analysis",
    "",
    `PR: #${analysis.prNumber} ${pr.title}`,
    `URL: ${pr.url || "(local)"}`,
    `Reviewed comments: ${analysis.commentsAnalyzed} (threads: ${analysis.threadsAnalyzed}, include resolved: ${includeResolved ? "yes" : "no"}).`,
    `Policy-style comments detected: ${analysis.policyHints.length}.`,
    "",
    "### Comment processing and suggested solutions",
    "",
    "| # | Comment | Priority | Theme | Suggested solution |",
    "|---:|---|---|---|---|",
    ...analysis.analyses.map((item, index) => {
      const solution = item.suggestedSolution || "—";
      return `| ${index + 1} | ${escapePipeCell(item.commentId)} | ${escapePipeCell(item.priority)} | ${escapePipeCell(item.theme)} | ${escapePipeCell(solution)} |`;
    }),
  ];

  if (analysis.policyHints.length) {
    lines.push(
      "",
      "### Policy-pattern comments (NEVER / ALWAYS / ANTIPATTERN)",
      "",
      "| Pattern | Comment ID | Excerpt |",
      "|---|---|---|",
      ...analysis.policyHints.map(
        (hint) =>
          `| ${escapePipeCell(hint.pattern)} | ${escapePipeCell(hint.commentId)} | ${escapePipeCell(summarizeCommentBody(hint.rawText))} |`,
      ),
    );
  }

  if (analysis.laneImprovements.length) {
    lines.push(
      "",
      "### Practical review lane improvements",
      "",
      "| Lane | Improvement | Why | Evidence comments |",
      "|---|---|---|---|",
      ...analysis.laneImprovements.map(
        (item) =>
          `| ${escapePipeCell(item.laneId)} | ${escapePipeCell(item.proposedImprovement)} | ${escapePipeCell(item.rationale)} | ${escapePipeCell(item.affectedCommentIds.join(", ") || "—")} |`,
      ),
    );
  } else {
    lines.push(
      "",
      "### Practical review lane improvements",
      "",
      "No high-confidence lane improvements identified.",
    );
  }

  if (analysis.newLaneProposals.length) {
    lines.push("", "### Confident new lane proposals", "");
    for (const proposal of analysis.newLaneProposals) {
      lines.push(
        `- **${proposal.proposedLaneId}** (${proposal.title}): ${proposal.focus}`,
        `  - Pattern: ${proposal.relevantPattern}`,
        `  - Why: ${proposal.rationale}`,
        `  - Evidence: ${proposal.evidenceCommentIds.join(", ") || "—"}`,
      );
    }
  }

  if (analysis.designRuleProposals.length) {
    lines.push("", "### Design rule proposals from PR comments", "");
    lines.push(
      "These patterns from NEVER/ALWAYS/ANTIPATTERN comments can become enforceable rules. When `dev/eslint/` exists, prefer a simple ESLint rule over a lane change or `.pi/design-rules/` rule.",
      "",
      "| Rule ID | Title | Implementation | Target path | Severity | Evidence |",
      "|---|---|---|---|---|---|",
      ...analysis.designRuleProposals.map(
        (proposal) =>
          `| ${escapePipeCell(proposal.ruleId)} | ${escapePipeCell(proposal.title)} | ${escapePipeCell(proposal.implementation)} | ${escapePipeCell(proposal.targetPath)} | ${escapePipeCell(proposal.severity)} | ${escapePipeCell(proposal.evidenceCommentIds.join(", ") || "—")} |`,
      ),
    );
  }

  return lines.join("\n");
}

async function hasDevEslintDirectory(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, "dev", "eslint"))).isDirectory();
  } catch {
    return false;
  }
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

async function runCiWatcher(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  local: boolean,
  prNumber: number,
  _sharedArtifacts: SharedReviewArtifacts,
): Promise<ReviewCiStatus> {
  if (local || prNumber <= 0) {
    return {
      checked: false,
      status: "skipped",
      message: "CI status is unavailable for local diffs.",
    };
  }

  const expectedWorkflows = await discoverGithubWorkflowNames(ctx.cwd);
  const result = await pi.exec(
    "gh",
    ["pr", "checks", String(prNumber), "--json", "name,state,bucket,link,workflow"],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 60_000 },
  );
  await writeSharedArtifact(ctx, "ci-watcher-stdout.txt", result.stdout);
  await writeSharedArtifact(ctx, "ci-watcher-stderr.txt", result.stderr);

  const checks = parseCiChecksOutput(result.stdout);
  const missingWorkflows = expectedWorkflows.filter(
    (workflow) =>
      !checks.some((check) => check.workflow === workflow || check.name.includes(workflow)),
  );
  const failedLogFiles = await collectFailedCiLogs(pi, ctx, checks);
  const status = inferCiStatus(checks, missingWorkflows);
  const ciStatus: ReviewCiStatus = {
    checked: true,
    status,
    message: checks.length ? undefined : "No CI checks were returned by GitHub.",
    checks,
    missingWorkflows,
    failedLogFiles,
  };
  await writeSharedArtifact(ctx, "ci-status.json", `${JSON.stringify(ciStatus, null, 2)}\n`);
  return ciStatus;
}

function parseCiChecksOutput(stdout: string): ReviewCiCheck[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap(normalizeCiCheck) : [];
  } catch {
    return [];
  }
}

function normalizeCiCheck(value: unknown): ReviewCiCheck[] {
  if (!isRecord(value)) return [];
  const name = stringValue(value.name);
  if (!name) return [];
  return [
    {
      name,
      state: stringValue(value.state),
      bucket: stringValue(value.bucket),
      workflow: stringValue(value.workflow),
      link: stringValue(value.link),
    },
  ];
}

function inferCiStatus(
  checks: readonly ReviewCiCheck[],
  missingWorkflows: readonly string[] = [],
): ReviewCiStatus["status"] {
  if (!checks.length) return "unknown";
  if (missingWorkflows.length > 0) return "pending";
  if (
    checks.some((check) =>
      /fail|failure|cancel|timed|action|required|error/i.test(
        [check.bucket, check.state].filter(Boolean).join(" "),
      ),
    )
  )
    return "fail";
  if (
    checks.some((check) =>
      /pending|queued|progress|waiting|requested|expected/i.test(
        [check.bucket, check.state].filter(Boolean).join(" "),
      ),
    )
  )
    return "pending";
  return "pass";
}

async function discoverGithubWorkflowNames(rootDir: string): Promise<string[]> {
  const workflowDir = path.join(rootDir, ".github", "workflows");
  const entries = await readdir(workflowDir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const filePath = path.join(workflowDir, entry.name);
    const content = await readFile(filePath, "utf8").catch(() => "");
    const declaredName = /^name:\s*["']?([^"'\n#]+)["']?\s*$/m.exec(content)?.[1]?.trim();
    names.push(declaredName || entry.name.replace(/\.ya?ml$/i, ""));
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function collectFailedCiLogs(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  checks: readonly ReviewCiCheck[],
): Promise<string[]> {
  const failedChecks = checks.filter((check) =>
    /fail|failure|cancel|timed|error/i.test([check.bucket, check.state].filter(Boolean).join(" ")),
  );
  if (!failedChecks.length) return [];

  const runList = await pi.exec(
    "gh",
    ["run", "list", "--limit", "20", "--json", "databaseId,name,workflowName,status,conclusion"],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 30_000 },
  );
  if (runList.code !== 0 || !runList.stdout.trim()) return [];

  let runs: unknown[] = [];
  try {
    const parsed = JSON.parse(runList.stdout.trim()) as unknown;
    runs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }

  const written: string[] = [];
  for (const check of failedChecks) {
    const run = runs.find((candidate) => ciRunMatchesCheck(candidate, check));
    if (!isRecord(run)) continue;
    const databaseId = numberValue(run.databaseId);
    if (databaseId === undefined) continue;
    const log = await pi.exec("gh", ["run", "view", String(databaseId), "--log-failed"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 60_000,
    });
    const fileName = `ci-${databaseId}-${safeFileName(check.name)}.log`;
    const relativePath = await writeSharedArtifact(
      ctx,
      fileName,
      log.stdout || log.stderr || `No failed log output for ${check.name}.\n`,
    );
    written.push(relativePath);
  }
  return written;
}

function ciRunMatchesCheck(candidate: unknown, check: ReviewCiCheck): boolean {
  if (!isRecord(candidate)) return false;
  const text = [candidate.name, candidate.workflowName].map((value) => String(value ?? ""));
  return text.some((value) => value === check.name || value === check.workflow);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "check";
}

function formatCiStatusLine(ciStatus: ReviewCiStatus): string {
  if (ciStatus.status === "pass") return "passing";
  if (ciStatus.status === "fail") return "failing";
  if (ciStatus.status === "pending") return "pending";
  if (ciStatus.status === "skipped") return ciStatus.message || "skipped";
  return ciStatus.message ? `unknown (${ciStatus.message})` : "unknown";
}

function buildReviewSkillCoverage(input: {
  local: boolean;
  noAgents: boolean;
  prData: GithubPrData;
  lanes: readonly ReviewLanePacket[];
  agentResults: readonly LaneAgentResult[];
  ciStatus: ReviewCiStatus;
  requestedLaneIds?: readonly string[];
}): ReviewSkillCoverage {
  const hasUiChanges = input.prData.files.some((file) => isUiPath(file.path));
  const laneSet = new Set(input.lanes.map((lane) => lane.laneId));
  const successfulLaneSet = new Set(
    input.agentResults.filter((result) => !result.error).map((result) => result.laneId),
  );
  const items: ReviewCoverageItem[] = [
    {
      id: "pr-number",
      label: "Determine PR number / target",
      status: "covered",
      details: input.local
        ? `Local diff against ${input.prData.metadata.base.ref}`
        : `PR #${input.prData.prNumber}`,
    },
    {
      id: "preanalysis",
      label: "Pre-analyze PR metadata and file categories",
      status: "covered",
      details: `${input.prData.files.length} file(s), ${input.prData.hunks.length} diff hunk(s), UI changes: ${hasUiChanges ? "yes" : "no"}`,
    },
    {
      id: "ci",
      label: "CI status",
      status: input.ciStatus.checked ? "covered" : input.local ? "not-applicable" : "partial",
      details: formatCiStatusLine(input.ciStatus),
    },
    {
      id: "changed-files",
      label: "Changed files and diff context",
      status: input.prData.hunks.length ? "partial" : "missing",
      details: input.prData.hunks.length
        ? "Lane agents receive parsed diff hunks; full changed-file snapshots are not yet attached."
        : "No diff hunk data available.",
    },
    laneCoverageItem("dedupe", "Dedupe/reuse search", laneSet, successfulLaneSet, input.noAgents),
    laneCoverageItem("api-safety", "API safety agent", laneSet, successfulLaneSet, input.noAgents),
    laneCoverageItem(
      "code-quality",
      "Code quality agent",
      laneSet,
      successfulLaneSet,
      input.noAgents,
    ),
    laneCoverageItem("docs", "Docs agent", laneSet, successfulLaneSet, input.noAgents),
    laneCoverageItem("tests", "Tests review", laneSet, successfulLaneSet, input.noAgents),
    {
      id: "ui-testing",
      label: "Conditional live UI testing",
      status: hasUiChanges ? "missing" : "not-applicable",
      details: hasUiChanges
        ? "Static UX lane may run, but exploratory/browser agents are not launched by this extension yet."
        : "No UI files detected in the changed file list.",
    },
    {
      id: "approval-gate",
      label: "Approval before posting",
      status: input.local ? "not-applicable" : "covered",
      details: "Review command only writes a dry-run payload; posting is not automatic.",
    },
  ];
  return {
    items,
    notes: input.requestedLaneIds?.length
      ? [`Explicit lane filter used: ${input.requestedLaneIds.join(", ")}.`]
      : undefined,
  };
}

function laneCoverageItem(
  laneId: ReviewLaneId,
  label: string,
  laneSet: ReadonlySet<ReviewLaneId>,
  successfulLaneSet: ReadonlySet<ReviewLaneId>,
  noAgents: boolean,
): ReviewCoverageItem {
  if (!laneSet.has(laneId)) {
    return { id: laneId, label, status: "missing", details: "Lane was not routed for this diff." };
  }
  if (noAgents) {
    return { id: laneId, label, status: "skipped", details: "Skipped by --no-agents." };
  }
  return successfulLaneSet.has(laneId)
    ? { id: laneId, label, status: "covered", details: "Lane completed." }
    : {
        id: laneId,
        label,
        status: "partial",
        details: "Lane was routed but failed or was omitted.",
      };
}

function isUiPath(filePath: string): boolean {
  return /(^|\/)(app|pages|components|ui)(\/|$)|\.tsx$|\.css$|\.scss$/i.test(filePath);
}

async function writeSharedArtifact(
  ctx: ExtensionCommandContext,
  fileName: string,
  content: string,
): Promise<string> {
  const sharedDir = getSharedDir(ctx);
  const absoluteSharedDir = path.join(ctx.cwd, sharedDir);
  await mkdir(absoluteSharedDir, { recursive: true });
  const filePath = path.join(absoluteSharedDir, fileName);
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

async function writeSharedReviewArtifacts(
  ctx: ExtensionCommandContext,
  prData: GithubPrData,
  lanes: readonly ReviewLanePacket[],
): Promise<SharedReviewArtifacts> {
  const { sessionId, baseDir } = getReviewSessionDir(ctx);
  const sharedDir = getSharedDir(ctx);
  const absoluteSharedDir = path.join(ctx.cwd, sharedDir);
  await mkdir(absoluteSharedDir, { recursive: true });

  const writtenFiles: string[] = [];
  const writeSharedFile = async (fileName: string, content: string): Promise<void> => {
    const filePath = path.join(absoluteSharedDir, fileName);
    await writeFile(filePath, content, "utf8");
    writtenFiles.push(relativePath(ctx.cwd, filePath));
  };

  await writeSharedFile("pr-metadata.json", `${JSON.stringify(prData.metadata, null, 2)}\n`);
  await writeSharedFile("files.json", `${JSON.stringify(prData.files, null, 2)}\n`);
  await writeSharedFile("hunks.json", `${JSON.stringify(prData.hunks, null, 2)}\n`);
  await writeSharedFile(
    "patch.diff",
    prData.patch.endsWith("\n") ? prData.patch : `${prData.patch}\n`,
  );
  await writeSharedFile(
    "lanes.json",
    `${JSON.stringify(
      lanes.map((lane) => ({
        laneId: lane.laneId,
        title: lane.title,
        focus: lane.focus,
        files: lane.files.map((file) => file.path),
        hunkCount: lane.hunks.length,
      })),
      null,
      2,
    )}\n`,
  );
  await writeSharedFile("README.md", sharedReviewReadme(sessionId, sharedDir));
  await writeSharedFile(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(sharedDir, sharedDir),
  );

  return { sessionId, baseDir, sharedDir, files: writtenFiles };
}

function sharedReviewReadme(sessionId: string, sharedDir: string): string {
  return [
    `# PR review shared data for Pi session ${sessionId}`,
    "",
    "This directory contains data shared by all PR review lane agents.",
    "Agents should read these files before re-fetching or rediscovering PR metadata.",
    "",
    "## Files",
    "- `pr-metadata.json` — normalized PR metadata.",
    "- `files.json` — changed file list from GitHub/local diff.",
    "- `hunks.json` — parsed diff hunks with line numbers.",
    "- `patch.diff` — full patch text.",
    "- `lanes.json` — lane routing summary.",
    "- `review-agent-tool-guard.ts` — tool-call guard loaded into lane-agent Pi processes.",
    "",
    "## Tool/edit rules",
    "- Bash is intentionally unavailable to lane agents.",
    "- Lane agents may use read/read-many-files-lines, web tools, and project_index tools.",
    `- Lane agents may edit only their own lane directory under \`tmp/${sessionId}/<lane>\` or this shared directory: \`${sharedDir}\`.`,
    "",
  ].join("\n");
}

function reviewAgentToolGuardSource(laneDir: string, sharedDir: string): string {
  return [
    'import path from "node:path";',
    "",
    "export default function reviewAgentToolGuard(pi) {",
    '  pi.on("tool_call", (event, ctx) => {',
    '    if (!["edit", "write", "multi-edit"].includes(event.toolName)) return;',
    "    const input = event.input || {};",
    '    const rawPaths = event.toolName === "multi-edit"',
    "      ? (Array.isArray(input.files) ? input.files.map((file) => file && file.path) : [])",
    "      : [input.path];",
    `    const laneDir = ${JSON.stringify(laneDir)};`,
    `    const sharedDir = ${JSON.stringify(sharedDir)};`,
    "    const allowedRoots = [laneDir, sharedDir].map((item) => path.resolve(ctx.cwd, item));",
    "    for (const rawPath of rawPaths) {",
    '      if (typeof rawPath !== "string" || rawPath.length === 0) {',
    '        return { block: true, reason: "Review lane agents may edit only their lane directory or shared review directory." };',
    "      }",
    "      const absolutePath = path.resolve(ctx.cwd, rawPath);",
    "      const allowed = allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(root + path.sep));",
    "      if (!allowed) {",
    "        return { block: true, reason: `Review lane agents may edit only files under ${laneDir} or ${sharedDir}. Blocked: ${rawPath}` };",
    "      }",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n");
}

function laneAgentArtifactDir(
  ctx: ExtensionCommandContext,
  laneId: ReviewLaneId,
): { absolute: string; relative: string } {
  const relative = getLaneDir(ctx, laneId);
  return {
    absolute: path.join(ctx.cwd, relative),
    relative,
  };
}

async function writeLaneAgentArtifact(
  ctx: ExtensionCommandContext,
  laneId: ReviewLaneId,
  fileName: string,
  content: string,
): Promise<string> {
  const artifactDir = laneAgentArtifactDir(ctx, laneId);
  await mkdir(artifactDir.absolute, { recursive: true });
  const safeFileName = fileName.replace(/[^a-z0-9._-]+/gi, "-");
  const filePath = path.join(artifactDir.absolute, safeFileName);
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

async function runCiAnalysisLaneAgent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  ciStatus: ReviewCiStatus,
  sharedArtifacts: SharedReviewArtifacts,
): Promise<LaneAgentResult> {
  const laneId = "ci-analysis";
  const prompt = [
    `# CI failure analysis for PR #${pr.ref.number}`,
    "",
    "Analyze failing CI checks and suggest concrete fixes.",
    "Use shared CI artifacts first, especially:",
    `- ${sharedArtifacts.sharedDir}/ci-status.json`,
    ...(ciStatus.failedLogFiles ?? []).map((file) => `- ${file}`),
    "",
    "Return JSON findings only. Each finding should point to the likely file/line when possible.",
  ].join("\n");
  const artifactFiles: string[] = [];
  const writeArtifact = async (fileName: string, content: string): Promise<void> => {
    const artifactPath = await writeLaneAgentArtifact(ctx, laneId, fileName, content);
    artifactFiles.push(artifactPath);
  };
  await writeArtifact("prompt.md", prompt);
  await writeArtifact("ci-status.json", `${JSON.stringify(ciStatus, null, 2)}\n`);
  await writeArtifact(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(getLaneDir(ctx, laneId), sharedArtifacts.sharedDir),
  );
  const artifactDir = laneAgentArtifactDir(ctx, laneId).relative;
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    ...(REVIEW_AGENT_ENABLE_TOOLS
      ? [
          "--tools",
          REVIEW_AGENT_ALLOWED_TOOLS,
          "--extension",
          path.join(ctx.cwd, getLaneDir(ctx, laneId), "review-agent-tool-guard.ts"),
        ]
      : ["--no-tools"]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    REVIEW_AGENT_SYSTEM_PROMPT,
    prompt,
  ];
  try {
    const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: REVIEW_AGENT_TIMEOUT_MS,
    });
    await writeArtifact("stdout.txt", result.stdout);
    await writeArtifact("stderr.txt", result.stderr);
    if (result.code !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || `ci analysis exited ${result.code}`;
      await writeArtifact("error.txt", `${error}\n`);
      return {
        laneId,
        findings: [],
        error,
        rawOutput: result.stdout || result.stderr,
        artifactDir,
        artifactFiles,
      };
    }
    const findings = parseAgentFindings(result.stdout, laneId);
    await writeArtifact("findings.json", `${JSON.stringify({ findings }, null, 2)}\n`);
    return { laneId, findings, artifactDir, artifactFiles };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeArtifact("error.txt", `${errorMessage}\n`);
    return { laneId, findings: [], error: errorMessage, artifactDir, artifactFiles };
  }
}

async function runLaneAgent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pr: PRMetadata,
  packet: ReviewLanePacket,
  sharedArtifacts: SharedReviewArtifacts,
  onProgress?: (progress: LaneAgentProgress) => void,
): Promise<LaneAgentResult> {
  onProgress?.("running");
  const prompt = buildLaneReviewPrompt(pr, packet, {
    sharedDir: sharedArtifacts.sharedDir,
    laneDir: getLaneDir(ctx, packet.laneId),
    sharedFiles: sharedArtifacts.files,
  });
  const artifactFiles: string[] = [];
  const writeArtifact = async (fileName: string, content: string): Promise<void> => {
    const artifactPath = await writeLaneAgentArtifact(ctx, packet.laneId, fileName, content);
    artifactFiles.push(artifactPath);
  };
  await writeArtifact("prompt.md", prompt);
  await writeArtifact(
    "metadata.json",
    `${JSON.stringify(
      {
        laneId: packet.laneId,
        title: packet.title,
        focus: packet.focus,
        pr: { title: pr.title, url: pr.url, head: pr.head, base: pr.base },
        files: packet.files.map((file) => file.path),
        hunkCount: packet.hunks.length,
        sharedDir: sharedArtifacts.sharedDir,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await writeArtifact("packet.json", `${JSON.stringify(packet, null, 2)}\n`);
  await writeArtifact("hunks.json", `${JSON.stringify(packet.hunks, null, 2)}\n`);
  await writeArtifact(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(getLaneDir(ctx, packet.laneId), sharedArtifacts.sharedDir),
  );
  const artifactDir = laneAgentArtifactDir(ctx, packet.laneId).relative;
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const laneToolsEnabled = REVIEW_AGENT_ENABLE_TOOLS || packet.laneId === "dedupe";
  const laneAllowedTools =
    packet.laneId === "dedupe" && !REVIEW_AGENT_ENABLE_TOOLS
      ? DEDUPE_REVIEW_AGENT_ALLOWED_TOOLS
      : REVIEW_AGENT_ALLOWED_TOOLS;
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    ...(laneToolsEnabled
      ? [
          "--tools",
          laneAllowedTools,
          "--extension",
          path.join(ctx.cwd, getLaneDir(ctx, packet.laneId), "review-agent-tool-guard.ts"),
        ]
      : ["--no-tools"]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    laneToolsEnabled ? REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS : REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS,
    prompt,
  ];
  try {
    const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: REVIEW_AGENT_TIMEOUT_MS,
    });
    await writeArtifact("stdout.txt", result.stdout);
    await writeArtifact("stderr.txt", result.stderr);
    if (result.code !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || `review agent exited ${result.code}`;
      await writeArtifact("error.txt", `${error}\n`);
      onProgress?.("error");
      return {
        laneId: packet.laneId,
        findings: [],
        error,
        rawOutput: truncateForPrompt(result.stdout || result.stderr, 20_000),
        artifactDir,
        artifactFiles,
      };
    }
    try {
      const findings = parseAgentFindings(result.stdout, packet.laneId);
      await writeArtifact("findings.json", `${JSON.stringify({ findings }, null, 2)}\n`);
      onProgress?.("done");
      return { laneId: packet.laneId, findings, artifactDir, artifactFiles };
    } catch (parseError) {
      const parseErrorMessage =
        parseError instanceof Error ? parseError.message : String(parseError);
      await writeArtifact("parse-error.txt", `${parseErrorMessage}\n`);
      const repairedFindings = await repairAgentFindings(
        pi,
        ctx,
        packet,
        result.stdout,
        writeArtifact,
      );
      if (repairedFindings) {
        await writeArtifact(
          "findings.json",
          `${JSON.stringify({ findings: repairedFindings, repaired: true }, null, 2)}\n`,
        );
        onProgress?.("done");
        return { laneId: packet.laneId, findings: repairedFindings, artifactDir, artifactFiles };
      }
      onProgress?.("error");
      return {
        laneId: packet.laneId,
        findings: [],
        error: parseErrorMessage,
        rawOutput: truncateForPrompt(result.stdout, 20_000),
        artifactDir,
        artifactFiles,
      };
    }
  } catch (error) {
    onProgress?.("error");
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeArtifact("error.txt", `${errorMessage}\n`);
    return {
      laneId: packet.laneId,
      findings: [],
      error: errorMessage,
      artifactDir,
      artifactFiles,
    };
  }
}

async function repairAgentFindings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  packet: ReviewLanePacket,
  stdout: string,
  writeArtifact?: LaneArtifactWriter,
): Promise<ReviewFinding[] | undefined> {
  if (REVIEW_AGENT_DISABLE_REPAIR || !stdout.trim()) return undefined;
  const model =
    REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const prompt = [
    "Convert this PR review lane agent output into the required JSON shape.",
    'Return JSON only. If there are no concrete findings, return {"findings":[]}.',
    "Do not invent findings that are not present in the output.",
    `Lane: ${packet.laneId}`,
    "Required shape:",
    '{"findings":[{"severity":"blocker|high|medium|low|nit","type":"bug|security|performance|maintainability|test|documentation|style|question","path":"file","line":123,"functionName":"name","title":"one line","body":"rationale","confidence":0.8,"suggestion":"fix"}]}',
    "Agent output:",
    "```",
    truncateForPrompt(stripAnsi(stdout), 20_000),
    "```",
  ].join("\n");
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    REVIEW_AGENT_SYSTEM_PROMPT,
    prompt,
  ];
  try {
    const result = await pi.exec(process.env.PI_REVIEW_PI_BIN || "pi", args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: REVIEW_AGENT_REPAIR_TIMEOUT_MS,
    });
    await writeArtifact?.("repair-stdout.txt", result.stdout);
    await writeArtifact?.("repair-stderr.txt", result.stderr);
    if (result.code !== 0) return undefined;
    return parseAgentFindings(result.stdout, packet.laneId);
  } catch {
    return undefined;
  }
}

function parseAgentFindings(stdout: string, laneId: ReviewLaneId): ReviewFinding[] {
  const raw = parseAgentJson(stdout);
  const findings = Array.isArray(raw.findings)
    ? raw.findings
    : Array.isArray(raw.issues)
      ? raw.issues
      : [];
  return findings.flatMap((finding, index) => normalizeFinding(finding, laneId, index) ?? []);
}

export function parseAgentJson(stdout: string): { findings?: unknown; issues?: unknown } {
  const trimmed = stripAnsi(stdout).trim();
  if (!trimmed) return { findings: [] };

  for (const candidateText of collectAgentCandidateTexts(trimmed)) {
    for (const candidate of collectJsonCandidates(candidateText)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // Try the next candidate.
      }
    }
  }

  throw new Error(
    `Review agent did not return parseable JSON. Output starts with: ${formatOutputSnippet(trimmed)}`,
  );
}

function collectAgentCandidateTexts(stdout: string): string[] {
  return uniqueStrings([
    ...extractPiJsonModeFinalTexts(stdout),
    ...extractFencedBlocks(stdout),
    stdout,
  ]);
}

function collectJsonCandidates(text: string): string[] {
  return uniqueStrings([text.trim(), ...extractBalancedJsonObjects(text)]).filter(Boolean);
}

function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, index + 1).trim();
        if (candidate.includes("findings") || candidate.includes("issues")) objects.push(candidate);
        start = -1;
      }
    }
  }

  return objects;
}

function extractPiJsonModeFinalTexts(stdout: string): string[] {
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      const text = extractPiEventFinalText(event);
      if (text) texts.push(text);
    } catch {
      // Not a Pi JSON-mode event line.
    }
  }
  return texts;
}

function extractPiEventFinalText(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const messages = event.messages;
  if (Array.isArray(messages)) {
    const assistantMessages = messages.filter(
      (message) => isRecord(message) && message.role === "assistant",
    );
    const lastAssistant = assistantMessages.at(-1);
    return extractPiMessageText(lastAssistant);
  }
  return extractPiMessageText(event.message);
}

function extractPiMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
  return text || undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function formatOutputSnippet(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(truncateForPrompt(singleLine, 500));
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const headLength = Math.floor(maxLength / 2);
  const tailLength = maxLength - headLength;
  return `${value.slice(0, headLength)}\n… truncated …\n${value.slice(-tailLength)}`;
}

function normalizeFinding(
  value: unknown,
  laneId: ReviewLaneId,
  index: number,
): ReviewFinding | undefined {
  if (!isRecord(value)) return undefined;
  const title = stringValue(value.title) || stringValue(value.message);
  if (!title) return undefined;
  const body = stringValue(value.body) || stringValue(value.rationale) || title;
  const pathValue =
    stringValue(value.path) || stringValue(value.file) || stringValue(value.filePath);
  const line = numberValue(value.line) ?? numberValue(value.startLine);
  const type = normalizeType(stringValue(value.type), laneId);
  const severity = normalizeSeverity(stringValue(value.severity));
  const functionName = stringValue(value.functionName) || stringValue(value.function);
  return {
    id: `${laneId}-${index + 1}-${stableId(title)}`,
    laneId,
    type,
    severity,
    title,
    body,
    suggestion: stringValue(value.suggestion),
    confidence: numberValue(value.confidence),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(String) : undefined,
    location: pathValue ? { filePath: pathValue, line, functionName } : undefined,
    functionName,
  };
}

function normalizeSeverity(value: string | undefined): ReviewSeverity {
  const normalized = value?.toLowerCase().trim();
  if (
    normalized === "blocker" ||
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "nit"
  )
    return normalized;
  if (normalized === "critical" || normalized === "blocking") return "blocker";
  if (normalized === "important" || normalized === "major" || normalized === "serious")
    return "high";
  if (normalized === "mid" || normalized === "moderate") return "medium";
  if (normalized === "minor") return "low";
  if (normalized === "trivial") return "nit";
  return "low";
}

function normalizeType(value: string | undefined, laneId: ReviewLaneId): ReviewFindingType {
  const valid: ReviewFindingType[] = [
    "bug",
    "security",
    "performance",
    "maintainability",
    "test",
    "documentation",
    "style",
    "question",
  ];
  if (valid.includes(value as ReviewFindingType)) return value as ReviewFindingType;
  if (laneId.includes("security")) return "security";
  if (laneId.includes("test")) return "test";
  if (laneId.includes("doc")) return "documentation";
  if (laneId.includes("relevance") || laneId.includes("description") || laneId.includes("intent"))
    return "question";
  if (laneId.includes("performance")) return "performance";
  if (
    laneId.includes("quality") ||
    laneId.includes("architecture") ||
    laneId.includes("dedupe") ||
    laneId.includes("reuse")
  )
    return "maintainability";
  return "bug";
}

function stableId(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1)
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

interface IssueConsolidationBucket {
  key: string;
  title: string;
  summary: string;
  priority: number;
  findings: ReviewFinding[];
}

function buildIssueConsolidations(findings: readonly ReviewFinding[]): IssueConsolidation[] {
  const buckets = new Map<string, IssueConsolidationBucket>();
  const addToBucket = (
    key: string,
    title: string,
    summary: string,
    finding: ReviewFinding,
    priority: number,
  ) => {
    const existing = buckets.get(key) ?? { key, title, summary, priority, findings: [] };
    if (!existing.findings.some((candidate) => candidate.id === finding.id))
      existing.findings.push(finding);
    existing.priority = Math.max(existing.priority, priority);
    buckets.set(key, existing);
  };

  for (const finding of findings) {
    const filePath = finding.location?.filePath;
    const text = findingSearchText(finding);

    if (finding.type === "documentation" && filePath) {
      addToBucket(
        `docs:${filePath}`,
        `${path.basename(filePath)} documentation quality`,
        `Multiple documentation findings affect ${filePath}. Resolve the shared guidance once, then update each affected example or instruction.`,
        finding,
        60,
      );
    }

    if (isValidationLeakageText(text)) {
      addToBucket(
        "pattern:validation-error-details",
        "Validation error details expose identifiers",
        "Common root: validators expose raw identifier values in errors. Decide the shared error-message policy once, then apply it to all affected validators.",
        finding,
        100,
      );
    }

    if (isDataOptionalityText(text)) {
      addToBucket(
        "pattern:data-optionality",
        "Data schema optionality is too loose",
        "Common root: DB/API/UI types allow absent or nullable values where the feature appears to require a concrete value. Tighten the schema boundary first, then derive API and form types from it.",
        finding,
        90,
      );
    }

    if (isSchemaDriftText(text)) {
      addToBucket(
        "pattern:schema-drift",
        "Schema-derived types drift across layers",
        "Common root: API or UI/form types appear duplicated or broader than the source schema. Derive downstream types from the API/schema boundary and keep feature constraints in the schema.",
        finding,
        85,
      );
    }

    if (isAuthScopeText(text)) {
      addToBucket(
        "pattern:auth-scope",
        "Authorization or tenant scope is inconsistent",
        "Common root: multiple findings point to missing or inconsistent auth, permission, or tenant/company scoping. Fix the shared boundary check before addressing individual call sites.",
        finding,
        80,
      );
    }

    if (isMissingTestText(text)) {
      addToBucket(
        "pattern:missing-tests",
        "Changed behavior lacks focused coverage",
        "Common root: several changed paths rely on the same untested behavior. Add a focused test at the shared behavior boundary, then cover representative edge cases.",
        finding,
        70,
      );
    }

    const locationKey = sharedLocationKey(finding);
    if (locationKey) {
      addToBucket(
        `location:${locationKey}`,
        `Multiple lanes flagged ${sharedLocationLabel(finding)}`,
        "Several reviewers point at the same changed code area. Treat these as symptoms of one underlying implementation issue before fixing each reported detail.",
        finding,
        55,
      );
    }

    const normalizedTitle = normalizeIssuePhrase(finding.title);
    if (normalizedTitle) {
      addToBucket(
        `title:${normalizedTitle}`,
        `Repeated issue: ${sentenceCase(normalizedTitle)}`,
        "Multiple findings describe the same issue pattern. Fix the shared cause once, then verify each affected site.",
        finding,
        50,
      );
    }
  }

  const usedFindingIds = new Set<string>();
  return [...buckets.values()]
    .filter((bucket) => bucket.findings.length >= 2)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.findings.length - a.findings.length ||
        a.title.localeCompare(b.title),
    )
    .flatMap((bucket, index): IssueConsolidation[] => {
      const group = bucket.findings.filter((finding) => !usedFindingIds.has(finding.id));
      if (group.length < 2) return [];
      for (const finding of group) usedFindingIds.add(finding.id);
      return [
        {
          id: `group-${index + 1}-${stableId(`${bucket.key}:${group.map((finding) => finding.id).join(",")}`)}`,
          title: bucket.title,
          summary: bucket.summary,
          findingIds: group.map((finding) => finding.id),
        },
      ];
    });
}

function findingSearchText(finding: ReviewFinding): string {
  return [
    finding.title,
    finding.body,
    finding.suggestion,
    finding.type,
    finding.laneId,
    finding.location?.filePath,
    finding.functionName,
    finding.location?.functionName,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidationLeakageText(text: string): boolean {
  return /(echo|echoed|expos|leak).*(validation error|error detail|identifier|\bid\b|pii|tax id|national id)/i.test(
    text,
  );
}

function isDataOptionalityText(text: string): boolean {
  return (
    /(data|database|db|drizzle|schema|zod|type|form)/i.test(text) &&
    /(nullable|nullability|null|optional|undefined|required|not null|notnull|default|constraint|tight|loose|broad|empty array|empty string)/i.test(
      text,
    )
  );
}

function isSchemaDriftText(text: string): boolean {
  return /(duplicate|drift|derive|derived|infer|inferred|source of truth|broader|looser).*(schema|type|api|ui|form|zod|db)|((schema|type|api|ui|form|zod|db).*(duplicate|drift|derive|derived|infer|inferred|source of truth|broader|looser))/i.test(
    text,
  );
}

function isAuthScopeText(text: string): boolean {
  return /(auth|authorization|permission|access control|tenant|company\s*id|companyid|scope|scoping)/i.test(
    text,
  );
}

function isMissingTestText(text: string): boolean {
  return /(missing|lacks?|without|no).{0,30}(test|coverage)|untested|edge case/i.test(text);
}

function sharedLocationKey(finding: ReviewFinding): string | undefined {
  const filePath = finding.location?.filePath;
  if (!filePath) return undefined;
  const functionName = finding.functionName?.trim() || finding.location?.functionName?.trim();
  if (functionName) return `${filePath}#${functionName}`;
  const line = finding.location?.line ?? finding.location?.startLine;
  return line === undefined ? undefined : `${filePath}:${line}`;
}

function sharedLocationLabel(finding: ReviewFinding): string {
  const filePath = finding.location?.filePath ?? "the same code area";
  const functionName = finding.functionName?.trim() || finding.location?.functionName?.trim();
  return functionName ? `${functionName} in ${filePath}` : filePath;
}

function normalizeIssuePhrase(value: string): string | undefined {
  const normalized = value
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(can|could|may|might|should|would|the|a|an|to|of|for|in|on|with|and|or|is|are|be|been|this|that|these|those)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized.split(" ").length >= 3 ? normalized : undefined;
}

function sentenceCase(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function buildReviewReportBody(
  snapshot: ReviewRenderSnapshot,
  summary = renderExecutiveSummary(snapshot.summaryInput),
): string {
  return [summary, "", snapshot.runDetailsHeading, "", ...snapshot.runDetailLines].join("\n");
}

async function writeReviewReports(
  ctx: ExtensionCommandContext,
  prNumber: number,
  markdownContent: string,
  snapshot: ReviewRenderSnapshot,
): Promise<ReviewReportPaths> {
  const rootDir = ctx.cwd;
  const reportDir = path.join(rootDir, getReviewSessionDir(ctx).baseDir, REVIEW_REPORT_DIR);
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = prNumber > 0 ? `pr-${prNumber}` : "local";
  const markdownPath = path.join(reportDir, `${label}-${stamp}.md`);
  const visualPath = path.join(reportDir, `${label}-${stamp}.html`);
  const resultsPath = path.join(reportDir, `${label}-${stamp}.results.json`);
  const latestResultsPath = path.join(reportDir, LATEST_REVIEW_RESULTS_FILE);
  const relativeMarkdownPath = relativePath(rootDir, markdownPath);
  const relativeVisualPath = relativePath(rootDir, visualPath);
  const relativeResultsPath = relativePath(rootDir, resultsPath);
  const visualContent = renderVisualReviewReport({
    summary: snapshot.summaryInput,
    runDetails: { ...snapshot.visualRunDetails, markdownReportPath: relativeMarkdownPath },
  });
  const snapshotContent = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(markdownPath, `${markdownContent.trim()}\n`, "utf8");
  await writeFile(visualPath, visualContent, "utf8");
  await writeFile(resultsPath, snapshotContent, "utf8");
  await writeFile(latestResultsPath, snapshotContent, "utf8");

  let commentPayloadPath: string | undefined;
  if (snapshot.commentPayload) {
    const payloadPath = path.join(reportDir, `${label}-${stamp}.comment-payload.json`);
    await writeFile(payloadPath, `${JSON.stringify(snapshot.commentPayload, null, 2)}\n`, "utf8");
    commentPayloadPath = relativePath(rootDir, payloadPath);
  }

  return {
    markdownPath: relativeMarkdownPath,
    visualPath: relativeVisualPath,
    commentPayloadPath,
    resultsPath: relativeResultsPath,
  };
}

async function loadReviewRenderSnapshot(
  ctx: ExtensionCommandContext,
  requestedPath?: string,
): Promise<{ snapshot: ReviewRenderSnapshot; relativePath: string } | undefined> {
  const relative =
    requestedPath?.trim() ||
    path.join(getReviewSessionDir(ctx).baseDir, REVIEW_REPORT_DIR, LATEST_REVIEW_RESULTS_FILE);
  const absolutePath = path.resolve(ctx.cwd, relative);
  const relativeCheck = path.relative(ctx.cwd, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck))
    throw new Error(`Path is outside project: ${relative}`);
  const text = await readFile(absolutePath, "utf8").catch(() => undefined);
  if (!text) return undefined;
  return {
    snapshot: JSON.parse(text) as ReviewRenderSnapshot,
    relativePath: relativePath(ctx.cwd, absolutePath),
  };
}

async function rerenderReviewReport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const openVisual = hasFlag(tokens, "--open-visual");
  const requestedPath = tokens.find((token) => !token.startsWith("--"));
  const loaded = await loadReviewRenderSnapshot(ctx, requestedPath);
  if (!loaded) {
    const message = requestedPath
      ? `No cached review results found at ${requestedPath}.`
      : "No cached review results are available. Run /pr-review first.";
    showWidget(ctx, [message]);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    return;
  }
  const snapshot = { ...loaded.snapshot, generatedAt: new Date().toISOString() };
  const summary = renderExecutiveSummary(snapshot.summaryInput);
  const reportBody = buildReviewReportBody(snapshot, summary);
  const reportPaths = await writeReviewReports(
    ctx,
    snapshot.summaryInput.pr.ref.number,
    reportBody,
    snapshot,
  );
  publishReviewReport(pi, reportBody);
  lastStatus = {
    prNumber: snapshot.summaryInput.pr.ref.number,
    targetLabel: snapshot.targetLabel,
    title: snapshot.summaryInput.pr.title,
    updatedAt: new Date().toISOString(),
    summary,
    reportPath: reportPaths.markdownPath,
    visualReportPath: reportPaths.visualPath,
    commentPayloadPath: reportPaths.commentPayloadPath,
    resultsPath: reportPaths.resultsPath,
    laneCount: snapshot.visualRunDetails?.lanePacketCount,
    findingCount: snapshot.summaryInput.findings.length,
  };
  setStatus(ctx, "✅:rerendered");
  showWidget(ctx, [
    `Re-rendered cached review results from ${loaded.relativePath}.`,
    ...reviewStatusLines(lastStatus),
  ]);
  if (openVisual && reportPaths.visualPath)
    await openVisualReport(pi, ctx.cwd, reportPaths.visualPath, ctx.signal);
}

async function openVisualReport(
  pi: ExtensionAPI,
  rootDir: string,
  visualReportPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const absolutePath = path.resolve(rootDir, visualReportPath);
  const command =
    process.platform === "darwin"
      ? { command: "open", args: [absolutePath] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", absolutePath] }
        : { command: "xdg-open", args: [absolutePath] };
  const result = await pi.exec(command.command, command.args, { signal, timeout: 10_000 });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || `open exited ${result.code}`);
}

async function openLatestVisual(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const noOpen = hasFlag(tokenizeArgs(args), "--no-open");
  const visualPath = lastStatus.visualReportPath;
  if (!visualPath) {
    showWidget(ctx, ["No visual review report is available. Run /pr-review first."]);
    return;
  }
  showWidget(ctx, [`Visual review report: ${visualPath}`]);
  if (!noOpen) await openVisualReport(pi, ctx.cwd, visualPath, ctx.signal);
}

function publishReviewReport(pi: ExtensionAPI, markdown: string): void {
  pi.sendMessage({
    customType: REVIEW_REPORT_MESSAGE_TYPE,
    content: markdown,
    display: true,
    details: { markdown },
  });
}

function setStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function formatReviewAgentProgress(
  lanes: readonly ReviewLanePacket[],
  progressByLane: ReadonlyMap<ReviewLaneId, LaneAgentProgress>,
): string {
  const segments = lanes.map((lane) => {
    const progress = progressByLane.get(lane.laneId) ?? "waiting";
    return `${laneIcon(lane.laneId)}:${progress}`;
  });
  return segments.join(" ");
}

function showWidget(ctx: ExtensionCommandContext, lines: string[]): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, lines);
}

async function restoreLastStatusFromDisk(ctx: ExtensionCommandContext): Promise<LastStatus> {
  if (lastStatus.updatedAt) return lastStatus;
  const loaded = await loadReviewRenderSnapshot(ctx).catch(() => undefined);
  if (!loaded) return lastStatus;
  const snapshot = loaded.snapshot;
  const summary = renderExecutiveSummary(snapshot.summaryInput);
  lastStatus = {
    prNumber: snapshot.summaryInput.pr.ref.number,
    targetLabel: snapshot.targetLabel,
    title: snapshot.summaryInput.pr.title,
    updatedAt: snapshot.generatedAt,
    summary,
    resultsPath: loaded.relativePath,
    laneCount: snapshot.visualRunDetails?.lanePacketCount,
    findingCount: snapshot.summaryInput.findings.length,
  };
  return lastStatus;
}

function reviewStatusLines(status: LastStatus): string[] {
  return [
    statusLine(status),
    ...(status.visualReportPath ? [`Visual review report: ${status.visualReportPath}`] : []),
    ...(status.reportPath ? [`Markdown review report: ${status.reportPath}`] : []),
    ...(status.commentPayloadPath
      ? [`Prepared comment payload: ${status.commentPayloadPath}`]
      : []),
    ...(status.resultsPath ? [`Cached review results: ${status.resultsPath}`] : []),
  ];
}

function statusLine(status: LastStatus): string {
  if (!status.updatedAt) return "No PR review has run in this session.";
  return `${status.targetLabel ?? "review"} ${status.title ?? ""} — ${status.findingCount ?? 0} findings, ${status.laneCount ?? 0} lanes`;
}

function relativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function positionalArgs(
  tokens: readonly string[],
  flagsWithValues: readonly string[] = [],
): string[] {
  return tokens.filter((token, index) => {
    if (token.startsWith("--")) return false;
    const previous = tokens[index - 1] ?? "";
    return !flagsWithValues.includes(previous);
  });
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index] ?? "";
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function hasFlag(tokens: readonly string[], flag: string): boolean {
  return tokens.includes(flag);
}

function flagValue(tokens: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = tokens.find((token) => token.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = tokens.indexOf(flag);
  return index === -1 ? undefined : tokens[index + 1];
}

function isFlagValue(tokens: readonly string[], token: string): boolean {
  const index = tokens.indexOf(token);
  if (index <= 0) return false;
  const previous = tokens[index - 1] ?? "";
  return previous === "--lanes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function demoSummary(): string {
  const findings: ReviewFinding[] = [
    {
      id: "f1",
      laneId: "docs",
      type: "documentation",
      severity: "low",
      title: "Generated migration file expectations remain unclear",
      body: "The guide does not say whether generated files should be committed.",
      location: { filePath: "docs/custom-db-migrations.md", line: 40 },
    },
    {
      id: "f2",
      laneId: "docs",
      type: "documentation",
      severity: "low",
      title: "Placeholder bash examples can be copied as unsafe shell syntax",
      body: "The placeholder command is shown inside a bash block.",
      location: { filePath: "docs/custom-db-migrations.md", line: 80 },
    },
  ];
  return renderExecutiveSummary({
    pr: {
      ref: { owner: "local", repo: "demo", number: 0 },
      title: "Demo PR review",
      body: "Demonstrates grouped PR review findings.",
      author: "pi",
      url: "",
      state: "open",
      base: { ref: "main", sha: "base" },
      head: { ref: "demo", sha: "head" },
    },
    findings,
    reviewedLaneIds: ["docs"],
    issueConsolidations: [
      {
        id: "custom-migration-guide",
        title: "Custom migration guide still has ambiguous or unsafe instructions",
        summary:
          "Both docs findings concern residual quality problems in the same custom migration guide: generated/committed file expectations are unclear, and placeholder examples in bash blocks can be copied as unsafe shell syntax.",
        findingIds: ["f1", "f2"],
      },
    ],
  });
}

function inferDesignRuleProposals(
  policyHints: readonly PolicyHint[],
  options: PolicyInferenceOptions = {},
): DesignRuleProposal[] {
  const ruleProposals: DesignRuleProposal[] = [];
  const hints = policyHints.filter((hint) => hint.confidence >= 0.8);
  if (!hints.length) return [];

  // Look for NEVER/ALWAYS/ANTIPATTERN patterns that suggest reusable rules
  for (const hint of hints) {
    const text = hint.rawText;

    // Infer a rule description from the hint text
    if (/(?:\bnever\b|\balways\b)[^.!?\n]{10,200}/i.test(text)) {
      const baseId = "pr-review-" + stableId(text.slice(0, 60));
      const ruleId = `review-${baseId}`;
      const implementation = options.preferEslintRules ? "eslint-rule" : "design-rule";
      ruleProposals.push({
        ruleId,
        title: shortenRuleTitle(text.slice(0, 100)),
        antipattern: text.slice(0, 200).replace(/\s+/g, " ").trim(),
        suggestion: `Fix the pattern described above in "${hint.pattern}" comment ${hint.commentId}.`,
        severity: hint.confidence >= 0.9 ? "error" : "warning",
        category: implementation === "eslint-rule" ? "eslint" : "lint suggestions from PR review",
        implementation,
        targetPath:
          implementation === "eslint-rule"
            ? `dev/eslint/rules/${ruleId}.ts`
            : `.pi/design-rules/${ruleId}.ts`,
        evidenceCommentIds: [hint.commentId],
      });
    }
  }

  return ruleProposals;
}

function shortenRuleTitle(text: string): string {
  const cleaned = text
    .replace(/^(?:never|always|antipattern)[:，\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 90) return cleaned;
  return cleaned.slice(0, 87) + "…";
}

export default function prReviewExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(REVIEW_REPORT_MESSAGE_TYPE, (message) => {
    const details = message.details as { markdown?: string } | undefined;
    const markdown =
      details?.markdown ?? (typeof message.content === "string" ? message.content : "");
    return new ReviewReportMarkdown(markdown);
  });

  pi.registerCommand("pr-create", {
    description:
      "Create or update a GitHub PR from the current branch (usage: /pr-create [pr-number|branch] [--base=main] [--no-sync] [--no-checks] [--skip-screenshots])",
    handler: async (args, ctx) => runPrCreateCommand(pi, ctx, args),
  });

  pi.registerCommand("pr-update", {
    description:
      "Sync a PR branch with its base, resolve conflicts, run checks, push, refresh metadata, and watch CI (usage: /pr-update [pr-number] [--no-checks] [--no-push] [--no-metadata])",
    handler: async (args, ctx) => runPrUpdateCommand(pi, ctx, args),
  });

  pi.registerCommand("pr-review", {
    description:
      "Run a multi-lane PR review (usage: /pr-review [pr-number] [--no-agents] [--lanes=a,b] [--open-visual])",
    handler: async (args, ctx) => runReviewCommand(pi, ctx, args, false),
  });

  pi.registerCommand("pr-review-local", {
    description:
      "Run a multi-lane review for a local diff (usage: /pr-review-local [base-ref] [--no-agents] [--lanes=a,b] [--open-visual])",
    handler: async (args, ctx) => runReviewCommand(pi, ctx, args, true),
  });

  pi.registerCommand("pr-review-process", {
    description:
      "Analyze reviewer comments after review and suggest fixes/lane improvements (usage: /pr-review-process [pr-number] [--include-resolved])",
    handler: async (args, ctx) => runReviewAfterCommand(pi, ctx, args),
  });

  pi.registerCommand("pr-review-demo", {
    description: "Render a demo PR review summary with a grouped issue row.",
    handler: async () => publishReviewReport(pi, demoSummary()),
  });

  pi.registerCommand("pr-review-rerender", {
    description:
      "Re-render latest cached PR review report (usage: /pr-review-rerender [results-json] [--open-visual])",
    handler: async (args, ctx) => rerenderReviewReport(pi, ctx, args),
  });

  pi.registerCommand("pr-review-visual", {
    description: "Open the latest visual PR review report (usage: /pr-review-visual [--no-open])",
    handler: async (args, ctx) => openLatestVisual(pi, ctx, args),
  });

  pi.registerCommand("pr-review-status", {
    description: "Show the latest PR review status.",
    handler: async (_args, ctx) => {
      const status = await restoreLastStatusFromDisk(ctx);
      setStatus(ctx, status.updatedAt ? "✅:done" : undefined);
      showWidget(ctx, reviewStatusLines(status));
    },
  });

  pi.registerCommand("pr-review-update", {
    description:
      "Refresh PR reviewer knowledge (currently no-op in the recovered local extension).",
    handler: async (_args, ctx) => {
      showWidget(ctx, [
        "No external review knowledge cache is configured in this recovered extension.",
      ]);
      if (ctx.hasUI) ctx.ui.notify("Review knowledge is already local/no-op.", "info");
    },
  });
}
