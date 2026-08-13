import * as piAi from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-connection-retry";
export const INITIAL_RETRY_DELAYS_MS = [0, 1_000, 5_000, 10_000, 20_000] as const;
export const FAULT_RETRY_DELAY_MS = 60_000;
const CONNECTION_FAILURE_RE =
  /timed? ?out|timeout|fetch failed|network|socket|connection|econn|overloaded|service.?unavailable|upstream/i;

type CodexStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type Wait = (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;

const streamCodex = (piAi as typeof piAi & { streamSimpleOpenAICodexResponses: CodexStream })
  .streamSimpleOpenAICodexResponses;

export interface CodexRetryEvent {
  delayMs: number;
  errorMessage: string;
  failureCount: number;
  faulted: boolean;
  status?: number;
}

interface CodexRetryHooks {
  onFault?: (event: CodexRetryEvent) => void;
  onRecovered?: () => void;
  onRetry?: (event: CodexRetryEvent) => void;
}

const wait: Wait = (delayMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export const connectionRetryDelayMs = (failureCount: number): number =>
  INITIAL_RETRY_DELAYS_MS[failureCount - 1] ?? FAULT_RETRY_DELAY_MS;

export const isConnectionFailure = (errorMessage: string, status: number | undefined): boolean =>
  Boolean((status !== undefined && status >= 400) || CONNECTION_FAILURE_RE.test(errorMessage));

const errorEvent = (
  model: Model<Api>,
  error: unknown,
): Extract<AssistantMessageEvent, { type: "error" }> => ({
  type: "error",
  reason: "error",
  error: {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  },
});

const abortedEvent = (event: Extract<AssistantMessageEvent, { type: "error" }>) => ({
  type: "error" as const,
  reason: "aborted" as const,
  error: {
    ...event.error,
    stopReason: "aborted" as const,
    errorMessage: "Request was aborted",
  },
});

const forwardTerminalEvent = (
  target: AssistantMessageEventStream,
  event: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
): void => {
  target.push(event);
  target.end();
};

const consumeAttempt = async (
  source: AssistantMessageEventStream,
  target: AssistantMessageEventStream,
): Promise<Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined> => {
  let emittedResponse = false;
  for await (const event of source) {
    if (event.type === "error") {
      if (!emittedResponse) return event;
      forwardTerminalEvent(target, event);
      return undefined;
    }
    if (event.type === "done") return event;
    emittedResponse = true;
    target.push(event);
  }
  return undefined;
};

export const createRetryingCodexStream =
  (request: CodexStream, hooks: CodexRetryHooks = {}, sleep: Wait = wait): CodexStream =>
  (model, context, options) => {
    const output = createAssistantMessageEventStream();

    void (async () => {
      let failureCount = 0;
      let faulted = false;

      while (true) {
        let status: number | undefined;
        let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
        try {
          const source = request(model, context, {
            ...options,
            maxRetries: 0,
            onResponse: async (response, responseModel) => {
              status = response.status;
              await options?.onResponse?.(response, responseModel);
            },
          });
          terminal = await consumeAttempt(source, output);
        } catch (error) {
          terminal = errorEvent(model, error);
        }

        if (!terminal) {
          output.end();
          return;
        }
        if (terminal.type === "done") {
          if (failureCount > 0) hooks.onRecovered?.();
          forwardTerminalEvent(output, terminal);
          return;
        }

        const errorMessage = terminal.error.errorMessage ?? "Unknown Codex connection error";
        if (terminal.reason === "aborted" || !isConnectionFailure(errorMessage, status)) {
          forwardTerminalEvent(output, terminal);
          return;
        }

        failureCount += 1;
        const event: CodexRetryEvent = {
          delayMs: connectionRetryDelayMs(failureCount),
          errorMessage,
          failureCount,
          faulted: failureCount > INITIAL_RETRY_DELAYS_MS.length,
          ...(status === undefined ? {} : { status }),
        };
        hooks.onRetry?.(event);
        if (event.faulted && !faulted) {
          faulted = true;
          hooks.onFault?.(event);
        }

        try {
          await sleep(event.delayMs, options?.signal);
        } catch {
          forwardTerminalEvent(output, abortedEvent(terminal));
          return;
        }
      }
    })();

    return output;
  };

const statusText = (event: CodexRetryEvent): string =>
  event.faulted
    ? `⚠ Codex connection fault; retrying in ${event.delayMs / 1_000}s`
    : `Codex connection failed; retry ${event.failureCount}/${INITIAL_RETRY_DELAYS_MS.length} in ${event.delayMs / 1_000}s`;

const errorDetail = (event: CodexRetryEvent): string =>
  `${event.status ? `HTTP ${event.status}: ` : ""}${event.errorMessage}`.slice(0, 500);

const setStatus = (ctx: ExtensionContext | undefined, text: string | undefined): void => {
  if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
};

const alertFault = (
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  event: CodexRetryEvent,
): void => {
  const detail = errorDetail(event);
  if (ctx?.hasUI) ctx.ui.notify(`Codex connection fault: ${detail}`, "error");
  if (process.env.HERDR_ENV !== "1") return;
  void pi
    .exec(
      "herdr",
      [
        "notification",
        "show",
        "Codex connection fault",
        "--body",
        `${detail}. Retrying every minute.`,
        "--sound",
        "request",
      ],
      { timeout: 5_000 },
    )
    .catch(() => undefined);
};

export default function codexConnectionRetry(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;

  const retryingStream = createRetryingCodexStream(streamCodex as CodexStream, {
    onRetry: (event) => setStatus(context, statusText(event)),
    onFault: (event) => alertFault(pi, context, event),
    onRecovered: () => setStatus(context, undefined),
  });

  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: retryingStream,
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    setStatus(ctx, undefined);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    context = ctx;
  });

  pi.on("session_shutdown", () => {
    setStatus(context, undefined);
    context = undefined;
  });
}
