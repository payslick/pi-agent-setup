import { spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { canExecute, getAccessMode, type AccessMode } from "../access-mode/state";
import {
  validationIssueForExpectation,
  type ValidationExpectation,
} from "../herdr-subagents/contract-validation";
import type {
  CommandResult,
  EditedFileRanges,
  ValidationCommand,
  ValidationIssue,
} from "./contracts";

const VALIDATION_PROMPT_MARKER = "Post-edit validation discipline:";
const POST_EDIT_VALIDATION_INSTRUCTIONS = `${VALIDATION_PROMPT_MARKER}
- In access modes 3-4, multi-edit awaits \`bun run format\` for edited files, then \`bun run typecheck\` only when the batch includes .ts/.tsx edits before returning.
- Tests run in the background with \`bun run test\`. Filter edited paths to .ts/.tsx before selecting direct/transitive importing tests from the refreshed project index and edited test files themselves. No eligible edits means no test lookup; no matches means no test run. Incomplete selection is reported, never expanded to the full suite.
- Access modes 1-2 skip validation and cancel active checks. New edits cancel stale results.
- Do not repeat automatic format, typecheck, or tests after an edit. Run validation manually only when explicitly requested or diagnosing a reported failure.
- Failure messages contain only failure diagnostics and triggering edited file ranges. Passing and stale results stay hidden.
- In a declared red phase, active contract tests must fail with every recorded title and output pattern.
- Validation reports are status notifications, not user requests. Never send an assistant response solely to acknowledge one.`;
const configuredTimeout = Number(process.env.PI_POST_EDIT_CHECK_TIMEOUT_MS);
const DEFAULT_COMMAND_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000;

export function isPostEditValidationIgnored(filePath: string): boolean {
  return filePath.split(path.sep).join("/").startsWith(".pi/tmp/upstream/");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function explicitPaths(files: readonly string[]): string[] {
  return [...new Set(files)]
    .sort()
    .map((file) => (path.isAbsolute(file) || file.startsWith("./") ? file : `./${file}`));
}

export function buildValidationCommands(
  mode: AccessMode = getAccessMode(),
  testPaths: readonly string[] = [],
  formatPaths: readonly string[] = [],
): ValidationCommand[] {
  if (!canExecute(mode)) return [];
  const commands: ValidationCommand[] = [
    {
      lane: "format",
      label: "format",
      executable: "bun",
      args: ["run", "format", ...explicitPaths(formatPaths)],
    },
    { lane: "typecheck", label: "typecheck", executable: "bun", args: ["run", "typecheck"] },
  ];
  if (testPaths.length)
    commands.push({
      lane: "unit-tests",
      label: "unit tests",
      executable: "bun",
      args: ["run", "test", ...explicitPaths(testPaths)],
    });
  return commands;
}

export function appendPostEditValidationInstructions(systemPrompt: string): string {
  if (systemPrompt.includes(VALIDATION_PROMPT_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${POST_EDIT_VALIDATION_INSTRUCTIONS}`;
}

function signalCommand(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform === "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

function killAfterGrace(child: ReturnType<typeof spawn>): NodeJS.Timeout {
  const timeout = setTimeout(() => signalCommand(child, "SIGKILL"), 2_000);
  timeout.unref?.();
  return timeout;
}

export function runCommand(
  executable: string,
  args: readonly string[],
  root: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const command = formatCommand(executable, args);

  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer && !aborted && !timedOut) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      resolve({
        command,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
      });
    };

    const terminate = (reason: "timeout" | "abort") => {
      if (settled) return;
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      signalCommand(child, "SIGTERM");
      killTimer ??= killAfterGrace(child);
    };

    const abort = () => terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish(1);
    });
    child.on("close", finish);

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function validationIssueForResult(
  command: ValidationCommand,
  result: CommandResult,
  expectation?: ValidationExpectation,
): ValidationIssue | null {
  if (result.aborted) return null;
  return validationIssueForExpectation(command, result, expectation);
}

function failureDiagnostics(result: CommandResult): string {
  const lines = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).split(/\r?\n/);
  const diagnostics: string[] = [];
  let context: string[] = [];
  let failing = false;
  const noise =
    /^(?:\s*\$|bun test v|Ran \d+ tests?|\s*\d+ (?:pass|fail|skip|todo|expect\(\) calls)|\d+ tests? failed:|error: script .* exited with code)/;
  for (const line of lines) {
    if (/^\((?:pass|skip|todo)\)/.test(line)) {
      context = [];
      failing = false;
      continue;
    }
    if (noise.test(line) || !line.trim()) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line)) {
      context = [line];
      failing = false;
      continue;
    }
    if (
      /^(?:\(fail\)|.*\b(?:error|Error|TypeError|SyntaxError):|.*\berror TS\d+:|# Unhandled error)/.test(
        line,
      )
    ) {
      diagnostics.push(...context, line);
      context = [];
      failing = !line.startsWith("(fail)");
      continue;
    }
    if (failing) {
      diagnostics.push(line);
      continue;
    }
    if (/^\s*(?:\d+\s*[| ]|\^)/.test(line)) context.push(line);
  }
  if (diagnostics.length) return diagnostics.join("\n");
  return stripVTControlCharacters(result.stderr || result.stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !noise.test(line) && !/^\((?:pass|skip|todo)\)/.test(line))
    .join("\n");
}

export function formatValidationIssueOutput(
  files: readonly string[],
  issue: ValidationIssue,
  editRanges: readonly EditedFileRanges[] = [],
): string {
  const edits = files.flatMap((file) => {
    const ranges = editRanges.find((edit) => edit.path === file)?.ranges ?? [];
    return ranges.length
      ? ranges.map((range) => `${file}:${range.startLine}-${range.endLine}`)
      : [file];
  });
  return [
    `Post-edit validation failed: ${issue.title}.`,
    edits.length ? `Edited: ${edits.join(", ")}` : "",
    failureDiagnostics(issue.result),
  ]
    .filter(Boolean)
    .join("\n");
}
