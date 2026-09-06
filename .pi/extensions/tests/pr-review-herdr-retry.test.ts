import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { runPiAgentInHerdr } from "../pr-review/herdr-agent";

const environmentKeys = [
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS",
  "PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS",
  "PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS",
  "PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS",
  "PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
const readySessionPath = fileURLToPath(
  new URL("./fixtures/pr-review-ready-session.jsonl", import.meta.url),
);

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "workspace-1";
  process.env.PI_REVIEW_AGENT_PROMPT_MAX_ATTEMPTS = "2";
  process.env.PI_REVIEW_AGENT_PROMPT_RETRY_DELAY_MS = "0";
  process.env.PI_REVIEW_AGENT_PROMPT_EFFECT_TIMEOUT_MS = "1";
  process.env.PI_REVIEW_AGENT_FRESH_TAB_MAX_ATTEMPTS = "2";
  process.env.PI_REVIEW_AGENT_FRESH_TAB_RETRY_DELAY_MS = "0";
});

afterEach(() => {
  for (const key of environmentKeys) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("PR review Herdr fresh-tab retries", () => {
  test("retries an unresponsive staged prompt in a fresh tab", async () => {
    let tabCount = 0;
    const startedAgents: string[] = [];
    const notifications: Array<{ message: string; level: string }> = [];
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
        if (args[0] === "agent" && args[1] === "start") startedAgents.push(args[2] ?? "");
        const firstAgent = startedAgents[0];
        if (args[0] === "agent" && args[1] === "prompt" && args[2] === firstAgent) {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_prompt_stalled" } }),
          };
        }
        if (args[0] === "agent" && args[1] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  ...(args[2] === firstAgent
                    ? {}
                    : { agent_session: { kind: "path", value: readySessionPath } }),
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "wait" && args[2] === firstAgent) {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "timeout" } }),
          };
        }
        if (args[0] === "agent" && args[1] === "read") {
          return { code: 0, stdout: '{"findings":[]}', stderr: "" };
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

    const result = await runPiAgentInHerdr(pi as never, ctx as never, {
      label: "PR-tests",
      prompt: "Review the PR",
      piArgs: ["--no-tools"],
    });

    expect(result.code).toBe(0);
    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(2);
    expect(startedAgents).toHaveLength(2);
    expect(startedAgents[0]).not.toBe(startedAgents[1]);
    expect(calls).toContainEqual(["tab", "close", "tab-1"]);
    expect(calls.at(-1)).toEqual(["tab", "close", "tab-2"]);
    expect(notifications).toHaveLength(0);
  });
});
