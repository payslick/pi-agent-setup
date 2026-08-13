import { describe, expect, test } from "bun:test";
import path from "node:path";
import { piArgsForSpec } from "./index";
import {
  agentNameForSpec,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  formatSubagentDuration,
  formatSubagentModel,
  formatSubagentUsage,
  questionNeedsUserPrompt,
  restoreRecordsForWorkspace,
  shortenHomePath,
  tabLabelForSpec,
  type SpawnedSubagentRecord,
} from "./state";

const record = (id: string, workspaceId = "w1"): SpawnedSubagentRecord => ({
  id,
  name: id,
  tabId: `${workspaceId}:t2`,
  paneId: `${workspaceId}:p2`,
  workspaceId,
  tabLabel: "BE-create-schemas",
  cwd: "/repo",
  promptPreview: "Create schemas",
  prompted: true,
  outboxPath: "/tmp/outbox.jsonl",
  replaceSystemPrompt: false,
  createdAt: 1,
});

describe("piArgsForSpec", () => {
  test("defaults to the main agent model", () => {
    expect(piArgsForSpec({}, "/repo")).toEqual(["--model", "openai-codex/gpt-5.6-sol"]);
  });

  test("loads selected skills and excludes worker coordination", () => {
    expect(
      piArgsForSpec(
        {
          skills: [".pi/skills/testing/SKILL.md"],
          excludeTools: ["spawn_subagents", "manage_subagents"],
        },
        "/repo",
      ),
    ).toEqual([
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--exclude-tools",
      "spawn_subagents,manage_subagents",
      "--no-skills",
      "--skill",
      path.resolve("/repo", ".pi/skills/testing/SKILL.md"),
    ]);
  });

  test("allows an absolute worktree cwd but rejects external skill files", () => {
    expect(() =>
      piArgsForSpec({ cwd: "/repo-worktree", skills: ["../secret.md"] }, "/repo"),
    ).toThrow("Subagent skill must stay inside /repo: ../secret.md");
  });
});

describe("Herdr identity", () => {
  test("creates abbreviated labels with at most three task/type words", () => {
    expect(
      tabLabelForSpec({
        profile: "backend-implementer",
        workPacket: {
          objective: "Create the approved payroll schemas",
          writableFiles: ["app/schema.ts"],
          acceptanceCriteria: ["Schemas compile"],
        },
      }),
    ).toBe("BE-create-payroll");
    expect(tabLabelForSpec({ prompt: "Review authentication risks thoroughly" })).toBe(
      "AG-review-authentication",
    );
    expect(tabLabelForSpec({ prompt: "Reply exactly: smoke complete" })).toBe("AG-reply-smoke");
  });

  test("creates a valid unique Herdr agent name", () => {
    const name = agentNameForSpec(
      { profile: "backend-implementer", prompt: "Create schemas" },
      "64b47174-8be0",
    );
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name).toEndWith("-64b4");
  });

  test("shortens paths under home", () => {
    expect(shortenHomePath("/Users/OmryN/repo/file", "/Users/OmryN")).toBe("~/repo/file");
  });
});

describe("question forwarding", () => {
  test("prompts the user when audience is unsure", () => {
    expect(
      questionNeedsUserPrompt({
        id: "q1",
        type: "question",
        addressedTo: "unsure",
        question: "Which path?",
      }),
    ).toBe(true);
  });

  test("formats the Herdr tab and response command", () => {
    const text = formatQuestionForMainAgent(
      record("worker"),
      {
        id: "q1",
        type: "question",
        addressedTo: "main_agent",
        question: "Run tests?",
      },
      "Inspected files",
    );
    expect(text).toContain('Herdr tab "BE-create-schemas"');
    expect(text).toContain('manage_subagents action="prompt"');
  });
});

describe("completion summaries", () => {
  test("formats duration, model, and usage", () => {
    expect(formatSubagentDuration(123_400)).toBe("2:03");
    expect(
      formatSubagentUsage(
        { input: 1000, output: 250, totalTokens: 1250, cost: 0.0042, turns: 1 },
        65_000,
        "high",
      ),
    ).toBe("1:05 effort:high 1 turn ↑1k ↓250 total:1.3k $0.00");
    expect(formatSubagentModel("openai-codex", "gpt-5.6-sol")).toBe("openai-codex/gpt-5.6-sol");
  });

  test("keeps structured handoff content", () => {
    const text = formatSubagentCompletionSummary(
      { ...record("worker"), profile: "backend-implementer", thinking: "high" },
      {
        type: "done",
        task: "Create schemas",
        result:
          "## Handoff\n- Summary: Added schemas.\n- Changed files: schema.ts\n- Validation: passed\n- Deviations: none\n- Risks: none\n- Follow-up: none",
        status: "success",
        runtimeMs: 65_000,
      },
    );
    expect(text).toContain("✅ Added schemas.");
    expect(text).toContain("Handoff:\n## Handoff");
  });
});

describe("session restoration", () => {
  test("restores only records in the current Herdr workspace and applies removals", () => {
    const restored = restoreRecordsForWorkspace(
      [
        { type: "custom", customType: "herdr-subagent", data: { record: record("current") } },
        {
          type: "custom",
          customType: "herdr-subagent",
          data: { record: record("other", "w2") },
        },
        { type: "custom", customType: "herdr-subagent", data: { removedId: "current" } },
      ],
      "w1",
    );
    expect(restored.size).toBe(0);
  });
});
