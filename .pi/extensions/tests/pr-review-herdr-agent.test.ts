import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalAssistantTextFromSession,
  runPiAgentInHerdr,
  silentReviewTabArgs,
} from "../pr-review/herdr-agent";
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewAgentRuntime = await import("../pr-review/runtime/review-agents.js");
const { buildReviewAgentArguments, selectedReviewAgentDefaults } = reviewAgentRuntime;

const originalHerdrEnv = process.env.HERDR_ENV;
const originalWorkspaceId = process.env.HERDR_WORKSPACE_ID;
const originalStartMaxAttempts = process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS;
const originalStartRetryDelay = process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS;
const originalPromptMaxAttempts = process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS;
const originalPromptRetryDelay = process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS;
const originalPromptEffectTimeout = process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS;
const originalFreshTabMaxAttempts = process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS;
const originalFreshTabRetryDelay = process.env.PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS;
const originalSessionMaxAttempts = process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS;
const originalSessionRetryDelay = process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS;
const readySessionPath = fileURLToPath(
  new URL("./fixtures/pr-review-ready-session.jsonl", import.meta.url),
);

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "workspace-1";
});

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  if (originalWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = originalWorkspaceId;
  if (originalStartMaxAttempts === undefined) delete process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS;
  else process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS = originalStartMaxAttempts;
  if (originalStartRetryDelay === undefined)
    delete process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS;
  else process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS = originalStartRetryDelay;
  if (originalPromptMaxAttempts === undefined)
    delete process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS;
  else process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS = originalPromptMaxAttempts;
  if (originalPromptRetryDelay === undefined)
    delete process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS;
  else process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS = originalPromptRetryDelay;
  if (originalPromptEffectTimeout === undefined)
    delete process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS;
  else process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS = originalPromptEffectTimeout;
  if (originalFreshTabMaxAttempts === undefined)
    delete process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS;
  else process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS = originalFreshTabMaxAttempts;
  if (originalFreshTabRetryDelay === undefined)
    delete process.env.PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS;
  else process.env.PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS = originalFreshTabRetryDelay;
  if (originalSessionMaxAttempts === undefined)
    delete process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS;
  else process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS = originalSessionMaxAttempts;
  if (originalSessionRetryDelay === undefined)
    delete process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS;
  else process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS = originalSessionRetryDelay;
});

describe("PR review Herdr agents", () => {
  test("inherits the spawning agent model and thinking level", () => {
    const defaults = selectedReviewAgentDefaults(
      { getThinkingLevel: () => "max" },
      { model: { provider: "anthropic", id: "claude-opus-4-6" } },
    );
    const args = buildReviewAgentArguments(
      { cwd: "/repo" },
      {
        laneId: "correctness",
        ...defaults,
        toolsEnabled: false,
        allowedTools: "",
        systemPrompt: "Review the PR.\nReturn JSON only.",
      },
    );

    expect(defaults).toEqual({ model: "anthropic/claude-opus-4-6", thinking: "max" });
    expect(args).toContain("anthropic/claude-opus-4-6");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("Review the PR.\nReturn JSON only.");
    expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual([
      "--thinking",
      "max",
    ]);
  });

  test("creates an unfocused silent tab", () => {
    const args = silentReviewTabArgs(
      "workspace-1",
      "/repo",
      "PR-correctness",
      "subagent-1",
      "pr-correctness-1",
    );

    expect(args).toContain("tab");
    expect(args).toContain("create");
    expect(args).toContain("--no-focus");
    expect(args).toContain("PI_SUBAGENT_ID=subagent-1");
    expect(args).toContain("PI_DISABLE_SOUNDS=1");
    expect(args).toContain("PI_ACCESS_PROJECT_ROOT=/repo");
    expect(args).toContain("HERDR_ENV=0");
  });

  test("reads only the final assistant response from a Pi session", () => {
    const session = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "prompt with JSON" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] },
      }),
    ].join("\n");

    expect(finalAssistantTextFromSession(session)).toBe('{"findings":[]}');
  });

  test("starts, prompts, reads, and closes a review agent tab", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-herdr-"));
    const sessionPath = join(directory, "agent.jsonl");
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: '{"findings":[]}' }],
        },
      })}\n`,
    );
    const calls: string[][] = [];
    const systemPrompt = `Review the PR.\n${"Return JSON only. ".repeat(500)}`;
    const appendSystemPrompt = "Keep the output deterministic.\nDo not add prose.";
    const existingPromptPath = join(directory, "existing-system-prompt.md");
    const existingPrompt = "This prompt was already file-backed.";
    await writeFile(existingPromptPath, existingPrompt);
    let startupPromptPaths: string[] = [];
    let loadedSystemPrompts: string[] = [];
    const pi = {
      exec: async (command: string, args: string[]) => {
        expect(command).toBe("herdr");
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start") {
          startupPromptPaths = args.filter((_argument, index) =>
            ["--system-prompt", "--append-system-prompt"].includes(args[index - 1] ?? ""),
          );
          loadedSystemPrompts = await Promise.all(
            startupPromptPaths.map((promptPath) => readFile(promptPath, "utf8")),
          );
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  agent_session: { kind: "path", value: sessionPath },
                },
              },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    try {
      const progressEvents: Array<{ phase: string; sessionPath?: string }> = [];
      const result = await runPiAgentInHerdr(
        pi as never,
        { cwd: directory, signal: undefined } as never,
        {
          label: "PR-correctness",
          prompt: "Review the PR",
          piArgs: [
            "--model",
            "openai-codex/gpt-5.6-sol",
            "--no-tools",
            "--system-prompt",
            systemPrompt,
            "--append-system-prompt",
            appendSystemPrompt,
            "--append-system-prompt",
            existingPromptPath,
          ],
          onProgress: (phase, details) => progressEvents.push({ phase, ...details }),
        },
      );

      expect(result.code).toBe(0);
      expect(progressEvents.map(({ phase }) => phase)).toEqual([
        "queued",
        "starting",
        "submitting",
        "working",
        "finalizing",
      ]);
      expect(progressEvents.find(({ phase }) => phase === "working")?.sessionPath).toBe(
        sessionPath,
      );
      expect(result.stdout).toBe('{"findings":[]}');
      const createCall = calls.find((args) => args[0] === "tab" && args[1] === "create");
      const startCall = calls.find((args) => args[0] === "agent" && args[1] === "start");
      const promptCall = calls.find((args) => args[0] === "agent" && args[1] === "prompt");
      expect(createCall).toContain("--no-focus");
      expect(createCall?.some((argument) => argument.startsWith("PI_SUBAGENT_ID="))).toBeTrue();
      expect(startCall).toContain("pane-1");
      expect(startCall).not.toContain("--print");
      expect(startCall?.every((argument) => !/[\r\n]/.test(argument))).toBeTrue();
      const systemPromptPath = startCall?.[startCall.indexOf("--system-prompt") + 1];
      expect(systemPromptPath).toContain(".pi/tmp/pr-review-agents/");
      expect(systemPromptPath?.length).toBeLessThan(systemPrompt.length);
      expect(startupPromptPaths).toHaveLength(3);
      expect(startupPromptPaths[1]).toContain(".pi/tmp/pr-review-agents/");
      expect(startupPromptPaths[2]).toBe(existingPromptPath);
      expect(loadedSystemPrompts).toEqual([systemPrompt, appendSystemPrompt, existingPrompt]);
      expect(startCall).not.toContain(systemPrompt);
      expect(await Bun.file(startupPromptPaths[0] ?? "").exists()).toBeFalse();
      expect(await Bun.file(startupPromptPaths[1] ?? "").exists()).toBeFalse();
      expect(await Bun.file(existingPromptPath).exists()).toBeTrue();
      expect(promptCall).toContain("Review the PR");
      expect(promptCall).toContain("working");
      expect(promptCall).toContain("idle");
      expect(promptCall).toContain("done");
      expect(promptCall).toContain("blocked");
      expect(calls.some((args) => args[0] === "agent" && args[1] === "wait")).toBeTrue();
      expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
      expect(calls.some((args) => args[0] === "notification")).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("waits for review-agent completion without a finite prompt timeout", async () => {
    const calls: Array<{ args: string[]; options?: { timeout?: number } }> = [];
    let getCalls = 0;
    const pi = {
      exec: async (_command: string, args: string[], options?: { timeout?: number }) => {
        calls.push({ args, options });
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          getCalls += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(getCalls === 1
                    ? { agent_session: { kind: "path", value: readySessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    const result = await runPiAgentInHerdr(
      pi as never,
      { cwd: "/repo", signal: undefined } as never,
      {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      },
    );

    expect(result.code).toBe(0);
    const promptCall = calls.find(({ args }) => args[0] === "agent" && args[1] === "prompt");
    const waitCall = calls.find(({ args }) => args[0] === "agent" && args[1] === "wait");
    expect(promptCall).toBeDefined();
    expect(promptCall?.args).toContain("working");
    expect(promptCall?.args).not.toContain("--timeout");
    expect(promptCall?.options?.timeout).toBeUndefined();
    expect(waitCall).toBeDefined();
    expect(waitCall?.args).not.toContain("--timeout");
    expect(waitCall?.options?.timeout).toBeUndefined();
  });

  test.each([
    { code: 0, stdout: "", stderr: "" },
    {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
    },
  ])("closes a lane tab when bounded completion times out", async (waitResult) => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { agent: { agent_session: { kind: "path", value: readySessionPath } } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "wait") return waitResult;
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    await expect(
      runPiAgentInHerdr(pi as never, { cwd: "/repo", signal: undefined } as never, {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
        timeout: 50,
      }),
    ).rejects.toThrow(
      'PR review lane "PR-correctness" did not complete within 50 ms. Its tab was closed',
    );
    expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
  });

  test("accepts a reported session path before Pi persists it and waits for completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-deferred-session-"));
    const sessionPath = join(directory, "deferred.jsonl");
    const calls: string[][] = [];
    let markCompletionWaitStarted!: () => void;
    let releaseCompletionWait!: () => void;
    const completionWaitStarted = new Promise<void>((resolve) => (markCompletionWaitStarted = resolve));
    const completionWait = new Promise<void>((resolve) => (releaseCompletionWait = resolve));
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "wait") {
          markCompletionWaitStarted();
          await completionWait;
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  agent_session: { kind: "path", value: sessionPath },
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    try {
      const resultPromise = runPiAgentInHerdr(
        pi as never,
        { cwd: "/repo", signal: undefined } as never,
        {
          label: "PR-correctness",
          prompt: "Review the PR",
          piArgs: ["--no-tools"],
        },
      );

      await completionWaitStarted;
      expect(await Bun.file(sessionPath).exists()).toBeFalse();
      expect(calls.some((args) => args[0] === "agent" && args[1] === "read")).toBeFalse();

      await writeFile(
        sessionPath,
        [
          JSON.stringify({ type: "message", message: { role: "assistant", content: "draft" } }),
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: '{"findings":[]}' },
          }),
        ].join("\n"),
        "utf8",
      );
      releaseCompletionWait();
      const result = await resultPromise;

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('{"findings":[]}');
      expect(calls.some((args) => args[0] === "agent" && args[1] === "read")).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries when a new review pane is not ready yet", async () => {
    process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS = "3";
    process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS = "0";
    let startAttempts = 0;
    let getCalls = 0;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start") {
          startAttempts += 1;
          if (startAttempts === 1) {
            return {
              code: 1,
              stdout: "",
              stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }),
            };
          }
        }
        if (args[0] === "agent" && args[1] === "get") {
          getCalls += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(getCalls === 1
                    ? { agent_session: { kind: "path", value: readySessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    const result = await runPiAgentInHerdr(
      pi as never,
      { cwd: "/repo", signal: undefined } as never,
      {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      },
    );

    expect(result.code).toBe(0);
    expect(startAttempts).toBe(2);
  });

  test("resubmits a staged prompt with Enter instead of duplicating its text", async () => {
    process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS = "2";
    process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS = "0";
    process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS = "1";
    let getCalls = 0;
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "prompt") {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_prompt_stalled" } }),
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          getCalls += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(getCalls === 2
                    ? { agent_session: { kind: "path", value: readySessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    const result = await runPiAgentInHerdr(
      pi as never,
      { cwd: "/repo", signal: undefined } as never,
      {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      },
    );

    expect(result.code).toBe(0);
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "prompt")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "send-keys")).toEqual([
      ["agent", "send-keys", expect.any(String), "enter"],
    ]);
    const getCallIndices = calls.flatMap((args, index) =>
      args[0] === "agent" && args[1] === "get" ? [index] : [],
    );
    const enterCallIndex = calls.findIndex(
      (args) => args[0] === "agent" && args[1] === "send-keys",
    );
    expect(getCallIndices).toHaveLength(3);
    expect(enterCallIndex).toBeGreaterThan(getCallIndices[0] ?? -1);
    expect(enterCallIndex).toBeLessThan(getCallIndices[1] ?? Number.POSITIVE_INFINITY);
  });

  test("accepts an ID-backed agent session and reads output from the terminal fallback", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  agent_session: { kind: "id", value: "agent-session-1" },
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    const result = await runPiAgentInHerdr(
      pi as never,
      { cwd: "/repo", signal: undefined } as never,
      {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"findings":[]}');
    expect(calls.some((args) => args[0] === "agent" && args[1] === "read")).toBeTrue();
  });

  test("can use terminal output when an agent intentionally disables session reporting", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    const result = await runPiAgentInHerdr(
      pi as never,
      { cwd: "/repo", signal: undefined } as never,
      {
        label: "PR-process-analysis",
        prompt: "Analyze comments",
        piArgs: ["--no-tools", "--no-extensions"],
        requireAgentSession: false,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"findings":[]}');
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "get")).toHaveLength(1);
  });

  test("serializes pane creation and agent startup", async () => {
    let tabCount = 0;
    let activeStarts = 0;
    let maximumActiveStarts = 0;
    const getCallsByAgent = new Map<string, number>();
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[0] === "tab" && args[1] === "create") {
          tabCount += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                tab: { tab_id: `tab-${tabCount}` },
                root_pane: { pane_id: `pane-${tabCount}` },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start") {
          activeStarts += 1;
          maximumActiveStarts = Math.max(maximumActiveStarts, activeStarts);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeStarts -= 1;
        }
        if (args[0] === "agent" && args[1] === "get") {
          const agentName = args[2] ?? "";
          const getCalls = (getCallsByAgent.get(agentName) ?? 0) + 1;
          getCallsByAgent.set(agentName, getCalls);
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(getCalls === 1
                    ? { agent_session: { kind: "path", value: readySessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const runAgent = (label: string) =>
      runPiAgentInHerdr(pi as never, { cwd: "/repo", signal: undefined } as never, {
        label,
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      });

    await Promise.all([runAgent("PR-correctness"), runAgent("PR-tests")]);

    expect(maximumActiveStarts).toBe(1);
  });

  test("prompts before requiring a Pi session reference and closes an unresponsive lane", async () => {
    process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS = "1";
    process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS = "2";
    process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS = "0";
    const notifications: Array<{ message: string; level: string }> = [];
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }),
            stderr: "",
          };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const ctx = {
      cwd: "/repo",
      signal: undefined,
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    };

    await expect(
      runPiAgentInHerdr(pi as never, ctx as never, {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      }),
    ).rejects.toThrow("did not expose a session reference after 2 readiness checks");
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "get")).toHaveLength(2);
    const promptCallIndex = calls.findIndex((args) => args[0] === "agent" && args[1] === "prompt");
    const firstGetCallIndex = calls.findIndex((args) => args[0] === "agent" && args[1] === "get");
    expect(promptCallIndex).toBeGreaterThan(-1);
    expect(promptCallIndex).toBeLessThan(firstGetCallIndex);
    expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("error");
    expect(notifications[0]?.message).toContain("unresponsive tab was closed");
    expect(notifications[0]?.message).toContain("reported as omitted");
  });

  test("releases the startup lock after one concurrent lane lacks a session", async () => {
    process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS = "1";
    process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS = "1";
    process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS = "0";
    let tabCount = 0;
    let failingAgent = "";
    const getCallsByAgent = new Map<string, number>();
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          tabCount += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                tab: { tab_id: `tab-${tabCount}` },
                root_pane: { pane_id: `pane-${tabCount}` },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start" && !failingAgent) {
          failingAgent = args[2] ?? "";
        }
        if (args[0] === "agent" && args[1] === "get") {
          const agentName = args[2] ?? "";
          const getCalls = (getCallsByAgent.get(agentName) ?? 0) + 1;
          getCallsByAgent.set(agentName, getCalls);
          const hasSession = agentName !== failingAgent && getCalls === 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(hasSession
                    ? { agent_session: { kind: "path", value: readySessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const runAgent = (label: string) =>
      runPiAgentInHerdr(pi as never, { cwd: "/repo", signal: undefined } as never, {
        label,
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      });

    const results = await Promise.allSettled([runAgent("PR-correctness"), runAgent("PR-tests")]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(2);
    expect(calls).toContainEqual(["tab", "close", "tab-1"]);
    expect(calls).toContainEqual(["tab", "close", "tab-2"]);
  });

  test("notifies when a review pane stays busy after every retry", async () => {
    process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS = "1";
    process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS = "2";
    process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS = "0";
    const notifications: Array<{ message: string; level: string }> = [];
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start") {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }),
          };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const ctx = {
      cwd: "/repo",
      signal: undefined,
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    };

    await expect(
      runPiAgentInHerdr(pi as never, ctx as never, {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      }),
    ).rejects.toThrow("could not start after 2 attempts");
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "start")).toHaveLength(2);
    expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("error");
    expect(notifications[0]?.message).toContain("not an available shell");
    expect(notifications[0]?.message).toContain("reported as omitted");
  });

  test("closes a blank review tab when agent startup fails", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "start") {
          return { code: 1, stdout: "", stderr: "invalid agent arguments" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    await expect(
      runPiAgentInHerdr(pi as never, { cwd: "/repo", signal: undefined } as never, {
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
      }),
    ).rejects.toThrow("invalid agent arguments");
    expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
  });

  test("routes review and post-review model calls through Herdr", async () => {
    const reviewAgents = await readFile(
      new URL("../pr-review/runtime/review-agents.js", import.meta.url),
      "utf8",
    );
    const processAgents = await readFile(
      new URL("../pr-review/process-agents.ts", import.meta.url),
      "utf8",
    );

    expect(reviewAgents).toContain("runPiAgentInHerdr");
    expect(processAgents).toContain("runPiAgentInHerdr");
    expect(reviewAgents).not.toContain("PI_REVIEW_PI_BIN");
    expect(processAgents).not.toContain("PI_REVIEW_PI_BIN");
    expect(reviewAgents).not.toContain('"--print"');
    expect(processAgents).not.toContain('"--print"');
    expect(processAgents).toContain("requireAgentSession: false");
  });

  test("requires a Herdr workspace instead of falling back to hidden subprocesses", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;

    await expect(
      runPiAgentInHerdr(
        { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as never,
        { cwd: "/repo", signal: undefined } as never,
        { label: "PR-tests", prompt: "Review", piArgs: [] },
      ),
    ).rejects.toThrow("require Pi to run inside a Herdr workspace");
  });
});
