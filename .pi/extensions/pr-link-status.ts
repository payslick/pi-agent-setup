import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

interface GetPrNumberResult {
  status: "found" | "none" | "multiple";
  pr?: PullRequestInfo;
}

const STATUS_KEY = "branch-pr";
const REFRESH_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
const BRIGHT_WHITE = "\u001B[97m";
const FG_RESET = "\u001B[39m";

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
    const parsed = JSON.parse(stdout.trim()) as GetPrNumberResult;
    const pr = parsed.status === "found" ? parsed.pr : undefined;
    if (!pr || typeof pr.number !== "number" || typeof pr.url !== "string") return null;
    return pr;
  } catch {
    return null;
  }
}

function terminalLink(url: string, label: string): string {
  return `\u001B]8;;${url}\u001B\\${label}\u001B]8;;\u001B\\`;
}

function brightWhite(text: string): string {
  return `${BRIGHT_WHITE}${text}${FG_RESET}`;
}

function prUrlLabel(pr: PullRequestInfo): string {
  const numberText = String(pr.number);
  return pr.url.endsWith(numberText)
    ? `${pr.url.slice(0, -numberText.length)}${brightWhite(numberText)}`
    : pr.url;
}

function getPrNumberScript(cwd: string): string | null {
  const envDir = process.env.PI_FINITO_SCRIPTS_DIR?.trim();
  const scriptDirs = [
    envDir ? resolve(cwd, envDir) : undefined,
    join(cwd, ".pi/finito-scripts/scripts"),
    join(cwd, "skills/skills/finito-scripts/scripts"),
  ].filter((dir): dir is string => Boolean(dir));
  return scriptDirs.map((dir) => join(dir, "getPrNumber.ts")).find(existsSync) ?? null;
}

async function findPr(cwd: string): Promise<PullRequestInfo | null> {
  const script = getPrNumberScript(cwd);
  if (!script) return null;
  const result = await run("bun", [script, "--current-branch-only"], cwd);
  if (result.code !== 0) return null;
  return parsePrJson(result.stdout);
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
    const pr = await findPr(ctx.cwd);
    if (!pr) {
      setStatus(ctx, undefined);
      return;
    }

    setStatus(ctx, terminalLink(pr.url, prUrlLabel(pr)));
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
