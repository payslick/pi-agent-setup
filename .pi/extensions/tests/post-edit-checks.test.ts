import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForFile(filePath: string): Promise<void> {
  for (let attempts = 0; attempts < 500; attempts += 1) {
    if (await Bun.file(filePath).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("post-edit validation commands", () => {
  test("ignores temporary upstream source clones", () => {
    expect(isPostEditValidationIgnored(".pi/tmp/upstream/pi/src/index.ts")).toBe(true);
    expect(isPostEditValidationIgnored(".pi/extensions/index.ts")).toBe(false);
  });

  test("runs the bun test package script only in execute modes", () => {
    const expected = [
      {
        lane: "unit-tests" as const,
        label: "unit tests",
        executable: "bun",
        args: ["run", "test"],
      },
    ];

    expect(buildValidationCommands(1)).toEqual([]);
    expect(buildValidationCommands(2)).toEqual([]);
    expect(buildValidationCommands(3)).toEqual(expected);
    expect(buildValidationCommands(4)).toEqual(expected);
  });
});

describe("awaited post-edit validation", () => {
  test("finishes bun run test before resolving and suppresses duplicate multi-edit results", async () => {
    setAccessMode(3);
    const root = await mkdtemp(path.join(tmpdir(), "post-edit-await-test-"));
    temporaryPaths.add(root);
    await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"bun test"}}\n', "utf8");
    await writeFile(path.join(root, "example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(root, "validation.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'test("records the validation run", async () => {',
        '  const output = "validation-count";',
        '  const previous = await Bun.file(output).text().catch(() => "0");',
        "  await Bun.sleep(20);",
        "  await Bun.write(output, String(Number(previous) + 1));",
        "  expect(true).toBe(true);",
        "});",
      ].join("\n"),
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

  test("a downgrade cancels queued and active bun run test commands", async () => {
    setAccessMode(3);
    const queuedRoot = await mkdtemp(path.join(tmpdir(), "post-edit-queued-test-"));
    temporaryPaths.add(queuedRoot);
    await writeFile(path.join(queuedRoot, "example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(queuedRoot, "validation.test.ts"),
      'import { test } from "bun:test";\ntest("must not run", () => Bun.write("validation-ran", "1"));\n',
      "utf8",
    );
    const queuedCtx = { cwd: queuedRoot, hasUI: false } as ExtensionContext;
    const queuedHarness = postEditChecksHarness();
    queuedHarness.trigger("session_start", {}, queuedCtx);
    queuedHarness.trigger("tool_call", { toolName: "write", toolCallId: "write-1" }, queuedCtx);
    queuedHarness.trigger(
      "tool_result",
      {
        toolName: "write",
        toolCallId: "write-1",
        isError: false,
        input: { path: "example.ts" },
        content: [],
      },
      queuedCtx,
    );
    setAccessMode(2);
    await Bun.sleep(800);
    expect(await Bun.file(path.join(queuedRoot, "validation-ran")).exists()).toBe(false);
    queuedHarness.shutdown();

    setAccessMode(3);
    const activeRoot = await mkdtemp(path.join(tmpdir(), "post-edit-active-test-"));
    temporaryPaths.add(activeRoot);
    await writeFile(
      path.join(activeRoot, "package.json"),
      '{"scripts":{"test":"bun test"}}\n',
      "utf8",
    );
    await writeFile(path.join(activeRoot, "example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(activeRoot, "validation.test.ts"),
      [
        'import { test } from "bun:test";',
        'test("waits for cancellation", async () => {',
        '  await Bun.write("validation-started", "1");',
        "  await Bun.sleep(30_000);",
        '  await Bun.write("validation-finished", "1");',
        "});",
      ].join("\n"),
      "utf8",
    );
    const activeCtx = { cwd: activeRoot, hasUI: false } as ExtensionContext;
    const activeHarness = postEditChecksHarness();
    activeHarness.trigger("session_start", {}, activeCtx);
    activeHarness.trigger(
      "tool_call",
      { toolName: "multi-edit", toolCallId: "multi-edit-active" },
      activeCtx,
    );
    let validation: Promise<void> | undefined;
    activeHarness.emit(POST_EDIT_VALIDATION_REQUEST_EVENT, {
      toolCallId: "multi-edit-active",
      affectedPaths: ["example.ts"],
      ctx: activeCtx,
      waitFor(value) {
        validation = value;
      },
    } satisfies PostEditValidationRequest);

    expect(validation).toBeDefined();
    await waitForFile(path.join(activeRoot, "validation-started"));
    setAccessMode(2);
    await validation;
    expect(await Bun.file(path.join(activeRoot, "validation-finished")).exists()).toBe(false);
  });
});

describe("post-edit validation reporting", () => {
  test("detects command failures", () => {
    const issue = validationIssueForResult(command(), result({ exitCode: 1, stderr: "boom" }));

    expect(issue?.kind).toBe("error");
    expect(formatValidationIssueOutput(["src/a.ts"], issue!)).toContain(
      "Post-edit validation failed: unit tests failed.",
    );
  });

  test("hides successful, warning-producing, timed-out, and aborted results", () => {
    expect(
      validationIssueForResult(command(), result({ stdout: "warning: slow test" })),
    ).toBeNull();
    expect(
      validationIssueForResult(command(), result({ timedOut: true, exitCode: null })),
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
    expect(first).toContain("access modes 3-4, multi-edit awaits `bun run test`");
    expect(first).toContain("Access modes 1-2 skip post-edit tests");
    expect(first).toContain("Only nonzero test exits are reported");
    expect(first).toContain("Never send an assistant response solely to acknowledge one");
    expect(second).toBe(first);
  });
});
