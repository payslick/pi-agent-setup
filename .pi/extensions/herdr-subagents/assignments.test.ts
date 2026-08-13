import { describe, expect, test } from "bun:test";
import { validateImplementationAssignments, writableFilesForSpec } from "./assignments";
import type { SubagentSpec } from "./schemas";
import type { SpawnedSubagentRecord } from "./state";

const implementationSpec = (
  name: string,
  writableFiles: string[],
  contractFiles: string[] = ["app/src/contracts/example.ts"],
): SubagentSpec => ({
  name,
  profile: "backend-implementer",
  workPacket: {
    objective: `Implement ${name}.`,
    writableFiles,
    contractFiles,
    acceptanceCriteria: ["Focused tests pass."],
  },
});

const activeRecord = (
  name: string,
  writableFiles: string[],
  contractFiles: string[] = [],
): SpawnedSubagentRecord => ({
  id: name,
  name,
  tabId: "w1:t2",
  paneId: "w1:p2",
  workspaceId: "w1",
  tabLabel: "BE-implement-test",
  cwd: "/repo",
  promptPreview: name,
  prompted: true,
  profile: "backend-implementer",
  writableFiles,
  contractFiles,
  outboxPath: "/tmp/outbox.jsonl",
  replaceSystemPrompt: false,
  createdAt: 1,
});

describe("implementation assignments", () => {
  test("normalizes writable files inside the project", () => {
    expect(writableFilesForSpec(implementationSpec("one", ["app/src/one.ts"]), "/repo")).toEqual([
      "app/src/one.ts",
    ]);
  });

  test("rejects overlapping requested ownership", () => {
    expect(() =>
      validateImplementationAssignments(
        [
          implementationSpec("one", ["app/src/shared.ts"]),
          implementationSpec("two", ["app/src/shared.ts"]),
        ],
        [],
        "/repo",
      ),
    ).toThrow("app/src/shared.ts is already owned by one.");
  });

  test("rejects overlap with an active worker", () => {
    expect(() =>
      validateImplementationAssignments(
        [implementationSpec("two", ["app/src/shared.ts"])],
        [activeRecord("one", ["app/src/shared.ts"])],
        "/repo",
      ),
    ).toThrow("app/src/shared.ts is already owned by one.");
  });

  test("limits implementation concurrency", () => {
    expect(() =>
      validateImplementationAssignments(
        [implementationSpec("three", ["app/src/three.ts"])],
        [activeRecord("one", ["app/src/one.ts"]), activeRecord("two", ["app/src/two.ts"])],
        "/repo",
      ),
    ).toThrow("At most 2 implementation workers may run at once.");
  });

  test("rejects contract files in writable ownership", () => {
    const spec = implementationSpec("one", ["app/src/contracts/example.ts"]);
    expect(() => validateImplementationAssignments([spec], [], "/repo")).toThrow(
      "app/src/contracts/example.ts is a contract owned by one.",
    );
  });

  test("rejects another worker writing a requested contract", () => {
    expect(() =>
      validateImplementationAssignments(
        [
          implementationSpec("one", ["app/src/one.ts"]),
          implementationSpec("two", ["app/src/contracts/example.ts"], ["app/src/contracts/two.ts"]),
        ],
        [],
        "/repo",
      ),
    ).toThrow("app/src/contracts/example.ts is a contract owned by one.");
  });

  test("rejects writing an active worker contract", () => {
    expect(() =>
      validateImplementationAssignments(
        [implementationSpec("two", ["app/src/shared.ts"])],
        [activeRecord("one", [], ["app/src/shared.ts"])],
        "/repo",
      ),
    ).toThrow("app/src/shared.ts is a contract owned by one.");
  });

  test("rejects unknown profiles from slash-command JSON", () => {
    const spec = { ...implementationSpec("one", ["app/src/one.ts"]), profile: "unknown" };
    expect(() =>
      validateImplementationAssignments([spec as unknown as SubagentSpec], [], "/repo"),
    ).toThrow("Unknown subagent profile: unknown.");
  });

  test("treats unit and E2E test specialists as implementation workers", () => {
    const specs: SubagentSpec[] = [
      {
        ...implementationSpec("unit", ["app/tests/unit/example.test.ts"]),
        profile: "unit-test-implementer",
      },
      {
        ...implementationSpec("e2e", ["app/tests/e2e/example.test.ts"]),
        profile: "e2e-test-implementer",
      },
    ];

    expect(() => validateImplementationAssignments(specs, [], "/repo")).not.toThrow();
  });

  test("requires read-only reviewers to have an empty write scope", () => {
    const spec: SubagentSpec = {
      ...implementationSpec("review", ["app/src/review.ts"]),
      profile: "test-reviewer",
    };
    expect(() => validateImplementationAssignments([spec], [], "/repo")).toThrow(
      "test-reviewer is read-only and cannot own writable files.",
    );
  });
});
