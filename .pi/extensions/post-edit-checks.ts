import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ValidationCommand {
  lane: "format" | "check" | "typecheck" | "unit-tests";
  label: string;
  executable: string;
  args: string[];
}

export interface ValidationIssue {
  kind: "error" | "warning";
  title: string;
  command: ValidationCommand;
  result: CommandResult;
}

interface ValidationBatch {
  revision: number;
  files: string[];
  commands: ValidationCommand[];
}

interface ActiveValidationRun {
  revision: number;
  controller: AbortController;
}

interface DeferredValidationIssue {
  batch: ValidationBatch;
  issue: ValidationIssue;
}

interface ValidationCommandOptions {
  runUnitTests?: boolean;
}

const CHECKABLE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const TYPECHECKABLE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const EXIT_CODE_UNKNOWN = "unknown";
const MULTI_EDIT_TOOL_NAME = "multi-edit";
const PARENT_PATH_SEGMENT = "." + ".";
const STATUS_KEY = "post-edit-checks";
const WARNING_RE = /\b(warnings?|deprecated|deprecation)\b/i;
const VALIDATION_PROMPT_MARKER = "Post-edit validation discipline:";
const POST_EDIT_VALIDATION_INSTRUCTIONS = `${VALIDATION_PROMPT_MARKER}
- Background post-edit validation runs configured format, check, typecheck, and unit-test scripts after file edits.
- Do not run manual format/check/typecheck/test commands just to validate a completed edit batch; passing and stale results stay hidden.
- Run validation manually only when the user explicitly asks or you need a targeted diagnostic after a reported issue.
- Validation issues are delivered privately first so you can fix them; only unresolved issues are shown after your run settles.
- Validation reports are status notifications, not user requests. Never send an assistant response solely to acknowledge one.`;
const DEFAULT_BATCH_DELAY_MS = numberFromEnv("PI_POST_EDIT_BATCH_DELAY_MS", 750);
const DEFAULT_COMMAND_TIMEOUT_MS = numberFromEnv("PI_POST_EDIT_CHECK_TIMEOUT_MS", 120_000);
const DEFAULT_MAX_OUTPUT_CHARS = numberFromEnv("PI_POST_EDIT_MAX_OUTPUT_CHARS", 6_000);
const RUN_UNIT_TESTS = process.env.PI_POST_EDIT_RUN_TESTS !== "0";

let editRevision = 0;
let pendingTimer: NodeJS.Timeout | undefined;
let activeRun: ActiveValidationRun | undefined;
const activeEditToolCallIds = new Set<string>();
const activeEditFallbackTimers = new Map<string, NodeJS.Timeout>();
const editQuiescenceWaiters = new Set<() => void>();
const pendingFiles = new Set<string>();
let deferredValidationIssues: DeferredValidationIssue[] = [];

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isCheckableFile(filePath: string): boolean {
  return CHECKABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isTypecheckableFile(filePath: string): boolean {
  return TYPECHECKABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function relativeFiles(root: string, files: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const file of files) seen.add(normalizeRelativePath(path.relative(root, file)));
  return [...seen].sort();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function scriptCommand(
  lane: ValidationCommand["lane"],
  label: string,
  scriptName: string,
  args: readonly string[] = [],
): ValidationCommand {
  return {
    lane,
    label,
    executable: "bun",
    args: ["run", scriptName, ...(args.length > 0 ? ["--", ...args] : [])],
  };
}

export function selectUnitTestScript(scripts: Record<string, string>): string | undefined {
  return ["test:unit", "unit", "test"].find((scriptName) => Boolean(scripts[scriptName]));
}

export function buildValidationCommands(
  scripts: Record<string, string>,
  files: readonly string[],
  options: ValidationCommandOptions = {},
): ValidationCommand[] {
  const targets = [...new Set(files)].sort();
  const commands: ValidationCommand[] = [];

  if (scripts.format) commands.push(scriptCommand("format", "format", "format", targets));
  if (scripts.check) commands.push(scriptCommand("check", "check", "check", targets));
  if (scripts.typecheck && targets.some(isTypecheckableFile))
    commands.push(scriptCommand("typecheck", "typecheck", "typecheck"));

  const unitTestScript = selectUnitTestScript(scripts);
  if ((options.runUnitTests ?? true) && unitTestScript)
    commands.push(scriptCommand("unit-tests", "unit tests", unitTestScript));

  return commands;
}

export function appendPostEditValidationInstructions(systemPrompt: string): string {
  if (systemPrompt.includes(VALIDATION_PROMPT_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${POST_EDIT_VALIDATION_INSTRUCTIONS}`;
}

export function validationCommandWaves(
  commands: readonly ValidationCommand[],
): ValidationCommand[][] {
  const format = commands.filter((command) => command.lane === "format");
  const checks = commands.filter((command) => command.lane !== "format");
  return [format, checks].filter((wave) => wave.length > 0);
}

function clearPendingTimer(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = undefined;
}

function resolveEditQuiescenceWaiters(): void {
  const waiters = [...editQuiescenceWaiters];
  editQuiescenceWaiters.clear();
  for (const waiter of waiters) waiter();
}

function wakeEditQuiescenceWaiters(): void {
  if (activeEditToolCallIds.size > 0) return;
  resolveEditQuiescenceWaiters();
}

function clearEditFallbackTimer(toolCallId: string): void {
  const timeout = activeEditFallbackTimers.get(toolCallId);
  if (timeout) clearTimeout(timeout);
  activeEditFallbackTimers.delete(toolCallId);
}

function releaseEditToolCall(pi: ExtensionAPI, ctx: ExtensionContext, toolCallId: string): void {
  clearEditFallbackTimer(toolCallId);
  activeEditToolCallIds.delete(toolCallId);
  wakeEditQuiescenceWaiters();
  schedulePendingBatch(pi, ctx);
}

function markEditToolCallActive(pi: ExtensionAPI, ctx: ExtensionContext, toolCallId: string): void {
  activeEditToolCallIds.add(toolCallId);
  setValidationStatus(ctx, undefined);
  clearEditFallbackTimer(toolCallId);
  const timeout = setTimeout(
    () => releaseEditToolCall(pi, ctx, toolCallId),
    DEFAULT_COMMAND_TIMEOUT_MS,
  );
  timeout.unref?.();
  activeEditFallbackTimers.set(toolCallId, timeout);
}

function waitForEditQuiescence(): Promise<void> {
  if (activeEditToolCallIds.size === 0) return Promise.resolve();
  return new Promise((resolve) => editQuiescenceWaiters.add(resolve));
}

function resetValidationState(): void {
  clearPendingTimer();
  activeRun?.controller.abort();
  activeRun = undefined;
  editRevision = 0;
  activeEditToolCallIds.clear();
  for (const timeout of activeEditFallbackTimers.values()) clearTimeout(timeout);
  activeEditFallbackTimers.clear();
  resolveEditQuiescenceWaiters();
  pendingFiles.clear();
  deferredValidationIssues = [];
}

function terminateActiveRun(): void {
  activeRun?.controller.abort();
}

function setValidationStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function schedulePendingBatch(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (activeEditToolCallIds.size > 0 || pendingFiles.size === 0) return;
  clearPendingTimer();
  pendingTimer = setTimeout(() => void launchPendingBatch(pi, ctx), DEFAULT_BATCH_DELAY_MS);
  pendingTimer.unref?.();
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

function killAfterGrace(child: ReturnType<typeof spawn>): NodeJS.Timeout {
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
  timeout.unref?.();
  return timeout;
}

function runCommand(
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
      if (killTimer) clearTimeout(killTimer);
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
      child.kill("SIGTERM");
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

function isCleanWarningLine(line: string): boolean {
  return /\b(?:0|no)\s+warnings?\b/i.test(line) || /^\s*\(pass\)\s/.test(line);
}

function lineHasWarning(line: string): boolean {
  return WARNING_RE.test(line) && !isCleanWarningLine(line);
}

function textHasWarning(text: string): boolean {
  return text.split(/\r?\n/).some(lineHasWarning);
}

function outputHasWarning(result: CommandResult): boolean {
  return textHasWarning(result.stdout) || textHasWarning(result.stderr);
}

export function validationIssueForResult(
  command: ValidationCommand,
  result: CommandResult,
): ValidationIssue | null {
  if (result.aborted) return null;
  if (result.timedOut)
    return { kind: "error", title: `${command.label} timed out`, command, result };
  if (result.exitCode !== 0)
    return { kind: "error", title: `${command.label} failed`, command, result };
  if (outputHasWarning(result))
    return { kind: "warning", title: `${command.label} warning`, command, result };
  return null;
}

function truncateOutput(text: string, maxChars = DEFAULT_MAX_OUTPUT_CHARS): string {
  const value = text.trim();
  if (!value || value.length <= maxChars) return value;
  const headLength = Math.floor(maxChars * 0.35);
  const tailLength = maxChars - headLength;
  return `${value.slice(0, headLength)}\n… truncated ${value.length - maxChars} chars …\n${value.slice(-tailLength)}`;
}

function warningLines(text: string, maxLines = 30): string {
  return text.split(/\r?\n/).filter(lineHasWarning).slice(0, maxLines).join("\n").trim();
}

function outputSection(label: "stdout" | "stderr", text: string, issue: ValidationIssue): string {
  const excerpt =
    issue.kind === "warning" && issue.result.exitCode === 0
      ? warningLines(text) || truncateOutput(text)
      : truncateOutput(text);
  return excerpt ? `${label}:\n${excerpt}` : "";
}

function commandOutput(issue: ValidationIssue): string {
  const result = issue.result;
  const parts = [
    `$ ${result.command}`,
    `Exit code: ${result.exitCode ?? EXIT_CODE_UNKNOWN}${result.timedOut ? " (timed out)" : ""}`,
    outputSection("stdout", result.stdout, issue),
    outputSection("stderr", result.stderr, issue),
  ].filter(Boolean);
  return parts.join("\n");
}

function formatFileList(files: readonly string[]): string {
  const shown = files.slice(0, 8).join(", ");
  const hidden = files.length - 8;
  return hidden > 0 ? `${shown}, … +${hidden} more` : shown;
}

export function formatValidationIssueOutput(
  files: readonly string[],
  issue: ValidationIssue,
): string {
  const prefix =
    issue.kind === "warning" ? "Post-edit validation warning" : "Post-edit validation failed";
  return [
    `${prefix}: ${issue.title}.`,
    files.length > 0 ? `Files: ${formatFileList(files)}` : "",
    "",
    commandOutput(issue),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function validationMessage(
  batch: ValidationBatch,
  issue: ValidationIssue,
  display: boolean,
): Parameters<ExtensionAPI["sendMessage"]>[0] {
  return {
    customType: "post-edit-checks",
    content: formatValidationIssueOutput(batch.files, issue),
    display,
    details: {
      revision: batch.revision,
      files: batch.files,
      kind: issue.kind,
      lane: issue.command.lane,
      command: issue.result.command,
      exitCode: issue.result.exitCode,
      timedOut: issue.result.timedOut,
    },
  };
}

function reportIssue(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  batch: ValidationBatch,
  issue: ValidationIssue,
): void {
  setValidationStatus(ctx, issue.kind === "warning" ? "checks:warning" : "checks:failed");
  deferredValidationIssues.push({ batch, issue });
  pi.sendMessage(validationMessage(batch, issue, false), { triggerTurn: true });
}

function reportDeferredIssues(pi: ExtensionAPI): void {
  const issues = deferredValidationIssues.filter(({ batch }) => batch.revision === editRevision);
  deferredValidationIssues = [];
  for (const { batch, issue } of issues) pi.sendMessage(validationMessage(batch, issue, true));
}

function reportBackgroundError(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  batch: ValidationBatch | undefined,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  setValidationStatus(ctx, "checks:error");
  pi.sendMessage({
    customType: "post-edit-checks",
    content: `Post-edit validation extension failed: ${message}`,
    display: true,
    details: { revision: batch?.revision, files: batch?.files, error: message },
  });
}

function isCurrentBatch(revision: number, signal: AbortSignal): boolean {
  return (
    !signal.aborted &&
    activeRun?.revision === revision &&
    editRevision === revision &&
    activeEditToolCallIds.size === 0
  );
}

async function runValidationBatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  batch: ValidationBatch,
  signal: AbortSignal,
): Promise<void> {
  if (batch.commands.length === 0) {
    setValidationStatus(ctx, undefined);
    return;
  }

  let issues = 0;
  for (const wave of validationCommandWaves(batch.commands)) {
    await Promise.all(
      wave.map(async (command) => {
        const result = await runCommand(command.executable, command.args, ctx.cwd, signal);
        const issue = validationIssueForResult(command, result);
        if (!issue) return;
        await waitForEditQuiescence();
        if (!isCurrentBatch(batch.revision, signal)) return;
        issues += 1;
        reportIssue(pi, ctx, batch, issue);
      }),
    );
    if (!isCurrentBatch(batch.revision, signal)) return;
  }

  await waitForEditQuiescence();
  if (issues === 0 && isCurrentBatch(batch.revision, signal)) setValidationStatus(ctx, undefined);
}

async function launchPendingBatch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  pendingTimer = undefined;
  if (activeEditToolCallIds.size > 0 || pendingFiles.size === 0) {
    schedulePendingBatch(pi, ctx);
    return;
  }

  const files = relativeFiles(ctx.cwd, pendingFiles);
  const revision = editRevision;
  pendingFiles.clear();
  const scripts = await packageScripts(ctx.cwd);
  const commands = buildValidationCommands(scripts, files, { runUnitTests: RUN_UNIT_TESTS });
  const controller = new AbortController();
  const batch: ValidationBatch = { revision, files, commands };
  activeRun = { revision, controller };

  try {
    await runValidationBatch(pi, ctx, batch, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted && isCurrentBatch(revision, controller.signal))
      reportBackgroundError(pi, ctx, batch, error);
  } finally {
    if (activeRun?.revision === revision) activeRun = undefined;
    schedulePendingBatch(pi, ctx);
  }
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

function checkableAffectedFiles(root: string, affectedPaths: readonly string[]): string[] {
  return affectedPaths
    .map((filePath) => resolveAffectedFile(root, filePath))
    .filter((file): file is string => Boolean(file && isCheckableFile(file)));
}

function queueAffectedPaths(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  affectedPaths: string[],
): void {
  const files = checkableAffectedFiles(ctx.cwd, affectedPaths);
  if (files.length === 0) return;

  editRevision += 1;
  terminateActiveRun();
  deferredValidationIssues = [];
  setValidationStatus(ctx, undefined);
  for (const file of files) pendingFiles.add(file);
  schedulePendingBatch(pi, ctx);
}

export default function postEditChecks(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    resetValidationState();
    setValidationStatus(ctx, undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    resetValidationState();
    setValidationStatus(ctx, undefined);
  });

  pi.on("before_agent_start", (event) => {
    const systemPrompt = appendPostEditValidationInstructions(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  pi.on("agent_settled", () => reportDeferredIssues(pi));

  pi.on("tool_call", (event, ctx) => {
    if (!isFileMutationToolName(event.toolName)) return;
    clearPendingTimer();
    markEditToolCallActive(pi, ctx, event.toolCallId);
  });

  pi.on("tool_result", (event, ctx) => {
    const isMutationTool = isFileMutationToolName(event.toolName);
    const affectedPaths = affectedPathsFromEvent(event);
    if (affectedPaths.length > 0) queueAffectedPaths(pi, ctx, affectedPaths);
    if (isMutationTool) releaseEditToolCall(pi, ctx, event.toolCallId);
    return undefined;
  });
}
