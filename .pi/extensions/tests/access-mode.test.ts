import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import accessModeExtension, { appendAccessModeInstructions } from "../access-mode";
import { assertProjectPath, projectPathIsAllowed } from "../access-mode/path-policy";
import {
  accessModeStatus,
  DEFAULT_ACCESS_MODE,
  nextAccessMode,
  previousAccessMode,
  setAccessMode,
} from "../access-mode/state";
import {
  filterToolsForAccessMode,
  isBashActionAllowed,
  isToolAllowed,
} from "../access-mode/tool-policy";

const temporaryPaths = new Set<string>();

afterEach(async () => {
  setAccessMode(DEFAULT_ACCESS_MODE);
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

describe("access mode state", () => {
  test("formats compact footer indications", () => {
    expect([1, 2, 3, 4].map((mode) => accessModeStatus(mode as 1 | 2 | 3 | 4))).toEqual([
      "1: r",
      "2: rw",
      "3: rwx",
      "4: RWX",
    ]);
  });

  test("cycles and wraps all four modes", () => {
    expect(nextAccessMode(1)).toBe(2);
    expect(nextAccessMode(4)).toBe(1);
    expect(previousAccessMode(4)).toBe(3);
    expect(previousAccessMode(1)).toBe(4);
  });
});

describe("access mode tool policy", () => {
  const tools = ["read", "get_data", "write", "multi-edit", "bash", "custom-tool"];

  test("uses direct reads and read-action Bash without get_data in mode 1", () => {
    expect(filterToolsForAccessMode(tools, 1)).toEqual(["read", "bash"]);
    expect(isBashActionAllowed("read", 1)).toBe(true);
    expect(isBashActionAllowed("write", 1)).toBe(false);
  });

  test("adds writes and execution cumulatively", () => {
    expect(filterToolsForAccessMode(tools, 2)).toEqual([
      "read",
      "get_data",
      "write",
      "multi-edit",
      "bash",
    ]);
    expect(isBashActionAllowed("read", 2)).toBe(true);
    expect(isBashActionAllowed("write", 2)).toBe(true);
    expect(filterToolsForAccessMode(tools, 3)).toEqual([
      "read",
      "get_data",
      "write",
      "multi-edit",
      "bash",
    ]);
  });

  test("allows unknown tools only in mode 4", () => {
    expect(isToolAllowed("custom-tool", 3)).toBe(false);
    expect(filterToolsForAccessMode(tools, 4)).toEqual(tools);
  });
});

describe("access mode project paths", () => {
  test("rejects lexical and symlink escapes until mode 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "access-mode-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "access-mode-outside-"));
    temporaryPaths.add(root);
    temporaryPaths.add(outside);
    await writeFile(path.join(root, "inside.txt"), "inside", "utf8");
    await writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
    await symlink(path.join(outside, "outside.txt"), path.join(root, "escape.txt"));

    expect(await projectPathIsAllowed(root, "inside.txt", 3)).toBe(true);
    expect(await projectPathIsAllowed(root, "../outside.txt", 3)).toBe(false);
    expect(await projectPathIsAllowed(root, "escape.txt", 3)).toBe(false);
    await expect(
      assertProjectPath(root, path.join(outside, "outside.txt"), 4),
    ).resolves.toBeUndefined();
  });
});

describe("access mode prompt", () => {
  test("replaces stale mode guidance", () => {
    const modeOne = appendAccessModeInstructions("base", 1);
    const modeFour = appendAccessModeInstructions(modeOne, 4);

    expect(modeOne).toContain("Access mode 1: read only");
    expect(modeOne).toContain("Bash self-reported as read");
    expect(modeFour).toContain("Access mode 4: unrestricted host access");
    expect(modeFour).not.toContain("Access mode 1: read only");
  });
});

describe("access mode extension enforcement", () => {
  test("updates active tools and blocks disallowed calls immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "access-mode-extension-"));
    temporaryPaths.add(root);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const statuses = new Map<string, string | undefined>();
    const allTools = ["read", "grep", "get_data", "write", "multi-edit", "bash", "edit", "custom"];
    let activeTools = [...allTools];
    const pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      getAllTools() {
        return allTools.map((name) => ({ name }));
      },
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(toolNames: string[]) {
        activeTools = toolNames;
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: root,
      hasUI: true,
      ui: {
        setStatus(key: string, value: string | undefined) {
          statuses.set(key, value);
        },
      },
    } as unknown as ExtensionContext;
    accessModeExtension(pi);

    setAccessMode(1);
    handlers.get("session_start")?.({}, ctx);
    expect(activeTools).toEqual(["read", "grep", "bash"]);
    expect(statuses.get("access-mode")).toBe("1: r");
    const readBash = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { action: "read", purpose: "Inspect files", command: "ls" },
        toolCallId: "bash-read-1",
      },
      ctx,
    );
    const writeBash = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { action: "write", purpose: "Create file", command: "touch output" },
        toolCallId: "bash-write-1",
      },
      ctx,
    );
    expect(readBash).toBeUndefined();
    expect(writeBash).toMatchObject({ block: true });

    setAccessMode(2);
    const modeTwoWriteBash = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { action: "write", purpose: "Create file", command: "touch output" },
        toolCallId: "bash-write-2",
      },
      ctx,
    );
    expect(modeTwoWriteBash).toBeUndefined();

    setAccessMode(3);
    expect(activeTools).toEqual(["read", "grep", "get_data", "write", "multi-edit", "bash"]);
    const blocked = await handlers.get("tool_call")?.(
      { toolName: "custom", input: {}, toolCallId: "custom-1" },
      ctx,
    );
    expect(blocked).toMatchObject({ block: true });

    handlers.get("session_shutdown")?.({}, ctx);
  });
});
