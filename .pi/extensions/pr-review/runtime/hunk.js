import { readFile } from "node:fs/promises";
import path from "node:path";
import { PR_REVIEW_OPEN_HUNK_EVENT } from "../hunk-events.ts";
import { getReviewSessionDir } from "./artifacts.js";
import { orderFindingsForIssueTable } from "./summary.js";

const LATEST_REVIEW_RESULTS_FILE = "latest-results.json";
const HUNK_SESSION_WAIT_ATTEMPTS = 40;
const HUNK_SESSION_WAIT_MS = 100;

let unsubscribeOpenHunk;

const execute = async (pi, ctx, command, args, timeout = 30_000) => {
  const result = await pi.exec(command, args, { cwd: ctx.cwd, signal: ctx.signal, timeout });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
};

const parseResult = (output) => {
  try {
    return JSON.parse(output).result ?? {};
  } catch {
    throw new Error(`Invalid command response: ${output.trim() || "(empty)"}`);
  }
};

export const hunkSessionIds = (output) => {
  try {
    const parsed = JSON.parse(output);
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return sessions.flatMap((session) => {
      const id = session?.id ?? session?.sessionId ?? session?.session_id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    });
  } catch {
    return [];
  }
};

const latestReviewSnapshot = async (ctx) => {
  const file = path.join(
    ctx.cwd,
    getReviewSessionDir(ctx).baseDir,
    "reports",
    LATEST_REVIEW_RESULTS_FILE,
  );
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (!content) throw new Error("No cached PR review is available. Run /pr-review first.");
  return JSON.parse(content);
};

export const findingAtIssueNumber = (snapshot, findingNumber) => {
  const summary = snapshot?.summaryInput;
  if (!summary || !Array.isArray(summary.findings)) return undefined;
  return orderFindingsForIssueTable(
    summary.findings,
    summary.issueConsolidations ?? summary.assessment?.issueConsolidations ?? [],
  )[findingNumber - 1];
};

const listHunkSessions = async (pi, ctx) =>
  hunkSessionIds(await execute(pi, ctx, "hunk", ["session", "list", "--json"]));

const waitForNewHunkSession = async (pi, ctx, previousIds) => {
  for (let attempt = 0; attempt < HUNK_SESSION_WAIT_ATTEMPTS; attempt += 1) {
    const currentIds = await listHunkSessions(pi, ctx);
    const newId = currentIds.find((id) => !previousIds.has(id));
    if (newId) return newId;
    await new Promise((resolve) => setTimeout(resolve, HUNK_SESSION_WAIT_MS));
  }
  throw new Error("Hunk opened, but its live session did not become available.");
};

const createFocusedHunkTab = async (pi, ctx, findingNumber, target) => {
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (process.env.HERDR_ENV !== "1" || !workspaceId) {
    throw new Error("Opening a Hunk finding requires Pi to run inside Herdr.");
  }
  const output = await execute(pi, ctx, "herdr", [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    ctx.cwd,
    "--label",
    `Hunk-${findingNumber}`,
    "--focus",
  ]);
  const created = parseResult(output);
  const paneId = created.root_pane?.pane_id;
  if (!paneId) throw new Error("Herdr did not return a pane for the Hunk tab.");
  await execute(pi, ctx, "herdr", [
    "pane",
    "run",
    paneId,
    "hunk",
    "diff",
    target,
    "--agent-notes",
    "--line-numbers",
  ]);
};

const focusFindingComment = async (pi, ctx, sessionId, finding) => {
  const location = finding.location;
  const line = location?.line ?? location?.startLine;
  if (!location?.filePath || !line) {
    throw new Error("This finding has no file and line that Hunk can focus.");
  }
  await execute(pi, ctx, "hunk", [
    "session",
    "comment",
    "add",
    sessionId,
    "--file",
    location.filePath,
    "--new-line",
    String(line),
    "--summary",
    `#${finding.issueNumber}: ${finding.title}`,
    "--rationale",
    finding.body,
    "--author",
    finding.laneId,
    "--focus",
    "--json",
  ]);
};

export const openReviewFindingInHunk = async (pi, ctx, findingNumber) => {
  const snapshot = await latestReviewSnapshot(ctx);
  const finding = findingAtIssueNumber(snapshot, findingNumber);
  if (!finding) throw new Error(`Review finding #${findingNumber} does not exist.`);
  const location = finding.location;
  if (!location?.filePath || !(location.line ?? location.startLine)) {
    throw new Error(`Review finding #${findingNumber} has no focusable code location.`);
  }
  const pr = snapshot.summaryInput.pr;
  const target = `${pr.base.sha || pr.base.ref}...${pr.head.sha || pr.head.ref || "HEAD"}`;
  const previousIds = new Set(await listHunkSessions(pi, ctx));
  await createFocusedHunkTab(pi, ctx, findingNumber, target);
  const sessionId = await waitForNewHunkSession(pi, ctx, previousIds);
  await focusFindingComment(pi, ctx, sessionId, { ...finding, issueNumber: findingNumber });
};

export const registerPrReviewHunkIntegration = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    unsubscribeOpenHunk ??= pi.events.on(PR_REVIEW_OPEN_HUNK_EVENT, (request) => {
      if (!request || typeof request.findingNumber !== "number") return;
      request.reportStatus(`opening Hunk #${request.findingNumber}`);
      void openReviewFindingInHunk(pi, ctx, request.findingNumber).then(
        () => request.reportStatus(`Hunk #${request.findingNumber}`),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          request.reportStatus(`Hunk failed: ${message}`);
          if (ctx.hasUI) ctx.ui.notify(message, "error");
        },
      );
    });
  });
  pi.on("session_shutdown", () => {
    unsubscribeOpenHunk?.();
    unsubscribeOpenHunk = undefined;
  });
};
