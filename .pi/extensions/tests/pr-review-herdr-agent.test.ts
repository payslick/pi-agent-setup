import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  finalAssistantTextFromSession,
  runPiAgentInHerdr,
  silentReviewTabArgs,
} from "../pr-review/herdr-agent";

const originalHerdrEnv = process.env.HERDR_ENV;
const originalWorkspaceId = process.env.HERDR_WORKSPACE_ID;
const originalStartMaxAttempts = process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS;
const originalStartRetryDelay = process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS;

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
});

describe("PR review Herdr agents", () => {
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
      const result = await runPiAgentInHerdr(
        pi as never,
        { cwd: "/repo", signal: undefined } as never,
        {
          label: "PR-correctness",
          prompt: "Review the PR",
          piArgs: [
            "--model",
            "openai-codex/gpt-5.6-sol",
            "--no-tools",
            "--system-prompt",
            "Review the PR.\nReturn JSON only.",
          ],
          timeout: 1_000,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('{"findings":[]}');
      const createCall = calls.find((args) => args[0] === "tab" && args[1] === "create");
      const startCall = calls.find((args) => args[0] === "agent" && args[1] === "start");
      const promptCall = calls.find((args) => args[0] === "agent" && args[1] === "prompt");
      expect(createCall).toContain("--no-focus");
      expect(createCall?.some((argument) => argument.startsWith("PI_SUBAGENT_ID="))).toBeTrue();
      expect(startCall).toContain("pane-1");
      expect(startCall).not.toContain("--print");
      expect(startCall?.every((argument) => !/[\r\n]/.test(argument))).toBeTrue();
      expect(startCall).toContain("Review the PR. Return JSON only.");
      expect(promptCall).toContain("Review the PR");
      expect(promptCall).toContain("idle");
      expect(promptCall).toContain("done");
      expect(promptCall).toContain("blocked");
      expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
      expect(calls.some((args) => args[0] === "notification")).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries when a new review pane is not ready yet", async () => {
    process.env.PI_REVIEW_AGENT_START_MAX_ATTEMPTS = "3";
    process.env.PI_REVIEW_AGENT_START_RETRY_DELAY_MS = "0";
    let startAttempts = 0;
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
        label: "PR-correctness",
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
        timeout: 1_000,
      },
    );

    expect(result.code).toBe(0);
    expect(startAttempts).toBe(2);
  });

  test("serializes pane creation and agent startup", async () => {
    let tabCount = 0;
    let activeStarts = 0;
    let maximumActiveStarts = 0;
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
    const runAgent = (label: string) =>
      runPiAgentInHerdr(pi as never, { cwd: "/repo", signal: undefined } as never, {
        label,
        prompt: "Review the PR",
        piArgs: ["--no-tools"],
        timeout: 1_000,
      });

    await Promise.all([runAgent("PR-correctness"), runAgent("PR-tests")]);

    expect(maximumActiveStarts).toBe(1);
  });

  test("notifies when a review pane stays busy after every retry", async () => {
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
        timeout: 1_000,
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
        timeout: 1_000,
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
  });

  test("requires a Herdr workspace instead of falling back to hidden subprocesses", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;

    await expect(
      runPiAgentInHerdr(
        { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as never,
        { cwd: "/repo", signal: undefined } as never,
        { label: "PR-tests", prompt: "Review", piArgs: [], timeout: 1_000 },
      ),
    ).rejects.toThrow("require Pi to run inside a Herdr workspace");
  });
});
