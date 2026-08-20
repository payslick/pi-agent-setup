import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface HerdrAgentSession {
  kind?: string;
  value?: string;
}

interface HerdrAgent {
  agent_status?: "idle" | "working" | "blocked" | "done" | "unknown";
  agent_session?: HerdrAgentSession;
}

interface HerdrTabResult {
  tab?: { tab_id?: string };
  root_pane?: { pane_id?: string };
}

interface HerdrAgentResult {
  agent?: HerdrAgent;
}

interface HerdrCommandResult<T> {
  result?: T;
}

interface SessionMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  errorMessage?: string;
}

interface SessionEntry {
  type?: string;
  message?: SessionMessage;
}

export interface HerdrPiAgentInput {
  label: string;
  prompt: string;
  piArgs: readonly string[];
  timeout?: number;
  cwd?: string;
}

export interface HerdrPiAgentOutput {
  code: number;
  stdout: string;
  stderr: string;
  tabId: string;
}

const safeName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "") || "review-agent";

const compactLabel = (value: string): string =>
  value
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "PR-review";

const runHerdr = async <T>(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
  cwd: string,
  timeout: number | null = 30_000,
): Promise<T> => {
  const result = await pi.exec("herdr", args, {
    cwd,
    signal: ctx.signal,
    ...(timeout === null ? {} : { timeout }),
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `herdr ${args.join(" ")} failed`,
    );
  }
  try {
    return ((JSON.parse(result.stdout) as HerdrCommandResult<T>).result ?? {}) as T;
  } catch {
    throw new Error(`Invalid Herdr response: ${result.stdout.trim() || "(empty)"}`);
  }
};

const sessionMessageText = (message: SessionMessage): string => {
  if (typeof message.content === "string") return message.content.trim();
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
};

export const finalAssistantTextFromSession = (content: string): string => {
  const messages = content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line): SessionMessage[] => {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        return entry.type === "message" && entry.message?.role === "assistant"
          ? [entry.message]
          : [];
      } catch {
        return [];
      }
    });
  const finalMessage = messages.at(-1);
  return finalMessage ? sessionMessageText(finalMessage) || finalMessage.errorMessage || "" : "";
};

const readAgentOutput = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  agentName: string,
  agent: HerdrAgent,
  cwd: string,
): Promise<string> => {
  const sessionPath =
    agent.agent_session?.kind === "path" ? agent.agent_session.value?.trim() : undefined;
  if (sessionPath) return finalAssistantTextFromSession(await readFile(sessionPath, "utf8"));
  const result = await pi.exec(
    "herdr",
    ["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "2000"],
    { cwd, signal: ctx.signal, timeout: 30_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || "herdr agent read failed");
  return result.stdout.trim();
};

export const silentReviewTabArgs = (
  workspaceId: string,
  cwd: string,
  label: string,
  subagentId: string,
  agentName: string,
): string[] => [
  "tab",
  "create",
  "--workspace",
  workspaceId,
  "--cwd",
  cwd,
  "--label",
  label,
  "--env",
  `PI_SUBAGENT_ID=${subagentId}`,
  "--env",
  `PI_SUBAGENT_NAME=${agentName}`,
  "--env",
  "PI_DISABLE_SOUNDS=1",
  "--env",
  "HERDR_ENV=0",
  "--no-focus",
];

const shellSafePiArguments = (piArgs: readonly string[]): string[] =>
  piArgs.map((argument, index) => {
    const previousArgument = piArgs[index - 1];
    if (previousArgument !== "--system-prompt" && previousArgument !== "--append-system-prompt")
      return argument;
    return argument.replace(/\s+/g, " ").trim();
  });

class ReviewAgentStartupError extends Error {}

let reviewAgentStartupQueue = Promise.resolve();

const withReviewAgentStartupLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previousStartup = reviewAgentStartupQueue;
  let releaseStartup!: () => void;
  reviewAgentStartupQueue = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  await previousStartup;
  try {
    return await operation();
  } finally {
    releaseStartup();
  }
};

const herdrErrorCode = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return (JSON.parse(message) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

const reviewAgentStartMaxAttempts = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS ?? 6);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 6;
};

const reviewAgentStartRetryDelay = (attempt: number): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS ?? 250);
  const baseDelay = Number.isFinite(configured) ? Math.max(0, configured) : 250;
  return Math.min(4_000, baseDelay * 2 ** Math.max(0, attempt - 1));
};

const startReviewAgent = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: HerdrPiAgentInput,
  cwd: string,
  label: string,
  agentName: string,
  paneId: string,
): Promise<void> => {
  const maxAttempts = reviewAgentStartMaxAttempts();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runHerdr<HerdrAgentResult>(
        pi,
        ctx,
        [
          "agent",
          "start",
          agentName,
          "--kind",
          "pi",
          "--pane",
          paneId,
          "--timeout",
          "60000",
          "--",
          ...shellSafePiArguments(input.piArgs),
          "--name",
          label,
        ],
        cwd,
        70_000,
      );
      return;
    } catch (error) {
      if (herdrErrorCode(error) !== "agent_pane_busy") throw error;
      if (attempt === maxAttempts) {
        throw new ReviewAgentStartupError(
          `PR review lane "${label}" could not start after ${maxAttempts} attempts because Herdr kept reporting that its new pane was not an available shell. The empty tab was closed and this lane will be reported as omitted.`,
        );
      }
      await wait(reviewAgentStartRetryDelay(attempt), undefined, { signal: ctx.signal });
    }
  }
};

const notifyReviewAgentStartupFailure = (
  ctx: ExtensionCommandContext,
  error: ReviewAgentStartupError,
): void => {
  if (ctx.hasUI) ctx.ui.notify(error.message, "error");
};

export const runPiAgentInHerdr = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: HerdrPiAgentInput,
): Promise<HerdrPiAgentOutput> => {
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (process.env.HERDR_ENV !== "1" || !workspaceId)
    throw new Error("PR review agents require Pi to run inside a Herdr workspace.");
  const cwd = input.cwd ?? ctx.cwd;
  const subagentId = randomUUID();
  const label = compactLabel(input.label);
  const agentName = `${safeName(label).slice(0, 22)}-${subagentId.replace(/-/g, "").slice(0, 8)}`;
  const { tabId } = await withReviewAgentStartupLock(async () => {
    const created = await runHerdr<HerdrTabResult>(
      pi,
      ctx,
      silentReviewTabArgs(workspaceId, cwd, label, subagentId, agentName),
      cwd,
    );
    const createdTabId = created.tab?.tab_id;
    const paneId = created.root_pane?.pane_id;
    if (!createdTabId || !paneId)
      throw new Error("Herdr did not return a review-agent tab and pane.");

    try {
      await startReviewAgent(pi, ctx, input, cwd, label, agentName, paneId);
    } catch (error) {
      await runHerdr(pi, ctx, ["tab", "close", createdTabId], cwd).catch(() => undefined);
      if (error instanceof ReviewAgentStartupError) notifyReviewAgentStartupFailure(ctx, error);
      throw error;
    }
    return { tabId: createdTabId };
  });

  await runHerdr<HerdrAgentResult>(
    pi,
    ctx,
    [
      "agent",
      "prompt",
      agentName,
      input.prompt,
      "--wait",
      "--until",
      "idle",
      "--until",
      "done",
      "--until",
      "blocked",
      ...(input.timeout === undefined ? [] : ["--timeout", String(input.timeout)]),
    ],
    cwd,
    input.timeout === undefined ? null : input.timeout + 10_000,
  );
  const current = await runHerdr<HerdrAgentResult>(pi, ctx, ["agent", "get", agentName], cwd);
  const agent = current.agent ?? {};
  const stdout = await readAgentOutput(pi, ctx, agentName, agent, cwd);
  const blocked = agent.agent_status === "blocked";
  const code = blocked || !stdout ? 1 : 0;
  const stderr = blocked
    ? "Review agent is blocked."
    : !stdout
      ? "Review agent returned no output."
      : "";
  if (code === 0) await runHerdr(pi, ctx, ["tab", "close", tabId], cwd);
  return { code, stdout, stderr, tabId };
};
