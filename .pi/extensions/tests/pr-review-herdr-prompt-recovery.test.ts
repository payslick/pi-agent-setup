import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPiAgentInHerdr } from "../pr-review/herdr-agent";

const environmentKeys = [
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS",
  "PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS",
  "PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS",
  "PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS",
  "PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "workspace-1";
  process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS = "2";
  process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS = "0";
  process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS = "1";
  process.env.PI_REVIEW_AGENT_SESSION_MAX_ATTEMPTS = "1";
  process.env.PI_REVIEW_AGENT_SESSION_RETRY_DELAY_MS = "0";
});

afterEach(() => {
  for (const key of environmentKeys) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("PR review Herdr prompt recovery", () => {
  test("accepts a fast idle session completed before prompt-stall recovery polls it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-prompt-recovery-"));
    const sessionPath = join(directory, "repair-agent.jsonl");
    const prompt = "Normalize the review response into JSON.";
    const finalOutput = '{"findings":[]}';
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: finalOutput }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const calls: string[][] = [];
    let getCalls = 0;
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
                  ...(getCalls === 1
                    ? { agent_session: { kind: "path", value: sessionPath } }
                    : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: finalOutput, stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    try {
      const result = await runPiAgentInHerdr(
        pi as never,
        { cwd: directory, signal: undefined } as never,
        {
          label: "PR-correctness-repair",
          prompt,
          piArgs: ["--no-tools", "--no-extensions"],
        },
      );

      expect(result).toMatchObject({ code: 0, stdout: finalOutput, stderr: "" });
      const promptCalls = calls.filter(
        (args) => args[0] === "agent" && args[1] === "prompt",
      );
      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0]?.filter((argument) => argument === prompt)).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "agent" && args[1] === "send-keys")).toEqual(
        [],
      );
      expect(calls.filter((args) => args.includes(prompt))).toHaveLength(1);
      expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not finalize on transient idle before the assistant response is persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-transient-idle-"));
    const sessionPath = join(directory, "lane-agent.jsonl");
    const prompt = "Review the PR.";
    const userEntry = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    });
    const finalOutput = '{"findings":[]}';
    const assistantEntry = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: finalOutput }],
      },
    });
    await writeFile(sessionPath, `${userEntry}\n`, "utf8");

    let completionWaits = 0;
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
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "working",
                  agent_session: { kind: "path", value: sessionPath },
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "wait") {
          completionWaits += 1;
          if (completionWaits === 2) {
            await writeFile(sessionPath, `${userEntry}\n${assistantEntry}\n`, "utf8");
          }
          return {
            code: 0,
            stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }),
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
          return { code: 0, stdout: "terminal chrome, not JSON", stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    try {
      const result = await runPiAgentInHerdr(
        pi as never,
        { cwd: directory, signal: undefined } as never,
        { label: "PR-docs", prompt, piArgs: ["--no-tools"] },
      );

      expect(completionWaits).toBe(2);
      expect(result).toMatchObject({ code: 0, stdout: finalOutput, stderr: "" });
      expect(calls.some((args) => args[0] === "agent" && args[1] === "read")).toBeFalse();
      expect(calls.at(-1)).toEqual(["tab", "close", "tab-1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
