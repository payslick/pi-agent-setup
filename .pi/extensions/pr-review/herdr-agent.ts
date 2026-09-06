import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
  stopReason?: string;
}

interface SessionEntry {
  type?: string;
  timestamp?: string | number;
  message?: SessionMessage;
}

export interface HerdrPiAgentInput {
  label: string;
  prompt: string;
  piArgs: readonly string[];
  timeout?: number;
  inactivityTimeout?: number;
  cwd?: string;
  requireAgentSession?: boolean;
  onProgress?: (
    phase: "queued" | "starting" | "submitting" | "working" | "finalizing",
    details?: { sessionPath?: string },
  ) => void;
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

const sessionEntries = (content: string): SessionEntry[] =>
  content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line): SessionEntry[] => {
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });

export const latestSessionMessageTimestamp = (content: string): number | undefined => {
  let latest: number | undefined;
  for (const entry of sessionEntries(content)) {
    if (entry.type !== "message") continue;
    const timestamp =
      typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(timestamp)) latest = Math.max(latest ?? timestamp, timestamp);
  }
  return latest;
};

export const reviewAgentCompletionDeadline = (
  startedAt: number,
  timeout: number,
  inactivityTimeout: number | undefined,
  lastMessageAt: number | undefined,
): number =>
  Math.max(
    startedAt + timeout,
    inactivityTimeout !== undefined && lastMessageAt !== undefined
      ? lastMessageAt + inactivityTimeout
      : Number.NEGATIVE_INFINITY,
  );

export const finalAssistantTextFromSession = (content: string): string => {
  const messages = sessionEntries(content).flatMap((entry): SessionMessage[] =>
    entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : [],
  );
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
  if (sessionPath) {
    try {
      const sessionOutput = finalAssistantTextFromSession(await readFile(sessionPath, "utf8"));
      if (sessionOutput) return sessionOutput;
    } catch {}
  }
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
  `PI_ACCESS_PROJECT_ROOT=${cwd}`,
  "--env",
  "HERDR_ENV=0",
  "--no-focus",
];

const REVIEW_AGENT_PROMPT_ROOT = path.join(".pi", "tmp", "pr-review-agents");
const SYSTEM_PROMPT_ARGUMENTS = new Set(["--system-prompt", "--append-system-prompt"]);

const promptArgumentReferencesPath = async (cwd: string, argument: string): Promise<boolean> => {
  try {
    await stat(path.resolve(cwd, argument));
    return true;
  } catch {
    return false;
  }
};

interface FileBackedPiArguments {
  args: string[];
  cleanup: () => Promise<void>;
}

const fileBackedPiArguments = async (
  piArgs: readonly string[],
  cwd: string,
  agentName: string,
): Promise<FileBackedPiArguments> => {
  const prepared = [...piArgs];
  let promptDirectory: string | undefined;
  const cleanup = async (): Promise<void> => {
    if (promptDirectory)
      await rm(promptDirectory, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    for (let index = 1; index < prepared.length; index += 1) {
      if (!SYSTEM_PROMPT_ARGUMENTS.has(prepared[index - 1] ?? "")) continue;
      const prompt = prepared[index] ?? "";
      if (await promptArgumentReferencesPath(cwd, prompt)) continue;
      promptDirectory ??= path.resolve(cwd, REVIEW_AGENT_PROMPT_ROOT, agentName);
      await mkdir(promptDirectory, { recursive: true, mode: 0o700 });
      const promptPath = path.join(promptDirectory, `${index}.system-prompt.md`);
      await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
      prepared[index] = promptPath;
    }
    return { args: prepared, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

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

const reviewAgentPromptMaxAttempts = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS ?? 3);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 3;
};

const reviewAgentPromptRetryDelay = (attempt: number): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS ?? 250);
  const baseDelay = Number.isFinite(configured) ? Math.max(0, configured) : 250;
  return Math.min(4_000, baseDelay * 2 ** Math.max(0, attempt - 1));
};

const reviewAgentPromptEffectTimeout = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS ?? 5_000);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 5_000;
};

const reviewAgentFreshTabMaxAttempts = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS ?? 2);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 2;
};

const reviewAgentFreshTabRetryDelay = (attempt: number): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS ?? 500);
  const baseDelay = Number.isFinite(configured) ? Math.max(0, configured) : 500;
  return Math.min(4_000, baseDelay * 2 ** Math.max(0, attempt - 1));
};

const reviewAgentSessionMaxAttempts = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS ?? 40);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 40;
};

const reviewAgentSessionRetryDelay = (): number => {
  const configured = Number(process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS ?? 250);
  return Number.isFinite(configured) ? Math.max(0, configured) : 250;
};

const hasAgentSessionReference = (session: HerdrAgentSession | undefined): boolean =>
  Boolean(session?.value?.trim());

const sessionHasCompletedPrompt = (content: string): boolean =>
  sessionEntries(content).some(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.stopReason !== "toolUse" &&
      Boolean(sessionMessageText(entry.message) || entry.message.errorMessage),
  );

const agentSessionHasCompletedPrompt = async (
  session: HerdrAgentSession | undefined,
): Promise<boolean> => {
  const sessionPath = session?.kind === "path" ? session.value?.trim() : undefined;
  if (!sessionPath) return false;
  try {
    return sessionHasCompletedPrompt(await readFile(sessionPath, "utf8"));
  } catch {
    return false;
  }
};

const waitForReviewAgentSession = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  label: string,
  agentName: string,
): Promise<HerdrAgentSession> => {
  const maxAttempts = reviewAgentSessionMaxAttempts();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await runHerdr<HerdrAgentResult>(pi, ctx, ["agent", "get", agentName], cwd);
    const session = current.agent?.agent_session;
    if (hasAgentSessionReference(session)) return session ?? {};
    if (attempt === maxAttempts) {
      throw new ReviewAgentStartupError(
        `PR review lane "${label}" accepted its prompt, but Pi did not expose a session reference after ${maxAttempts} readiness checks. The unresponsive tab was closed and this lane will be reported as omitted.`,
      );
    }
    await wait(reviewAgentSessionRetryDelay(), undefined, { signal: ctx.signal });
  }
  throw new ReviewAgentStartupError(`PR review lane "${label}" did not expose a session reference.`);
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
          "300000",
          "--",
          ...input.piArgs,
          "--name",
          label,
        ],
        cwd,
        310_000,
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

const promptEffectObserved = async (
  agent: HerdrAgent | undefined,
  sessionReferenceBeforeEnter: string | undefined,
): Promise<boolean> => {
  if (["working", "blocked", "done"].includes(agent?.agent_status ?? "")) return true;
  if (await agentSessionHasCompletedPrompt(agent?.agent_session)) return true;
  const currentSessionReference = agent?.agent_session?.value?.trim();
  return Boolean(currentSessionReference && !sessionReferenceBeforeEnter);
};

const waitForReviewAgentPromptEffect = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  agentName: string,
  sessionReferenceBeforeEnter: string | undefined,
  timeout: number,
): Promise<HerdrAgent | undefined> => {
  const deadline = Date.now() + timeout;
  while (true) {
    const current = await runHerdr<HerdrAgentResult>(
      pi,
      ctx,
      ["agent", "get", agentName],
      cwd,
    );
    if (await promptEffectObserved(current.agent, sessionReferenceBeforeEnter)) {
      return current.agent;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await wait(Math.min(reviewAgentSessionRetryDelay(), remaining), undefined, {
      signal: ctx.signal,
    });
  }
};

const resumeStagedReviewAgentPrompt = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  label: string,
  agentName: string,
): Promise<HerdrAgentSession | undefined> => {
  const maxAttempts = reviewAgentPromptMaxAttempts();
  const effectTimeout = reviewAgentPromptEffectTimeout();
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    await wait(reviewAgentPromptRetryDelay(attempt - 1), undefined, { signal: ctx.signal });
    const current = await runHerdr<HerdrAgentResult>(pi, ctx, ["agent", "get", agentName], cwd);
    if (await promptEffectObserved(current.agent, current.agent?.agent_session?.value?.trim())) {
      return current.agent?.agent_session;
    }
    const sessionReferenceBeforeEnter = current.agent?.agent_session?.value?.trim();
    await runHerdr(pi, ctx, ["agent", "send-keys", agentName, "enter"], cwd);
    const observedAgent = await waitForReviewAgentPromptEffect(
      pi,
      ctx,
      cwd,
      agentName,
      sessionReferenceBeforeEnter,
      effectTimeout,
    );
    if (observedAgent) return observedAgent.agent_session;
  }
  throw new ReviewAgentStartupError(
    `PR review lane "${label}" could not submit its staged prompt after ${maxAttempts} attempts because Herdr observed no Pi state change. The unresponsive tab was closed and this lane will be reported as omitted.`,
  );
};

const promptReviewAgent = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: HerdrPiAgentInput,
  cwd: string,
  label: string,
  agentName: string,
): Promise<HerdrAgentSession | undefined> => {
  try {
    const prompted = await runHerdr<HerdrAgentResult>(
      pi,
      ctx,
      [
        "agent",
        "prompt",
        agentName,
        input.prompt,
        "--wait",
        "--until",
        "working",
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
    return prompted.agent?.agent_session;
  } catch (error) {
    if (herdrErrorCode(error) !== "agent_prompt_stalled") throw error;
    return resumeStagedReviewAgentPrompt(pi, ctx, cwd, label, agentName);
  }
};

const latestSessionActivity = async (
  session: HerdrAgentSession | undefined,
): Promise<number | undefined> => {
  const sessionPath = session?.kind === "path" ? session.value?.trim() : undefined;
  if (!sessionPath) return undefined;
  try {
    return latestSessionMessageTimestamp(await readFile(sessionPath, "utf8"));
  } catch {
    return undefined;
  }
};

const reviewAgentTimeoutError = (
  label: string,
  timeout: number,
  inactivityTimeout: number | undefined,
): Error => {
  const inactivityDescription =
    inactivityTimeout === undefined
      ? ""
      : ` or within ${inactivityTimeout} ms after its latest message`;
  return new Error(
    `PR review lane "${label}" did not complete within ${timeout} ms${inactivityDescription}. Its tab was closed and the lane will be reported as omitted.`,
  );
};

const waitForReviewAgentCompletion = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: HerdrPiAgentInput,
  cwd: string,
  label: string,
  agentName: string,
  initialSession: HerdrAgentSession | undefined,
): Promise<HerdrAgentSession | undefined> => {
  const startedAt = Date.now();
  let session = initialSession;
  let deadline = input.timeout === undefined ? undefined : startedAt + input.timeout;
  while (true) {
    if (deadline !== undefined && deadline <= Date.now()) {
      const lastMessageAt = await latestSessionActivity(session);
      const nextDeadline = reviewAgentCompletionDeadline(
        startedAt,
        input.timeout ?? 0,
        input.inactivityTimeout,
        lastMessageAt === undefined ? undefined : Math.min(lastMessageAt, Date.now()),
      );
      if (nextDeadline <= Date.now()) {
        throw reviewAgentTimeoutError(label, input.timeout ?? 0, input.inactivityTimeout);
      }
      deadline = nextDeadline;
    }
    const waitTimeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    try {
      const completed = await runHerdr<HerdrAgentResult>(
        pi,
        ctx,
        [
          "agent",
          "wait",
          agentName,
          "--until",
          "idle",
          "--until",
          "done",
          "--until",
          "blocked",
          ...(waitTimeout === undefined ? [] : ["--timeout", String(waitTimeout)]),
        ],
        cwd,
        waitTimeout === undefined ? null : waitTimeout + 10_000,
      );
      if (hasAgentSessionReference(completed.agent?.agent_session)) {
        session = completed.agent?.agent_session;
      }
      if (["blocked", "done"].includes(completed.agent?.agent_status ?? "")) return session;
      if (session?.kind !== "path" || (await agentSessionHasCompletedPrompt(session))) {
        return session;
      }
      await wait(reviewAgentSessionRetryDelay(), undefined, { signal: ctx.signal });
      continue;
    } catch (error) {
      const completionTimedOut =
        herdrErrorCode(error) === "timeout" ||
        String(error).includes("Invalid Herdr response: (empty)");
      if (input.timeout === undefined || !completionTimedOut) throw error;
      const lastMessageAt = await latestSessionActivity(session);
      const nextDeadline = reviewAgentCompletionDeadline(
        startedAt,
        input.timeout,
        input.inactivityTimeout,
        lastMessageAt === undefined ? undefined : Math.min(lastMessageAt, Date.now()),
      );
      if (nextDeadline > Date.now()) {
        deadline = nextDeadline;
        continue;
      }
      throw reviewAgentTimeoutError(label, input.timeout, input.inactivityTimeout);
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
  const label = compactLabel(input.label);
  const preparationId = randomUUID();
  const preparationName = `${safeName(label).slice(0, 22)}-${preparationId.replace(/-/g, "").slice(0, 8)}`;
  const prepared = await fileBackedPiArguments(input.piArgs, cwd, preparationName);
  const preparedInput = { ...input, piArgs: prepared.args };
  try {
    preparedInput.onProgress?.("queued");
    const maxFreshTabAttempts = reviewAgentFreshTabMaxAttempts();
    let launched:
      | { tabId: string; session: HerdrAgentSession | undefined; agentName: string }
      | undefined;
    let lastStartupError: ReviewAgentStartupError | undefined;

    for (let attempt = 1; attempt <= maxFreshTabAttempts; attempt += 1) {
      try {
        launched = await withReviewAgentStartupLock(async () => {
          const subagentId = randomUUID();
          const agentName = `${safeName(label).slice(0, 22)}-${subagentId.replace(/-/g, "").slice(0, 8)}`;
          preparedInput.onProgress?.("starting");
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

          let session: HerdrAgentSession | undefined;
          try {
            await startReviewAgent(pi, ctx, preparedInput, cwd, label, agentName, paneId);
            preparedInput.onProgress?.("submitting");
            const promptedSession = await promptReviewAgent(
              pi,
              ctx,
              preparedInput,
              cwd,
              label,
              agentName,
            );
            session =
              preparedInput.requireAgentSession === false
                ? undefined
                : hasAgentSessionReference(promptedSession)
                  ? promptedSession
                  : await waitForReviewAgentSession(pi, ctx, cwd, label, agentName);
            preparedInput.onProgress?.("working", {
              sessionPath: session?.kind === "path" ? session.value?.trim() : undefined,
            });
          } catch (error) {
            await runHerdr(pi, ctx, ["tab", "close", createdTabId], cwd).catch(() => undefined);
            throw error;
          }
          return { tabId: createdTabId, session, agentName };
        });
        break;
      } catch (error) {
        if (!(error instanceof ReviewAgentStartupError)) throw error;
        lastStartupError = error;
        if (attempt === maxFreshTabAttempts) {
          notifyReviewAgentStartupFailure(ctx, error);
          throw error;
        }
        await wait(reviewAgentFreshTabRetryDelay(attempt), undefined, { signal: ctx.signal });
      }
    }

    if (!launched) throw lastStartupError ?? new Error(`PR review lane "${label}" did not start.`);
    const { tabId, session: launchedSession, agentName } = launched;
    let completedSession: HerdrAgentSession | undefined;
    try {
      completedSession = await waitForReviewAgentCompletion(
        pi,
        ctx,
        preparedInput,
        cwd,
        label,
        agentName,
        launchedSession,
      );
    } catch (error) {
      await runHerdr(pi, ctx, ["tab", "close", tabId], cwd).catch(() => undefined);
      throw error;
    }
    preparedInput.onProgress?.("finalizing");
    const current = await runHerdr<HerdrAgentResult>(pi, ctx, ["agent", "get", agentName], cwd);
    const agent = {
      ...(current.agent ?? {}),
      agent_session:
        current.agent?.agent_session ?? completedSession ?? launchedSession,
    };
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
  } finally {
    await prepared.cleanup();
  }
};
