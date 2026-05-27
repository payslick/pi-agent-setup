import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CheckFailure {
  title: string;
  result: CommandResult;
}

const CHECKABLE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const TYPECHECKABLE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const TEMP_DIR = path.join(".pi", "tmp");
const EXIT_CODE_UNKNOWN = "unknown";
const MULTI_EDIT_TOOL_NAME = "multi-edit";
const PARENT_PATH_SEGMENT = "." + ".";
const RECHECK_DELAY_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.PI_POST_EDIT_CHECK_TIMEOUT_MS ?? 120_000);

let editRevision = 0;
let activeCheckRunCount = 0;
const activeEditToolCallIds = new Set<string>();
const latestRevisionByFile = new Map<string, number>();
const quiescenceWaiters = new Set<() => void>();

function isCheckableFile(filePath: string): boolean {
  return CHECKABLE_EXTENSIONS.has(path.extname(filePath));
}

function isTypecheckableFile(filePath: string): boolean {
  return TYPECHECKABLE_EXTENSIONS.has(path.extname(filePath));
}

function isFileMutationToolName(toolName: string): boolean {
  return toolName === "edit" || toolName === "write" || toolName === MULTI_EDIT_TOOL_NAME;
}

function resolveAffectedFile(root: string, filePath: string): string | null {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot =
    relativePath === "" ||
    (!relativePath.startsWith(PARENT_PATH_SEGMENT) && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function wakeQuiescenceWaiters(): void {
  if (activeEditToolCallIds.size > 0 || activeCheckRunCount > 0) return;
  const waiters = [...quiescenceWaiters];
  quiescenceWaiters.clear();
  for (const waiter of waiters) waiter();
}

function waitForQuiescence(): Promise<void> {
  if (activeEditToolCallIds.size === 0 && activeCheckRunCount === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const waiter = () => resolve();
    quiescenceWaiters.add(waiter);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}

function runCommand(
  executable: string,
  args: readonly string[],
  root: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const command = formatCommand(executable, args);

  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish(1);
    });
    child.on("close", finish);
  });
}

async function packageScripts(root: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = parsed.scripts ?? {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function runScript(
  root: string,
  scriptName: "format" | "check",
  args: readonly string[],
): Promise<CheckFailure[]> {
  const result = await runCommand("bun", ["run", scriptName, "--", ...args], root);
  return result.exitCode === 0 ? [] : [{ title: `bun run ${scriptName} failed`, result }];
}

async function writeAffectedTsconfig(root: string, file: string): Promise<string> {
  const tmpDir = path.join(root, TEMP_DIR);
  await mkdir(tmpDir, { recursive: true });
  const tsconfigPath = path.join(tmpDir, `affected-typecheck-${process.pid}-${randomUUID()}.json`);
  const config = {
    extends: path.join(root, "tsconfig.json"),
    files: [file],
  };
  await writeFile(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return tsconfigPath;
}

async function runAffectedTypecheck(root: string, file: string): Promise<CheckFailure[]> {
  const tsconfigPath = await writeAffectedTsconfig(root, file);
  try {
    const relativeTsconfigPath = path.relative(root, tsconfigPath);
    const result = await runCommand(
      "bun",
      ["run", "typecheck", "--", "--project", relativeTsconfigPath, "--pretty", "false"],
      root,
    );
    return result.exitCode === 0 ? [] : [{ title: "bun run typecheck failed", result }];
  } finally {
    await rm(tsconfigPath, { force: true });
  }
}

async function runPostEditChecks(root: string, file: string): Promise<CheckFailure[]> {
  activeCheckRunCount += 1;
  try {
    const relativeFile = path.relative(root, file);
    const scripts = await packageScripts(root);
    const checks: Array<Promise<CheckFailure[]>> = [];

    if (scripts.format) checks.push(runScript(root, "format", [relativeFile]));
    if (scripts.check) checks.push(runScript(root, "check", [relativeFile]));
    if (scripts.typecheck && isTypecheckableFile(file))
      checks.push(runAffectedTypecheck(root, file));

    return (await Promise.all(checks)).flat();
  } finally {
    activeCheckRunCount = Math.max(0, activeCheckRunCount - 1);
    wakeQuiescenceWaiters();
  }
}

function commandOutput(result: CommandResult): string {
  const parts = [
    `$ ${result.command}`,
    `Exit code: ${result.exitCode ?? EXIT_CODE_UNKNOWN}${result.timedOut ? " (timed out)" : ""}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function failureOutput(root: string, file: string, failures: CheckFailure[]): string {
  return [
    `Post-edit checks failed for ${path.relative(root, file)}.`,
    ...failures.map((failure) => `\n## ${failure.title}\n${commandOutput(failure.result)}`),
  ].join("\n");
}

function reportFailures(
  pi: ExtensionAPI,
  root: string,
  file: string,
  failures: CheckFailure[],
): void {
  pi.sendMessage(
    {
      customType: "post-edit-checks",
      content: failureOutput(root, file, failures),
      display: true,
      details: {
        file: path.relative(root, file),
        failures: failures.map(({ title, result }) => ({
          title,
          command: result.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        })),
      },
    },
    { triggerTurn: true },
  );
}

function reportBackgroundError(pi: ExtensionAPI, root: string, file: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  pi.sendMessage(
    {
      customType: "post-edit-checks",
      content: `Post-edit checks extension failed for ${path.relative(root, file)}: ${message}`,
      display: true,
      details: { file: path.relative(root, file), error: message },
    },
    { triggerTurn: true },
  );
}

function changedFilesFromMultiEdit(event: ToolResultEvent): string[] {
  if (event.toolName !== MULTI_EDIT_TOOL_NAME || event.isError) return [];
  const details = event.details;
  if (!details || typeof details !== "object") return [];
  const changedFiles = (details as { changedFiles?: unknown }).changedFiles;
  return Array.isArray(changedFiles)
    ? changedFiles.filter((file): file is string => typeof file === "string")
    : [];
}

function affectedPathsFromEvent(event: ToolResultEvent): string[] {
  if (event.isError) return [];
  if (isEditToolResult(event) || isWriteToolResult(event)) {
    const filePath = event.input.path;
    return typeof filePath === "string" ? [filePath] : [];
  }
  return changedFilesFromMultiEdit(event);
}

function queueChecksForFile(
  pi: ExtensionAPI,
  root: string,
  filePath: string,
  revision: number,
): void {
  const affectedFile = resolveAffectedFile(root, filePath);
  if (affectedFile === null || !isCheckableFile(affectedFile)) return;

  latestRevisionByFile.set(affectedFile, revision);

  void runChecksForFile(pi, root, affectedFile, revision).catch((error: unknown) => {
    reportBackgroundError(pi, root, affectedFile, error);
  });
}

function reportIfLatest(
  pi: ExtensionAPI,
  root: string,
  file: string,
  revision: number,
  failures: CheckFailure[],
): void {
  if (latestRevisionByFile.get(file) !== revision) return;
  reportFailures(pi, root, file, failures);
}

async function recheckAfterOtherEdits(
  pi: ExtensionAPI,
  root: string,
  file: string,
  revision: number,
): Promise<void> {
  while (true) {
    await waitForQuiescence();
    if (latestRevisionByFile.get(file) !== revision) return;

    const stableRevision = editRevision;
    const failures = await runPostEditChecks(root, file);
    if (editRevision !== stableRevision) continue;
    if (failures.length > 0) reportIfLatest(pi, root, file, revision, failures);
    return;
  }
}

async function runChecksForFile(
  pi: ExtensionAPI,
  root: string,
  file: string,
  revision: number,
): Promise<void> {
  const failures = await runPostEditChecks(root, file);
  if (failures.length === 0) return;

  await delay(RECHECK_DELAY_MS);

  if (editRevision === revision && activeEditToolCallIds.size === 0) {
    reportIfLatest(pi, root, file, revision, failures);
    return;
  }

  await recheckAfterOtherEdits(pi, root, file, revision);
}

export default function postEditChecks(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isFileMutationToolName(event.toolName)) return;
    activeEditToolCallIds.add(event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    if (!isFileMutationToolName(event.toolName)) return;
    activeEditToolCallIds.delete(event.toolCallId);
    wakeQuiescenceWaiters();
  });

  pi.on("tool_result", (event, ctx) => {
    if (isFileMutationToolName(event.toolName)) {
      activeEditToolCallIds.delete(event.toolCallId);
      wakeQuiescenceWaiters();
    }

    const affectedPaths = affectedPathsFromEvent(event);
    if (affectedPaths.length === 0) return undefined;

    editRevision += 1;
    const revision = editRevision;
    for (const filePath of affectedPaths) queueChecksForFile(pi, ctx.cwd, filePath, revision);
    return undefined;
  });
}
