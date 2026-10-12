import type { CommandResult, ValidationCommand, ValidationIssue } from "../post-edit-checks";
import type { FrozenTestStructure, SubagentWorkPacket } from "./schemas";

export interface ValidationExpectation {
  phase: "red" | "green";
  expectedFailingTests: Array<{
    path: string;
    title: string;
    expectedReason: string;
    outputPattern: string;
  }>;
}

export interface ValidationAssessment {
  accepted: boolean;
  summary: string;
  missingExpectedFailures: string[];
  unexpectedFailures: string[];
}

const validExpectedFailure = (
  value: unknown,
): value is ValidationExpectation["expectedFailingTests"][number] => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    typeof entry.title === "string" &&
    typeof entry.expectedReason === "string" &&
    typeof entry.outputPattern === "string"
  );
};

export function validationExpectationFromWorkPacket(
  packet: SubagentWorkPacket | undefined,
): ValidationExpectation | undefined {
  if (!packet?.validationPhase) return undefined;
  return {
    phase: packet.validationPhase,
    expectedFailingTests: (packet.expectedFailingTests ?? []).map((entry) => ({ ...entry })),
  };
}

export function validationExpectationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ValidationExpectation | undefined {
  const phase = environment.PI_VALIDATION_PHASE;
  if (phase !== "red" && phase !== "green") return undefined;
  let expectedFailingTests: ValidationExpectation["expectedFailingTests"] = [];
  const serialized = environment.PI_EXPECTED_FAILING_TESTS;
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(validExpectedFailure)) return undefined;
      expectedFailingTests = parsed.map((entry) => ({ ...entry }));
    } catch {
      return undefined;
    }
  }
  return { phase, expectedFailingTests };
}

export function assessValidationResult(
  result: Pick<CommandResult, "exitCode" | "stdout" | "stderr" | "aborted">,
  expectation?: ValidationExpectation,
): ValidationAssessment {
  if (result.aborted || result.exitCode === null) {
    return {
      accepted: false,
      summary: result.aborted ? "Validation was aborted." : "Validation did not return an exit code.",
      missingExpectedFailures: [],
      unexpectedFailures: [],
    };
  }
  if (expectation?.phase !== "red") {
    return {
      accepted: result.exitCode === 0,
      summary: result.exitCode === 0 ? "Validation passed." : "Validation was expected to be green.",
      missingExpectedFailures: [],
      unexpectedFailures: [],
    };
  }
  if (expectation.expectedFailingTests.length === 0) {
    return {
      accepted: false,
      summary: "Red validation requires at least one declared failing test.",
      missingExpectedFailures: [],
      unexpectedFailures: [],
    };
  }
  if (result.exitCode === 0) {
    return {
      accepted: false,
      summary: "Contract tests were expected to fail during the red phase but validation passed.",
      missingExpectedFailures: expectation.expectedFailingTests.map((entry) => entry.title),
      unexpectedFailures: [],
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const missingExpectedFailures = expectation.expectedFailingTests
    .filter(
      (entry) => !output.includes(entry.title) || !output.includes(entry.outputPattern),
    )
    .map((entry) => entry.title);
  const unexpectedFailures = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\(fail\)\s/.test(line))
    .filter(
      (line) => !expectation.expectedFailingTests.some((entry) => line.includes(entry.title)),
    );
  if (output.includes("# Unhandled error between tests"))
    unexpectedFailures.push("# Unhandled error between tests");
  const accepted = missingExpectedFailures.length === 0 && unexpectedFailures.length === 0;
  return {
    accepted,
    summary: accepted
      ? `All ${expectation.expectedFailingTests.length} expected contract test failure(s) were observed.`
      : `${missingExpectedFailures.length} expected failure(s) missing; ${unexpectedFailures.length} unrelated failure(s) observed.`,
    missingExpectedFailures,
    unexpectedFailures,
  };
}

const validationIssueTitle = (
  command: ValidationCommand,
  result: CommandResult,
  expectation?: ValidationExpectation,
): string => {
  if (expectation?.phase === "red") return `${command.label} did not match the red contract`;
  if (result.timedOut) return `${command.label} timed out`;
  return `${command.label} failed`;
};

export function validationIssueForExpectation(
  command: ValidationCommand,
  result: CommandResult,
  expectation?: ValidationExpectation,
): ValidationIssue | null {
  const assessment = assessValidationResult(result, expectation);
  if (assessment.accepted) return null;
  return {
    kind: "error",
    title: validationIssueTitle(command, result, expectation),
    command,
    result,
  };
}

export function validateFrozenTestStructures(
  structures: readonly FrozenTestStructure[],
  sources: Readonly<Record<string, string>>,
): string[] {
  const failures: string[] = [];
  for (const structure of structures) {
    const source = sources[structure.path];
    if (source === undefined) {
      failures.push(`${structure.path}: file is missing`);
      continue;
    }
    let cursor = 0;
    for (const title of structure.orderedTitles) {
      const index = source.indexOf(title, cursor);
      if (index >= 0) {
        cursor = index + title.length;
        continue;
      }
      failures.push(
        source.includes(title)
          ? `${structure.path}: title "${title}" is out of order`
          : `${structure.path}: title "${title}" is missing`,
      );
    }
    for (const text of structure.requiredText ?? []) {
      if (!source.includes(text))
        failures.push(`${structure.path}: required text "${text}" is missing`);
    }
  }
  return failures;
}
