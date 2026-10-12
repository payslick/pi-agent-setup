import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAccessMode, setAccessMode } from "../access-mode/state";
import debugUiExtension from "../debug-ui";

async function debugFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "debug-ui-guard-"));
  const previousRoot = process.env.PI_DEBUG_UI_APP_ROOT;
  const previousMode = getAccessMode();
  process.env.PI_DEBUG_UI_APP_ROOT = root;
  setAccessMode(4);
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const status = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const failures = { navigation: false, close: false };
  let sessionNumber = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      setStatus(key: string, value: string | undefined) { status.set(key, value); },
      notify(message: string) { notifications.push(message); },
    },
  } as unknown as ExtensionContext;
  debugUiExtension({
    on(event: string, handler: (...args: unknown[]) => unknown) { hooks.set(event, handler); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
      commands.set(name, command);
    },
    async exec(_executable: string, args: string[]) {
      if (args.includes("-i")) return { code: 0, stdout: JSON.stringify({ sessionId: `browser-${++sessionNumber}` }), stderr: "" };
      if (args.includes("-r") && failures.navigation) return { code: 1, stdout: "", stderr: "navigation failed" };
      if (args.includes("-c") && failures.close) return { code: 1, stdout: "", stderr: "socket closed" };
      return { code: 0, stdout: "done", stderr: "" };
    },
  } as unknown as ExtensionAPI);
  const execute = (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return tool.execute("debug-test", input, undefined, undefined, ctx);
  };
  const prompt = (text: string) => hooks.get("before_agent_start")?.({ prompt: text, systemPrompt: "base" }, ctx);
  hooks.get("session_start")?.({}, ctx);
  prompt("Adjust the layout");
  return {
    root, failures, status, notifications, execute, prompt,
    async close(via: "tool" | "command", sessionId?: string) {
      if (via === "tool") return execute("debug_ui_close", sessionId ? { sessionId } : {});
      await commands.get("debug-ui")?.handler(`close${sessionId ? ` ${sessionId}` : ""}`, ctx as ExtensionCommandContext);
    },
    guard(toolName: "write" | "edit" | "multi-edit", paths: string[]) {
      const input = toolName === "multi-edit" ? {
        files: paths.map((file) => ({ path: file, edits: [{ oldText: "before", newText: "after" }] })),
      } : { path: paths[0], content: "after", oldText: "before", newText: "after" };
      return hooks.get("tool_call")?.({ toolName, toolCallId: "mutation", input }, ctx);
    },
    async [Symbol.asyncDispose]() {
      failures.navigation = false;
      failures.close = false;
      await execute("debug_ui_close").catch(() => undefined);
      hooks.get("session_shutdown")?.({}, ctx);
      if (previousRoot === undefined) delete process.env.PI_DEBUG_UI_APP_ROOT;
      else process.env.PI_DEBUG_UI_APP_ROOT = previousRoot;
      setAccessMode(previousMode);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["succeeds", "fails"])("failed navigation releases local preview state when remote cleanup %s", async (cleanupOutcome) => {
  await using fixture = await debugFixture();
  fixture.failures.navigation = true;
  fixture.failures.close = cleanupOutcome === "fails";
  await expect(fixture.execute("debug_ui_start")).rejects.toThrow("navigation failed");
  expect(fixture.guard("multi-edit", ["src/components/card.tsx"])).toBeUndefined();
  expect(fixture.prompt("Prepare the PR description")).toBeUndefined();
  expect(fixture.status.get("debug-ui")).toBeUndefined();
  await expect(fixture.execute("debug_ui_run", { code: "page.url()" })).rejects.toThrow("No active debug UI session");
});

test.each(["tool", "command"] as const)("failed explicit close via %s releases local state but reports remote cleanup failure", async (via) => {
  await using fixture = await debugFixture();
  await fixture.execute("debug_ui_start");
  fixture.failures.close = true;
  if (via === "tool") await expect(fixture.close(via)).rejects.toThrow("socket closed");
  else {
    await fixture.close(via);
    expect(fixture.notifications.join("\n")).toContain("socket closed");
  }
  expect(fixture.guard("write", ["src/components/card.tsx"])).toBeUndefined();
  expect(fixture.prompt("Prepare the PR description")).toBeUndefined();
  expect(fixture.status.get("debug-ui")).toBeUndefined();
});

test.each(["write", "edit", "multi-edit"] as const)("active previews allow unrelated files through %s", async (tool) => {
  await using fixture = await debugFixture();
  await fixture.execute("debug_ui_start");
  for (const file of [
    "tmp/913/pr-description.md", "src/server/payroll.ts", "app/api/payroll/route.ts",
    "components/README.md", "tests/card.test.tsx", "src/components/card.test.tsx",
    "package.json", path.join(path.dirname(fixture.root), "outside.tsx"),
  ]) {
    expect(fixture.guard(tool, [file])).toBeUndefined();
  }
});

test.each(["write", "edit", "multi-edit"] as const)("active previews still protect UI source through %s until save approval", async (tool) => {
  await using fixture = await debugFixture();
  await fixture.execute("debug_ui_start");
  for (const file of [
    "src/components/card.tsx", "src/styles/global.css", "src/pages/home.js",
    "src/components/theme.ts", "src/views/home.vue", "src/views/home.svelte",
  ]) {
    expect(fixture.guard(tool, [file])).toMatchObject({ block: true, reason: expect.stringContaining("save") });
  }
  fixture.prompt("save");
  expect(fixture.guard(tool, ["src/components/card.tsx"])).toBeUndefined();
});

test("a mixed multi-edit remains blocked when any file is protected UI source", async () => {
  await using fixture = await debugFixture();
  await fixture.execute("debug_ui_start");
  expect(fixture.guard("multi-edit", ["tmp/pr.md", "src/components/card.tsx"])).toMatchObject({ block: true });
});

test.each(["tool", "command"] as const)("a failed close of another session via %s does not unlock the active preview", async (via) => {
  await using fixture = await debugFixture();
  await fixture.execute("debug_ui_start");
  fixture.failures.close = true;
  if (via === "tool") await expect(fixture.close(via, "other-session")).rejects.toThrow("socket closed");
  else await fixture.close(via, "other-session");
  expect(fixture.guard("multi-edit", ["src/components/card.tsx"])).toMatchObject({ block: true });
  expect(fixture.status.get("debug-ui")).toContain("browser-1");
});
