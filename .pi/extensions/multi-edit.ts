import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  generateDiffString,
  getLanguageFromPath,
  highlightCode,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { assertProjectPath, resolveAccessPath } from "./access-mode/path-policy";
import {
  canWrite,
  getAccessMode,
  getAccessProjectRoot,
  subscribeToAccessMode,
  type AccessMode,
} from "./access-mode/state";
import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "./post-edit-validation/events";

const TOOL_NAME = "multi-edit";
const DISABLED_TOOL_NAME = "edit";
const MULTI_EDIT_ACCESS_ERROR = "The current access mode blocks multi-edit.";
const COLLAPSED_BLOCK_LINES = 2;
export const CONSECUTIVE_EDIT_REMINDER =
  "Reminder: this was a consecutive edit call. Plan related replacements together and combine them into as few multi-edit tool calls as possible.";

const editSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text to replace. Must match exactly one non-overlapping region in the original file.",
  }),
  newText: Type.String({ description: "Replacement text." }),
});

const fileSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to the project root." }),
  edits: Type.Array(editSchema, {
    minItems: 1,
    description:
      "Exact text replacements for this file. Each oldText must match a unique, non-overlapping region in the original file.",
  }),
});

const multiEditSchema = Type.Object({
  files: Type.Array(fileSchema, {
    minItems: 1,
    description:
      "Files to edit. Use one entry per file; repeated paths are merged before validation.",
  }),
});

export type MultiEditInput = Static<typeof multiEditSchema>;

export interface MultiEditLineCount {
  path: string;
  addedLines: number;
  removedLines: number;
}

interface MultiEditDiff {
  path: string;
  diff: string;
}

interface MultiEditEditRanges {
  path: string;
  ranges: Array<{ startLine: number; endLine: number }>;
}

interface MultiEditDetails {
  changedFiles: string[];
  lineCounts: MultiEditLineCount[];
  diffs: MultiEditDiff[];
  editRanges: MultiEditEditRanges[];
}

interface AppliedMultiEdit {
  changedFiles: string[];
  originals: Array<{ path: string; content: string }>;
  editRanges: MultiEditEditRanges[];
}

interface Replacement {
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

async function resolveEditablePath(
  root: string,
  projectRoot: string,
  filePath: string,
  mode: AccessMode,
): Promise<string> {
  const absolutePath = resolveAccessPath(root, filePath);
  await assertProjectPath(projectRoot, absolutePath, mode);
  return absolutePath;
}

function countOccurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;
    positions.push(index);
    cursor = index + Math.max(1, needle.length);
  }
  return positions;
}

function assertNoOverlaps(filePath: string, replacements: readonly Replacement[]): void {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.start < previous.end) {
      throw new Error(
        `Overlapping edits for ${filePath}; merge nearby changes into one replacement.`,
      );
    }
  }
}

function applyReplacements(original: string, replacements: readonly Replacement[]): string {
  let output = original;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.newText}${output.slice(replacement.end)}`;
  }
  return output;
}

export function mergeFileInputs(
  files: readonly MultiEditInput["files"][number][],
): MultiEditInput["files"] {
  const byPath = new Map<string, MultiEditInput["files"][number]>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing) existing.edits.push(...file.edits);
    else byPath.set(file.path, { path: file.path, edits: [...file.edits] });
  }
  return [...byPath.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRenderableFiles(input: unknown): MultiEditInput["files"] {
  if (!isRecord(input) || !Array.isArray(input.files)) return [];

  const files: MultiEditInput["files"] = [];
  for (const candidateFile of input.files) {
    if (!isRecord(candidateFile)) continue;

    const edits: MultiEditInput["files"][number]["edits"] = [];
    if (Array.isArray(candidateFile.edits)) {
      for (const candidateEdit of candidateFile.edits) {
        if (!isRecord(candidateEdit)) continue;
        edits.push({
          oldText: typeof candidateEdit.oldText === "string" ? candidateEdit.oldText : "",
          newText: typeof candidateEdit.newText === "string" ? candidateEdit.newText : "",
        });
      }
    }

    files.push({
      path: typeof candidateFile.path === "string" ? candidateFile.path : "",
      edits,
    });
  }
  return files;
}

function sourceLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function visibleBlockLines(
  text: string,
  expanded: boolean,
): {
  lines: string[];
  omittedLines: number;
} {
  const lines = sourceLines(text);
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_BLOCK_LINES);
  return { lines: visibleLines, omittedLines: lines.length - visibleLines.length };
}

export function layoutCodeLine(
  line: string,
  filePath: string,
  expanded: boolean,
  width: number,
  focusColumn?: number,
): string[] {
  const normalizedLine = line.replaceAll("\t", "   ");
  const indentation = normalizedLine.match(/^\s*/)?.[0] ?? "";
  const code = normalizedLine.slice(indentation.length);
  const highlightedCode = highlightCode(code, getLanguageFromPath(filePath))[0] ?? code;
  const highlightedLine = `${indentation}${highlightedCode}`;
  const availableWidth = Math.max(1, width);

  if (!expanded) {
    const lineWidth = visibleWidth(highlightedLine);
    if (lineWidth <= availableWidth || focusColumn === undefined) {
      return [truncateToWidth(highlightedLine, availableWidth, "…")];
    }

    const contentWidth = Math.max(1, availableWidth - 1);
    const normalizedFocus = Math.max(0, Math.min(focusColumn, lineWidth));
    const start = Math.max(
      0,
      Math.min(normalizedFocus - Math.floor(contentWidth / 2), lineWidth - contentWidth),
    );
    if (start === 0) return [truncateToWidth(highlightedLine, availableWidth, "…")];
    return [
      truncateToWidth(`…${sliceByColumn(highlightedLine, start, lineWidth)}`, availableWidth, "…"),
    ];
  }

  const fittedIndentation = truncateToWidth(indentation, Math.max(0, availableWidth - 1), "");
  const codeWidth = Math.max(1, availableWidth - visibleWidth(fittedIndentation));
  const wrappedCode = wrapTextWithAnsi(highlightedCode || " ", codeWidth);
  return wrappedCode.map((segment) => `${fittedIndentation}${segment}`);
}

interface ChangedLine {
  content: string;
  lineNumber: number;
  kind: "added" | "removed";
  focusColumn?: number;
}

function changedOnlyDiff(original: string, updated: string): string {
  const { diff } = generateDiffString(original, updated, 0);
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .join("\n");
}

function changedColumn(line: string, counterpart: string): number {
  let index = 0;
  while (index < line.length && index < counterpart.length && line[index] === counterpart[index]) {
    index += 1;
  }
  return visibleWidth(line.slice(0, index).replaceAll("\t", "   "));
}

function parseChangedLines(diff: string): ChangedLine[] {
  const lines: ChangedLine[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^([+-])\s*(\d+)\s(.*)$/);
    if (!match) continue;
    lines.push({
      lineNumber: Number(match[2]),
      content: match[3] ?? "",
      kind: match[1] === "-" ? "removed" : "added",
    });
  }

  for (let index = 0; index < lines.length; ) {
    if (lines[index]?.kind !== "removed") {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (lines[index]?.kind === "removed") index += 1;
    const addedStart = index;
    while (lines[index]?.kind === "added") index += 1;
    const pairCount = Math.min(addedStart - removedStart, index - addedStart);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const removed = lines[removedStart + pairIndex]!;
      const added = lines[addedStart + pairIndex]!;
      removed.focusColumn = changedColumn(removed.content, added.content);
      added.focusColumn = changedColumn(added.content, removed.content);
    }
  }
  return lines;
}

function visibleChangedLines(
  lines: readonly ChangedLine[],
  expanded: boolean,
): { lines: ChangedLine[]; omittedLines: number } {
  if (expanded) return { lines: [...lines], omittedLines: 0 };
  let added = 0;
  let removed = 0;
  const visibleLines = lines.filter((line) => {
    if (line.kind === "added") {
      added += 1;
      return added <= COLLAPSED_BLOCK_LINES;
    }
    removed += 1;
    return removed <= COLLAPSED_BLOCK_LINES;
  });
  return { lines: visibleLines, omittedLines: lines.length - visibleLines.length };
}

function renderChangedLines(
  lines: readonly ChangedLine[],
  filePath: string,
  expanded: boolean,
  theme: Theme,
  width: number,
  showLineNumbers: boolean,
): string[] {
  const { lines: visibleLines, omittedLines } = visibleChangedLines(lines, expanded);
  const codeWidth = Math.max(1, width - 2);
  const rendered = visibleLines.flatMap((line) => {
    const prefix = showLineNumbers ? `${line.lineNumber} ` : "";
    const availableCodeWidth = Math.max(1, codeWidth - prefix.length);
    const background = line.kind === "removed" ? "toolErrorBg" : "toolSuccessBg";
    return layoutCodeLine(
      line.content,
      filePath,
      expanded,
      availableCodeWidth,
      line.focusColumn,
    ).map((segment) => theme.bg(background, ` ${prefix}${segment || " "} `));
  });
  if (omittedLines > 0) {
    rendered.push(
      theme.fg("muted", ` … ${omittedLines} more line${omittedLines === 1 ? "" : "s"}`),
    );
  }
  return rendered;
}

function formatLineRange(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}–${range.endLine}`;
}

function renderMultiEditInputLines(
  input: unknown,
  expanded: boolean,
  theme: Theme,
  width: number,
  editRanges: readonly MultiEditEditRanges[] = [],
): string[] {
  const files = mergeFileInputs(normalizeRenderableFiles(input));
  const rangesByPath = new Map(editRanges.map((entry) => [entry.path, entry.ranges]));
  const output = [
    `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg(
      "muted",
      `${files.length} file${files.length === 1 ? "" : "s"}`,
    )}`,
  ];

  for (const file of files) {
    output.push("", theme.fg("toolOutput", file.path));
    const fileRanges = rangesByPath.get(file.path) ?? [];
    for (const [index, edit] of file.edits.entries()) {
      const range = fileRanges[index];
      if (range) output.push(theme.fg("muted", formatLineRange(range)));
      const changedLines = parseChangedLines(changedOnlyDiff(edit.oldText, edit.newText));
      if (changedLines.length) {
        output.push(...renderChangedLines(changedLines, file.path, expanded, theme, width, false));
      } else {
        output.push(theme.fg("muted", "(no changes)"));
      }
    }
  }

  return output;
}

export function renderMultiEditInput(
  input: unknown,
  expanded: boolean,
  theme: Theme,
  width = Number.MAX_SAFE_INTEGER,
  editRanges: readonly MultiEditEditRanges[] = [],
): string {
  return renderMultiEditInputLines(input, expanded, theme, width, editRanges).join("\n");
}

class MultiEditInputComponent implements Component {
  private editRanges: readonly MultiEditEditRanges[] = [];

  constructor(
    private readonly input: unknown,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  setEditRanges(editRanges: readonly MultiEditEditRanges[]): void {
    this.editRanges = editRanges;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const horizontalPadding = 1;
    const contentWidth = Math.max(1, width - horizontalPadding * 2);
    const margin = " ".repeat(horizontalPadding);
    const content = renderMultiEditInputLines(
      this.input,
      this.expanded,
      this.theme,
      contentWidth,
      this.editRanges,
    ).map((line) => {
      const fitted = truncateToWidth(line, contentWidth, "");
      return `${margin}${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))}${margin}`;
    });
    return [" ".repeat(width), ...content, " ".repeat(width)];
  }
}

export function renderFinalDiffs(
  diffs: readonly MultiEditDiff[],
  expanded: boolean,
  theme: Theme,
  width = Number.MAX_SAFE_INTEGER,
): string {
  const output: string[] = [];
  for (const { path: filePath, diff } of diffs) {
    const changedLines = parseChangedLines(diff);
    if (!changedLines.length) continue;
    output.push(theme.fg("toolOutput", filePath));
    output.push(...renderChangedLines(changedLines, filePath, expanded, theme, width, true));
  }
  return output.join("\n");
}

class FinalDiffComponent implements Component {
  constructor(
    private readonly diffs: readonly MultiEditDiff[],
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderFinalDiffs(this.diffs, this.expanded, this.theme, width).split("\n");
  }
}

export function countChangedLines(
  original: string,
  updated: string,
): {
  addedLines: number;
  removedLines: number;
} {
  const { diff } = generateDiffString(original, updated, 0);
  const lines = diff.split("\n");
  return {
    addedLines: lines.filter((line) => line.startsWith("+")).length,
    removedLines: lines.filter((line) => line.startsWith("-")).length,
  };
}

export function formatLineCounts(lineCounts: readonly MultiEditLineCount[]): string {
  return lineCounts
    .map(
      ({ path: filePath, addedLines, removedLines }) =>
        `${filePath}  +${addedLines}  -${removedLines}`,
    )
    .join("\n");
}

export function renderLineCounts(lineCounts: readonly MultiEditLineCount[], theme: Theme): string {
  return lineCounts
    .map(({ path: filePath, addedLines, removedLines }) => {
      const added = theme.bg("toolSuccessBg", ` +${addedLines} `);
      const removed = theme.bg("toolErrorBg", ` -${removedLines} `);
      return `${theme.fg("toolOutput", filePath)}  ${added} ${removed}`;
    })
    .join("\n");
}

async function applyMultiEdit(
  root: string,
  projectRoot: string,
  input: MultiEditInput,
  mode: AccessMode,
): Promise<AppliedMultiEdit> {
  const changedFiles: string[] = [];
  const originals: AppliedMultiEdit["originals"] = [];
  const editRanges: MultiEditEditRanges[] = [];
  for (const file of mergeFileInputs(input.files)) {
    const absolutePath = await resolveEditablePath(root, projectRoot, file.path, mode);
    const original = await readFile(absolutePath, "utf8");
    const replacements: Replacement[] = [];
    const ranges: MultiEditEditRanges["ranges"] = [];
    for (const edit of file.edits) {
      if (!edit.oldText) throw new Error(`oldText cannot be empty for ${file.path}.`);
      const matches = countOccurrences(original, edit.oldText);
      if (matches.length !== 1) {
        throw new Error(
          `oldText for ${file.path} must match exactly once; found ${matches.length}. Use a more specific replacement.`,
        );
      }
      const start = matches[0]!;
      const startLine = original.slice(0, start).split("\n").length;
      ranges.push({
        startLine,
        endLine: startLine + Math.max(1, sourceLines(edit.oldText).length) - 1,
      });
      replacements.push({
        oldText: edit.oldText,
        newText: edit.newText,
        start,
        end: start + edit.oldText.length,
      });
    }

    assertNoOverlaps(file.path, replacements);
    editRanges.push({ path: file.path, ranges });
    const updated = applyReplacements(original, replacements);
    if (updated !== original) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, updated, "utf8");
      changedFiles.push(file.path);
      originals.push({ path: file.path, content: original });
    }
  }
  return { changedFiles, originals, editRanges };
}

async function finalizeMultiEdit(
  root: string,
  projectRoot: string,
  applied: AppliedMultiEdit,
  mode: AccessMode,
): Promise<MultiEditDetails> {
  const lineCounts: MultiEditLineCount[] = [];
  const diffs: MultiEditDiff[] = [];
  for (const original of applied.originals) {
    const absolutePath = await resolveEditablePath(root, projectRoot, original.path, mode);
    const formatted = await readFile(absolutePath, "utf8");
    lineCounts.push({ path: original.path, ...countChangedLines(original.content, formatted) });
    diffs.push({ path: original.path, diff: changedOnlyDiff(original.content, formatted) });
  }
  return {
    changedFiles: applied.changedFiles,
    lineCounts,
    diffs,
    editRanges: applied.editRanges,
  };
}

async function awaitPostEditValidation(
  pi: ExtensionAPI,
  toolCallId: string,
  details: MultiEditDetails,
  ctx: ExtensionContext,
): Promise<void> {
  if (details.changedFiles.length === 0) return;
  const validations: Promise<void>[] = [];
  pi.events.emit(POST_EDIT_VALIDATION_REQUEST_EVENT, {
    toolCallId,
    affectedPaths: details.changedFiles,
    ctx,
    waitFor(validation) {
      validations.push(validation);
    },
  } satisfies PostEditValidationRequest);
  await Promise.all(validations);
}

function registerMultiEditTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof multiEditSchema, MultiEditDetails>({
    name: TOOL_NAME,
    label: "Multi Edit",
    description: "Edit any number of files using exact text replacements.",
    promptSnippet: "Edit any number of files using exact text replacements.",
    promptGuidelines: [
      "Use multi-edit for every edit; the built-in edit tool is disabled.",
      "For multi-edit, each oldText must match a unique, non-overlapping region in the original file content.",
    ],
    parameters: multiEditSchema,
    executionMode: "sequential",
    renderShell: "self",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = getAccessMode();
      if (!canWrite(mode)) throw new Error(MULTI_EDIT_ACCESS_ERROR);
      const projectRoot = getAccessProjectRoot(ctx.cwd);
      const applied = await applyMultiEdit(ctx.cwd, projectRoot, params, mode);
      await awaitPostEditValidation(
        pi,
        toolCallId,
        { changedFiles: applied.changedFiles, lineCounts: [], diffs: [], editRanges: [] },
        ctx,
      );
      const details = await finalizeMultiEdit(ctx.cwd, projectRoot, applied, mode);
      return {
        content: [
          {
            type: "text" as const,
            text: details.lineCounts.length ? formatLineCounts(details.lineCounts) : "No changes.",
          },
        ],
        details,
      };
    },
    renderCall(params, theme, context) {
      const component = new MultiEditInputComponent(params, context.expanded, theme);
      context.state.callComponent = component;
      return component;
    },
    renderResult(result, options, theme, context) {
      const output = new Container();
      output.addChild(new Spacer(1));
      if (context.isError) {
        const error = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        output.addChild(new Text(theme.fg("error", error), 1, 0));
        return output;
      }
      const details = result.details;
      const callComponent = context.state.callComponent;
      if (callComponent instanceof MultiEditInputComponent && details?.editRanges) {
        callComponent.setEditRanges(details.editRanges);
      }
      const lineCounts = details?.lineCounts ?? [];
      const diffs = details?.diffs ?? [];
      if (diffs.some(({ diff }) => diff.length > 0)) {
        output.addChild(new FinalDiffComponent(diffs, options.expanded, theme));
        output.addChild(new Spacer(1));
      }
      output.addChild(
        new Text(
          lineCounts.length
            ? renderLineCounts(lineCounts, theme)
            : theme.fg("muted", "No changes."),
          1,
          0,
        ),
      );
      return output;
    },
  });
}

export default function multiEdit(pi: ExtensionAPI): void {
  let previousToolCallWasEdit = false;
  let sessionActive = false;
  const consecutiveEditCallIds = new Set<string>();

  function syncActiveEditTools(): void {
    const writeAllowed = canWrite();
    const activeTools = pi
      .getActiveTools()
      .filter(
        (toolName) => toolName !== DISABLED_TOOL_NAME && (writeAllowed || toolName !== TOOL_NAME),
      );
    if (writeAllowed && !activeTools.includes(TOOL_NAME)) activeTools.push(TOOL_NAME);
    pi.setActiveTools(activeTools);
  }

  let unsubscribe: (() => void) | undefined;
  registerMultiEditTool(pi);

  pi.on("session_start", () => {
    unsubscribe?.();
    unsubscribe = subscribeToAccessMode(() => {
      if (sessionActive) syncActiveEditTools();
    });
    previousToolCallWasEdit = false;
    sessionActive = true;
    consecutiveEditCallIds.clear();
    syncActiveEditTools();
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === DISABLED_TOOL_NAME) {
      return { block: true, reason: "The edit tool is disabled. Use multi-edit instead." };
    }
    if (event.toolName === TOOL_NAME && !canWrite()) {
      return { block: true, reason: MULTI_EDIT_ACCESS_ERROR };
    }

    const isEditCall = event.toolName === TOOL_NAME;
    if (isEditCall && previousToolCallWasEdit) consecutiveEditCallIds.add(event.toolCallId);
    previousToolCallWasEdit = isEditCall;
  });

  pi.on("tool_result", (event) => {
    if (!consecutiveEditCallIds.delete(event.toolCallId)) return;
    return {
      content: [...event.content, { type: "text" as const, text: CONSECUTIVE_EDIT_REMINDER }],
    };
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
