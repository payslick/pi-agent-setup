import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  connectionRetryDelayMs,
  createRetryingCodexStream,
  FAULT_RETRY_DELAY_MS,
  INITIAL_RETRY_DELAYS_MS,
  isConnectionFailure,
  type CodexRetryEvent,
} from "../codex-connection-retry";

const model = {
  id: "gpt-5.6-sol",
  provider: "openai-codex",
} as Model<Api>;
const context: Context = { messages: [] };

const assistantMessage = (
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }),
  timestamp: 1,
});

const eventStream = (event: AssistantMessageEvent): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  stream.push(event);
  stream.end();
  return stream;
};

const collectEvents = async (stream: AssistantMessageEventStream) => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

describe("Codex connection retries", () => {
  test("uses the requested progressive delays before retrying every minute", () => {
    expect(Array.from({ length: 7 }, (_, index) => connectionRetryDelayMs(index + 1))).toEqual([
      ...INITIAL_RETRY_DELAYS_MS,
      FAULT_RETRY_DELAY_MS,
      FAULT_RETRY_DELAY_MS,
    ]);
  });

  test("alerts after five retries and keeps retrying until recovery", async () => {
    const waits: number[] = [];
    const retries: CodexRetryEvent[] = [];
    let faults = 0;
    let recoveries = 0;
    let requests = 0;
    const request = (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      requests += 1;
      if (requests <= 6) {
        void options?.onResponse?.({ status: 503, headers: {} }, model);
        return eventStream({
          type: "error",
          reason: "error",
          error: assistantMessage("error", "Service unavailable"),
        });
      }
      return eventStream({ type: "done", reason: "stop", message: assistantMessage("stop") });
    };
    const retryingStream = createRetryingCodexStream(
      request,
      {
        onRetry: (event) => retries.push(event),
        onFault: () => {
          faults += 1;
        },
        onRecovered: () => {
          recoveries += 1;
        },
      },
      async (delayMs) => {
        waits.push(delayMs);
      },
    );

    const events = await collectEvents(retryingStream(model, context));

    expect(waits).toEqual([...INITIAL_RETRY_DELAYS_MS, FAULT_RETRY_DELAY_MS]);
    expect(retries.map(({ faulted }) => faulted)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(faults).toBe(1);
    expect(recoveries).toBe(1);
    expect(events).toEqual([{ type: "done", reason: "stop", message: assistantMessage("stop") }]);
  });

  test("does not retry non-connection model errors", async () => {
    let waits = 0;
    const retryingStream = createRetryingCodexStream(
      () =>
        eventStream({
          type: "error",
          reason: "error",
          error: assistantMessage("error", "Invalid tool schema"),
        }),
      {},
      async () => {
        waits += 1;
      },
    );

    const events = await collectEvents(retryingStream(model, context));

    expect(waits).toBe(0);
    expect(events[0]?.type).toBe("error");
  });

  test("recognizes response codes and connection timeouts", () => {
    expect(isConnectionFailure("Bad request", 400)).toBe(true);
    expect(
      isConnectionFailure("Codex SSE response headers timed out after 300000ms", undefined),
    ).toBe(true);
    expect(isConnectionFailure("Invalid tool schema", undefined)).toBe(false);
  });
});
