import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionFactory,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

const { default: impl } = (await import(pathToFileURL(resolve(".pi/extensions/impl.ts")).href)) as {
  default: ExtensionFactory;
};
const directories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  for (const key of [
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "PI_ACCESS_MODE",
    "PI_ACCESS_PROJECT_ROOT",
  ]) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(failure?: "start" | "prompt") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-impl-"));
  directories.push(cwd);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "workspace-impl";
  process.env.PI_ACCESS_MODE = "3";
  process.env.PI_ACCESS_PROJECT_ROOT = cwd;
  const session = SessionManager.create(cwd, join(cwd, "sessions"));
  session.appendMessage({ role: "user", content: "Plan a payroll export", timestamp: 1 });
  const planId = session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Implement CSV payroll export with tenant isolation." }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  session.appendMessage({ role: "user", content: "Discarded alternative plan", timestamp: 3 });
  session.branch(planId);
  const calls: string[][] = [];
  const notices: { message: string; type: string | undefined }[] = [];
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand: (name: string, registered: RegisteredCommand) => {
      if (name === "impl") command = registered;
    },
    exec: async (executable: string, args: string[]) => {
      expect(executable).toBe("herdr");
      calls.push(args);
      if (args[0] === "agent" && args[1] === failure)
        return { code: 1, stdout: "", stderr: `Herdr ${failure} failed`, killed: false };
      const result =
        args[0] === "tab" && args[1] === "create"
          ? { tab: { tab_id: "impl-tab" }, root_pane: { pane_id: "impl-pane" } }
          : {};
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  await impl(pi);
  const ctx = {
    cwd,
    sessionManager: session,
    isIdle: () => true,
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
  } as unknown as ExtensionCommandContext;
  if (!command) throw new Error("/impl command was not registered");
  const handler = command.handler;
  return { cwd, session, calls, notices, ctx, run: () => handler("", ctx) };
}

const option = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("/impl", () => {
  test("launches Sol 6.1 high with the active plan in an independent Herdr session", async () => {
    const fixture = await setup();
    const parentPath = fixture.session.getSessionFile()!;
    const parentBefore = await readFile(parentPath, "utf8");
    const parentLeaf = fixture.session.getLeafId();
    await fixture.run();
    expect(fixture.calls.map((args) => args.slice(0, 2))).toEqual([
      ["tab", "create"],
      ["agent", "start"],
      ["agent", "prompt"],
    ]);
    const [tab, start, prompt] = fixture.calls;
    expect(option(tab!, "--workspace")).toBe("workspace-impl");
    expect(option(tab!, "--cwd")).toBe(fixture.cwd);
    expect(tab).toContain("PI_ACCESS_MODE=3");
    expect(tab).toContain(`PI_ACCESS_PROJECT_ROOT=${fixture.cwd}`);
    expect(option(start!, "--pane")).toBe("impl-pane");
    expect(option(start!, "--model")).toBe("openai-codex/gpt-6.1-sol");
    expect(option(start!, "--thinking")).toBe("high");
    expect(prompt!.slice(2, 4)).toEqual([start![2]!, "Implement"]);
    const childPath = option(start!, "--session")!;
    expect(childPath).not.toBe(parentPath);
    const child = SessionManager.open(childPath);
    expect(child.getSessionId()).not.toBe(fixture.session.getSessionId());
    expect(child.getHeader()?.parentSession).toBe(parentPath);
    expect(child.buildSessionContext().messages).toEqual(
      fixture.session.buildSessionContext().messages,
    );
    expect(fixture.session.getLeafId()).toBe(parentLeaf);
    expect(await readFile(parentPath, "utf8")).toBe(parentBefore);
    expect(fixture.notices.some((notice) => notice.type === "error")).toBe(false);
  });

  test.each(["1", "2"])("blocks launching in access mode %s", async (mode) => {
    const fixture = await setup();
    process.env.PI_ACCESS_MODE = mode;
    await fixture.run();
    expect(fixture.calls).toEqual([]);
    expect(fixture.notices).toContainEqual({
      message: `Access mode ${mode} blocks /impl; spawning requires mode 3 or 4.`,
      type: "error",
    });
    expect(await readdir(join(fixture.cwd, "sessions"))).toHaveLength(1);
  });

  test("reports missing Herdr without creating a fork", async () => {
    const fixture = await setup();
    delete process.env.HERDR_WORKSPACE_ID;
    await fixture.run();
    expect(fixture.calls).toEqual([]);
    expect(fixture.notices).toContainEqual({
      message: "/impl requires a Herdr workspace.",
      type: "error",
    });
    expect(await readdir(join(fixture.cwd, "sessions"))).toHaveLength(1);
  });

  test("rejects an unpersisted conversation rather than launching without the plan", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager = SessionManager.inMemory(fixture.cwd);
    await fixture.run();
    expect(fixture.calls).toEqual([]);
    expect(fixture.notices).toContainEqual({
      message: "/impl requires a saved conversation with an assistant response.",
      type: "error",
    });
  });

  test.each(["start", "prompt"] as const)(
    "reports a failed agent %s and closes its tab",
    async (failure) => {
      const fixture = await setup(failure);
      await fixture.run();
      expect(fixture.notices).toContainEqual({ message: `Herdr ${failure} failed`, type: "error" });
      expect(fixture.calls.at(-1)).toEqual(["tab", "close", "impl-tab"]);
      if (failure === "start")
        expect(fixture.calls.some((args) => args[1] === "prompt")).toBe(false);
      expect(await readdir(join(fixture.cwd, "sessions"))).toHaveLength(1);
    },
  );
});
