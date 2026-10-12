import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { ACCESS_MODE_STATUS_KEY } from "./access-mode";
import {
  recentUserMessages,
  userMessageText,
  WorkingSummary,
  type SummaryExecutor,
} from "./context-summary/summary";
import { PREFIX_STATUS_KEY } from "./prefix-mode/registry";
import { SESSION_SEARCH_STATUS_KEY } from "./prefix-mode/session-search";

const SUMMARY_KEY = "context-summary-footer";
const CODEX_STATUS_KEY = "codex-usage";
const VIM_STATUS_KEY = "vim-motion";
const BRANCH_PR_STATUS_KEY = "branch-pr";

interface FooterState {
  summary: WorkingSummary;
  width: number;
  thinkingLevel: string;
  requestRender: () => void;
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

export const resolveFooterTopLine = (summary: string, searchStatus: string | undefined): string =>
  oneLine(searchStatus ?? "") || summary;

export const resolvePrefixFooterLines = (
  statusEntries: ReadonlyArray<readonly [string, string]>,
): string[] | undefined => {
  const text = statusEntries.find(([key]) => key === PREFIX_STATUS_KEY)?.[1];
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map(oneLine).filter(Boolean);
  return lines.length ? lines : undefined;
};

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

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
  const worktreePrefix = "~/payslick/app/wt/";
  if (cwd.startsWith(worktreePrefix)) return cwd.slice(worktreePrefix.length);
  return cwd.startsWith("~/payslick/") ? cwd.slice("~/payslick/".length) : cwd;
}

const secondaryFooterStatuses = (
  statusEntries: Array<[string, string]>,
  vimStatus: string,
): string[] =>
  [
    vimStatus || undefined,
    ...statusEntries
      .filter(
        ([key]) =>
          key !== ACCESS_MODE_STATUS_KEY &&
          key !== CODEX_STATUS_KEY &&
          key !== VIM_STATUS_KEY &&
          key !== BRANCH_PR_STATUS_KEY &&
          key !== SESSION_SEARCH_STATUS_KEY,
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => oneLine(text)),
  ].filter((status): status is string => Boolean(status));

const footerUsage = (ctx: ExtensionContext): { input: number; output: number; cost: number } => {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    input += entry.message.usage.input;
    output += entry.message.usage.output;
    cost += entry.message.usage.cost.total;
  }
  return { input, output, cost };
};

const renderPrefixFooter = (
  statusEntries: Array<[string, string]>,
  theme: Theme,
  width: number,
): string[] | undefined => {
  const lines = resolvePrefixFooterLines(statusEntries);
  if (!lines) return undefined;
  return lines.flatMap((line, index) =>
    wrapTextWithAnsi(index === 0 ? theme.fg("accent", line) : line, width),
  );
};

function installFooter(ctx: ExtensionContext, state: FooterState): void {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    state.width = tui.terminal?.columns ?? state.width;
    state.requestRender = () => tui.requestRender();
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose() {
        unsub();
        state.requestRender = () => {};
      },
      invalidate() {},
      render(width: number): string[] {
        state.width = width;
        const { input, output, cost } = footerUsage(ctx);
        const statusEntries = Array.from(footerData.getExtensionStatuses().entries()).filter(
          ([key]) => key !== SUMMARY_KEY,
        );
        const prefixFooter = renderPrefixFooter(statusEntries, theme, width);
        if (prefixFooter) return prefixFooter;

        const prStatus = statusEntries.find(([key]) => key === BRANCH_PR_STATUS_KEY)?.[1];
        const searchStatus = statusEntries.find(([key]) => key === SESSION_SEARCH_STATUS_KEY)?.[1];
        let cwd = formatCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        const branchLabel = prStatus ?? branch?.replace(/^omry\//, "");
        if (branchLabel) cwd = `${branchLabel} ${cwd}`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) cwd = `${cwd} • ${sessionName}`;
        const sessionId = ctx.sessionManager.getSessionId();

        const usage = ctx.getContextUsage();
        const percent = usage?.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
        const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const accessStatus = oneLine(
          statusEntries.find(([key]) => key === ACCESS_MODE_STATUS_KEY)?.[1] ?? "",
        );
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
        const effort = state.thinkingLevel;
        const modelEffort = effort ? `${model} ${effort}` : model;
        const effortSuffix = effort ? ` ${brightWhite(effort)}` : "";
        const pad = " ".repeat(
          Math.max(1, width - visibleWidth(statsLeftText) - visibleWidth(modelEffort)),
        );
        const statsLine = truncateToWidth(
          `${statsLeft}${theme.fg("dim", pad + model)}${effortSuffix}`,
          width,
        );

        const topLine = resolveFooterTopLine(state.summary.render(width), searchStatus);
        const lines = topLine
          ? [truncateToWidth(theme.fg("accent", topLine), width, theme.fg("dim", "..."))]
          : [];
        lines.push(
          alignSides(
            theme.fg("dim", cwd),
            theme.fg("dim", sessionId),
            width,
            theme.fg("dim", "..."),
          ),
          statsLine,
        );

        const statuses = secondaryFooterStatuses(statusEntries, vimStatus);
        if (statuses.length || accessStatus)
          lines.push(
            alignSides(
              statuses.join(" "),
              theme.fg("accent", accessStatus),
              width,
              theme.fg("dim", "..."),
            ),
          );
        return lines;
      },
    };
  });
}

export default function contextSummaryFooter(pi: ExtensionAPI, execute?: SummaryExecutor): void {
  const state: FooterState = {
    summary: new WorkingSummary(() => state.requestRender(), execute),
    width: 80,
    thinkingLevel: "",
    requestRender: () => {},
  };
  let working = false;
  let lastPrompt = "";
  const startSummary = (ctx: ExtensionContext, prompt: string) => {
    if (!ctx.hasUI) return;
    working = true;
    const messages = recentUserMessages(ctx.sessionManager.getBranch(), prompt);
    lastPrompt = messages.at(-1) ?? "";
    state.summary.start(messages, ctx.cwd, state.width);
  };
  const stopSummary = () => {
    working = false;
    lastPrompt = "";
    state.summary.stop();
  };

  pi.on("session_start", (_event, ctx) => {
    stopSummary();
    state.thinkingLevel = pi.getThinkingLevel();
    installFooter(ctx, state);
  });

  pi.on("thinking_level_select", (event) => {
    state.thinkingLevel = event.level;
    state.requestRender();
  });

  pi.on("before_agent_start", (event, ctx) => startSummary(ctx, event.prompt));
  pi.on("agent_start", (_event, ctx) => {
    if (!working) startSummary(ctx, "");
  });
  pi.on("message_start", (event, ctx) => {
    if (!working) return;
    const prompt = userMessageText(event.message);
    if (prompt && prompt !== lastPrompt) startSummary(ctx, prompt);
  });
  pi.on("agent_settled", stopSummary);

  pi.on("session_shutdown", (_event, ctx) => {
    stopSummary();
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
    state.requestRender = () => {};
  });
}
