import { describe, expect, test } from "bun:test";
import {
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  friendlySubagentName,
  formatSubagentDuration,
  formatSubagentModel,
  formatSubagentUsage,
  planSubagentPlacement,
  questionNeedsUserPrompt,
  restoreRecordsForWindow,
  shortenHomePath,
  type SpawnedSubagentRecord,
} from "./state";

function record(id: string, paneId: string, windowId?: string): SpawnedSubagentRecord {
  return {
    id,
    name: id,
    paneId,
    windowId,
    cwd: ".",
    promptPreview: "test",
    bridgePath: "bridge.mjs",
    configPath: "config.json",
    controlPath: "control.jsonl",
    runScriptPath: "run.sh",
    replaceSystemPrompt: false,
    noSession: true,
    createdAt: 1,
  };
}

describe("planSubagentPlacement", () => {
  test("opens the first automatic subagent on the right at 40%", () => {
    expect(planSubagentPlacement(false, undefined, undefined)).toEqual({
      split: "right",
      target: "main",
      size: "40%",
    });
  });

  test("stacks later automatic subagents below the latest subagent pane", () => {
    expect(planSubagentPlacement(true, undefined, undefined)).toEqual({
      split: "below",
      target: "stack",
    });
  });

  test("honors explicit right split by targeting the main pane", () => {
    expect(planSubagentPlacement(true, "right", undefined)).toEqual({
      split: "right",
      target: "main",
    });
  });

  test("honors requested size", () => {
    expect(planSubagentPlacement(false, undefined, "30%")).toEqual({
      split: "right",
      target: "main",
      size: "30%",
    });
  });
});

describe("friendly ids and paths", () => {
  test("creates a stable human-friendly subagent name from uuid", () => {
    const name = friendlySubagentName("64b47174-8be0-4757-875b-7f14c9f52607");

    expect(name).toMatch(/^[a-z]+-[a-z]+-64b4$/);
    expect(name).toBe(friendlySubagentName("64b47174-8be0-4757-875b-7f14c9f52607"));
  });

  test("shortens paths under home with tilde", () => {
    expect(shortenHomePath("/Users/OmryN/finito/pi/.pi/tmp/file", "/Users/OmryN")).toBe(
      "~/finito/pi/.pi/tmp/file",
    );
    expect(shortenHomePath("/tmp/file", "/Users/OmryN")).toBe("/tmp/file");
  });
});

describe("question forwarding", () => {
  test("prompts the user when the subagent is unsure", () => {
    expect(
      questionNeedsUserPrompt({
        id: "q1",
        type: "question",
        addressedTo: "unsure",
        question: "Which path should I take?",
      }),
    ).toBe(true);
  });

  test("formats subagent question with task and recent pane context", () => {
    const text = formatQuestionForMainAgent(
      record("worker", "%7", "@current"),
      {
        id: "q1",
        type: "question",
        addressedTo: "main_agent",
        question: "Should I run tests now?",
        whatDone: "Read the extension files.",
      },
      "assistant> I inspected the files",
    );

    expect(text).toContain('Subagent "worker" (%7) has a question.');
    expect(text).toContain("Question: Should I run tests now?");
    expect(text).toContain("Read the extension files.");
    expect(text).toContain("assistant> I inspected the files");
  });
});

describe("completion summaries", () => {
  test("formats duration and usage", () => {
    expect(formatSubagentDuration(123_400)).toBe("2:03");
    expect(
      formatSubagentUsage(
        {
          input: 36_000,
          output: 12_000,
          cacheRead: 373_000,
          cacheWrite: 0,
          totalTokens: 421_000,
          cost: 0.73,
          turns: 20,
        },
        321_000,
      ),
    ).toBe("5:21 20 turns ↑36k ↓12k R373k total:421k $0.73");
    expect(
      formatSubagentUsage(
        {
          input: 36_000,
          output: 12_000,
          cacheRead: 373_000,
          cacheWrite: 0,
          totalTokens: 421_000,
          cost: 0.73,
          turns: 20,
        },
        321_000,
        "high",
      ),
    ).toBe("5:21 effort:high 20 turns ↑36k ↓12k R373k total:421k $0.73");
    expect(formatSubagentModel("openai-codex", "gpt-5.5")).toBe("openai-codex/gpt-5.5");
    expect(formatSubagentModel("openai-codex", "openai-codex/gpt-5.5")).toBe(
      "openai-codex/gpt-5.5",
    );
  });

  test("formats a brief completion summary without the main-agent prompt block", () => {
    const text = formatSubagentCompletionSummary(
      { ...record("worker", "%7", "@current"), thinking: "high" },
      {
        type: "done",
        task: "Review the tmux subagent extension.",
        result:
          "1:47 effort:low 15 turns ↑48k ↓2.8k R195k total:246k $0.42\n✅ Identified spawn-time profiles and runtime RPC configuration as the best path.",
        runtimeMs: 65_000,
        usage: { input: 1000, output: 250, totalTokens: 1250, cost: 0.0042, turns: 1 },
        status: "success",
        model: "claude-test",
      },
    );

    expect(text).toBe(
      [
        "Task: Review the tmux subagent extension.",
        "1:05 effort:high 1 turn ↑1k ↓250 total:1.3k $0.00",
        "✅ Identified spawn-time profiles and runtime RPC configuration as the best path.",
      ].join("\n"),
    );
    expect(text).not.toContain("Write a concise subagent completion summary");
    expect(text).not.toContain("Usage line:");
  });
});

describe("restoreRecordsForWindow", () => {
  test("restores only records for the current tmux window", () => {
    const restored = restoreRecordsForWindow(
      [
        {
          type: "custom",
          customType: "tmux-subagent",
          data: { record: record("current", "%1", "@current") },
        },
        {
          type: "custom",
          customType: "tmux-subagent",
          data: { record: record("other", "%2", "@other") },
        },
      ],
      "@current",
    );

    expect([...restored.keys()]).toEqual(["current"]);
  });

  test("ignores legacy records without a tmux window id", () => {
    const restored = restoreRecordsForWindow(
      [{ type: "custom", customType: "tmux-subagent", data: { record: record("legacy", "%55") } }],
      "@current",
    );

    expect(restored.size).toBe(0);
  });

  test("applies killed records within the same window", () => {
    const restored = restoreRecordsForWindow(
      [
        {
          type: "custom",
          customType: "tmux-subagent",
          data: { record: record("a", "%1", "@current") },
        },
        { type: "custom", customType: "tmux-subagent", data: { killedId: "a" } },
      ],
      "@current",
    );

    expect(restored.size).toBe(0);
  });
});
