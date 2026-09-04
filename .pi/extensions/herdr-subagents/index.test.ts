import { afterEach, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACCESS_MODE_ENV, ACCESS_PROJECT_ROOT_ENV } from "../access-mode/state";
import {
  agentPromptArgs,
  assertSubagentExecuteAccess,
  missingSubagentActionResult,
  piArgsForSpec,
  renderSubagentCompletionMessage,
  resolveSubagentCwd,
  shouldPlayMainAgentSound,
  subagentAccessEnvironment,
} from "./index";
import {
  agentNameForSpec,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  formatSubagentDuration,
  formatSubagentModel,
  formatSubagentUsage,
  questionNeedsUserPrompt,
  restoreRecordsForWorkspace,
  sessionNameForSpec,
  shortenHomePath,
  tabLabelForSpec,
  type SpawnedSubagentRecord,
} from "./state";

const temporaryPaths = new Set<string>();

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

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

describe("subagent access", () => {
  test("requires execute mode and propagates the access environment", () => {
    expect(() => assertSubagentExecuteAccess(1)).toThrow("requires execute mode");
    expect(() => assertSubagentExecuteAccess(2)).toThrow("requires execute mode");
    expect(() => assertSubagentExecuteAccess(3)).not.toThrow();
    expect(() => assertSubagentExecuteAccess(4)).not.toThrow();
    expect(subagentAccessEnvironment(3, "/project")).toEqual({
      [ACCESS_MODE_ENV]: "3",
      [ACCESS_PROJECT_ROOT_ENV]: "/project",
    });
  });

  test("confines cwd to the inherited project root until mode 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "subagent-project-"));
    const outside = await mkdtemp(path.join(tmpdir(), "subagent-outside-"));
    temporaryPaths.add(root);
    temporaryPaths.add(outside);

    await expect(resolveSubagentCwd(root, ".", 3, root)).resolves.toBe(root);
    for (const mode of [1, 2, 3] as const)
      await expect(resolveSubagentCwd(root, outside, mode, root)).rejects.toThrow(
        "only permits paths inside",
      );
    await expect(resolveSubagentCwd(root, outside, 4, root)).resolves.toBe(outside);
  });
});

describe("agentPromptArgs", () => {
  test("submits follow-up prompts without waiting for a working-state transition", () => {
    expect(agentPromptArgs("w1:p2", "Finish now")).toEqual([
      "agent",
      "prompt",
      "w1:p2",
      "Finish now",
    ]);
  });
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

  test("keeps inline system prompts safe for Herdr agent startup", () => {
    expect(piArgsForSpec({ systemPrompt: "First line.\nSecond line." }, "/repo")).toEqual([
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--append-system-prompt",
      "First line. Second line.",
    ]);
  });

  test("uses a prompt file path when one is prepared for startup", () => {
    const promptPath = "/repo/.pi/tmp/herdr-subagents/worker.system-prompt.md";
    expect(
      piArgsForSpec({ systemPrompt: "First line.\nSecond line." }, "/repo", promptPath),
    ).toContain(promptPath);
  });

  test("retains the access guard when other extensions are disabled", () => {
    const guardPath = path.resolve(import.meta.dir, "../access-mode/index.ts");
    expect(piArgsForSpec({ noExtensions: true }, "/repo", undefined, 3)).toContain(guardPath);
    expect(piArgsForSpec({ noExtensions: true }, "/repo", undefined, 4)).not.toContain(guardPath);
  });

  test("keeps cwd out of Pi args but rejects external skill files", () => {
    expect(() =>
      piArgsForSpec({ cwd: "/repo-worktree", skills: ["../secret.md"] }, "/repo"),
    ).toThrow("Subagent skill must stay inside /repo: ../secret.md");
  });
});

describe("subagent management", () => {
  test("silently ignores cleanup races for agents that already exited", () => {
    expect(missingSubagentActionResult({ action: "abort", id: "finished-agent" })).toBe("");
    expect(missingSubagentActionResult({ action: "close", id: "finished-agent" })).toBe("");
    expect(() => missingSubagentActionResult({ action: "read", id: "missing-agent" })).toThrow(
      "Unknown subagent: missing-agent.",
    );
  });
});

describe("main-agent sound", () => {
  test("plays only for an unfocused main Herdr agent", () => {
    expect(shouldPlayMainAgentSound({ HERDR_ENV: "1" }, false)).toBe(true);
    expect(shouldPlayMainAgentSound({ HERDR_ENV: "1", PI_SUBAGENT_ID: "worker" }, false)).toBe(
      false,
    );
    expect(shouldPlayMainAgentSound({ HERDR_ENV: "1" }, true)).toBe(false);
    expect(shouldPlayMainAgentSound({}, false)).toBe(false);
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

  test("identifies the spawning Pi session in the child session title", () => {
    expect(
      sessionNameForSpec(
        {
          workPacket: {
            objective: "Create schemas",
            writableFiles: ["app/schema.ts"],
            acceptanceCriteria: ["Schemas compile"],
          },
        },
        "pi-session-123",
      ),
    ).toBe("Work packet [spawned by pi-session-123]");
    expect(sessionNameForSpec({ prompt: "Review authentication" }, "pi-session-123")).toBe(
      "AG-review-authentication [spawned by pi-session-123]",
    );
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
  test("renders returned agent responses as collapsed Markdown", () => {
    initTheme("dark");
    const content = [
      "Task: Create schemas",
      "0:03 effort:high",
      "✅ Added schemas.",
      "Handoff:",
      "## Handoff",
      "- **Summary:** Added schema.ts",
    ].join("\n");
    const message = {
      role: "custom",
      customType: "herdr-subagent-completion",
      content,
      display: true,
      timestamp: Date.now(),
    } as const;
    const theme = { fg: (_color: string, text: string) => text } as never;

    const collapsed = renderSubagentCompletionMessage(message, { expanded: false }, theme);
    const collapsedText = Bun.stripANSI(collapsed?.render(80).join("\n") ?? "");
    expect(collapsedText).toContain("✅ Added schemas.");
    expect(collapsedText).toContain("Ctrl+O to expand");
    expect(collapsedText).not.toContain("Handoff");

    const expanded = renderSubagentCompletionMessage(message, { expanded: true }, theme);
    const expandedText = Bun.stripANSI(expanded?.render(80).join("\n") ?? "");
    expect(expandedText).toContain("Handoff");
    expect(expandedText).toContain("Summary: Added schema.ts");
    expect(expandedText).not.toContain("**Summary:**");
  });

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
