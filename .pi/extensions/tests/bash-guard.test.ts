import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  clearAccessProjectRoot,
  DEFAULT_ACCESS_MODE,
  initializeAccessProjectRoot,
  setAccessMode,
} from "../access-mode/state";
import bashGuard, { analyzeBashCommand, replaceSearchCommand } from "../bash-guard";

type BashToolCall = {
  toolName: "bash";
  toolCallId: string;
  input: { action?: "read" | "write"; purpose?: string; command: string };
};

function registerBashGuard(cwd = process.cwd()): (event: BashToolCall) => Promise<unknown> {
  let toolCall: ((event: BashToolCall, ctx: { cwd: string }) => Promise<unknown>) | undefined;
  bashGuard({
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "tool_call")
        toolCall = handler as (event: BashToolCall, ctx: { cwd: string }) => Promise<unknown>;
    },
  } as unknown as ExtensionAPI);
  if (!toolCall) throw new Error("bash guard did not register correctly");
  const handler = toolCall;
  return (event) => handler(event, { cwd });
}

async function withBashWorkspace(
  run: (workspace: { root: string; cwd: string; outside: string }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "bash-guard-"));
  const root = path.join(directory, "workspace");
  const cwd = path.join(root, "pi");
  const outside = path.join(directory, "outside");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, ".piroot"), "");
    clearAccessProjectRoot();
    initializeAccessProjectRoot(cwd);
    await run({ root, cwd, outside });
  } finally {
    clearAccessProjectRoot();
    await rm(directory, { recursive: true, force: true });
  }
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

describe("bash && command validation", () => {
  test("reports the first blocked command rather than a later rule category", () => {
    expect(
      analyzeBashCommand("node --eval 'console.log(1)' && cat ../secret.txt", 3),
    ).toMatchObject({ rule: "ad-hoc-script" });
  });

  test.each(["'&&'", '"&&"', "\\&\\&"])(
    "keeps literal %s inside its command arguments",
    (literal) => {
      expect(
        analyzeBashCommand(`printf '%s' ${literal} node --eval harmless && git status`, 3),
      ).toBeNull();
    },
  );

  test("preserves literal && patterns when rewriting chained searches", () => {
    expect(replaceSearchCommand("grep '&&' .pi && git status")).toEqual({
      command: "rg '&&' .pi && git status",
    });
  });

  test("checks a command's paths before evaluating the next command", async () => {
    await withBashWorkspace(async ({ cwd, outside }) => {
      await symlink(outside, path.join(cwd, ".pi"));
      setAccessMode(3);

      expect(
        await registerBashGuard(cwd)({
          toolName: "bash",
          toolCallId: "bash-chain-path-first",
          input: {
            action: "read",
            purpose: "Check chained command boundaries",
            command: "git status .pi && bun run dev",
          },
        }),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining('Rejected Bash path: ".pi"'),
      });
    });
  });

  test("validates later commands without changing an allowed chain", async () => {
    await withBashWorkspace(async ({ cwd }) => {
      await mkdir(path.join(cwd, ".pi"));
      setAccessMode(3);
      const input = {
        action: "write" as const,
        purpose: "Publish Pi setup changes",
        command: 'git add .gitignore .pi && git commit -m "Update setup" && git push origin HEAD',
      };
      const command = input.command;
      const call = registerBashGuard(cwd);

      expect(
        await call({ toolName: "bash", toolCallId: "bash-chain-allowed", input }),
      ).toBeUndefined();
      expect(input.command).toBe(command);
      expect(
        await call({
          toolName: "bash",
          toolCallId: "bash-chain-blocked",
          input: { ...input, command: `${command} && node --eval 'console.log(1)'` },
        }),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("ad hoc interpreter scripts"),
      });
    });
  });
});

describe("bash ad hoc script guard", () => {
  test("allows named Bun scripts to receive temporary input paths", () => {
    expect(
      analyzeBashCommand(
        "bun run check:type-aware --no-ignore " +
          "tmp/alerts-ci-913-fix/tests/e2e/alerts.test.ts " +
          "tmp/alerts-ci-913-fix/tests/unit/services/alert-checks/drain.test.ts",
        3,
      ),
    ).toBeNull();
  });

  test("blocks executing temporary scripts through bun run", () => {
    for (const command of [
      "bun run tmp/replacement.ts",
      "bun run --silent tmp/replacement.ts",
      "bun run .pi/tmp/replacement.ts",
      "bun run temp/replacement.ts input.txt",
    ]) {
      expect(analyzeBashCommand(command, 3)).toMatchObject({ rule: "ad-hoc-script" });
    }
  });

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

describe("Herdr worker Bash isolation", () => {
  test("blocks direct or wrapped Herdr orchestration only for workers", () => {
    for (const command of [
      "herdr agent start --name child pane -- pi",
      "env DEBUG=1 herdr tab create workspace",
      "command /usr/local/bin/herdr agent list",
    ]) {
      expect(analyzeBashCommand(command, 4, { isSubagent: true })).toMatchObject({
        rule: "herdr-orchestration",
      });
    }
    expect(analyzeBashCommand("herdr agent list", 4)).toBeNull();
  });
});

describe("bash guard access modes", () => {
  test.each([2, 3] as const)(
    "allows staging cwd-local .pi beneath the project root in mode %i",
    async (mode) => {
      await withBashWorkspace(async ({ root, cwd, outside }) => {
        await mkdir(path.join(cwd, ".pi"));
        await symlink(outside, path.join(root, ".pi"));
        setAccessMode(mode);

        expect(
          await registerBashGuard(cwd)({
            toolName: "bash",
            toolCallId: "bash-local-pi",
            input: {
              action: "write",
              purpose: "Stage Pi setup changes",
              command: "git add .gitignore .pi",
            },
          }),
        ).toBeUndefined();
      });
    },
  );

  test.each([1, 2, 3] as const)(
    "blocks cwd-local .pi symlinks escaping the project root in mode %i",
    async (mode) => {
      await withBashWorkspace(async ({ root, cwd, outside }) => {
        await mkdir(path.join(root, ".pi"));
        await symlink(outside, path.join(cwd, ".pi"));
        setAccessMode(mode);

        expect(
          await registerBashGuard(cwd)({
            toolName: "bash",
            toolCallId: "bash-escaping-pi",
            input: {
              action: "read",
              purpose: "Inspect Pi setup changes",
              command: "git status --short .pi",
            },
          }),
        ).toMatchObject({
          block: true,
          reason: expect.stringContaining('Rejected Bash path: ".pi"'),
        });
      });
    },
  );

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
