import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import accessModeExtension, { appendAccessModeInstructions } from "../access-mode";
import { assertProjectPath, projectPathIsAllowed } from "../access-mode/path-policy";
import {
  accessModeStatus,
  clearAccessProjectRoot,
  DEFAULT_ACCESS_MODE,
  discoverAccessProjectRoot,
  initializeAccessProjectRoot,
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
  clearAccessProjectRoot();
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

describe("access mode state", () => {
  test("uses the nearest ancestor containing a .piroot file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "access-mode-workspace-"));
    const project = path.join(workspace, "app", "wt", "feature");
    temporaryPaths.add(workspace);
    await mkdir(project, { recursive: true });
    await writeFile(path.join(workspace, ".piroot"), "", "utf8");

    expect(discoverAccessProjectRoot(project)).toBe(workspace);

    const nearerRoot = path.join(workspace, "app");
    await writeFile(path.join(nearerRoot, ".piroot"), "", "utf8");
    expect(discoverAccessProjectRoot(project)).toBe(nearerRoot);
  });

  test("uses the current directory when no .piroot file exists", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "access-mode-project-"));
    temporaryPaths.add(project);

    expect(discoverAccessProjectRoot(project)).toBe(project);
    expect(initializeAccessProjectRoot(project)).toBe(project);
  });

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
  const tools = [
    "read",
    "read-many-files-lines",
    "get_data",
    "write",
    "multi-edit",
    "submit_checkpoint",
    "submit_handoff",
    "bash",
    "debug_ui_start",
    "custom-tool",
  ];

  test("filters tools by mode and excludes standalone write below mode 4", () => {
    expect(filterToolsForAccessMode(tools, 1)).toEqual(["read", "read-many-files-lines", "bash"]);
    expect(filterToolsForAccessMode(tools, 2)).toEqual([
      "read",
      "read-many-files-lines",
      "get_data",
      "multi-edit",
      "submit_checkpoint",
      "submit_handoff",
      "bash",
    ]);
    expect(filterToolsForAccessMode(tools, 3)).toEqual([
      "read-many-files-lines",
      "get_data",
      "multi-edit",
      "submit_checkpoint",
      "submit_handoff",
      "bash",
      "debug_ui_start",
    ]);

    expect(isToolAllowed("get_data", 1)).toBe(false);
    expect(isToolAllowed("get_data", 2)).toBe(true);
    expect(isToolAllowed("read", 3)).toBe(false);
    expect(isToolAllowed("read-many-files-lines", 3)).toBe(true);
    expect(isToolAllowed("read", 4)).toBe(true);
    expect(isToolAllowed("read-many-files-lines", 4)).toBe(true);
    expect(isToolAllowed("write", 1)).toBe(false);
    expect(isToolAllowed("write", 2)).toBe(false);
    expect(isToolAllowed("write", 3)).toBe(false);
    expect(isToolAllowed("write", 4)).toBe(true);
    expect(isToolAllowed("submit_checkpoint", 2)).toBe(true);
    expect(isToolAllowed("submit_handoff", 3)).toBe(true);
    expect(isToolAllowed("debug_ui_start", 2)).toBe(false);
    expect(isToolAllowed("debug_ui_start", 3)).toBe(true);
    expect(isToolAllowed("herdr_spawn_agents", 3, true)).toBe(false);
    expect(isToolAllowed("herdr_manage_agents", 4, true)).toBe(false);
    expect(isToolAllowed("herdr_spawn_agents", 3, false)).toBe(true);
  });

  test("allows unknown tools only in mode 4", () => {
    expect(isToolAllowed("custom-tool", 3)).toBe(false);
    expect(filterToolsForAccessMode(tools, 4)).toEqual(tools);
  });
});

describe("access mode project paths", () => {
  test("allows symlinks whose targets remain inside the discovered .piroot boundary", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "access-mode-workspace-"));
    const worktree = path.join(workspace, "app", "wt", "feature");
    const sharedPi = path.join(workspace, "pi", ".pi");
    const skillFile = path.join(sharedPi, "skills", "wayfinder", "SKILL.md");
    temporaryPaths.add(workspace);
    await mkdir(worktree, { recursive: true });
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(path.join(workspace, ".piroot"), "", "utf8");
    await writeFile(skillFile, "# Wayfinder\n", "utf8");
    await symlink(sharedPi, path.join(worktree, ".pi"));

    const projectRoot = initializeAccessProjectRoot(worktree);
    expect(projectRoot).toBe(workspace);
    await expect(
      assertProjectPath(projectRoot, path.join(worktree, ".pi/skills/wayfinder/SKILL.md"), 3),
    ).resolves.toBeUndefined();
  });

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
    const modeThree = appendAccessModeInstructions(modeOne, 3);
    const modeFour = appendAccessModeInstructions(modeThree, 4);

    expect(modeOne).toContain("Access mode 1: read only");
    expect(modeOne).toContain("Bash self-reported as read");
    expect(modeThree).toContain("read-many-files-lines");
    expect(modeThree).toContain("parent read is blocked");
    expect(modeThree).toContain("use get_data when requested data must be located");
    expect(modeFour).toContain("Access mode 4: unrestricted host access");
    expect(modeFour).not.toContain("Access mode 1: read only");
  });
});

describe("access mode extension enforcement", () => {
  test("checks project boundaries for every flat multi-edit key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "access-mode-map-"));
    const outside = await mkdtemp(path.join(tmpdir(), "access-mode-map-outside-"));
    temporaryPaths.add(root);
    temporaryPaths.add(outside);
    await symlink(outside, path.join(root, "escape"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    accessModeExtension({
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI);
    const ctx = { cwd: root } as ExtensionContext;
    const call = (input: Record<string, string>) =>
      handlers.get("tool_call")?.({ toolName: "multi-edit", toolCallId: "map-access", input }, ctx);

    for (const mode of [2, 3] as const) {
      setAccessMode(mode);
      expect(await call({ "inside.txt:1-2": "edited", "new.txt": "created" })).toBeUndefined();
      for (const key of ["escape/new.txt", "escape/existing.txt:1-2", "escape/existing.txt:2-"]) {
        expect(await call({ "inside.txt:1-1": "allowed", [key]: "blocked" })).toMatchObject({
          block: true,
        });
      }
    }
    setAccessMode(4);
    expect(await call({ [path.join(outside, "existing.txt:2-")]: "allowed" })).toBeUndefined();
  });

  test("checks worker ownership for create, bounded, and open-ended map keys even in mode 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "access-mode-owned-map-"));
    temporaryPaths.add(root);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    accessModeExtension({
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI);
    const ctx = { cwd: root } as ExtensionContext;
    const originalEnvironment = {
      PI_SUBAGENT_ID: process.env.PI_SUBAGENT_ID,
      PI_AGENT_WRITABLE_FILES: process.env.PI_AGENT_WRITABLE_FILES,
    };
    try {
      process.env.PI_SUBAGENT_ID = "map-worker";
      process.env.PI_AGENT_WRITABLE_FILES = JSON.stringify(["owned.txt"]);
      setAccessMode(4);
      for (const suffix of ["", ":1-2", ":2-"]) {
        const call = (file: string) =>
          handlers.get("tool_call")?.(
            {
              toolName: "multi-edit",
              toolCallId: "map-ownership",
              input: { [`${file}${suffix}`]: "replacement" },
            },
            ctx,
          );
        expect(await call("owned.txt")).toBeUndefined();
        expect(await call("unowned.txt")).toMatchObject({
          block: true,
          reason: expect.stringContaining("not in this Herdr worker's writableFiles"),
        });
      }
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("updates active tools and blocks disallowed calls immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "access-mode-extension-"));
    temporaryPaths.add(root);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const statuses = new Map<string, string | undefined>();
    const allTools = [
      "read",
      "read-many-files-lines",
      "grep",
      "get_data",
      "write",
      "multi-edit",
      "bash",
      "debug_ui_start",
      "edit",
      "custom",
    ];
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
    expect(activeTools).toEqual(["read", "read-many-files-lines", "grep", "bash"]);
    expect(statuses.get("access-mode")).toBe("1: r");
    const allowedRead = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "inside.txt" }, toolCallId: "read-1" },
      ctx,
    );
    expect(allowedRead).toBeUndefined();
    const blockedWriteBash = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { action: "write", purpose: "Create file", command: "touch inside.txt" },
        toolCallId: "bash-write-1",
      },
      ctx,
    );
    expect(blockedWriteBash).toMatchObject({ block: true });

    setAccessMode(2);
    expect(activeTools).toEqual([
      "read",
      "read-many-files-lines",
      "grep",
      "get_data",
      "multi-edit",
      "bash",
    ]);
    const allowedWriteBash = await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { action: "write", purpose: "Create file", command: "touch inside.txt" },
        toolCallId: "bash-write-2",
      },
      ctx,
    );
    expect(allowedWriteBash).toBeUndefined();
    const blockedExecute = await handlers.get("tool_call")?.(
      { toolName: "debug_ui_start", input: {}, toolCallId: "debug-2" },
      ctx,
    );
    expect(blockedExecute).toMatchObject({ block: true });

    setAccessMode(3);
    expect(activeTools).toEqual([
      "read-many-files-lines",
      "grep",
      "get_data",
      "multi-edit",
      "bash",
      "debug_ui_start",
    ]);
    const allowedExecute = await handlers.get("tool_call")?.(
      { toolName: "debug_ui_start", input: {}, toolCallId: "debug-3" },
      ctx,
    );
    expect(allowedExecute).toBeUndefined();

    setAccessMode(4);
    expect(activeTools).toEqual([
      "read",
      "read-many-files-lines",
      "grep",
      "get_data",
      "write",
      "multi-edit",
      "bash",
      "debug_ui_start",
      "custom",
    ]);
    const allowed = await handlers.get("tool_call")?.(
      { toolName: "custom", input: {}, toolCallId: "custom-4" },
      ctx,
    );
    expect(allowed).toBeUndefined();

    for (const mode of [1, 2, 3, 4, 3] as const) {
      setAccessMode(mode);
      expect(activeTools.includes("write")).toBe(mode === 4);
      expect(activeTools.includes("multi-edit")).toBe(mode >= 2);
      const writeResult = await handlers.get("tool_call")?.(
        {
          toolName: "write",
          input: { path: "inside.txt", content: "value" },
          toolCallId: `write-${mode}`,
        },
        ctx,
      );
      if (mode === 4) expect(writeResult).toBeUndefined();
      else expect(writeResult).toMatchObject({ block: true });
    }

    handlers.get("session_shutdown")?.({}, ctx);
  });
});
