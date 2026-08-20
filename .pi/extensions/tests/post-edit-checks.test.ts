import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import postEditChecks, {
  appendPostEditValidationInstructions,
  buildValidationCommands,
  formatValidationIssueOutput,
  isPostEditValidationIgnored,
  selectUnitTestScript,
  validationCommandWaves,
  validationIssueForResult,
  type CommandResult,
  type ValidationCommand,
} from "../post-edit-checks";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "../post-edit-validation-events";

const temporaryPaths = new Set<string>();

function postEditChecksHarness() {
  const extensionHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      extensionHandlers.set(event, handler);
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      },
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  postEditChecks(pi);
  return {
    trigger(event: string, data: unknown, ctx: ExtensionContext) {
      return extensionHandlers.get(event)?.(data, ctx);
    },
    emit(channel: string, data: unknown) {
      eventHandlers.get(channel)?.(data);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

function scripts(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    format: "oxfmt",
    check: "bun .pi/scripts/check.ts",
    typecheck: "tsgo --noEmit",
    test: "bun test",
    ...overrides,
  };
}

function command(overrides: Partial<ValidationCommand> = {}): ValidationCommand {
  return {
    lane: "check",
    label: "check",
    executable: "bun",
    args: ["run", "check"],
    ...overrides,
  };
}

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "bun run check",
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

describe("post-edit validation commands", () => {
  test("ignores temporary upstream source clones", () => {
    expect(isPostEditValidationIgnored(".pi/tmp/upstream/pi/src/index.ts")).toBe(true);
    expect(isPostEditValidationIgnored(".pi/extensions/index.ts")).toBe(false);
  });

  test("runs format, check, typecheck, and unit tests for TypeScript changes", () => {
    const commands = buildValidationCommands(scripts(), ["src/a.ts", "src/a.test.ts"]);

    expect(commands.map((item) => item.lane)).toEqual([
      "format",
      "check",
      "typecheck",
      "unit-tests",
    ]);
    expect(commands[0]?.args).toEqual(["run", "format", "--", "src/a.test.ts", "src/a.ts"]);
    expect(commands[1]?.args).toEqual(["run", "check", "--", "src/a.test.ts", "src/a.ts"]);
    expect(commands[2]?.args).toEqual(["run", "typecheck"]);
    expect(commands[3]?.args).toEqual(["run", "test"]);
  });

  test("runs formatting before parallel read-only checks", () => {
    const commands = buildValidationCommands(scripts(), ["src/a.ts"]);

    expect(validationCommandWaves(commands).map((wave) => wave.map(({ lane }) => lane))).toEqual([
      ["format"],
      ["check", "typecheck", "unit-tests"],
    ]);
  });

  test("prefers explicit unit-test scripts and can disable tests", () => {
    expect(selectUnitTestScript(scripts({ "test:unit": "vitest run" }))).toBe("test:unit");
    expect(
      buildValidationCommands(scripts({ "test:unit": "vitest run" }), ["src/a.ts"], {
        runUnitTests: false,
      }).map((item) => item.lane),
    ).not.toContain("unit-tests");
  });

  test("skips typecheck for non-TypeScript script changes", () => {
    const commands = buildValidationCommands(scripts(), ["scripts/tool.js"]);

    expect(commands.map((item) => item.lane)).toEqual(["format", "check", "unit-tests"]);
  });
});

describe("awaited post-edit validation", () => {
  test("finishes checks before resolving and suppresses duplicate multi-edit results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "post-edit-await-test-"));
    temporaryPaths.add(root);
    await writeFile(path.join(root, "example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(root, "check.ts"),
      [
        'const output = "validation-count";',
        'const previous = await Bun.file(output).text().catch(() => "0");',
        "await Bun.sleep(20);",
        "await Bun.write(output, String(Number(previous) + 1));",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { check: "bun check.ts" } }),
      "utf8",
    );
    const ctx = { cwd: root, hasUI: false } as ExtensionContext;
    const harness = postEditChecksHarness();
    harness.trigger("session_start", {}, ctx);
    harness.trigger("tool_call", { toolName: "multi-edit", toolCallId: "multi-edit-1" }, ctx);

    let validation: Promise<void> | undefined;
    harness.emit(POST_EDIT_VALIDATION_REQUEST_EVENT, {
      toolCallId: "multi-edit-1",
      affectedPaths: ["example.ts"],
      ctx,
      waitFor(value) {
        validation = value;
      },
    } satisfies PostEditValidationRequest);

    expect(validation).toBeDefined();
    let settled = false;
    void validation?.then(() => {
      settled = true;
    });
    expect(settled).toBeFalse();
    await validation;
    expect(settled).toBeTrue();
    expect(await readFile(path.join(root, "validation-count"), "utf8")).toBe("1");

    harness.trigger(
      "tool_result",
      {
        toolName: "multi-edit",
        toolCallId: "multi-edit-1",
        isError: false,
        input: {},
        content: [],
        details: { changedFiles: ["example.ts"] },
      },
      ctx,
    );
    await Bun.sleep(800);
    expect(await readFile(path.join(root, "validation-count"), "utf8")).toBe("1");
  });
});

describe("post-edit validation reporting", () => {
  test("detects command failures", () => {
    const issue = validationIssueForResult(command(), result({ exitCode: 1, stderr: "boom" }));

    expect(issue?.kind).toBe("error");
    expect(formatValidationIssueOutput(["src/a.ts"], issue!)).toContain(
      "Post-edit validation failed: check failed.",
    );
  });

  test("detects diagnostic output and only excerpts matching lines", () => {
    const issue = validationIssueForResult(
      command({ label: "unit tests", lane: "unit-tests" }),
      result({ stdout: "ok\nwarning: slow test\nok" }),
    );

    expect(issue?.kind).toBe("warning");
    const text = formatValidationIssueOutput(["src/a.test.ts"], issue!);
    expect(text).toContain("Post-edit validation warning: unit tests warning.");
    expect(text).toContain("warning: slow test");
    expect(text).not.toContain("ok\nwarning");
  });

  test("ignores clean summaries, passing test names, and aborted stale commands", () => {
    expect(validationIssueForResult(command(), result({ stdout: "0 warnings" }))).toBeNull();
    expect(
      validationIssueForResult(
        command({ label: "unit tests", lane: "unit-tests" }),
        result({ stderr: "(pass) post-edit validation reporting > detects warnings" }),
      ),
    ).toBeNull();
    expect(
      validationIssueForResult(command(), result({ aborted: true, exitCode: null })),
    ).toBeNull();
  });
});

describe("post-edit validation prompt", () => {
  test("appends validation guidance once", () => {
    const first = appendPostEditValidationInstructions("base prompt");
    const second = appendPostEditValidationInstructions(first);

    expect(first).toContain("Post-edit validation discipline:");
    expect(first).toContain("Multi-edit awaits configured format");
    expect(first).toContain("Never send an assistant response solely to acknowledge one");
    expect(second).toBe(first);
  });
});
