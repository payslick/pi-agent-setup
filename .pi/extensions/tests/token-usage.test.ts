import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import tokenUsage, { shouldDisplayUsage } from "../token-usage";
import { formatUsageReport } from "../token-usage/format";
import { sessionIdFromFileName } from "../token-usage/session-id";
import {
  openTokenUsageStore,
  tokenUsageDatabasePath,
  type TokenUsageGroup,
  type TokenUsageRecord,
} from "../token-usage/sqlite";

const temporaryDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "token-usage-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

function record(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    sessionId: "session-1",
    occurredAt: 1_700_000_000_000,
    provider: "anthropic",
    model: "claude-sonnet",
    messageIdentity: "response-1",
    subagentId: null,
    subagentName: null,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    ...overrides,
  };
}

function group(overrides: Partial<TokenUsageGroup> = {}): TokenUsageGroup {
  return {
    provider: "anthropic",
    model: "claude-sonnet",
    subagentId: null,
    subagentName: null,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    ...overrides,
  };
}

function extensionHarness() {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  tokenUsage({
    on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI);

  return {
    entries,
    trigger(event: string, data: unknown, ctx: ExtensionContext): unknown {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`Missing ${event} handler`);
      return handler(data as never, ctx);
    },
  };
}

describe("token usage SQLite store", () => {
  test("shares the parent database with alternate-cwd Herdr subagents", () => {
    expect(
      tokenUsageDatabasePath("/worktrees/feature", "/repo/.pi/tmp/herdr-subagents/agent-123.jsonl"),
    ).toBe(path.resolve("/repo/.pi/tmp/token-usage.db"));
    expect(tokenUsageDatabasePath("/worktrees/feature", "/unrelated/outbox.jsonl")).toBe(
      path.resolve("/worktrees/feature/.pi/tmp/token-usage.db"),
    );
  });

  test("persists idempotently and aggregates rolling-window boundaries", async () => {
    const cwd = await temporaryDirectory();
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1_000;
    const store = openTokenUsageStore(cwd);

    const current = record({ occurredAt: now, input: 1 });
    store.record(current);
    store.record(current);
    store.record(record({ ...current, messageIdentity: "response-2", input: 2 }));
    store.record(record({ occurredAt: now - day, model: "boundary", output: 2 }));
    store.record(record({ occurredAt: now - 8 * day, model: "monthly", cacheRead: 3 }));
    store.record(record({ occurredAt: now - 31 * day, model: "expired", cacheWrite: 4 }));
    store.record(record({ occurredAt: now + 1, model: "future", input: 99 }));

    expect(store.totalsSince(now - day, now)).toEqual([
      group({ model: "boundary", output: 2 }),
      group({ input: 3, output: 40, cacheRead: 60, cacheWrite: 80 }),
    ]);
    expect(store.totalsSince(now - 7 * day, now)).toHaveLength(2);
    expect(store.totalsSince(now - 30 * day, now).map((item) => item.model)).toEqual([
      "boundary",
      "claude-sonnet",
      "monthly",
    ]);
    store.close();

    const reopened = openTokenUsageStore(cwd);
    expect(reopened.totalsSince(now - day, now)).toHaveLength(2);
    reopened.close();

    const inspector = new Database(tokenUsageDatabasePath(cwd), { readonly: true, strict: true });
    expect(
      inspector.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");
    inspector.close();
  });

  test("groups main and subagent usage independently", async () => {
    const cwd = await temporaryDirectory();
    const store = openTokenUsageStore(cwd);
    const now = 1_700_000_000_000;
    store.record(record({ occurredAt: now }));
    store.record(
      record({
        occurredAt: now + 1,
        messageIdentity: "response-2",
        subagentId: "agent-123456789",
        subagentName: "reviewer",
        input: 5,
      }),
    );

    expect(store.totalsSince(now, now + 1)).toEqual([
      group(),
      group({
        subagentId: "agent-123456789",
        subagentName: "reviewer",
        input: 5,
      }),
    ]);
    store.close();
  });
});

describe("token usage report", () => {
  test("groups compact day, week, and month usage by model and agent type", () => {
    const report = formatUsageReport([
      {
        label: "Last 24 hours",
        groups: [
          group({ input: 1_000, output: 2_000 }),
          group({
            subagentId: "tests-first",
            subagentName: "unit-test-implementer",
            input: 200,
            output: 300,
          }),
          group({
            subagentId: "tests-second",
            subagentName: "ut-another-task-ab12",
            input: 300,
            output: 400,
          }),
        ],
      },
      {
        label: "Last 7 days",
        groups: [
          group({ input: 76_000, output: 12_000 }),
          group({
            subagentId: "tests-first",
            subagentName: "unit-test-implementer",
            input: 4_000,
            output: 1_000,
          }),
        ],
      },
      {
        label: "Last 30 days",
        groups: [
          group({ input: 898_000, output: 120_000 }),
          group({
            subagentId: "tests-first",
            subagentName: "unit-test-implementer",
            input: 10_000,
            output: 3_000,
          }),
          group({
            provider: "openai",
            model: "gpt-5",
            subagentId: "reviewer-id",
            subagentName: "test-reviewer",
            input: 1_250_000,
            output: 5_000,
          }),
        ],
      },
    ]);

    expect(report).toContain("Token usage (1d / 7d / 30d)");
    expect(report).toContain("Agent type │ Input");
    expect(report).toContain("Main       │ 1k / 76k / 898k");
    expect(report).toContain("Unit tests │ 500 / 4k / 10k");
    expect(report).toContain("Total      │ 1.5k / 80k / 908k");
    expect(report).toContain("Test reviewer │ 0 / 0 / 1.3M");
    expect(report.match(/Unit tests/g)).toHaveLength(1);
    expect(report).not.toContain("tests-first");
    expect(report).not.toContain("another-task");
    expect(report).not.toContain("Cache");
  });

  test("shows a compact empty state when no usage was recorded", () => {
    expect(
      formatUsageReport([
        { label: "Last 24 hours", groups: [] },
        { label: "Last 7 days", groups: [] },
        { label: "Last 30 days", groups: [] },
      ]),
    ).toBe("Token usage · No usage recorded");
  });

  test("only startup and new sessions request a report", () => {
    expect(shouldDisplayUsage("startup")).toBe(true);
    expect(shouldDisplayUsage("new")).toBe(true);
    expect(shouldDisplayUsage("reload")).toBe(false);
    expect(shouldDisplayUsage("resume")).toBe(false);
    expect(shouldDisplayUsage("fork")).toBe(false);
  });
});

describe("token usage extension lifecycle", () => {
  test("extracts the previous id from a generated session filename", () => {
    expect(
      sessionIdFromFileName(
        "/sessions/2026-09-03T10-15-17-474Z_01a066c4-04e2-721a-8972-907ccac8d354.jsonl",
      ),
    ).toBe("01a066c4-04e2-721a-8972-907ccac8d354");
  });

  test("shows a compact plain-text report for a new session", async () => {
    const cwd = await temporaryDirectory();
    const store = openTokenUsageStore(cwd);
    store.record(record({ occurredAt: Date.now() }));
    store.close();
    const notifications: string[] = [];
    const ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: { getSessionId: () => "session-new" },
    } as unknown as ExtensionContext;
    const harness = extensionHarness();

    const event = {
      type: "session_start",
      reason: "new",
      previousSessionFile: path.join(
        cwd,
        "2026-09-03T10-15-17-474Z_previous-session-id.jsonl",
      ),
    };
    await harness.trigger("session_start", event, ctx);
    await harness.trigger("session_start", event, ctx);
    harness.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("Token usage (1d / 7d / 30d)");
    expect(notifications[0]).toContain("Agent type │ Input");
    expect(notifications[0]).toContain("Main       │ 10 / 10 / 10 │ 20 / 20 / 20");
    expect(notifications[0]).not.toContain("|");
    expect(harness.entries).toEqual([
      {
        customType: "previous-session-id",
        data: { sessionId: "previous-session-id" },
      },
    ]);
  });

  test("records only assistant messages, captures subagent identity, and closes on shutdown", async () => {
    const cwd = await temporaryDirectory();
    const notifications: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: { getSessionId: () => "session-lifecycle" },
    } as unknown as ExtensionContext;
    const harness = extensionHarness();
    const previousId = process.env.PI_SUBAGENT_ID;
    const previousName = process.env.PI_SUBAGENT_NAME;
    const previousType = process.env.PI_SUBAGENT_TYPE;
    process.env.PI_SUBAGENT_ID = "child-123456789";
    process.env.PI_SUBAGENT_NAME = "worker-1234";
    process.env.PI_SUBAGENT_TYPE = "unit-test-implementer";

    try {
      harness.trigger("session_start", { type: "session_start", reason: "startup" }, ctx);
      expect(notifications).toHaveLength(1);
      harness.trigger(
        "message_end",
        { type: "message_end", message: { role: "user", timestamp: Date.now() } },
        ctx,
      );
      harness.trigger(
        "message_end",
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5-alias",
            responseModel: "gpt-5",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 },
          },
        },
        ctx,
      );
      harness.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      harness.trigger(
        "message_end",
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "openai",
            model: "ignored-after-close",
            content: [{ type: "text", text: "Ignored" }],
            stopReason: "stop",
            timestamp: Date.now() + 1,
            usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          },
        },
        ctx,
      );

      const store = openTokenUsageStore(cwd);
      expect(store.totalsSince(0, Date.now() + 2)).toEqual([
        group({
          provider: "openai",
          model: "gpt-5",
          subagentId: "child-123456789",
          subagentName: "unit-test-implementer",
          input: 7,
          output: 8,
          cacheRead: 9,
          cacheWrite: 10,
        }),
      ]);
      store.close();
    } finally {
      if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = previousId;
      if (previousName === undefined) delete process.env.PI_SUBAGENT_NAME;
      else process.env.PI_SUBAGENT_NAME = previousName;
      if (previousType === undefined) delete process.env.PI_SUBAGENT_TYPE;
      else process.env.PI_SUBAGENT_TYPE = previousType;
    }
  });

  test("does not display totals for reload, resume, or fork", async () => {
    const cwd = await temporaryDirectory();
    const notifications: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: { getSessionId: () => "session-1" },
    } as unknown as ExtensionContext;
    const harness = extensionHarness();

    for (const reason of ["reload", "resume", "fork"]) {
      harness.trigger("session_start", { type: "session_start", reason }, ctx);
    }
    harness.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(notifications).toEqual([]);
  });
});
