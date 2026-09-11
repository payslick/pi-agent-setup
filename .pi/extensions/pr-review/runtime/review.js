import { readFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fetchLocalData, fetchPrData, fetchPrReviewComments, resolvePrNumber } from "./github.js";
import { routeReviewLanes } from "./lanes.js";
import {
  filterReviewFiles,
  filterReviewFindings,
  filterReviewHunks,
  filterReviewPatch,
} from "../review-scope.ts";
import { prepareDryRunPosting } from "./posting.js";
import { laneIcon, renderExecutiveSummary } from "./summary.js";
import { getLaneDir, writeSharedReviewArtifacts } from "./artifacts.js";
import {
  readPartialReviewFindings,
  reviewAgentInactivityTimeout,
  reviewAgentTimeout,
  runCiAnalysisLaneAgent,
  runLaneAgent,
} from "./review-agents.js";
import { buildIssueConsolidations } from "./issues.js";
import { buildReviewSkillCoverage, runCiWatcher } from "./review-ci.js";
import {
  buildReviewReportBody,
  buildReviewSnapshot,
  openVisualReport,
  publishReviewReport,
  recordReviewStatus,
  setStatus,
  showWidget,
  statusLine,
  writeReviewReports,
} from "./review-reports.js";

export async function prefixTmuxWindowTitleWithPrNumber(pi, ctx, prNumber) {
  if (prNumber <= 0) return;
  try {
    const currentWindow = await pi.exec("tmux", ["display-message", "-p", "#W"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 5_000,
    });
    if (currentWindow.code !== 0) return;
    const currentTitle = currentWindow.stdout.trim().replace(/\s+/g, " ");
    if (!currentTitle) return;
    const baseTitle = currentTitle.replace(/^(?:#\d+:\s*)+/, "").trim() || currentTitle;
    const nextTitle = `#${prNumber}: ${baseTitle}`;
    if (currentTitle === nextTitle) return;
    await pi.exec("tmux", ["rename-window", nextTitle], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 5_000,
    });
  } catch {}
}

function parseReviewCommandOptions(args) {
  const tokens = tokenizeArgs(args);
  return {
    noAgents: hasFlag(tokens, "--no-agents"),
    openVisual: hasFlag(tokens, "--open-visual"),
    selfReview: hasFlag(tokens, "--self-review"),
    requestedLaneIds: flagValue(tokens, "--lanes")
      ?.split(",")
      .map((laneId) => laneId.trim())
      .filter(Boolean),
    positionalArguments: tokens.filter(
      (token, tokenIndex) => !token.startsWith("--") && tokens[tokenIndex - 1] !== "--lanes",
    ),
  };
}

async function loadReviewTarget(pi, ctx, local, positionalArguments) {
  if (local) return fetchLocalData(pi.exec, ctx.cwd, positionalArguments[0] || "origin/main");
  const prNumber = await resolvePrNumber(pi.exec, ctx.cwd, positionalArguments[0]);
  return fetchPrData(pi.exec, ctx.cwd, prNumber);
}

async function fetchExistingReviewComments(pi, ctx, local, prNumber) {
  if (local) return [];
  const comments = await fetchPrReviewComments(pi.exec, ctx.cwd, prNumber, {
    includeResolvedThreads: true,
  });
  return flattenReviewComments(comments);
}

function filterReviewData(prData) {
  return {
    ...prData,
    files: filterReviewFiles(prData.files),
    hunks: filterReviewHunks(prData.hunks),
    patch: filterReviewPatch(prData.patch),
  };
}

export async function runReviewAgentSafely(
  laneId,
  operation,
  onError,
  recoverFindings,
) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const findings = recoverFindings ? await recoverFindings().catch(() => []) : [];
    onError?.(message, findings.length);
    return {
      laneId,
      findings,
      partialFindingCount: findings.length,
      error: message,
    };
  }
}

async function runReviewAgents(pi, ctx, input) {
  const progress = createReviewAgentProgress(ctx, input.lanes);
  const ciStatusPromise = Promise.resolve(input.ciStatusPromise).catch((error) => ({
    checked: false,
    status: "unknown",
    message: `CI status unavailable: ${error instanceof Error ? error.message : String(error)}`,
  }));
  try {
    let agentResults = input.noAgents
      ? input.lanes.map((lane) => {
          progress.update(lane.laneId, "skipped");
          return { laneId: lane.laneId, findings: [], error: "review agents skipped (--no-agents)" };
        })
      : await Promise.all(
          input.lanes.map((lane) =>
            runReviewAgentSafely(
              lane.laneId,
              () =>
                runLaneAgent(
                  pi,
                  ctx,
                  input.prData.metadata,
                  lane,
                  input.sharedArtifacts,
                  (phase, details) => progress.update(lane.laneId, phase, details),
                ),
              (_message, findingCount) =>
                progress.update(lane.laneId, "error", { findingCount }),
              () =>
                readPartialReviewFindings(
                  path.join(ctx.cwd, getLaneDir(ctx, lane.laneId), "partial-findings.jsonl"),
                  lane.laneId,
                ),
            ),
          ),
        );
    const ciStatus = await ciStatusPromise;
    if (!input.noAgents && ciStatus.status === "fail") {
      const ciResult = await runReviewAgentSafely(
        "ci-analysis",
        () =>
          runCiAnalysisLaneAgent(
            pi,
            ctx,
            input.prData.metadata,
            ciStatus,
            input.sharedArtifacts,
          ),
        undefined,
        () =>
          readPartialReviewFindings(
            path.join(ctx.cwd, getLaneDir(ctx, "ci-analysis"), "partial-findings.jsonl"),
            "ci-analysis",
          ),
      );
      agentResults = [...agentResults, ciResult];
    }
    return { agentResults, ciStatus };
  } finally {
    progress.stop();
  }
}

export async function runReviewCommand(pi, ctx, args, local) {
  const options = parseReviewCommandOptions(args);
  setStatus(ctx, "⏳:loading");
  showWidget(ctx, [local ? "Preparing local review…" : "Preparing PR review…"]);
  const prData = filterReviewData(
    await loadReviewTarget(pi, ctx, local, options.positionalArguments),
  );
  if (!local) await prefixTmuxWindowTitleWithPrNumber(pi, ctx, prData.prNumber);
  const existingComments = await fetchExistingReviewComments(pi, ctx, local, prData.prNumber);
  const targetLabel = local ? `local:${prData.metadata.base.ref}` : `#${prData.prNumber}`;
  const lanes = routeReviewLanes(
    { pr: prData.metadata, files: prData.files, hunks: prData.hunks },
    options.requestedLaneIds,
  );
  const sharedArtifacts = await writeSharedReviewArtifacts(ctx, prData, lanes);
  const ciStatusPromise = runCiWatcher(pi, ctx, local, prData.prNumber, sharedArtifacts);
  const { agentResults, ciStatus } = await runReviewAgents(pi, ctx, {
    lanes,
    noAgents: options.noAgents,
    prData,
    sharedArtifacts,
    ciStatusPromise,
  });
  const agentErrors = agentResults.filter((result) => result.error);
  const findings = filterReviewFindings(agentResults.flatMap((result) => result.findings));
  const issueConsolidations = buildIssueConsolidations(findings);
  const reviewedLaneIds = agentResults
    .filter((result) => !result.error)
    .map((result) => result.laneId);
  const omittedLaneReasons = agentErrors.map((result) => ({
    laneId: result.laneId,
    reason: result.error ?? "review failed",
  }));
  const posting = prepareDryRunPosting({
    findings,
    hunks: prData.hunks,
    commitId: prData.metadata.head.sha || undefined,
    issueConsolidations,
    existingComments,
  });
  const summaryInput = {
    pr: prData.metadata,
    findings,
    reviewedLaneIds,
    omittedLaneIds: omittedLaneReasons.map((reason) => reason.laneId),
    omittedLaneReasons,
    issueConsolidations,
    ciStatus,
    coverage: buildReviewSkillCoverage({
      local,
      noAgents: options.noAgents,
      prData,
      lanes,
      agentResults,
      ciStatus,
      requestedLaneIds: options.requestedLaneIds,
    }),
  };
  const summary = renderExecutiveSummary(summaryInput);
  const snapshot = buildReviewSnapshot({
    ctx,
    local,
    noAgents: options.noAgents,
    targetLabel,
    prData,
    lanes,
    reviewedLaneIds,
    ciStatus,
    posting,
    existingComments,
    agentResults,
    agentErrors,
    summaryInput,
  });
  const reportBody = buildReviewReportBody(snapshot, summary);
  const reportPaths = await writeReviewReports(ctx, prData.prNumber, reportBody, snapshot);
  publishReviewReport(pi, reportBody);
  const reviewStatus = {
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
  recordReviewStatus(reviewStatus);
  setStatus(ctx, agentErrors.length ? "⚠️:done" : "✅:done");
  showWidget(ctx, [statusLine(reviewStatus)]);
  if (options.openVisual && reportPaths.visualPath) {
    await openVisualReport(pi, ctx.cwd, reportPaths.visualPath, ctx.signal);
  }
  await promptReviewNextAction(pi, ctx, reportPaths, summaryInput, options.selfReview);
}

export async function promptReviewNextAction(
  pi,
  ctx,
  reportPaths,
  summaryInput,
  selfReview = false,
) {
  if (!summaryInput.findings.length) return;
  if (!ctx.hasUI || !ctx.ui.select) return;
  const options = [
    "post critical/important comments",
    "post all comments",
    "fix critical/important",
    "fix all issues",
  ];
  const choice = await ctx.ui.select(
    selfReview
      ? "Self-review complete. No comments have been posted. What would you like to do? (Esc to type something else)"
      : "Review complete. What would you like to do? (Esc to type something else)",
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

function buildReviewNextActionPrompt(choice, reportPaths, summaryInput) {
  const artifactLines = [
    reportPaths.resultsPath ? `Cached review results: ${reportPaths.resultsPath}` : undefined,
    reportPaths.markdownPath ? `Markdown report: ${reportPaths.markdownPath}` : undefined,
    reportPaths.commentPayloadPath
      ? `Prepared comment payload: ${reportPaths.commentPayloadPath}`
      : undefined,
  ].filter(Boolean);
  const target = `PR #${summaryInput.pr.ref.number} (${summaryInput.pr.title})`;
  const duplicateInstruction =
    "Fetch all current PR comments, including resolved review threads, before posting. Do not post an equivalent comment. Reply to an existing thread only when adding substantial new evidence, reproduction details, security impact, or a concrete fix; otherwise post nothing.";
  const criticalCount = summaryInput.findings.filter(
    (finding) => finding.severity === "blocker" || finding.severity === "high",
  ).length;
  if (choice === "post critical/important comments")
    return [
      `For ${target}, post only critical/important review comments (severity blocker/high).`,
      `There are ${criticalCount} critical/important finding(s).`,
      ...artifactLines,
      duplicateInstruction,
      "Do not post medium/low/nit comments. Do not add a summary-only comment.",
    ].join("\n");
  if (choice === "post all comments")
    return [
      `For ${target}, post all prepared actionable review comments.`,
      `There are ${summaryInput.findings.length} finding(s).`,
      ...artifactLines,
      duplicateInstruction,
      "Do not add a summary-only comment unless there is a cross-cutting concern not covered by line comments.",
    ].join("\n");
  if (choice === "fix critical/important")
    return [
      `For ${target}, fix only critical/important review issues (severity blocker/high).`,
      `There are ${criticalCount} critical/important finding(s).`,
      ...artifactLines,
      "Read the cached review results first, then edit only files needed for those issues. Do not opportunistically fix lower-severity findings.",
    ].join("\n");
  return [
    `For ${target}, fix all review issues from the completed review.`,
    `There are ${summaryInput.findings.length} finding(s).`,
    ...artifactLines,
    "Read the cached review results first, then edit only files needed for the review findings.",
  ].join("\n");
}

function flattenReviewComments(reviewComments) {
  const mergedComments = [
    ...reviewComments.reviewThreads.flatMap((thread) => thread.comments),
    ...reviewComments.comments,
  ];
  const uniqueComments = new Map();
  for (const comment of mergedComments) {
    const commentKey = comment.id || `${comment.databaseId}`;
    if (!uniqueComments.has(commentKey)) uniqueComments.set(commentKey, comment);
  }
  return [...uniqueComments.values()];
}

const TERMINAL_AGENT_PHASES = new Set(["done", "error", "skipped"]);
const MESSAGE_COUNT_PHASES = new Set(["working", "finalizing"]);
const MAX_PROGRESS_COLUMNS = 4;
const PROGRESS_COLUMN_GAP = "  ";
const TIMEOUT_WARNING_MS = 5 * 60_000;

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function progressElapsed(entry, now) {
  if (!entry?.startedAt) return 0;
  return (entry.finishedAt ?? now) - entry.startedAt;
}

function parseJsonLines(content) {
  return content.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function sessionMessageProgress(content) {
  let messageCount = 0;
  let lastMessageAt;
  for (const entry of parseJsonLines(content)) {
    if (entry?.type !== "message") continue;
    messageCount += 1;
    const timestamp =
      typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(timestamp)) lastMessageAt = Math.max(lastMessageAt ?? timestamp, timestamp);
  }
  return { messageCount, lastMessageAt };
}

export function countSessionMessages(content) {
  return sessionMessageProgress(content).messageCount;
}

export function countPartialFindings(content) {
  const findingKeys = new Set();
  for (const finding of parseJsonLines(content)) {
    if (!finding || typeof finding !== "object" || typeof finding.title !== "string") continue;
    findingKeys.add(`${finding.path ?? ""}:${finding.line ?? ""}:${finding.title}`);
  }
  return findingKeys.size;
}

async function readProgressCount(filePath, counter) {
  if (!filePath) return undefined;
  try {
    return counter(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function formatReviewAgentProgress(lanes, progressByLane, startedAt, now = Date.now()) {
  const entries = lanes.map((lane) => progressByLane.get(lane.laneId));
  const finished = entries.filter((entry) => TERMINAL_AGENT_PHASES.has(entry?.phase)).length;
  const active = entries.filter(
    (entry) => entry?.startedAt && !TERMINAL_AGENT_PHASES.has(entry.phase),
  ).length;
  const failed = entries.filter((entry) => entry?.phase === "error").length;
  return `Review ${finished}/${lanes.length} • ${active} active • ${failed} failed • ${elapsedLabel(now - startedAt)}`;
}

function progressTimeoutRemaining(entry, timeout, inactivityTimeout, now) {
  if (!entry.timeoutStartedAt) return timeout;
  const deadline = Math.max(
    entry.timeoutStartedAt + timeout,
    entry.lastMessageAt
      ? Math.min(entry.lastMessageAt, now) + inactivityTimeout
      : Number.NEGATIVE_INFINITY,
  );
  return Math.max(0, deadline - now);
}

function progressCell(lane, entry, titleWidth, timeout, inactivityTimeout, now) {
  const title = `${laneIcon(lane.laneId)} ${lane.title}`.padEnd(titleWidth);
  const phase = entry.phase.padEnd(10);
  const elapsed = entry.startedAt ? elapsedLabel(progressElapsed(entry, now)) : "--:--";
  const messageCount = entry.messageCount ?? (entry.sessionPath ? 0 : "—");
  const activity = MESSAGE_COUNT_PHASES.has(entry.phase)
    ? `${elapsed}(${messageCount})`
    : elapsed;
  const fields = [`${title} ${phase} ${activity}`, `found:${entry.findingCount ?? 0}`];
  const remaining = progressTimeoutRemaining(entry, timeout, inactivityTimeout, now);
  if (!TERMINAL_AGENT_PHASES.has(entry.phase) && remaining <= TIMEOUT_WARNING_MS) {
    fields.push(`timeout ${elapsedLabel(remaining)}`);
  }
  return fields.join("  ");
}

function padProgressCell(cell, width) {
  return `${cell}${" ".repeat(Math.max(0, width - visibleWidth(cell)))}`;
}

function packProgressCells(cells, width) {
  if (!cells.length) return [];
  const requiredWidth = Math.max(...cells.map((cell) => visibleWidth(cell)));
  const columnCount = Math.max(
    1,
    Math.min(
      MAX_PROGRESS_COLUMNS,
      cells.length,
      Math.floor((width + PROGRESS_COLUMN_GAP.length) / (requiredWidth + PROGRESS_COLUMN_GAP.length)),
    ),
  );
  if (columnCount === 1) return cells.flatMap((cell) => wrapTextWithAnsi(cell, width));
  const lines = [];
  for (let index = 0; index < cells.length; index += columnCount) {
    const row = cells.slice(index, index + columnCount);
    lines.push(
      row
        .map((cell, cellIndex) =>
          cellIndex === row.length - 1 ? cell : padProgressCell(cell, requiredWidth),
        )
        .join(PROGRESS_COLUMN_GAP),
    );
  }
  return lines;
}

export function formatReviewAgentProgressWidget(
  lanes,
  progressByLane,
  startedAt,
  timeout,
  now = Date.now(),
  width = 120,
  inactivityTimeout = 600_000,
) {
  const titleWidth = Math.max(...lanes.map((lane) => visibleWidth(`${laneIcon(lane.laneId)} ${lane.title}`)), 1);
  const cells = lanes.map((lane) =>
    progressCell(
      lane,
      progressByLane.get(lane.laneId) ?? { phase: "waiting" },
      titleWidth,
      timeout,
      inactivityTimeout,
      now,
    ),
  );
  return [
    ...wrapTextWithAnsi(formatReviewAgentProgress(lanes, progressByLane, startedAt, now), width),
    "",
    ...packProgressCells(cells, width),
  ];
}

export async function refreshReviewProgressCounts(progressByLane) {
  await Promise.all(
    [...progressByLane].map(async ([laneId, entry]) => {
      if (TERMINAL_AGENT_PHASES.has(entry.phase)) return;
      const [sessionProgress, findingCount] = await Promise.all([
        MESSAGE_COUNT_PHASES.has(entry.phase)
          ? readProgressCount(entry.sessionPath, sessionMessageProgress)
          : undefined,
        readProgressCount(entry.partialFindingsPath, countPartialFindings),
      ]);
      const current = progressByLane.get(laneId);
      if (!current || TERMINAL_AGENT_PHASES.has(current.phase)) return;
      progressByLane.set(laneId, {
        ...current,
        messageCount: sessionProgress?.messageCount ?? current.messageCount,
        lastMessageAt: sessionProgress?.lastMessageAt ?? current.lastMessageAt,
        findingCount: findingCount ?? current.findingCount,
      });
    }),
  );
}

function createReviewAgentProgress(ctx, lanes) {
  const startedAt = Date.now();
  const timeout = reviewAgentTimeout();
  const inactivityTimeout = reviewAgentInactivityTimeout();
  const progressByLane = new Map(
    lanes.map((lane) => [lane.laneId, { phase: "waiting", startedAt: undefined, finishedAt: undefined }]),
  );
  let requestWidgetRender;
  let polling = false;
  let stopped = false;
  showWidget(ctx, (tui) => {
    requestWidgetRender = () => tui.requestRender();
    return {
      dispose: () => (requestWidgetRender = undefined),
      invalidate() {},
      render: (width) =>
        formatReviewAgentProgressWidget(
          lanes,
          progressByLane,
          startedAt,
          timeout,
          Date.now(),
          width,
          inactivityTimeout,
        ),
    };
  });
  const render = () => {
    setStatus(ctx, formatReviewAgentProgress(lanes, progressByLane, startedAt));
    requestWidgetRender?.();
  };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    await refreshReviewProgressCounts(progressByLane);
    polling = false;
    if (!stopped) render();
  };
  const update = (laneId, phase, details = {}) => {
    const current = progressByLane.get(laneId) ?? { phase: "waiting" };
    const now = Date.now();
    progressByLane.set(laneId, {
      ...current,
      ...details,
      phase,
      startedAt: current.startedAt ?? (phase === "waiting" ? undefined : now),
      timeoutStartedAt:
        current.timeoutStartedAt ?? (phase === "working" ? now : undefined),
      finishedAt: TERMINAL_AGENT_PHASES.has(phase) ? now : undefined,
    });
    render();
    void poll();
  };
  render();
  const timer = ctx.hasUI
    ? setInterval(() => {
        render();
        void poll();
      }, 1_000)
    : undefined;
  timer?.unref?.();
  return {
    update,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      render();
    },
  };
}

function tokenizeArgs(args) {
  const tokens = [];
  let currentToken = "";
  let quote = "";
  for (let characterIndex = 0; characterIndex < args.length; characterIndex += 1) {
    const character = args[characterIndex] ?? "";
    if (quote) {
      if (character === quote) quote = "";
      else currentToken += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (currentToken) tokens.push(currentToken);
      currentToken = "";
      continue;
    }
    currentToken += character;
  }
  if (currentToken) tokens.push(currentToken);
  return tokens;
}

function hasFlag(tokens, flag) {
  return tokens.includes(flag);
}

function flagValue(tokens, flag) {
  const inlinePrefix = `${flag}=`;
  const inlineValue = tokens.find((token) => token.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const flagIndex = tokens.indexOf(flag);
  return flagIndex === -1 ? undefined : tokens[flagIndex + 1];
}

export { parseAgentJson } from "./findings.js";
export {
  demoSummary,
  openLatestVisual,
  rerenderReviewReport,
  restoreLastStatusFromDisk,
  reviewStatusLines,
} from "./review-reports.js";
export { publishReviewReport, setStatus, showWidget, statusLine };
export { runCiWatcher };
