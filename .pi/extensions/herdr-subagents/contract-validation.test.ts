import { describe, expect, test } from "bun:test";
import {
  assessValidationResult,
  validateFrozenTestStructures,
  validationExpectationFromEnvironment,
  validationExpectationFromWorkPacket,
  validationIssueForExpectation,
} from "./contract-validation";
import type { CommandResult, ValidationCommand } from "../post-edit-checks";

const command: ValidationCommand = {
  lane: "unit-tests",
  label: "unit tests",
  executable: "bun",
  args: ["run", "test"],
};

const result = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  command: "bun run test",
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

const redExpectation = {
  phase: "red" as const,
  expectedFailingTests: [
    {
      path: "tests/unit/payroll.test.ts",
      title: "calculates payroll from the public API",
      expectedReason: "The controller is not implemented.",
      outputPattern: "PAYROLL_CONTRACT_PENDING",
    },
  ],
};

describe("contract validation expectations", () => {
  test("creates a red expectation from a work packet", () => {
    expect(
      validationExpectationFromWorkPacket({
        taskId: "payroll",
        objective: "Define payroll.",
        writableFiles: ["tests/unit/payroll.test.ts"],
        acceptanceCriteria: ["The contract is red."],
        validationPhase: "red",
        expectedFailingTests: redExpectation.expectedFailingTests,
      }),
    ).toEqual(redExpectation);
  });

  test("loads a red expectation from the Herdr environment", () => {
    expect(
      validationExpectationFromEnvironment({
        PI_VALIDATION_PHASE: "red",
        PI_EXPECTED_FAILING_TESTS: JSON.stringify(redExpectation.expectedFailingTests),
      }),
    ).toEqual(redExpectation);
  });

  test("accepts red validation only when every expected failure is observable", () => {
    expect(
      assessValidationResult(
        result({
          exitCode: 1,
          stderr:
            "calculates payroll from the public API\nError: PAYROLL_CONTRACT_PENDING",
        }),
        redExpectation,
      ),
    ).toEqual({
      accepted: true,
      summary: "All 1 expected contract test failure(s) were observed.",
      missingExpectedFailures: [],
      unexpectedFailures: [],
    });
  });

  test("rejects unrelated failures even when every declared red failure is present", () => {
    const assessment = assessValidationResult(
      result({
        exitCode: 1,
        stderr: [
          "(fail) payroll > calculates payroll from the public API",
          "Error: PAYROLL_CONTRACT_PENDING",
          "(fail) authentication > rejects valid sessions",
        ].join("\n"),
      }),
      redExpectation,
    );

    expect(assessment.accepted).toBeFalse();
    expect(assessment.unexpectedFailures).toEqual([
      "(fail) authentication > rejects valid sessions",
    ]);
  });

  test("rejects red validation without declared failing tests", () => {
    const assessment = assessValidationResult(result({ exitCode: 1 }), {
      phase: "red",
      expectedFailingTests: [],
    });

    expect(assessment.accepted).toBeFalse();
    expect(assessment.summary).toContain("declared failing test");
  });

  test("rejects a green run during the red phase", () => {
    const assessment = assessValidationResult(result(), redExpectation);

    expect(assessment.accepted).toBeFalse();
    expect(assessment.summary).toContain("expected to fail");
  });

  test("rejects red output that does not identify the declared contract test", () => {
    const assessment = assessValidationResult(
      result({ exitCode: 1, stderr: "unrelated test failed" }),
      redExpectation,
    );

    expect(assessment.accepted).toBeFalse();
    expect(assessment.missingExpectedFailures).toEqual([
      "calculates payroll from the public API",
    ]);
  });

  test("never accepts aborted or non-returning validation as contract evidence", () => {
    expect(assessValidationResult(result({ aborted: true, exitCode: null })).accepted).toBeFalse();
    expect(assessValidationResult(result({ exitCode: null })).accepted).toBeFalse();
  });

  test("requires green validation outside an explicit red phase", () => {
    expect(assessValidationResult(result()).accepted).toBeTrue();
    expect(assessValidationResult(result({ exitCode: 1 })).accepted).toBeFalse();
    expect(
      assessValidationResult(result({ exitCode: 1 }), {
        phase: "green",
        expectedFailingTests: [],
      }).accepted,
    ).toBeFalse();
  });

  test("converts an unmet expectation into a normal validation issue", () => {
    expect(
      validationIssueForExpectation(command, result({ exitCode: 1 }), redExpectation),
    ).toMatchObject({
      kind: "error",
      title: "unit tests did not match the red contract",
    });
    expect(
      validationIssueForExpectation(
        command,
        result({ exitCode: 1, stderr: "calculates payroll from the public API PAYROLL_CONTRACT_PENDING" }),
        redExpectation,
      ),
    ).toBeNull();
  });
});

describe("frozen test structure", () => {
  test("accepts suite, test, step, and required text in their declared order", () => {
    const failures = validateFrozenTestStructures(
      [
        {
          path: "tests/e2e/employees.test.ts",
          orderedTitles: [
            "Creating an employee",
            "creates an employee",
            "Open the new employee page",
            "Submit the form",
          ],
          requiredText: ["URLS.employees.new()", "Given: valid employee details"],
        },
      ],
      {
        "tests/e2e/employees.test.ts": [
          'test.describe("Creating an employee", () => {',
          'test("creates an employee", async () => {',
          'test.step("Open the new employee page", async () => {',
          "await page.goto(URLS.employees.new());",
          "// Given: valid employee details",
          'test.step("Submit the form", async () => {});',
        ].join("\n"),
      },
    );

    expect(failures).toEqual([]);
  });

  test("reports missing files, changed titles, and reordered steps", () => {
    const failures = validateFrozenTestStructures(
      [
        {
          path: "tests/e2e/missing.test.ts",
          orderedTitles: ["journey"],
        },
        {
          path: "tests/e2e/employees.test.ts",
          orderedTitles: ["first", "second"],
          requiredText: ["URLS.employees.list()"],
        },
      ],
      {
        "tests/e2e/employees.test.ts": 'test.step("second");\ntest.step("first");',
      },
    );

    expect(failures).toEqual([
      "tests/e2e/missing.test.ts: file is missing",
      'tests/e2e/employees.test.ts: title "second" is out of order',
      'tests/e2e/employees.test.ts: required text "URLS.employees.list()" is missing',
    ]);
  });
});
