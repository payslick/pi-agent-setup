import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { childGuardBlock } from "../access-mode/child-guard";
import {
  ACCESS_MODE_ENV,
  ACCESS_PROJECT_ROOT_ENV,
  DEFAULT_ACCESS_MODE,
  setAccessMode,
} from "../access-mode/state";
import getDataExtension, {
  appendGetDataInstructions,
  buildGetDataPrompt,
  childAccessEnvironment,
  childExecutionScope,
  childIsolationArgs,
  childModelArgs,
  GET_DATA_CHILD_MODEL,
  GET_DATA_CHILD_THINKING,
  GET_DATA_TOOL_NAME,
  parentActiveTools,
  bashActionRejection,
} from "./index";

interface CapturedTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  renderCall?: (...args: unknown[]) => unknown;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

interface ExtensionCapture {
  tools: CapturedTool[];
  events: string[];
}

function captureExtension(childMode = false): ExtensionCapture {
  const tools: CapturedTool[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    on(event: string) {
      events.push(event);
    },
  } as unknown as ExtensionAPI;
  const previous = process.env.PI_GET_DATA_CHILD;
  if (childMode) process.env.PI_GET_DATA_CHILD = "1";
  else delete process.env.PI_GET_DATA_CHILD;
  try {
    getDataExtension(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_GET_DATA_CHILD;
    else process.env.PI_GET_DATA_CHILD = previous;
  }
  return { tools, events };
}

function toolEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { toolName, input } as ToolCallEvent;
}

afterEach(() => setAccessMode(DEFAULT_ACCESS_MODE));

describe("parent data-tool policy", () => {
  const directTools = [
    "read",
    "grep",
    "find",
    "ls",
    "read-many-files-lines",
    "project_index_search",
    "web_search",
  ];

  test("exposes parent tools according to cumulative access-mode capabilities", () => {
    const configured = [
      ...directTools,
      GET_DATA_TOOL_NAME,
      "write",
      "debug_ui_start",
      "custom-tool",
    ];

    expect(parentActiveTools(configured, 1)).toEqual([...directTools, "bash"]);
    expect(parentActiveTools(configured, 2)).toEqual([
      ...directTools,
      GET_DATA_TOOL_NAME,
      "write",
      "bash",
    ]);
    expect(parentActiveTools(configured, 3)).toEqual([
      "grep",
      "find",
      "ls",
      "read-many-files-lines",
      "project_index_search",
      "web_search",
      GET_DATA_TOOL_NAME,
      "write",
      "debug_ui_start",
      "bash",
    ]);
  });

  test("keeps configured tools and required parent tools in mode 4", () => {
    expect(parentActiveTools([...directTools, "write"], 4)).toEqual([
      ...directTools,
      "write",
      GET_DATA_TOOL_NAME,
      "bash",
    ]);
  });

  test("does not duplicate required parent tools", () => {
    expect(parentActiveTools([GET_DATA_TOOL_NAME, "read", "bash"], 3)).toEqual([
      GET_DATA_TOOL_NAME,
      "bash",
    ]);
  });
});

describe("parent prompt guidance", () => {
  test("is mode-aware, cumulative, and replaceable", () => {
    const modeOne = appendGetDataInstructions("base prompt", 1);
    const modeTwo = appendGetDataInstructions(modeOne, 2);
    const modeThree = appendGetDataInstructions(modeTwo, 3);
    const modeFour = appendGetDataInstructions(modeThree, 4);
    const unchanged = appendGetDataInstructions(modeFour, 4);

    expect(modeOne).toContain("Access mode 1");
    expect(modeOne).toContain("`get_data` is unavailable in mode 1");
    expect(modeOne).toContain("text and image reads");
    expect(modeOne).toContain('Bash is available only with `action="read"`');
    expect(modeOne).toContain("cannot change to an external directory");
    expect(modeTwo).toContain("Access mode 2");
    expect(modeTwo).toContain("Use `get_data` whenever requested data is not already known");
    expect(modeTwo).toContain("Direct read/data tools remain available");
    expect(modeTwo).not.toContain("Access mode 1");
    expect(modeThree).toContain("Access mode 3");
    expect(modeThree).toContain("Use `read-many-files-lines` for already-identified files");
    expect(modeThree).toContain("Use `get_data` whenever requested data is not already known");
    expect(modeThree).toContain("direct `read` is unavailable");
    expect(modeThree).not.toContain("Access mode 2");
    expect(modeFour).toContain("Access mode 4");
    expect(modeFour).toContain("Use `get_data` whenever requested data is not already known");
    expect(unchanged).toBe(modeFour);
  });
});

describe("child extension isolation", () => {
  test("removes child edit/write and always loads the retrieval guard", () => {
    const guardPath = path.resolve(import.meta.dir, "../access-mode/child-guard.ts");
    const expected = [
      "--no-extensions",
      "--extension",
      guardPath,
      "--tools",
      "read,bash,grep,find,ls",
    ];

    expect(childIsolationArgs(3, "/project")).toEqual(expected);
    expect(childIsolationArgs(4, "/project")).toEqual(expected);
  });

  test("propagates access mode and project root through the child environment", () => {
    expect(childAccessEnvironment(2, "/project")).toEqual({
      [ACCESS_MODE_ENV]: "2",
      [ACCESS_PROJECT_ROOT_ENV]: "/project",
    });
  });

  test("starts the child in the caller cwd while retaining the access-policy root", () => {
    expect(childExecutionScope("/project/repository/.pi", 3, "/project")).toEqual({
      cwd: "/project/repository/.pi",
      environment: {
        [ACCESS_MODE_ENV]: "3",
        [ACCESS_PROJECT_ROOT_ENV]: "/project",
      },
    });
  });

  test("enforces retrieval-only child access in every mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "get-data-child-guard-"));
    const ctx = { cwd: root } as ExtensionContext;
    await writeFile(path.join(root, "inside.txt"), "inside", "utf8");
    try {
      for (const mode of [1, 2, 3] as const) {
        await expect(
          childGuardBlock(toolEvent("bash", { command: "rg inside inside.txt" }), ctx, mode, root),
        ).resolves.toBeUndefined();
        expect(
          await childGuardBlock(toolEvent("read", { path: "../outside.txt" }), ctx, mode, root),
        ).toMatchObject({ block: true });
        expect(
          await childGuardBlock(toolEvent("bash", { command: "cat /etc/passwd" }), ctx, mode, root),
        ).toMatchObject({ block: true });
      }

      await expect(
        childGuardBlock(toolEvent("bash", { command: "cat /etc/passwd" }), ctx, 4, root),
      ).resolves.toBeUndefined();
      for (const command of [
        "rm inside.txt",
        "find . -delete",
        "find . -exec touch marker {} ;",
        "git diff --output=marker",
      ])
        expect(await childGuardBlock(toolEvent("bash", { command }), ctx, 4, root)).toMatchObject({
          block: true,
        });
      expect(
        await childGuardBlock(toolEvent("bash", { command: "python -V" }), ctx, 4, root),
      ).toMatchObject({ block: true });
      expect(
        await childGuardBlock(toolEvent("bash", { command: "bun run dev" }), ctx, 4, root),
      ).toMatchObject({ block: true });

      for (const mode of [1, 2, 3, 4] as const) {
        for (const toolName of ["edit", "write", "multi-edit"])
          expect(
            await childGuardBlock(toolEvent(toolName, { path: "inside.txt" }), ctx, mode, root),
          ).toMatchObject({ block: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("child model defaults", () => {
  test("uses Luna with minimal thinking independently of the parent defaults", () => {
    expect(childModelArgs()).toEqual([
      "--model",
      GET_DATA_CHILD_MODEL,
      "--thinking",
      GET_DATA_CHILD_THINKING,
    ]);
    expect(GET_DATA_CHILD_MODEL).toBe("openai-codex/gpt-5.6-luna");
    expect(GET_DATA_CHILD_THINKING).toBe("minimal");
  });
});

describe("child retrieval prompt", () => {
  test("includes relevance, scope, evidence, limit, dense format, and complete context", () => {
    const prompt = buildGetDataPrompt(
      {
        objective: "Find currency-rate functions",
        relevance: "Needed to update rates without changing formatting",
        scope: ["app/src", "official documentation"],
        evidence: "exact",
        maxFindings: 7,
      },
      "[User]: Existing task context",
    );

    expect(prompt).toContain("Objective: Find currency-rate functions");
    expect(prompt).toContain(
      "Relevance criteria: Needed to update rates without changing formatting",
    );
    expect(prompt).toContain("- app/src");
    expect(prompt).toContain("- official documentation");
    expect(prompt).toContain("Evidence mode: exact");
    expect(prompt).toContain("Maximum findings: 7");
    expect(prompt).toContain("path:startLine-endLine");
    expect(prompt).toContain("source text copied verbatim from that exact range");
    expect(prompt).toContain("Never replace source text with a paraphrase or summary");
    expect(prompt).toContain("Complete compaction-aware parent context");
    expect(prompt).toContain("return it verbatim, label it as complete");
    expect(prompt).toContain("[User]: Existing task context");
  });

  test("marks bounded parent context explicitly", () => {
    const prompt = buildGetDataPrompt(
      { objective: "Inspect logs", relevance: "Identify the failure" },
      "recent context",
      true,
    );

    expect(prompt).toContain("Earlier parent context omitted");
    expect(prompt).toContain("recent context");
  });
});

describe("bash routing guidance", () => {
  test("explains why mode 1 rejects a write action", () => {
    const rejection = bashActionRejection(
      { action: "write", purpose: "Create output", command: "touch output" },
      1,
    );

    expect(rejection).toContain('Access mode 1 blocks Bash action="write"');
    expect(rejection).toContain("permits only self-reported read actions");
    expect(rejection).toContain("Rejected command: touch output");
  });
});

describe("extension registration", () => {
  test("registers get_data and intent-aware bash without replacing normal read", () => {
    const capture = captureExtension();
    const toolNames = capture.tools.map((tool) => tool.name);

    expect(toolNames).toEqual([GET_DATA_TOOL_NAME, "bash"]);
    expect(capture.events).toEqual(["session_start", "session_tree", "before_agent_start"]);

    const getData = capture.tools[0]!;
    expect(getData.description).toContain(
      "whenever requested data is not already known and finding the exact points of interest requires searching or reasoning",
    );
    expect(getData.description).toContain(
      "returns the relevant source text verbatim with its path and line range",
    );
    expect(getData.promptSnippet).toContain("findings include verbatim source text");
    expect(getData.parameters.required).toEqual(["objective", "relevance"]);
    expect(getData.parameters.properties).toHaveProperty("scope");
    expect(getData.renderCall).toBeFunction();

    const bash = capture.tools[1]!;
    expect(bash.parameters.required).toEqual(["action", "purpose", "command"]);
  });

  test("registers nothing inside the retrieval child", () => {
    expect(captureExtension(true)).toEqual({ tools: [], events: [] });
  });

  test("bash write action is rejected in mode 1", async () => {
    setAccessMode(1);
    const bash = captureExtension().tools.find((tool) => tool.name === "bash")!;
    const result = await bash.execute(
      "call-1",
      { action: "write", purpose: "Create output", command: "touch output" },
      undefined,
      undefined,
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Access mode 1 blocks Bash action");
  });
});
