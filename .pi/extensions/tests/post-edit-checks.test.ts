import { describe, expect, test } from "bun:test";
import {
  appendPostEditValidationInstructions,
  buildValidationCommands,
  formatValidationIssueOutput,
  selectUnitTestScript,
  validationCommandWaves,
  validationIssueForResult,
  type CommandResult,
  type ValidationCommand,
} from "../post-edit-checks";

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
    expect(first).toContain("Never send an assistant response solely to acknowledge one");
    expect(second).toBe(first);
  });
});
