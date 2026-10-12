import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ACCESS_MODE, setAccessMode } from "../access-mode/state";
import postEditChecks from "../post-edit-checks";
import type { CommandResult, EditedFileRanges } from "../post-edit-validation/contracts";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "../post-edit-validation/events";

const editedValue: EditedFileRanges[] = [
  { path: "src/value.ts", ranges: [{ startLine: 2, endLine: 4 }] },
];
const fixtureFiles = {
  "src/value.ts": "export const value = 1;",
  "src/bridge.ts": 'export { value } from "./value";',
  "src/unused.ts": "export const unused = true;",
  "src/component.tsx": "export const component = 1;",
  "src/legacy.js": "export const legacy = 1;",
  "tests/component.test.tsx": 'import { component } from "../src/component";',
  "tests/legacy.test.ts": 'import { legacy } from "../src/legacy.js";',
  "tests/value.test.ts": 'import { value } from "../src/bridge";',
  "tests/unrelated.test.ts": "export const unrelated = true;",
  "README.md": "# Example",
};
type ProcessResult = Partial<CommandResult>;
type ProcessHandler = (args: readonly string[], signal: AbortSignal) => Promise<ProcessResult>;

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function validationFixture(execute: ProcessHandler = async () => ({})) {
  const root = await mkdtemp(path.join(tmpdir(), "post-edit-pipeline-"));
  for (const [file, content] of Object.entries(fixtureFiles)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events = new Map<string, (data: unknown) => void>();
  const messages: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
  const commands: string[][] = [];
  const ctx = { cwd: root, hasUI: false } as ExtensionContext;
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    events: {
      on(event: string, handler: (data: unknown) => void) {
        events.set(event, handler);
      },
    },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0]) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  setAccessMode(3);
  const controller = postEditChecks(pi, {
    async runCommand(executable, args, cwd, signal) {
      expect(executable).toBe("bun");
      expect(cwd).toBe(root);
      commands.push([...args]);
      const aborted = gate<ProcessResult>();
      const onAbort = () => aborted.resolve({ aborted: true, exitCode: null });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        const result = await Promise.race([execute(args, signal), aborted.promise]);
        return {
          command: [executable, ...args].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          ...result,
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
  handlers.get("session_start")?.({}, ctx);
  return {
    commands,
    messages,
    root,
    async validate(edits = editedValue, toolCallId = "edit-1") {
      handlers.get("tool_call")?.({ toolName: "multi-edit", toolCallId }, ctx);
      const waits: Promise<void>[] = [];
      events.get(POST_EDIT_VALIDATION_REQUEST_EVENT)?.({
        toolCallId,
        affectedPaths: edits.map((edit) => edit.path),
        editRanges: edits,
        ctx,
        waitFor(validation) {
          waits.push(validation);
        },
      } satisfies PostEditValidationRequest);
      await Promise.all(waits);
    },
    result(toolCallId = "edit-1") {
      return handlers.get("tool_result")?.(
        {
          toolName: "multi-edit",
          toolCallId,
          isError: false,
          input: {},
          content: [],
          details: { changedFiles: ["src/value.ts"], editRanges: editedValue },
        },
        ctx,
      );
    },
    async noop() {
      handlers.get("tool_call")?.({ toolName: "multi-edit", toolCallId: "noop" }, ctx);
      await handlers.get("tool_result")?.(
        {
          toolName: "multi-edit",
          toolCallId: "noop",
          isError: false,
          input: {},
          content: [],
          details: { changedFiles: [], editRanges: [] },
        },
        ctx,
      );
    },
    settled() {
      handlers.get("agent_settled")?.({}, ctx);
    },
    whenIdle: () => controller.whenIdle(),
    async [Symbol.asyncDispose]() {
      handlers.get("session_shutdown")?.({}, ctx);
      await controller.whenIdle();
      setAccessMode(DEFAULT_ACCESS_MODE);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("post-edit pipeline", () => {
  test("awaits format then typecheck but returns while selected tests are still running", async () => {
    const formatStarted = gate<void>();
    const formatDone = gate<ProcessResult>();
    const typecheckStarted = gate<void>();
    const typecheckDone = gate<ProcessResult>();
    const testsStarted = gate<void>();
    const testsDone = gate<ProcessResult>();
    await using fixture = await validationFixture(async (args) => {
      if (args[1] === "format") {
        formatStarted.resolve();
        return formatDone.promise;
      }
      if (args[1] === "typecheck") {
        typecheckStarted.resolve();
        return typecheckDone.promise;
      }
      testsStarted.resolve();
      return testsDone.promise;
    });
    let returned = false;
    const validation = fixture.validate().then(() => {
      returned = true;
    });
    await formatStarted.promise;
    expect(fixture.commands).toEqual([["run", "format", "./src/value.ts"]]);
    expect(returned).toBe(false);
    formatDone.resolve({});
    await typecheckStarted.promise;
    expect(returned).toBe(false);
    typecheckDone.resolve({});
    await validation;
    await testsStarted.promise;
    expect(returned).toBe(true);
    expect(fixture.commands).toEqual([
      ["run", "format", "./src/value.ts"],
      ["run", "typecheck"],
      ["run", "test", "./tests/value.test.ts"],
    ]);
    testsDone.resolve({});
    await fixture.whenIdle();
    await fixture.result();
    await fixture.whenIdle();
    expect(fixture.commands).toHaveLength(3);
    expect(fixture.messages).toEqual([]);
  });

  test("sends only failure diagnostics and triggering edit ranges without replaying messages", async () => {
    await using fixture = await validationFixture(async (args) =>
      args[1] === "test"
        ? {
            exitCode: 1,
            stdout: "unrelated debug output\n",
            stderr: [
              "bun test v1.3.14",
              "(pass) other test",
              "tests/value.test.ts:",
              "error: expect(received).toBe(expected)",
              "Expected: 2",
              "Received: 1",
              "    at tests/value.test.ts:8:3",
              "(fail) value is doubled",
              " 1 pass",
              " 1 fail",
              "Ran 2 tests across 1 file.",
              'error: script "test" exited with code 1',
            ].join("\n"),
          }
        : {},
    );
    await fixture.validate();
    await fixture.whenIdle();
    fixture.settled();
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]?.display).toBe(true);
    expect(fixture.messages[0]?.content).toBe(
      [
        "Post-edit validation failed: unit tests failed.",
        "Edited: src/value.ts:2-4",
        "tests/value.test.ts:",
        "error: expect(received).toBe(expected)",
        "Expected: 2",
        "Received: 1",
        "    at tests/value.test.ts:8:3",
        "(fail) value is doubled",
      ].join("\n"),
    );
  });

  test("reports synchronous failures while still running both checks and affected tests", async () => {
    await using fixture = await validationFixture(async (args) => ({
      exitCode: args[1] === "test" ? 0 : 1,
      stderr:
        args[1] === "format"
          ? "error: invalid syntax"
          : args[1] === "typecheck"
            ? "src/value.ts(2,3): error TS2322: Type mismatch"
            : "",
    }));
    await fixture.validate();
    expect(fixture.messages.map((message) => message.content)).toEqual([
      "Post-edit validation failed: format failed.\nEdited: src/value.ts:2-4\nerror: invalid syntax",
      "Post-edit validation failed: typecheck failed.\nEdited: src/value.ts:2-4\nsrc/value.ts(2,3): error TS2322: Type mismatch",
    ]);
    await fixture.whenIdle();
    expect(fixture.commands.at(-1)).toEqual(["run", "test", "./tests/value.test.ts"]);
  });

  test("does not run tests when the index finds no importing tests", async () => {
    await using fixture = await validationFixture();
    await fixture.validate([{ path: "src/unused.ts", ranges: [{ startLine: 1, endLine: 1 }] }]);
    await fixture.whenIdle();
    expect(fixture.commands).toEqual([
      ["run", "format", "./src/unused.ts"],
      ["run", "typecheck"],
    ]);
    expect(fixture.messages).toEqual([]);
  });

  test("formats Markdown edits without typechecking or running tests", async () => {
    await using fixture = await validationFixture();
    await fixture.validate([{ path: "README.md", ranges: [{ startLine: 1, endLine: 1 }] }]);
    await fixture.whenIdle();
    expect(fixture.commands).toEqual([["run", "format", "./README.md"]]);
    expect(fixture.messages).toEqual([]);
  });

  test("skips typecheck and test selection for non-TypeScript edits even with importers or unindexed paths", async () => {
    await using fixture = await validationFixture();
    await fixture.validate([
      { path: "src/legacy.js", ranges: [] },
      { path: "src/missing.css", ranges: [] },
    ]);
    await fixture.whenIdle();
    expect(fixture.messages).toEqual([]);
    expect(fixture.commands).toEqual([
      ["run", "format", "./src/legacy.js", "./src/missing.css"],
    ]);
  });

  test("selects affected tests only for TypeScript and TSX edits in mixed batches", async () => {
    await using fixture = await validationFixture();
    await fixture.validate([
      ...editedValue,
      { path: "src/component.tsx", ranges: [] },
      { path: "src/legacy.js", ranges: [] },
      { path: "src/missing.css", ranges: [] },
    ]);
    await fixture.whenIdle();
    expect(fixture.messages).toEqual([]);
    expect(fixture.commands).toEqual([
      [
        "run",
        "format",
        "./src/component.tsx",
        "./src/legacy.js",
        "./src/missing.css",
        "./src/value.ts",
      ],
      ["run", "typecheck"],
      ["run", "test", "./tests/component.test.tsx", "./tests/value.test.ts"],
    ]);
  });

  test("reports incomplete test selection instead of silently running all tests", async () => {
    await using fixture = await validationFixture();
    await fixture.validate([{ path: "src/missing.ts", ranges: [{ startLine: 3, endLine: 3 }] }]);
    await fixture.whenIdle();
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]?.content).toContain("unindexed:src/missing.ts");
    expect(fixture.messages[0]?.content).toContain("src/missing.ts:3-3");
  });

  test("a downgrade cancels active tests and suppresses their failure messages", async () => {
    const started = gate<AbortSignal>();
    const done = gate<ProcessResult>();
    await using fixture = await validationFixture(async (args, signal) => {
      if (args[1] !== "test") return {};
      started.resolve(signal);
      return done.promise;
    });
    await fixture.validate();
    const signal = await started.promise;
    setAccessMode(2);
    await fixture.whenIdle();
    done.resolve({ exitCode: 1, stderr: "error: cancelled test" });
    expect(signal.aborted).toBe(true);
    expect(fixture.messages).toEqual([]);
  });

  test("new edits cancel stale results and retain the affected files in the next test run", async () => {
    const started = gate<void>();
    const oldResult = gate<ProcessResult>();
    let first = true;
    await using fixture = await validationFixture(async (args) => {
      if (args[1] !== "test") return {};
      if (first) {
        first = false;
        started.resolve();
        return oldResult.promise;
      }
      return { exitCode: 1, stderr: "error: latest failure" };
    });
    await fixture.validate();
    await started.promise;
    await fixture.validate(
      [{ path: "src/unused.ts", ranges: [{ startLine: 1, endLine: 1 }] }],
      "edit-2",
    );
    oldResult.resolve({ exitCode: 1, stderr: "error: stale failure" });
    await fixture.whenIdle();
    expect(fixture.commands.at(-1)).toEqual(["run", "test", "./tests/value.test.ts"]);
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]?.content).toContain("latest failure");
    expect(fixture.messages[0]?.content).not.toContain("stale failure");
    expect(fixture.messages[0]?.content).toContain("src/value.ts:2-4");
    expect(fixture.messages[0]?.content).toContain("src/unused.ts:1-1");
  });

  test("resumes interrupted validation after a no-op edit rather than dropping its tests", async () => {
    const started = gate<void>();
    const interrupted = gate<ProcessResult>();
    let first = true;
    await using fixture = await validationFixture(async (args) => {
      if (args[1] !== "test") return {};
      if (first) {
        first = false;
        started.resolve();
        return interrupted.promise;
      }
      return { exitCode: 1, stderr: "error: resumed failure" };
    });
    await fixture.validate();
    await started.promise;
    await fixture.noop();
    await fixture.whenIdle();
    interrupted.resolve({});
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]?.content).toContain("resumed failure");
    expect(fixture.messages[0]?.content).toContain("src/value.ts:2-4");
  });

  test("does not execute any checks in read or write-only access modes", async () => {
    await using fixture = await validationFixture();
    for (const mode of [1, 2] as const) {
      setAccessMode(mode);
      await fixture.validate(editedValue, `edit-${mode}`);
    }
    await fixture.whenIdle();
    expect(fixture.commands).toEqual([]);
    expect(fixture.messages).toEqual([]);
  });
});
