import { spawn } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SUMMARY_KEY = "context-summary-footer";
const CODEX_STATUS_KEY = "codex-usage";
const VIM_STATUS_KEY = "vim-motion";
const BRANCH_PR_STATUS_KEY = "branch-pr";
const REFRESH_EVERY_AGENT_TURNS = Number(process.env.PI_CTX_SUMMARY_EVERY ?? 3);
const SUMMARY_TIMEOUT_MS = Number(process.env.PI_CTX_SUMMARY_TIMEOUT_MS ?? 20_000);
const SUMMARY_MODEL = process.env.PI_CTX_SUMMARY_MODEL || "openai-codex/gpt-5.5";
const SUMMARY_THINKING = process.env.PI_CTX_SUMMARY_THINKING || "low";
const RECENT_USER_TURNS = Number(process.env.PI_CTX_SUMMARY_RECENT_USER_TURNS ?? 4);
const MAX_USER_SAID_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 180;

let summaryText = "Starting up…";
let agentTurnsSinceRefresh = REFRESH_EVERY_AGENT_TURNS;
let summarizeInFlight = false;
let pendingRefresh = false;
let requestFooterRender: (() => void) | undefined;
let lastPrompt = "";
let thinkingLevel = "";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BRIGHT_WHITE = `${ESC}[97m`;
const FG_RESET = `${ESC}[39m`;
const CSI_ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_ANSI_RE = new RegExp(`${ESC}\\].*?(?:${BEL}|${ESC}\\\\)`, "g");

function stripAnsi(text: string): string {
  return text.replace(CSI_ANSI_RE, "").replace(OSC_ANSI_RE, "");
}

function brightWhite(text: string): string {
  return `${BRIGHT_WHITE}${text}${FG_RESET}`;
}

function oneLine(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimSentence(text: string): string {
  const line = oneLine(text).replace(/^(["'`]+)|(["'`]+)$/g, "");
  if (!line) return "Active coding session.";
  const withoutPrefix = line.replace(/^session context:\s*/i, "");
  return withoutPrefix.length > MAX_SUMMARY_CHARS
    ? `${withoutPrefix.slice(0, MAX_SUMMARY_CHARS - 1).trim()}…`
    : withoutPrefix;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
          return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function userSaid(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch() as SessionEntry[];
  const userTurns = entries
    .filter(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "user",
    )
    .map((entry) => oneLine(messageText(entry.message)))
    .filter(Boolean);

  const recent = userTurns.slice(-Math.max(1, RECENT_USER_TURNS));
  const current = oneLine(lastPrompt);
  if (current && current !== recent.at(-1)) recent.push(current);

  const lines = recent.map((text, index) => `user turn ${index + 1}: ${text}`);
  const text = lines.join("\n");
  return text.length > MAX_USER_SAID_CHARS ? text.slice(-MAX_USER_SAID_CHARS) : text;
}

function runPiSummarizer(
  prompt: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--mode",
      "text",
      "--model",
      SUMMARY_MODEL,
      "--thinking",
      SUMMARY_THINKING,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "--system-prompt",
      "You summarize recent user requests in coding sessions. Reply with exactly one short sentence, no markdown.",
      prompt,
    ];

    const child = spawn(process.env.PI_CTX_SUMMARY_PI_BIN || "pi", args, {
      cwd,
      env: {
        ...process.env,
        PI_OFFLINE: process.env.PI_CTX_SUMMARY_OFFLINE ?? process.env.PI_OFFLINE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        timedOut,
      });
    };
    const abort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };
    const timeout = setTimeout(abort, SUMMARY_TIMEOUT_MS);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => finish(1));
    child.on("close", finish);
  });
}

function heuristicSummary(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch() as SessionEntry[];
  const userTexts = entries
    .filter(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "user",
    )
    .map((entry) => oneLine(messageText(entry.message)))
    .filter(Boolean);
  const latest = lastPrompt.trim() || userTexts.at(-1) || "active coding session";
  return trimSentence(latest);
}

async function refreshSummary(ctx: ExtensionContext, force = false): Promise<void> {
  if (!ctx.hasUI) return;
  if (summarizeInFlight) {
    pendingRefresh = true;
    return;
  }
  if (!force && agentTurnsSinceRefresh < REFRESH_EVERY_AGENT_TURNS) return;

  summarizeInFlight = true;
  pendingRefresh = false;
  agentTurnsSinceRefresh = 0;
  try {
    const said = userSaid(ctx);
    if (!said.trim()) {
      summaryText = heuristicSummary(ctx);
      return;
    }
    const prompt = `Summarize the user's last few turns into exactly one short sentence for a footer reminder. Use only the user turns below (ignore assistant/tool context).\n\nRecent user turns:\n${said}`;
    const result = await runPiSummarizer(prompt, ctx.cwd, ctx.signal);
    summaryText =
      result.code === 0 && result.stdout.trim()
        ? trimSentence(result.stdout)
        : heuristicSummary(ctx);
  } catch {
    summaryText = heuristicSummary(ctx);
  } finally {
    summarizeInFlight = false;
    requestFooterRender?.();
    if (pendingRefresh) void refreshSummary(ctx, true);
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function alignSides(left: string, right: string, width: number, ellipsis: string): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, ellipsis);

  const leftWidth = width - rightWidth - 1;
  const fittedLeft = truncateToWidth(left, leftWidth, ellipsis);
  const padding = " ".repeat(width - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${padding}${right}`;
}

function installFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    requestFooterRender = () => tui.requestRender();
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose() {
        unsub();
        if (requestFooterRender) requestFooterRender = undefined;
      },
      invalidate() {},
      render(width: number): string[] {
        let input = 0;
        let output = 0;
        let cost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            input += entry.message.usage.input;
            output += entry.message.usage.output;
            cost += entry.message.usage.cost.total;
          }
        }

        const statusEntries = Array.from(footerData.getExtensionStatuses().entries()).filter(
          ([key]) => key !== SUMMARY_KEY,
        );
        const prStatus = statusEntries.find(([key]) => key === BRANCH_PR_STATUS_KEY)?.[1];
        let cwd = ctx.sessionManager.getCwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
        const branch = footerData.getGitBranch();
        if (branch) cwd = `${cwd} (${branch})`;
        if (prStatus) cwd = `${cwd} ${prStatus}`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) cwd = `${cwd} • ${sessionName}`;
        const sessionId = ctx.sessionManager.getSessionId();

        const usage = ctx.getContextUsage();
        const percent = usage?.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
        const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const codexStatus = oneLine(
          statusEntries.find(([key]) => key === CODEX_STATUS_KEY)?.[1] ?? "",
        );
        const vimStatus = oneLine(statusEntries.find(([key]) => key === VIM_STATUS_KEY)?.[1] ?? "");
        const contextSize = `${percent}/${formatTokens(window)}`;
        const primaryStats = [
          `↑${formatTokens(input)}`,
          `↓${formatTokens(output)}`,
          `$${cost.toFixed(3)}`,
        ];
        const statsLeftText = [...primaryStats, contextSize, codexStatus || undefined]
          .filter(Boolean)
          .join(" ");
        const statsLeft = [
          theme.fg("dim", primaryStats.join(" ")),
          brightWhite(contextSize),
          codexStatus ? theme.fg("dim", codexStatus) : undefined,
        ]
          .filter(Boolean)
          .join(theme.fg("dim", " "));
        const model = ctx.model?.id || "no-model";
        const effort = thinkingLevel;
        const modelEffort = effort ? `${model} ${effort}` : model;
        const effortSuffix = effort ? ` ${brightWhite(effort)}` : "";
        const pad = " ".repeat(
          Math.max(1, width - visibleWidth(statsLeftText) - visibleWidth(modelEffort)),
        );
        const statsLine = truncateToWidth(
          `${statsLeft}${theme.fg("dim", pad + model)}${effortSuffix}`,
          width,
        );

        const lines = [
          truncateToWidth(theme.fg("accent", summaryText), width, theme.fg("dim", "...")),
          alignSides(
            theme.fg("dim", cwd),
            theme.fg("dim", sessionId),
            width,
            theme.fg("dim", "..."),
          ),
          statsLine,
        ];

        const statuses = [
          vimStatus || undefined,
          ...statusEntries
            .filter(
              ([key]) =>
                key !== CODEX_STATUS_KEY && key !== VIM_STATUS_KEY && key !== BRANCH_PR_STATUS_KEY,
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => oneLine(text)),
        ].filter(Boolean);
        if (statuses.length)
          lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
        return lines;
      },
    };
  });
}

export default function contextSummaryFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    summaryText = heuristicSummary(ctx);
    agentTurnsSinceRefresh = REFRESH_EVERY_AGENT_TURNS;
    thinkingLevel = pi.getThinkingLevel();
    installFooter(ctx);
    void refreshSummary(ctx, true);
  });

  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level;
    requestFooterRender?.();
  });

  pi.on("before_agent_start", (event, ctx) => {
    lastPrompt = event.prompt;
    if (summaryText === "Starting up…") summaryText = heuristicSummary(ctx);
    requestFooterRender?.();
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentTurnsSinceRefresh += 1;
    await refreshSummary(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
    requestFooterRender = undefined;
    lastPrompt = "";
  });
}
