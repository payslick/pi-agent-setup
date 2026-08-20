import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import multiEdit, {
  CONSECUTIVE_EDIT_REMINDER,
  countChangedLines,
  layoutCodeLine,
  renderLineCounts,
  renderMultiEditInput,
  visibleBlockLines,
  type MultiEditInput,
} from "../multi-edit";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "../post-edit-validation-events";

const temporaryPaths = new Set<string>();

const renderTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
} as unknown as Theme;

function registerMultiEdit(
  onValidationRequest: (request: PostEditValidationRequest) => void = () => {},
): {
  tool: ToolDefinition;
  startSession: () => void;
  callTool: (event: { toolName: string; toolCallId?: string }) => unknown;
  resultTool: (event: {
    toolName: string;
    toolCallId: string;
    content: Array<{ type: "text"; text: string }>;
  }) => unknown;
  activeTools: () => string[];
} {
  let tool: ToolDefinition | undefined;
  let startSession: (() => void) | undefined;
  let callTool: ((event: { toolName: string; toolCallId?: string }) => unknown) | undefined;
  let resultTool:
    | ((event: {
        toolName: string;
        toolCallId: string;
        content: Array<{ type: "text"; text: string }>;
      }) => unknown)
    | undefined;
  let activeTools = ["read", "edit", "multi-edit"];

  multiEdit({
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "session_start") startSession = handler as () => void;
      if (event === "tool_call") {
        callTool = handler as (toolEvent: { toolName: string; toolCallId?: string }) => unknown;
      }
      if (event === "tool_result") {
        resultTool = handler as (toolEvent: {
          toolName: string;
          toolCallId: string;
          content: Array<{ type: "text"; text: string }>;
        }) => unknown;
      }
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
    events: {
      emit(channel: string, data: unknown) {
        if (channel === POST_EDIT_VALIDATION_REQUEST_EVENT) {
          onValidationRequest(data as PostEditValidationRequest);
        }
      },
    },
  } as unknown as ExtensionAPI);

  if (!tool || !startSession || !callTool || !resultTool)
    throw new Error("multi-edit did not register correctly");
  return { tool, startSession, callTool, resultTool, activeTools: () => activeTools };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

describe("multi-edit presentation", () => {
  test("shows the first two lines of every before and after block when collapsed", () => {
    initTheme("dark");
    const input: MultiEditInput = {
      files: [
        {
          path: "src/example.ts",
          edits: [
            {
              oldText: "const oldOne = 1;\nconst oldTwo = 2;\nconst oldThree = 3;",
              newText: "const newOne = 1;\nconst newTwo = 2;\nconst newThree = 3;",
            },
          ],
        },
      ],
    };

    const collapsedWithHighlighting = renderMultiEditInput(input, false, renderTheme);
    const highlightedBeforeLine =
      collapsedWithHighlighting.split("\n").find((line) => line.includes("oldOne")) ?? "";
    const ansiEscape = String.fromCharCode(27);
    const syntaxColors = highlightedBeforeLine
      .split(`${ansiEscape}[`)
      .slice(1)
      .map((sequence) => sequence.split("m", 1)[0])
      .filter((sequence) => sequence?.startsWith("38;"));
    expect(new Set(syntaxColors).size).toBeGreaterThan(1);

    const collapsed = Bun.stripANSI(collapsedWithHighlighting);
    expect(collapsed).toContain("const oldOne = 1;");
    expect(collapsed).toContain("const oldTwo = 2;");
    expect(collapsed).not.toContain("const oldThree = 3;");
    expect(collapsed).toContain("const newOne = 1;");
    expect(collapsed).toContain("const newTwo = 2;");
    expect(collapsed).not.toContain("const newThree = 3;");
    expect(collapsed.match(/… 1 more line/g)).toHaveLength(2);
    expect(collapsed).toContain("[toolErrorBg] const oldOne = 1; [/toolErrorBg]");
    expect(collapsed).toContain("[toolSuccessBg] const newOne = 1; [/toolSuccessBg]");
    expect(collapsed).not.toContain("before");
    expect(collapsed).not.toContain("after");

    const expanded = Bun.stripANSI(renderMultiEditInput(input, true, renderTheme));
    expect(expanded).toContain("const oldThree = 3;");
    expect(expanded).toContain("const newThree = 3;");
    expect(expanded).not.toContain("more line");
  });

  test("tolerates partial input while tool arguments are streaming", () => {
    const incompleteInputs: unknown[] = [
      undefined,
      {},
      { files: null },
      { files: [null, {}] },
      { files: [{ path: "src/example.ts" }] },
    ];

    for (const input of incompleteInputs) {
      expect(() => renderMultiEditInput(input, false, renderTheme)).not.toThrow();
    }

    const partialEdit = Bun.stripANSI(
      renderMultiEditInput(
        {
          files: [
            {
              path: "src/example.ts",
              edits: [{ oldText: "const before = true;" }],
            },
          ],
        },
        false,
        renderTheme,
      ),
    );
    expect(partialEdit).toContain("src/example.ts");
    expect(partialEdit).toContain("const before = true;");
  });

  test("truncates long collapsed lines and preserves indentation when expanded", () => {
    initTheme("dark");
    const line = `    const value = ${"segment".repeat(8)};`;

    const collapsed = layoutCodeLine(line, "src/example.ts", false, 24).map(Bun.stripANSI);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toEndWith("…");
    expect(collapsed[0]?.length).toBeLessThanOrEqual(24);

    const expanded = layoutCodeLine(line, "src/example.ts", true, 24).map(Bun.stripANSI);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.every((wrappedLine) => wrappedLine.startsWith("    "))).toBeTrue();
    expect(expanded.every((wrappedLine) => wrappedLine.length <= 24)).toBeTrue();
  });

  test("counts changed lines and renders color-coded counts without success boilerplate", () => {
    expect(countChangedLines("one\ntwo\n", "one\nthree\nfour\n")).toEqual({
      addedLines: 2,
      removedLines: 1,
    });

    const rendered = renderLineCounts(
      [{ path: "src/example.ts", addedLines: 2, removedLines: 1 }],
      renderTheme,
    );
    expect(rendered).toBe(
      "src/example.ts  [toolSuccessBg] +2 [/toolSuccessBg] [toolErrorBg] -1 [/toolErrorBg]",
    );
    expect(rendered).not.toContain("Successfully edited");
    expect(rendered).not.toContain("Changed files:");
  });

  test("treats trailing newlines as terminators rather than extra preview lines", () => {
    expect(visibleBlockLines("one\ntwo\nthree\n", false)).toEqual({
      lines: ["one", "two"],
      omittedLines: 1,
    });
  });
});

describe("multi-edit tool", () => {
  test("removes edit from active tools and blocks attempted edit calls", () => {
    const registered = registerMultiEdit();

    registered.startSession();

    expect(registered.activeTools()).toEqual(["read", "multi-edit"]);
    expect(registered.callTool({ toolName: "edit", toolCallId: "edit-1" })).toEqual({
      block: true,
      reason: "The edit tool is disabled. Use multi-edit instead.",
    });
    expect(registered.callTool({ toolName: "read", toolCallId: "read-1" })).toBeUndefined();
  });

  test("reminds the model after consecutive edit calls", () => {
    const registered = registerMultiEdit();
    registered.startSession();

    registered.callTool({ toolName: "multi-edit", toolCallId: "edit-1" });
    expect(
      registered.resultTool({
        toolName: "multi-edit",
        toolCallId: "edit-1",
        content: [{ type: "text", text: "first result" }],
      }),
    ).toBeUndefined();

    registered.callTool({ toolName: "multi-edit", toolCallId: "edit-2" });
    expect(
      registered.resultTool({
        toolName: "multi-edit",
        toolCallId: "edit-2",
        content: [{ type: "text", text: "second result" }],
      }),
    ).toEqual({
      content: [
        { type: "text", text: "second result" },
        { type: "text", text: CONSECUTIVE_EDIT_REMINDER },
      ],
    });

    registered.callTool({ toolName: "read", toolCallId: "read-1" });
    registered.callTool({ toolName: "multi-edit", toolCallId: "edit-3" });
    expect(
      registered.resultTool({
        toolName: "multi-edit",
        toolCallId: "edit-3",
        content: [{ type: "text", text: "third result" }],
      }),
    ).toBeUndefined();
  });

  test("awaits requested post-edit validation before returning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multi-edit-await-test-"));
    temporaryPaths.add(root);
    await writeFile(path.join(root, "example.ts"), "before\n", "utf8");

    let notifyValidationRequested = () => {};
    const validationRequested = new Promise<void>((resolve) => {
      notifyValidationRequested = resolve;
    });
    let finishValidation = () => {};
    const validation = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const { tool } = registerMultiEdit((request) => {
      expect(request.affectedPaths).toEqual(["example.ts"]);
      request.waitFor(validation);
      notifyValidationRequested();
    });

    let settled = false;
    const execution = Promise.resolve(
      tool.execute(
        "call-await",
        {
          files: [
            {
              path: "example.ts",
              edits: [{ oldText: "before", newText: "after" }],
            },
          ],
        },
        undefined,
        undefined,
        { cwd: root } as ExtensionContext,
      ),
    ).then((result) => {
      settled = true;
      return result;
    });

    await validationRequested;
    expect(await readFile(path.join(root, "example.ts"), "utf8")).toBe("after\n");
    expect(settled).toBeFalse();

    finishValidation();
    await execution;
    expect(settled).toBeTrue();
  });

  test("returns only filenames and changed-line counts after editing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multi-edit-test-"));
    temporaryPaths.add(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/example.ts"), "one\ntwo\n", "utf8");
    const { tool } = registerMultiEdit();

    const result = await tool.execute(
      "call-1",
      {
        files: [
          {
            path: "src/example.ts",
            edits: [{ oldText: "two", newText: "three\nfour" }],
          },
        ],
      },
      undefined,
      undefined,
      { cwd: root } as ExtensionContext,
    );

    expect(await readFile(path.join(root, "src/example.ts"), "utf8")).toBe("one\nthree\nfour\n");
    expect(result.content).toEqual([{ type: "text", text: "src/example.ts  +2  -1" }]);
    expect(result.details).toEqual({
      changedFiles: ["src/example.ts"],
      lineCounts: [{ path: "src/example.ts", addedLines: 2, removedLines: 1 }],
    });
  });
});
