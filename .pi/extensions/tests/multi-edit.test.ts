import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { PROJECT_PATH_ERROR } from "../access-mode/path-policy";
import { DEFAULT_ACCESS_MODE, setAccessMode } from "../access-mode/state";
import multiEdit, {
  CONSECUTIVE_EDIT_REMINDER,
  countChangedLines,
  layoutCodeLine,
  renderFinalDiffs,
  renderLineCounts,
  renderMultiEditInput,
  visibleBlockLines,
} from "../multi-edit";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "../post-edit-validation/events";

const temporaryPaths = new Set<string>();
const shutdownSessions = new Set<() => void>();

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
  let shutdownSession: (() => void) | undefined;
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
      if (event === "session_shutdown") shutdownSession = handler as () => void;
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

  if (!tool || !startSession || !shutdownSession || !callTool || !resultTool)
    throw new Error("multi-edit did not register correctly");
  shutdownSessions.add(shutdownSession);
  return { tool, startSession, callTool, resultTool, activeTools: () => activeTools };
}

afterEach(async () => {
  for (const shutdownSession of shutdownSessions) shutdownSession();
  shutdownSessions.clear();
  setAccessMode(DEFAULT_ACCESS_MODE);
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

async function setupEditFile(content: string) {
  const root = await mkdtemp(path.join(tmpdir(), "multi-edit-lines-"));
  temporaryPaths.add(root);
  await writeFile(path.join(root, "example.txt"), content, "utf8");
  const { tool } = registerMultiEdit();
  return {
    root,
    execute: (input: Record<string, unknown>) =>
      tool.execute("line-edit", input, undefined, undefined, { cwd: root } as ExtensionContext),
    read: () => readFile(path.join(root, "example.txt"), "utf8"),
  };
}

describe("multi-edit presentation", () => {
  test("previews the selected range and first two replacement lines when collapsed", () => {
    initTheme("dark");
    const input = {
      "src/example.ts:4-6": "const newOne = 1;\nconst newTwo = 2;\nconst newThree = 3;",
    };

    const collapsedWithHighlighting = renderMultiEditInput(input, false, renderTheme);
    const highlightedLine =
      collapsedWithHighlighting.split("\n").find((line) => line.includes("newOne")) ?? "";
    const ansiEscape = String.fromCharCode(27);
    const syntaxColors = highlightedLine
      .split(`${ansiEscape}[`)
      .slice(1)
      .map((sequence) => sequence.split("m", 1)[0])
      .filter((sequence) => sequence?.startsWith("38;"));
    expect(new Set(syntaxColors).size).toBeGreaterThan(1);

    const collapsed = Bun.stripANSI(collapsedWithHighlighting);
    expect(collapsed).toContain("lines 4–6");
    expect(collapsed).toContain("const newOne = 1;");
    expect(collapsed).toContain("const newTwo = 2;");
    expect(collapsed).not.toContain("const newThree = 3;");
    expect(collapsed).toContain("… 1 more line");
    expect(collapsed).toContain("[toolSuccessBg] const newOne = 1; [/toolSuccessBg]");
    expect(collapsed).not.toContain("before");
    expect(collapsed).not.toContain("after");

    const expanded = Bun.stripANSI(renderMultiEditInput(input, true, renderTheme));
    expect(expanded).toContain("const newThree = 3;");
    expect(expanded).not.toContain("more line");
  });

  test("distinguishes deletion and creation previews", () => {
    initTheme("dark");
    const rendered = Bun.stripANSI(
      renderMultiEditInput(
        {
          "src/example.ts:8-10": "",
          "src/new.ts": "export const value = 1;\n",
          "src/tail.ts:4-": "replacement tail",
        },
        false,
        renderTheme,
      ),
    );

    expect(rendered).toContain("lines 8–10");
    expect(rendered).toContain("(delete lines)");
    expect(rendered).toContain("src/new.ts");
    expect(rendered).toContain("create");
    expect(rendered).toContain("export const value = 1;");
    expect(rendered).toContain("lines 4–EOF");
    expect(rendered).toContain("replacement tail");
  });

  test("windows collapsed diffs around changes at the end of long lines", () => {
    initTheme("dark");
    const prefix = "prefix_".repeat(7);
    const rendered = Bun.stripANSI(
      renderFinalDiffs(
        [
          {
            path: "src/example.ts",
            diff: `-12 const value = ${prefix}OLD;\n+12 const value = ${prefix}NEW;`,
          },
        ],
        false,
        renderTheme,
        28,
      ),
    );

    expect(rendered).toContain("…");
    expect(rendered).toContain("OLD;");
    expect(rendered).toContain("NEW;");
    expect(rendered).not.toContain("const value =");
  });

  test("tolerates partial input while tool arguments are streaming", () => {
    const incompleteInputs: unknown[] = [
      undefined,
      {},
      { "src/example.ts:4-": null },
      { "src/example.ts:": "" },
      { "src/example.ts:4": "" },
      { "src/new.ts": "export const" },
      { "same.ts": "", "same.ts:1-": "edited" },
    ];

    for (const input of incompleteInputs) {
      expect(() => renderMultiEditInput(input, false, renderTheme)).not.toThrow();
    }

    const partialEdit = Bun.stripANSI(
      renderMultiEditInput({ "src/example.ts:4-": "const value = true;" }, false, renderTheme),
    );
    expect(partialEdit).toContain("src/example.ts");
    expect(partialEdit).toContain("const value = true;");
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

describe("multi-edit line ranges", () => {
  test("replaces only the requested occurrence using inclusive original line numbers", async () => {
    const file = await setupEditFile("same\nsame\ntail\nlast\n");
    await file.execute({
      "example.txt:2-2": "second\nextra",
      "example.txt:3-4": "end\n",
    });
    expect(await file.read()).toBe("same\nsecond\nextra\nend\n");
  });

  test.each([
    ["terminated line", "first\nlast\n", "changed", "first\nchanged\n"],
    ["unterminated line", "first\nlast", "changed", "first\nchanged"],
    ["explicit terminator", "first\nlast\n", "changed\n", "first\nchanged\n"],
    ["CRLF", "first\r\nlast\r\n", "changed\nextra", "first\r\nchanged\r\nextra\r\n"],
    ["delete", "first\nlast\n", "", "first\n"],
    ["blank line", "first\nlast\n", "\n", "first\n\n"],
  ])("preserves whole-line boundaries for %s", async (_scenario, original, newText, expected) => {
    const file = await setupEditFile(original);
    await file.execute({ "example.txt:2-2": newText });
    expect(await file.read()).toBe(expected);
  });

  test("deletes a middle range without joining adjacent lines", async () => {
    const file = await setupEditFile("keep\nremove\nremove\ntail");
    await file.execute({ "example.txt:2-3": "" });
    expect(await file.read()).toBe("keep\ntail");
  });

  test.each([
    [0, 1],
    [2, 1],
    [1, 3],
    [1.5, 2],
    [1, 1.5],
  ])("rejects invalid range %s–%s without modifying the file", async (startLine, endLine) => {
    const file = await setupEditFile("one\ntwo\n");
    await expect(
      file.execute({ [`example.txt:${startLine}-${endLine}`]: "wrong" }),
    ).rejects.toThrow("Invalid line range");
    expect(await file.read()).toBe("one\ntwo\n");
  });

  test("rejects overlapping ranges across repeated paths without modifying the file", async () => {
    const file = await setupEditFile("one\ntwo\nthree\n");
    await expect(
      file.execute({ "example.txt:1-2": "first", "example.txt:2-3": "second" }),
    ).rejects.toThrow("Overlapping edits");
    expect(await file.read()).toBe("one\ntwo\nthree\n");
  });

  test("rejects the nested input format without modifying the file", async () => {
    const file = await setupEditFile("one\n");
    await expect(
      file.execute({
        files: [{ path: "example.txt", edits: [{ startLine: 1, endLine: 1, newText: "wrong" }] }],
      }),
    ).rejects.toThrow("multi-edit expects a non-empty map of file keys to strings");
    expect(await file.read()).toBe("one\n");
  });

  test.each([
    ["terminated", "one\ntwo\nthree\n", "tail", "first\nextra\ntail\n"],
    ["unterminated", "one\ntwo\nthree", "tail", "first\nextra\ntail"],
    ["deletion", "one\ntwo\nthree\n", "", "first\nextra\n"],
  ])(
    "replaces through original EOF for %s content",
    async (_scenario, original, tail, expected) => {
      const file = await setupEditFile(original);
      const result = await file.execute({
        "example.txt:1-1": "first\nextra",
        "example.txt:2-": tail,
      });
      expect(await file.read()).toBe(expected);
      expect(result.details).toMatchObject({
        editRanges: [
          {
            path: "example.txt",
            ranges: [
              { startLine: 1, endLine: 1 },
              { startLine: 2, endLine: 3 },
            ],
          },
        ],
      });
    },
  );

  test("rejects an open-ended range starting beyond EOF", async () => {
    const file = await setupEditFile("one\ntwo\n");
    await expect(file.execute({ "example.txt:3-": "wrong" })).rejects.toThrow("Invalid line range");
    expect(await file.read()).toBe("one\ntwo\n");
  });

  test("rejects overlapping open-ended ranges without modifying the file", async () => {
    const file = await setupEditFile("one\ntwo\nthree\n");
    await expect(
      file.execute({ "example.txt:2-": "tail", "example.txt:3-3": "last" }),
    ).rejects.toThrow("Overlapping edits");
    expect(await file.read()).toBe("one\ntwo\nthree\n");
  });

  test("parses the range after the last colon in a file path", async () => {
    const file = await setupEditFile("");
    const filePath = path.join(file.root, "notes:2026.txt");
    await writeFile(filePath, "first\nlast\n", "utf8");
    await file.execute({ "notes:2026.txt:2-": "tail" });
    expect(await readFile(filePath, "utf8")).toBe("first\ntail\n");
  });

  test.each(["example.txt:", "example.txt:1", "example.txt:1-x", "example.txt:-1-2", ":1-2"])(
    "rejects malformed key %s instead of creating a file",
    async (key) => {
      const file = await setupEditFile("one\n");
      await expect(file.execute({ [key]: "wrong" })).rejects.toThrow("Invalid multi-edit key");
      await expect(readFile(path.join(file.root, key), "utf8")).rejects.toThrow("ENOENT");
      expect(await file.read()).toBe("one\n");
    },
  );

  test("reports no changes when the replacement preserves the selected lines", async () => {
    const file = await setupEditFile("one\ntwo\n");
    const result = await file.execute({ "example.txt:2-2": "two" });
    expect(await file.read()).toBe("one\ntwo\n");
    expect(result.content).toEqual([{ type: "text", text: "No changes." }]);
    expect(result.details).toMatchObject({ changedFiles: [], diffs: [], lineCounts: [] });
  });
});

describe("multi-edit creation", () => {
  test("creates parent directories and new files alongside filling an empty file", async () => {
    const file = await setupEditFile("");
    const result = await file.execute({
      "nested/new.txt": "new\ncontent\n",
      "example.txt": "filled\n",
      "empty.txt": "",
    });
    expect(await readFile(path.join(file.root, "nested/new.txt"), "utf8")).toBe("new\ncontent\n");
    expect(await file.read()).toBe("filled\n");
    expect(await readFile(path.join(file.root, "empty.txt"), "utf8")).toBe("");
    expect(result.details).toMatchObject({
      changedFiles: ["nested/new.txt", "example.txt", "empty.txt"],
      lineCounts: [
        { path: "nested/new.txt", addedLines: 2, removedLines: 0 },
        { path: "example.txt", addedLines: 1, removedLines: 0 },
        { path: "empty.txt", addedLines: 0, removedLines: 0 },
      ],
      editRanges: [
        { path: "nested/new.txt", ranges: [{ startLine: 1, endLine: 2 }] },
        { path: "example.txt", ranges: [{ startLine: 1, endLine: 1 }] },
        { path: "empty.txt", ranges: [] },
      ],
    });
  });

  test.each(["existing\n", " \n"])("rejects create on non-empty content %j", async (content) => {
    const file = await setupEditFile(content);
    await expect(file.execute({ "example.txt": "replacement" })).rejects.toThrow(
      "Cannot create non-empty file",
    );
    expect(await file.read()).toBe(content);
  });

  test("rejects mixing creation and edits for the same path", async () => {
    const file = await setupEditFile("");
    for (const input of [
      { "example.txt": "created", "example.txt:1-1": "edited" },
      { "example.txt:1-": "edited", "example.txt": "created" },
    ]) {
      await expect(file.execute(input)).rejects.toThrow("Cannot combine create");
      expect(await file.read()).toBe("");
    }
  });

  test("requires create for empty files and rejects normal edits on missing files", async () => {
    const file = await setupEditFile("");
    await expect(file.execute({ "example.txt:1-1": "wrong" })).rejects.toThrow(
      "Invalid line range",
    );
    await expect(file.execute({ "missing.txt:1-1": "wrong" })).rejects.toThrow("ENOENT");
    expect(await file.read()).toBe("");
  });

  test("enforces access mode and project boundaries for creation", async () => {
    const file = await setupEditFile("");
    const outside = await mkdtemp(path.join(tmpdir(), "multi-edit-create-outside-"));
    temporaryPaths.add(outside);
    await symlink(outside, path.join(file.root, "escape"));
    setAccessMode(1);
    await expect(file.execute({ "example.txt": "blocked" })).rejects.toThrow("blocks multi-edit");
    setAccessMode(3);
    await expect(file.execute({ "escape/new.txt": "blocked" })).rejects.toThrow(PROJECT_PATH_ERROR);
    await expect(readFile(path.join(outside, "new.txt"), "utf8")).rejects.toThrow("ENOENT");
    expect(await file.read()).toBe("");
  });
});

describe("multi-edit tool", () => {
  test("keeps edit disabled and updates multi-edit availability with access mode", () => {
    setAccessMode(1);
    const registered = registerMultiEdit();
    registered.startSession();

    expect(registered.activeTools()).toEqual(["read"]);
    expect(registered.callTool({ toolName: "multi-edit", toolCallId: "multi-1" })).toEqual({
      block: true,
      reason: "The current access mode blocks multi-edit.",
    });

    for (const mode of [2, 3, 4] as const) {
      setAccessMode(mode);
      expect(registered.activeTools()).toEqual(["read", "multi-edit"]);
      expect(
        registered.callTool({ toolName: "multi-edit", toolCallId: `multi-${mode}` }),
      ).toBeUndefined();
    }

    setAccessMode(1);
    expect(registered.activeTools()).toEqual(["read"]);
    expect(registered.callTool({ toolName: "edit", toolCallId: "edit-1" })).toEqual({
      block: true,
      reason: "The edit tool is disabled. Use multi-edit instead.",
    });
    expect(registered.activeTools()).not.toContain("edit");
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

  test("rejects project escapes through mode 3 and permits host paths in mode 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multi-edit-path-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "multi-edit-path-outside-"));
    temporaryPaths.add(root);
    temporaryPaths.add(outside);
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "before\n", "utf8");
    await symlink(outsideFile, path.join(root, "escape.txt"));
    const { tool } = registerMultiEdit();
    const editFile = async (filePath: string) =>
      tool.execute(`path-${filePath}`, { [`${filePath}:1-1`]: "after" }, undefined, undefined, {
        cwd: root,
      } as ExtensionContext);

    setAccessMode(1);
    await expect(editFile("escape.txt")).rejects.toThrow("blocks multi-edit");
    for (const mode of [2, 3] as const) {
      setAccessMode(mode);
      await expect(editFile("escape.txt")).rejects.toThrow(PROJECT_PATH_ERROR);
      await expect(editFile(path.relative(root, outsideFile))).rejects.toThrow(PROJECT_PATH_ERROR);
    }
    expect(await readFile(outsideFile, "utf8")).toBe("before\n");

    setAccessMode(4);
    await editFile("escape.txt");
    expect(await readFile(outsideFile, "utf8")).toBe("after\n");
    await writeFile(outsideFile, "before\n", "utf8");
    await editFile(outsideFile);
    expect(await readFile(outsideFile, "utf8")).toBe("after\n");
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
      expect(request.editRanges).toEqual([
        { path: "example.ts", ranges: [{ startLine: 1, endLine: 1 }] },
      ]);
      request.waitFor(validation);
      notifyValidationRequested();
    });

    let settled = false;
    const execution = Promise.resolve(
      tool.execute("call-await", { "example.ts:1-": "after" }, undefined, undefined, {
        cwd: root,
      } as ExtensionContext),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.race([validationRequested, execution]);
    expect(await readFile(path.join(root, "example.ts"), "utf8")).toBe("after\n");
    expect(settled).toBeFalse();

    await writeFile(path.join(root, "example.ts"), "formatted after\n", "utf8");
    finishValidation();
    const result = await execution;
    expect(settled).toBeTrue();
    expect(result.details).toMatchObject({
      lineCounts: [{ path: "example.ts", addedLines: 1, removedLines: 1 }],
      diffs: [{ path: "example.ts", diff: "-1 before\n+1 formatted after" }],
    });
  });

  test("returns final diffs, source ranges, and changed-line counts after editing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multi-edit-test-"));
    temporaryPaths.add(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/example.ts"), "one\ntwo\n", "utf8");
    const { tool } = registerMultiEdit();

    const result = await tool.execute(
      "call-1",
      { "src/example.ts:2-2": "three\nfour" },
      undefined,
      undefined,
      { cwd: root } as ExtensionContext,
    );

    expect(await readFile(path.join(root, "src/example.ts"), "utf8")).toBe("one\nthree\nfour\n");
    expect(result.content).toEqual([{ type: "text", text: "src/example.ts  +2  -1" }]);
    expect(result.details).toEqual({
      changedFiles: ["src/example.ts"],
      lineCounts: [{ path: "src/example.ts", addedLines: 2, removedLines: 1 }],
      diffs: [{ path: "src/example.ts", diff: "-2 two\n+2 three\n+3 four" }],
      editRanges: [{ path: "src/example.ts", ranges: [{ startLine: 2, endLine: 2 }] }],
    });
  });
});
