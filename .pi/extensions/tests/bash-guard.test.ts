import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_ACCESS_MODE, setAccessMode } from "../access-mode/state";
import bashGuard, { analyzeBashCommand, replaceSearchCommand } from "../bash-guard";

type BashToolCall = {
  toolName: "bash";
  toolCallId: string;
  input: { action?: "read" | "write"; purpose?: string; command: string };
};

function registerBashGuard(): (event: BashToolCall) => Promise<unknown> {
  let toolCall: ((event: BashToolCall, ctx: { cwd: string }) => Promise<unknown>) | undefined;
  bashGuard({
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "tool_call")
        toolCall = handler as (event: BashToolCall, ctx: { cwd: string }) => Promise<unknown>;
    },
  } as unknown as ExtensionAPI);
  if (!toolCall) throw new Error("bash guard did not register correctly");
  const handler = toolCall;
  return (event) => handler(event, { cwd: process.cwd() });
}

afterEach(() => setAccessMode(DEFAULT_ACCESS_MODE));

describe("bash search rewriting", () => {
  test("keeps newline-separated find commands as separate commands", () => {
    expect(
      replaceSearchCommand(
        "find src -maxdepth 2 -type f -name '*.ts' -print\nfind test -type f -print",
      ),
    ).toEqual({
      command:
        "rg --files --hidden --no-ignore src --max-depth 2 -g '*.ts'\nrg --files --hidden --no-ignore test",
    });
  });

  test("gives actionable rg guidance for unsupported find expressions", () => {
    const command =
      "find .pi/skills/upgrade-deps -maxdepth 4 -type f -print\n" +
      "find . -path './node_modules' -prune -o -type f \\( " +
      "-name 'dependencyAudit.ts' -o -name 'dependencyReport.ts' -o " +
      "-name 'dependencyWorktree.ts' \\) -print";

    expect(() => replaceSearchCommand(command)).toThrow(
      "find command uses unsupported arguments for rg rewrite: -prune",
    );
    expect(() => replaceSearchCommand(command)).toThrow("Use `rg --files [path]` directly");
    expect(() => replaceSearchCommand(command)).toThrow("-g '!<glob>'");
    expect(() => replaceSearchCommand(command)).toThrow("Do not retry the `find` command");
  });
});

describe("bash guard access modes", () => {
  test("uses the self-reported action in modes 1 and 2", async () => {
    const toolCall = registerBashGuard();
    const call = (action?: "read" | "write") =>
      toolCall({
        toolName: "bash",
        toolCallId: `bash-${action ?? "missing"}`,
        input: { action, purpose: "Check output", command: "echo ok" },
      });

    setAccessMode(1);
    expect(await call("read")).toBeUndefined();
    expect(await call("write")).toMatchObject({ block: true });
    expect(await call()).toMatchObject({ block: true });

    setAccessMode(2);
    expect(await call("read")).toBeUndefined();
    expect(await call("write")).toBeUndefined();
  });

  test("blocks changing to an external directory for read Bash", async () => {
    setAccessMode(1);
    const blocked = await registerBashGuard()({
      toolName: "bash",
      toolCallId: "bash-cd-out",
      input: { action: "read", purpose: "Inspect temp", command: "cd /tmp && ls" },
    });

    expect(blocked).toMatchObject({ block: true });
  });

  test("retains project path restrictions in mode 3", () => {
    for (const command of [
      "cd /tmp && echo ok",
      "cat /tmp/example.txt",
      "cat ~/example.txt",
      "cat ../example.txt",
      "git -C /tmp status",
    ]) {
      expect(analyzeBashCommand(command, 3)).toMatchObject({ rule: "workdir" });
    }
  });

  test("allows host path controls in mode 4 but retains non-path safety rules", () => {
    for (const command of [
      "cd /tmp && echo ok",
      "cat /tmp/example.txt",
      "cat ~/example.txt",
      "cat ../example.txt",
      "git -C /tmp status",
      "pnpm --dir ../package test",
    ]) {
      expect(analyzeBashCommand(command, 4)).toBeNull();
    }

    expect(analyzeBashCommand("cd /tmp && python3 script.py", 4)).toMatchObject({
      rule: "python",
    });
    expect(analyzeBashCommand("cd /tmp && bun run dev", 4)).toMatchObject({
      rule: "dev-server",
    });
  });
});
