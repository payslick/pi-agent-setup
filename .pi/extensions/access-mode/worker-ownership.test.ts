import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  AGENT_WRITABLE_FILES_ENV,
  assertWorkerWriteOwnership,
  workerHasWriteOwnership,
} from "./worker-ownership";

const environment = {
  PI_SUBAGENT_ID: "agent-1",
  [AGENT_WRITABLE_FILES_ENV]: JSON.stringify([
    "app/src/payroll.ts",
    "app/tests/unit/payroll.test.ts",
  ]),
};

describe("Herdr worker write ownership", () => {
  test("allows only exact files assigned by the main thread", () => {
    expect(() =>
      assertWorkerWriteOwnership(
        "/repo",
        "/repo/app",
        "src/payroll.ts",
        environment,
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkerWriteOwnership(
        "/repo",
        "/repo",
        "app/src/contracts/payroll.ts",
        environment,
      ),
    ).toThrow("not in this Herdr worker's writableFiles");
    expect(() =>
      assertWorkerWriteOwnership("/repo", "/repo", "../outside.ts", {
        PI_SUBAGENT_ID: "agent-1",
        [AGENT_WRITABLE_FILES_ENV]: JSON.stringify(["../outside.ts"]),
      }),
    ).toThrow("must stay inside the project root");
  });

  test("gives read-only workers an explicit empty ownership set", () => {
    expect(() =>
      assertWorkerWriteOwnership("/repo", "/repo", "app/src/payroll.ts", {
        PI_SUBAGENT_ID: "reviewer-1",
        [AGENT_WRITABLE_FILES_ENV]: "[]",
      }),
    ).toThrow("not in this Herdr worker's writableFiles");
  });

  test("rejects malformed ownership environment rather than bypassing enforcement", () => {
    expect(() =>
      assertWorkerWriteOwnership("/repo", "/repo", "app/src/payroll.ts", {
        PI_SUBAGENT_ID: "agent-1",
        [AGENT_WRITABLE_FILES_ENV]: "not-json",
      }),
    ).toThrow("must be a JSON string array");
  });

  test("does not constrain the main thread or legacy workers without an ownership packet", () => {
    expect(workerHasWriteOwnership({})).toBeFalse();
    expect(workerHasWriteOwnership({ PI_SUBAGENT_ID: "legacy" })).toBeFalse();
    expect(() =>
      assertWorkerWriteOwnership(
        "/repo",
        "/repo",
        path.join("app", "src", "payroll.ts"),
        {},
      ),
    ).not.toThrow();
  });
});
