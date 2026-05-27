import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface PullRequestInfo {
  number: number;
  url: string;
  headRefName?: string;
}

const STATUS_KEY = "branch-pr";
const REFRESH_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;

let refreshTimer: NodeJS.Timeout | undefined;
let refreshInFlight = false;
let lastStatusText: string | undefined;

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ stdout: "", stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
  });
}

function parsePrJson(stdout: string): PullRequestInfo | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as PullRequestInfo | PullRequestInfo[];
    const pr = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!pr || typeof pr.number !== "number" || typeof pr.url !== "string") return null;
    return pr;
  } catch {
    return null;
  }
}

function terminalLink(url: string, label: string): string {
  return `\u001B]8;;${url}\u001B\\${label}\u001B]8;;\u001B\\`;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const result = await run("git", ["branch", "--show-current"], cwd);
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  return branch || null;
}

async function findPr(cwd: string, branch: string): Promise<PullRequestInfo | null> {
  const view = await run("gh", ["pr", "view", "--json", "number,url,headRefName"], cwd);
  if (view.code === 0) {
    const pr = parsePrJson(view.stdout);
    if (pr) return pr;
  }

  const list = await run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,headRefName",
      "--limit",
      "1",
    ],
    cwd,
  );
  if (list.code !== 0) return null;
  return parsePrJson(list.stdout);
}

function setStatus(ctx: ExtensionContext, text: string | undefined) {
  if (text === lastStatusText) return;
  lastStatusText = text;
  ctx.ui.setStatus(STATUS_KEY, text);
}

async function refreshPrStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const branch = await currentBranch(ctx.cwd);
    if (!branch) {
      setStatus(ctx, undefined);
      return;
    }

    const pr = await findPr(ctx.cwd, branch);
    if (!pr) {
      setStatus(ctx, undefined);
      return;
    }

    const label = `PR #${pr.number}`;
    setStatus(ctx, ctx.ui.theme.fg("accent", terminalLink(pr.url, label)));
  } catch {
    setStatus(ctx, undefined);
  } finally {
    refreshInFlight = false;
  }
}

function startRefreshLoop(ctx: ExtensionContext) {
  if (refreshTimer) clearInterval(refreshTimer);
  void refreshPrStatus(ctx);
  refreshTimer = setInterval(() => void refreshPrStatus(ctx), REFRESH_MS);
}

export default function prLinkStatus(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    startRefreshLoop(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshPrStatus(ctx);
  });

  pi.on("user_bash", async (_event, ctx) => {
    await refreshPrStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    lastStatusText = undefined;
  });
}
