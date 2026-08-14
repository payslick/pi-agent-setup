import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLaneList, renderExecutiveSummary } from "./summary.js";
import { renderVisualReviewReport } from "./visual.js";
import { getReviewSessionDir } from "./artifacts.js";
import { formatCiStatusLine } from "./review-ci.js";

const REVIEW_REPORT_MESSAGE_TYPE = "pr-review-report";
const STATUS_KEY = "pr-review";
const WIDGET_KEY = "pr-review";
const REVIEW_REPORT_DIR = "reports";
const LATEST_REVIEW_RESULTS_FILE = "latest-results.json";

let lastStatus = {};

export function buildReviewSnapshot(input) {
  const runDetailLines = [
    `Target: ${input.targetLabel}`,
    `Changed files: ${input.prData.files.length}. Diff hunks: ${input.prData.hunks.length}.`,
    `Review lanes: ${formatLaneList(input.lanes.map((lane) => lane.laneId)) || "none"}.`,
    input.noAgents
      ? "Review agents skipped (--no-agents)."
      : `Review agents completed: ${input.reviewedLaneIds.length}/${input.lanes.length}.`,
    `CI status: ${formatCiStatusLine(input.ciStatus)}.`,
    `Review agent artifacts: tmp/${getReviewSessionDir(input.ctx).sessionId}/<lane>/.`,
  ];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    targetLabel: input.targetLabel,
    canPostComments: !input.local,
    summaryInput: input.summaryInput,
    runDetailsHeading: "## Review run details",
    runDetailLines,
    visualRunDetails: {
      lanePacketCount: input.lanes.length,
      inlineDraftCount: input.posting.drafts.length,
      replyDraftCount: input.posting.replies.length,
      existingCommentCount: input.existingComments.length,
      agentArtifacts: input.agentResults.flatMap((result) =>
        result.artifactDir ? [{ laneId: result.laneId, path: result.artifactDir }] : [],
      ),
      agentErrors: input.agentErrors.map((result) => ({
        laneId: result.laneId,
        error: result.error,
        rawOutput: result.rawOutput,
      })),
    },
    commentPayload: input.local ? undefined : input.posting.payload,
    commentReplies: input.local ? undefined : input.posting.replies,
  };
}

export function buildReviewReportBody(
  snapshot,
  summary = renderExecutiveSummary(snapshot.summaryInput),
) {
  return [summary, "", snapshot.runDetailsHeading, "", ...snapshot.runDetailLines].join("\n");
}

export async function writeReviewReports(ctx, prNumber, markdownContent, snapshot) {
  const reportDir = path.join(ctx.cwd, getReviewSessionDir(ctx).baseDir, REVIEW_REPORT_DIR);
  await mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = prNumber > 0 ? `pr-${prNumber}` : "local";
  const markdownPath = path.join(reportDir, `${label}-${timestamp}.md`);
  const visualPath = path.join(reportDir, `${label}-${timestamp}.html`);
  const resultsPath = path.join(reportDir, `${label}-${timestamp}.results.json`);
  const relativeMarkdownPath = relativePath(ctx.cwd, markdownPath);
  const snapshotContent = `${JSON.stringify(snapshot, null, 2)}\n`;
  const visualContent = renderVisualReviewReport({
    summary: snapshot.summaryInput,
    runDetails: { ...snapshot.visualRunDetails, markdownReportPath: relativeMarkdownPath },
  });
  await writeFile(markdownPath, `${markdownContent.trim()}\n`, "utf8");
  await writeFile(visualPath, visualContent, "utf8");
  await writeFile(resultsPath, snapshotContent, "utf8");
  await writeFile(path.join(reportDir, LATEST_REVIEW_RESULTS_FILE), snapshotContent, "utf8");
  let commentPayloadPath;
  if (snapshot.commentPayload) {
    const payloadPath = path.join(reportDir, `${label}-${timestamp}.comment-payload.json`);
    await writeFile(payloadPath, `${JSON.stringify(snapshot.commentPayload, null, 2)}\n`, "utf8");
    commentPayloadPath = relativePath(ctx.cwd, payloadPath);
  }
  return {
    markdownPath: relativeMarkdownPath,
    visualPath: relativePath(ctx.cwd, visualPath),
    commentPayloadPath,
    resultsPath: relativePath(ctx.cwd, resultsPath),
  };
}

async function loadReviewRenderSnapshot(ctx, requestedPath) {
  const requestedRelativePath =
    requestedPath?.trim() ||
    path.join(getReviewSessionDir(ctx).baseDir, REVIEW_REPORT_DIR, LATEST_REVIEW_RESULTS_FILE);
  const absolutePath = path.resolve(ctx.cwd, requestedRelativePath);
  const pathFromRoot = path.relative(ctx.cwd, absolutePath);
  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    throw new Error(`Path is outside project: ${requestedRelativePath}`);
  }
  const text = await readFile(absolutePath, "utf8").catch(() => undefined);
  return text
    ? { snapshot: JSON.parse(text), relativePath: relativePath(ctx.cwd, absolutePath) }
    : undefined;
}

export async function rerenderReviewReport(pi, ctx, args) {
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
  if (openVisual && reportPaths.visualPath) {
    await openVisualReport(pi, ctx.cwd, reportPaths.visualPath, ctx.signal);
  }
}

export async function openVisualReport(pi, rootDir, visualReportPath, signal) {
  const absolutePath = path.resolve(rootDir, visualReportPath);
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [absolutePath] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", absolutePath] }
        : { command: "xdg-open", args: [absolutePath] };
  const result = await pi.exec(opener.command, opener.args, { signal, timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `open exited ${result.code}`);
  }
}

export async function openLatestVisual(pi, ctx, args) {
  const noOpen = hasFlag(tokenizeArgs(args), "--no-open");
  const visualReportPath = lastStatus.visualReportPath;
  if (!visualReportPath) {
    showWidget(ctx, ["No visual review report is available. Run /pr-review first."]);
    return;
  }
  showWidget(ctx, [`Visual review report: ${visualReportPath}`]);
  if (!noOpen) await openVisualReport(pi, ctx.cwd, visualReportPath, ctx.signal);
}

export function publishReviewReport(pi, markdown) {
  pi.sendMessage({
    customType: REVIEW_REPORT_MESSAGE_TYPE,
    content: markdown,
    display: true,
    details: { markdown },
  });
}

export function setStatus(ctx, text) {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

export function showWidget(ctx, lines) {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, lines);
}

export function recordReviewStatus(status) {
  lastStatus = status;
}

export async function restoreLastStatusFromDisk(ctx) {
  if (lastStatus.updatedAt) return lastStatus;
  const loaded = await loadReviewRenderSnapshot(ctx).catch(() => undefined);
  if (!loaded) return lastStatus;
  const snapshot = loaded.snapshot;
  lastStatus = {
    prNumber: snapshot.summaryInput.pr.ref.number,
    targetLabel: snapshot.targetLabel,
    title: snapshot.summaryInput.pr.title,
    updatedAt: snapshot.generatedAt,
    summary: renderExecutiveSummary(snapshot.summaryInput),
    resultsPath: loaded.relativePath,
    laneCount: snapshot.visualRunDetails?.lanePacketCount,
    findingCount: snapshot.summaryInput.findings.length,
  };
  return lastStatus;
}

export function reviewStatusLines(status) {
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

export function statusLine(status) {
  if (!status.updatedAt) return "No PR review has run in this session.";
  return `${status.targetLabel ?? "review"} ${status.title ?? ""} — ${status.findingCount ?? 0} findings, ${status.laneCount ?? 0} lanes`;
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
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

export function demoSummary() {
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
    findings: [
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
    ],
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
