import { fetchLocalData, fetchPrData, fetchPrReviewComments, resolvePrNumber } from "./github.js";
import { routeReviewLanes } from "./lanes.js";
import { prepareDryRunPosting } from "./posting.js";
import { laneIcon, renderExecutiveSummary } from "./summary.js";
import { writeSharedReviewArtifacts } from "./artifacts.js";
import { runCiAnalysisLaneAgent, runLaneAgent } from "./review-agents.js";
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

async function runReviewAgents(pi, ctx, input) {
  const laneProgress = new Map(input.lanes.map((lane) => [lane.laneId, "waiting"]));
  const updateProgress = (laneId, progress) => {
    laneProgress.set(laneId, progress);
    setStatus(ctx, formatReviewAgentProgress(input.lanes, laneProgress));
  };
  setStatus(ctx, formatReviewAgentProgress(input.lanes, laneProgress));
  let agentResults = input.noAgents
    ? input.lanes.map((lane) => {
        updateProgress(lane.laneId, "skipped");
        return { laneId: lane.laneId, findings: [], error: "review agents skipped (--no-agents)" };
      })
    : await Promise.all(
        input.lanes.map((lane) =>
          runLaneAgent(pi, ctx, input.prData.metadata, lane, input.sharedArtifacts, (progress) =>
            updateProgress(lane.laneId, progress),
          ),
        ),
      );
  const ciStatus = await input.ciStatusPromise;
  if (!input.noAgents && ciStatus.status === "fail") {
    const ciResult = await runCiAnalysisLaneAgent(
      pi,
      ctx,
      input.prData.metadata,
      ciStatus,
      input.sharedArtifacts,
    );
    agentResults = [...agentResults, ciResult];
  }
  return { agentResults, ciStatus };
}

export async function runReviewCommand(pi, ctx, args, local) {
  const options = parseReviewCommandOptions(args);
  setStatus(ctx, "⏳:loading");
  showWidget(ctx, [local ? "Preparing local review…" : "Preparing PR review…"]);
  const prData = await loadReviewTarget(pi, ctx, local, options.positionalArguments);
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
  const findings = agentResults.flatMap((result) => result.findings);
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

async function promptReviewNextAction(pi, ctx, reportPaths, summaryInput, selfReview = false) {
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

function formatReviewAgentProgress(lanes, progressByLane) {
  return lanes
    .map((lane) => `${laneIcon(lane.laneId)}:${progressByLane.get(lane.laneId) ?? "waiting"}`)
    .join(" ");
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
