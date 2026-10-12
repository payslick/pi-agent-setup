import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_ACCESS_MODE, setAccessMode } from "../access-mode/state";
import postEditChecks, {
  appendPostEditValidationInstructions,
  buildValidationCommands,
  formatValidationIssueOutput,
  isPostEditValidationIgnored,
  validationIssueForResult,
  type CommandResult,
  type ValidationCommand,
} from "../post-edit-checks";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "../post-edit-validation/events";
import type { ValidationExpectation } from "../herdr-subagents/contract-validation";

const temporaryPaths = new Set<string>();
const shutdownHarnesses = new Set<() => void>();

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
  let context: ExtensionContext | undefined;
  const shutdown = () => {
    if (context) extensionHandlers.get("session_shutdown")?.({}, context);
    shutdownHarnesses.delete(shutdown);
  };
  const harness = {
    trigger(event: string, data: unknown, ctx: ExtensionContext) {
      if (event === "session_start") context = ctx;
      return extensionHandlers.get(event)?.(data, ctx);
    },
    emit(channel: string, data: unknown) {
      eventHandlers.get(channel)?.(data);
    },
    shutdown,
  };
  shutdownHarnesses.add(shutdown);
  return harness;
}

afterEach(async () => {
  for (const shutdown of shutdownHarnesses) shutdown();
  shutdownHarnesses.clear();
  setAccessMode(DEFAULT_ACCESS_MODE);
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

function command(overrides: Partial<ValidationCommand> = {}): ValidationCommand {
  return {
    lane: "unit-tests",
    label: "unit tests",
    executable: "bun",
    args: ["run", "test"],
    ...overrides,
  };
}

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "bun run test",
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

  test("runs format and typecheck before selected tests only in execute modes", () => {
    const expected: ValidationCommand[] = [
      { lane: "format", label: "format", executable: "bun", args: ["run", "format", "./src/a.ts"] },
      { lane: "typecheck", label: "typecheck", executable: "bun", args: ["run", "typecheck"] },
      { lane: "unit-tests", label: "unit tests", executable: "bun", args: ["run", "test", "./tests/a.test.ts"] },
    ];
    expect(buildValidationCommands(1, ["tests/a.test.ts"], ["src/a.ts"])).toEqual([]);
    expect(buildValidationCommands(2, ["tests/a.test.ts"], ["src/a.ts"])).toEqual([]);
    expect(buildValidationCommands(3, ["tests/a.test.ts"], ["src/a.ts"])).toEqual(expected);
    expect(buildValidationCommands(4, ["tests/a.test.ts"], ["src/a.ts"])).toEqual(expected);
    expect(buildValidationCommands(3, [], ["src/a.ts"])).toEqual(expected.slice(0, 2));
  });
});

describe("awaited post-edit validation", () => {
  test("never launches bun run test below execute mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "post-edit-skip-test-"));
    temporaryPaths.add(root);
    await writeFile(path.join(root, "example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(root, "validation.test.ts"),
      'import { test } from "bun:test";\ntest("must not run", () => Bun.write("validation-ran", "1"));\n',
      "utf8",
    );
    const ctx = { cwd: root, hasUI: false } as ExtensionContext;
    const harness = postEditChecksHarness();
    setAccessMode(1);
    harness.trigger("session_start", {}, ctx);

    for (const mode of [1, 2] as const) {
      setAccessMode(mode);
      const toolCallId = `multi-edit-${mode}`;
      harness.trigger("tool_call", { toolName: "multi-edit", toolCallId }, ctx);
      let validation: Promise<void> | undefined;
      harness.emit(POST_EDIT_VALIDATION_REQUEST_EVENT, {
        toolCallId,
        affectedPaths: ["example.ts"],
        ctx,
        waitFor(value) {
          validation = value;
        },
      } satisfies PostEditValidationRequest);
      expect(validation).toBeDefined();
      await validation;
    }

    await expect(access(path.join(root, "validation-ran"))).rejects.toThrow();
  });

});

describe("post-edit validation reporting", () => {
  const redExpectation: ValidationExpectation = {
    phase: "red",
    expectedFailingTests: [
      {
        path: "tests/unit/payroll.test.ts",
        title: "calculates payroll through the public API",
        expectedReason: "The implementation is pending.",
        outputPattern: "PAYROLL_CONTRACT_PENDING",
      },
    ],
  };

  test("accepts an active failure only when it matches the declared red contract", () => {
    expect(
      validationIssueForResult(
        command(),
        result({
          exitCode: 1,
          stderr: "calculates payroll through the public API PAYROLL_CONTRACT_PENDING",
        }),
        redExpectation,
      ),
    ).toBeNull();
    expect(validationIssueForResult(command(), result(), redExpectation)?.title).toContain(
      "did not match the red contract",
    );
    expect(
      validationIssueForResult(
        command(),
        result({ exitCode: 1, stderr: "unrelated failure" }),
        redExpectation,
      )?.title,
    ).toContain("did not match the red contract");
  });

  test("detects command failures", () => {
    const issue = validationIssueForResult(command(), result({ exitCode: 1, stderr: "boom" }));

    expect(issue?.kind).toBe("error");
    expect(formatValidationIssueOutput(["src/a.ts"], issue!)).toContain(
      "Post-edit validation failed: unit tests failed.",
    );
  });

  test("reports timeouts but hides successful and aborted results", () => {
    expect(
      validationIssueForResult(command(), result({ stdout: "warning: slow test" })),
    ).toBeNull();
    expect(
      validationIssueForResult(command(), result({ timedOut: true, exitCode: null }))?.title,
    ).toContain("timed out");
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
    expect(first).toContain("bun run format");
    expect(first).toContain("bun run typecheck");
    expect(first).toContain("background");
    expect(first).toContain("transitive");
    expect(first).toContain("edited file ranges");
    expect(first).toContain("declared red phase");
    expect(first).toContain("Never send an assistant response solely to acknowledge one");
    expect(second).toBe(first);
  });
});
