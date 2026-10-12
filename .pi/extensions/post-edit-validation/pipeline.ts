import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { canExecute, getAccessMode, subscribeToAccessMode } from "../access-mode/state";
import { validationExpectationFromEnvironment } from "../herdr-subagents/contract-validation";
import { findAffectedTests } from "../project-index/index";
import {
  appendPostEditValidationInstructions, buildValidationCommands, formatValidationIssueOutput,
  isPostEditValidationIgnored, runCommand, validationIssueForResult,
} from "./helpers";
import { POST_EDIT_VALIDATION_REQUEST_EVENT, type PostEditValidationRequest } from "./events";
import type {
  CommandResult, EditedFileRanges, ValidationCommand, ValidationController,
  ValidationDependencies, ValidationIssue,
} from "./contracts";

interface ValidationBatch {
  revision: number;
  edits: EditedFileRanges[];
  ctx: ExtensionContext;
  signal: AbortSignal;
}

const isMutation = (name: string) => ["multi-edit", "edit", "write"].includes(name);
const isTypeScriptPath = (file: string) => /\.tsx?$/.test(file);
const relativePath = (root: string, file: string) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/");

function mergeEdits(pending: Map<string, EditedFileRanges>, request: PostEditValidationRequest): void {
  for (const file of request.affectedPaths) {
    const normalized = relativePath(request.ctx.cwd, file);
    if (isPostEditValidationIgnored(normalized)) continue;
    const supplied = request.editRanges?.find((edit) => relativePath(request.ctx.cwd, edit.path) === normalized);
    const ranges = [...(pending.get(normalized)?.ranges ?? []), ...(supplied?.ranges ?? [])];
    const unique = new Map(ranges.map((range) => [`${range.startLine}:${range.endLine}`, range]));
    pending.set(normalized, {
      path: normalized,
      ranges: [...unique.values()].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine),
    });
  }
}

function editsFromResult(event: ToolResultEvent): { paths: string[]; ranges: EditedFileRanges[] } {
  if (event.isError) return { paths: [], ranges: [] };
  if (isWriteToolResult(event) || isEditToolResult(event)) {
    const file = event.input.path;
    if (typeof file !== "string") return { paths: [], ranges: [] };
    const content = (event.input as { content?: string }).content;
    return {
      paths: [file],
      ranges: [{ path: file, ranges: typeof content === "string" ?
        [{ startLine: 1, endLine: Math.max(1, content.trimEnd().split("\n").length) }] : [] }],
    };
  }
  const details = event.details as { changedFiles?: string[]; editRanges?: EditedFileRanges[] } | undefined;
  return { paths: details?.changedFiles ?? [], ranges: details?.editRanges ?? [] };
}

function failureResult(command: ValidationCommand, error: unknown): CommandResult {
  return {
    command: [command.executable, ...command.args].join(" "), exitCode: 1,
    stdout: "", stderr: error instanceof Error ? error.message : String(error),
    timedOut: false, aborted: false,
  };
}

export default function postEditChecks(
  pi: ExtensionAPI,
  dependencies: ValidationDependencies = {},
): ValidationController {
  const execute = dependencies.runCommand ?? runCommand;
  const pending = new Map<string, EditedFileRanges>();
  const running = new Set<Promise<void>>();
  const awaited = new Set<string>();
  let revision = 0;
  let active: AbortController | undefined;
  let synchronous = Promise.resolve();
  let unsubscribe: (() => void) | undefined;

  const current = (batch: ValidationBatch) =>
    !batch.signal.aborted && revision === batch.revision && canExecute();

  function track(work: Promise<void>): Promise<void> {
    running.add(work);
    void work.then(() => running.delete(work), () => running.delete(work));
    return work;
  }

  function invalidate(clear = false): void {
    revision += 1;
    active?.abort();
    if (clear) { pending.clear(); awaited.clear(); }
  }

  function report(batch: ValidationBatch, issue: ValidationIssue): void {
    if (!current(batch)) return;
    pi.sendMessage({
      customType: "post-edit-checks",
      content: formatValidationIssueOutput(batch.edits.map((edit) => edit.path), issue, batch.edits),
      display: true,
      details: { revision: batch.revision, editRanges: batch.edits, lane: issue.command.lane },
    }, { triggerTurn: true });
  }

  async function run(batch: ValidationBatch, command: ValidationCommand): Promise<void> {
    if (!current(batch)) return;
    let result: CommandResult;
    try {
      result = await execute(command.executable, command.args, batch.ctx.cwd, batch.signal);
    } catch (error) {
      result = failureResult(command, error);
    }
    const expectation = command.lane === "unit-tests" ? validationExpectationFromEnvironment() : undefined;
    const issue = validationIssueForResult(command, result, expectation);
    if (issue) report(batch, issue);
  }

  async function runTests(batch: ValidationBatch): Promise<void> {
    if (!current(batch)) return;
    const selectionCommand: ValidationCommand = {
      lane: "test-selection", label: "test selection", executable: "project-index", args: [],
    };
    try {
      const editedTypeScriptPaths = batch.edits.map((edit) => edit.path).filter(isTypeScriptPath);
      if (!editedTypeScriptPaths.length) return;
      const selection = await findAffectedTests(batch.ctx.cwd, editedTypeScriptPaths, batch.signal);
      if (!current(batch)) return;
      if (!selection.complete) throw new Error(selection.reasons.join("\n"));
      const command = buildValidationCommands(getAccessMode(), selection.tests).find((entry) => entry.lane === "unit-tests");
      if (command) await run(batch, command);
    } catch (error) {
      const result = failureResult(selectionCommand, error);
      const issue = validationIssueForResult(selectionCommand, result);
      if (issue) report(batch, issue);
    } finally {
      if (current(batch)) pending.clear();
    }
  }

  function validate(request: PostEditValidationRequest): Promise<void> {
    if (!canExecute()) return Promise.resolve();
    invalidate();
    mergeEdits(pending, request);
    if (pending.size === 0) return Promise.resolve();
    active = new AbortController();
    const batch: ValidationBatch = {
      revision, ctx: request.ctx, signal: active.signal,
      edits: [...pending.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
    synchronous = synchronous.then(async () => {
      if (!current(batch)) return;
      const editedPaths = batch.edits.map((edit) => edit.path);
      const needsTypecheck = editedPaths.some(isTypeScriptPath);
      const commands = buildValidationCommands(getAccessMode(), [], editedPaths)
        .filter((command) => command.lane !== "typecheck" || needsTypecheck);
      for (const command of commands) await run(batch, command);
      if (current(batch)) void track(runTests(batch));
    });
    return track(synchronous);
  }

  pi.on("session_start", () => {
    invalidate(true);
    unsubscribe?.();
    unsubscribe = subscribeToAccessMode((mode) => { if (!canExecute(mode)) invalidate(true); });
  });
  pi.on("session_shutdown", () => { unsubscribe?.(); invalidate(true); });
  pi.on("before_agent_start", (event) => {
    const systemPrompt = appendPostEditValidationInstructions(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  pi.events.on(POST_EDIT_VALIDATION_REQUEST_EVENT, (data) => {
    const request = data as PostEditValidationRequest;
    awaited.add(request.toolCallId);
    request.waitFor(validate(request));
  });
  pi.on("tool_call", (event) => { if (isMutation(event.toolName)) invalidate(); });
  pi.on("tool_result", async (event, ctx) => {
    if (!isMutation(event.toolName)) return;
    if (event.toolName === "multi-edit" && awaited.delete(event.toolCallId)) return;
    const edits = editsFromResult(event);
    if (!edits.paths.length && pending.size === 0) return;
    await validate({ toolCallId: event.toolCallId, affectedPaths: edits.paths, editRanges: edits.ranges, ctx, waitFor() {} });
  });
  return {
    async whenIdle() {
      while (running.size) await Promise.all([...running]);
    },
  };
}
