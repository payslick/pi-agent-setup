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

export interface BranchUpstream {
  remote: string;
  branch: string;
}

export type PrStatusCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

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

function terminalLink(url: string, label: string): string {
  return `\u001B]8;;${url}\u001B\\${label}\u001B]8;;\u001B\\`;
}

export const formatBranchPrStatus = (
  branch: string,
  upstream: BranchUpstream | null,
  pr: PullRequestInfo | null,
): string => {
  const localName = branch.replace(/^omry\//, "");
  if (!pr) return `[No PR] ${localName}`;
  const remote = upstream
    ? upstream.remote + (upstream.branch === branch ? "" : `/${upstream.branch}`)
    : "";
  return terminalLink(pr.url, `#${pr.number} ${localName}${remote ? ` (${remote})` : ""}`);
};

const parseUpstream = (result: CommandResult): BranchUpstream | null => {
  if (result.code !== 0) return null;
  const [remote, ref] = result.stdout.trim().split("\t");
  return remote && ref?.startsWith("refs/heads/")
    ? { remote, branch: ref.slice("refs/heads/".length) }
    : null;
};

export const loadBranchPrStatus = async (
  cwd: string,
  execute: PrStatusCommand = run,
): Promise<string | undefined> => {
  const local = await execute("git", ["branch", "--show-current"], cwd);
  const branch = local.stdout.trim();
  if (local.code !== 0 || !branch) return undefined;
  const upstream = parseUpstream(
    await execute(
      "git",
      [
        "for-each-ref",
        "--format=%(upstream:remotename)%09%(upstream:remoteref)",
        `refs/heads/${branch}`,
      ],
      cwd,
    ),
  );
  const head = upstream?.branch ?? branch;
  const result = await execute(
    "gh",
    ["pr", "list", "--head", head, "--state", "open", "--json", "number,url,headRefName"],
    cwd,
  );
  if (result.code !== 0) return undefined;
  try {
    const prs = JSON.parse(result.stdout) as PullRequestInfo[];
    if (!Array.isArray(prs)) return undefined;
    if (!prs.length) return formatBranchPrStatus(branch, upstream, null);
    const pr = prs[0];
    if (
      prs.length !== 1 ||
      !pr ||
      typeof pr.number !== "number" ||
      typeof pr.url !== "string" ||
      pr.headRefName !== head
    )
      return undefined;
    return formatBranchPrStatus(branch, upstream, pr);
  } catch {
    return undefined;
  }
};

function setStatus(ctx: ExtensionContext, text: string | undefined) {
  if (text === lastStatusText) return;
  lastStatusText = text;
  ctx.ui.setStatus(STATUS_KEY, text);
}

async function refreshPrStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI || refreshInFlight) return;
  refreshInFlight = true;
  try {
    setStatus(ctx, await loadBranchPrStatus(ctx.cwd));
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
