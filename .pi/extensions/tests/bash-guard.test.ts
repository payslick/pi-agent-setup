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

describe("bash ad hoc script guard", () => {
  test("blocks inline code and interpreter stdin across languages", () => {
    for (const command of [
      "python3 -c 'print(1)'",
      "node --eval 'console.log(1)'",
      "bun -e 'console.log(1)'",
      "deno eval 'console.log(1)'",
      "ruby -e 'puts 1'",
      "perl -e 'print 1'",
      "php -r 'echo 1;'",
      "lua -e 'print(1)'",
      "Rscript -e 'print(1)'",
      "bash -c 'printf ok'",
      "bash -lc 'printf ok'",
      "perl -0777pe 's/a/b/g' file.txt",
      "node -e 'console.log(1)' --help",
      "npx tsx -e 'console.log(1)'",
      "pnpm exec -- ts-node -e 'console.log(1)'",
      "awk '{ print $1 }' file.txt",
      "awk --version '{ print $1 }' file.txt",
      "printf ok | python3",
    ]) {
      expect(analyzeBashCommand(command, 4)).toMatchObject({ rule: "ad-hoc-script" });
    }
  });

  test("blocks wrapped, heredoc, and temporary scripts", () => {
    for (const command of [
      "env FOO=bar time node -e 'console.log(1)'",
      "xargs ruby -e 'puts 1'",
      "python3 <<'PY'\nprint(1)\nPY",
      "node .pi/tmp/replacement.js",
      "bash tmp/one-off.sh",
    ]) {
      expect(analyzeBashCommand(command, 4)).toMatchObject({ rule: "ad-hoc-script" });
    }
  });

  test("allows dedicated commands and existing script invocations", () => {
    for (const command of [
      "rg 'needle' src",
      "jq '.name' package.json",
      "bun run test",
      "bun scripts/check.ts",
      "node scripts/check.js",
      "python3 scripts/check.py",
      "bash scripts/check.sh",
      "awk -f scripts/report.awk input.txt",
      "python3 --version",
      "node --help",
      "awk --version",
    ]) {
      expect(analyzeBashCommand(command, 4)).toBeNull();
    }
  });

  test("returns actionable language-neutral guidance", async () => {
    setAccessMode(4);
    const blocked = await registerBashGuard()({
      toolName: "bash",
      toolCallId: "bash-ad-hoc-script",
      input: { action: "write", purpose: "Replace code", command: "bun -e 'write()'" },
    });

    expect(blocked).toMatchObject({ block: true });
    const reason = (blocked as { reason: string }).reason;
    expect(reason).toContain("The command was not run and no files were changed");
    expect(reason).toContain("Do not retry it in Python, JavaScript/TypeScript");
    expect(reason).toContain("`rg`");
    expect(reason).toContain("`jq`");
    expect(reason).toContain("`multi-edit`");
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

  test("allows standard output suppression through /dev/null in mode 3", async () => {
    const command =
      "git log --oneline --all -25 && git diff --stat main..omry/alerts-v4 2>/dev/null | tail -80";

    expect(analyzeBashCommand(command, 3)).toBeNull();

    setAccessMode(3);
    expect(
      await registerBashGuard()({
        toolName: "bash",
        toolCallId: "bash-dev-null",
        input: { action: "read", purpose: "Inspect branch diffs", command },
      }),
    ).toBeUndefined();
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

    expect(analyzeBashCommand("cd /tmp && python3 -c 'print(1)'", 4)).toMatchObject({
      rule: "ad-hoc-script",
    });
    expect(analyzeBashCommand("cd /tmp && bun run dev", 4)).toMatchObject({
      rule: "dev-server",
    });
  });
});
