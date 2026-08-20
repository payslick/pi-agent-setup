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
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import {
  POST_EDIT_VALIDATION_REQUEST_EVENT,
  type PostEditValidationRequest,
} from "./post-edit-validation-events";

const TOOL_NAME = "multi-edit";
const DISABLED_TOOL_NAME = "edit";
const PARENT_PATH_SEGMENT = "." + ".";
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

interface MultiEditDetails {
  changedFiles: string[];
  lineCounts: MultiEditLineCount[];
}

interface Replacement {
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

function resolveInsideRoot(root: string, filePath: string): string | null {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot =
    relativePath === "" ||
    (!relativePath.startsWith(PARENT_PATH_SEGMENT) && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
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
): string[] {
  const normalizedLine = line.replaceAll("\t", "   ");
  const indentation = normalizedLine.match(/^\s*/)?.[0] ?? "";
  const code = normalizedLine.slice(indentation.length);
  const highlightedCode = highlightCode(code, getLanguageFromPath(filePath))[0] ?? code;
  const availableWidth = Math.max(1, width);

  if (!expanded) {
    return [truncateToWidth(`${indentation}${highlightedCode}`, availableWidth, "…")];
  }

  const fittedIndentation = truncateToWidth(indentation, Math.max(0, availableWidth - 1), "");
  const codeWidth = Math.max(1, availableWidth - visibleWidth(fittedIndentation));
  const wrappedCode = wrapTextWithAnsi(highlightedCode || " ", codeWidth);
  return wrappedCode.map((segment) => `${fittedIndentation}${segment}`);
}

function renderCodeBlock(
  text: string,
  filePath: string,
  expanded: boolean,
  background: "toolErrorBg" | "toolSuccessBg",
  theme: Theme,
  width: number,
): string[] {
  const { lines, omittedLines } = visibleBlockLines(text, expanded);
  const codeWidth = Math.max(1, width - 2);
  const rendered = lines.length
    ? lines.flatMap((line) =>
        layoutCodeLine(line, filePath, expanded, codeWidth).map((segment) =>
          theme.bg(background, ` ${segment || " "} `),
        ),
      )
    : [theme.bg(background, ` ${theme.fg("muted", "(empty)")} `)];
  if (omittedLines > 0) {
    rendered.push(
      theme.fg("muted", ` … ${omittedLines} more line${omittedLines === 1 ? "" : "s"}`),
    );
  }
  return rendered;
}

function renderMultiEditInputLines(
  input: unknown,
  expanded: boolean,
  theme: Theme,
  width: number,
): string[] {
  const files = mergeFileInputs(normalizeRenderableFiles(input));
  const output = [
    `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg(
      "muted",
      `${files.length} file${files.length === 1 ? "" : "s"}`,
    )}`,
  ];

  for (const file of files) {
    output.push("", theme.fg("toolOutput", file.path));
    for (const [index, edit] of file.edits.entries()) {
      if (file.edits.length > 1) {
        output.push(theme.fg("muted", `block ${index + 1}`));
      }
      output.push(
        ...renderCodeBlock(edit.oldText, file.path, expanded, "toolErrorBg", theme, width),
      );
      output.push(
        ...renderCodeBlock(edit.newText, file.path, expanded, "toolSuccessBg", theme, width),
      );
    }
  }

  return output;
}

export function renderMultiEditInput(
  input: unknown,
  expanded: boolean,
  theme: Theme,
  width = Number.MAX_SAFE_INTEGER,
): string {
  return renderMultiEditInputLines(input, expanded, theme, width).join("\n");
}

class MultiEditInputComponent implements Component {
  constructor(
    private readonly input: unknown,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

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
    ).map((line) => {
      const fitted = truncateToWidth(line, contentWidth, "");
      return `${margin}${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))}${margin}`;
    });
    return [" ".repeat(width), ...content, " ".repeat(width)];
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

async function applyMultiEdit(root: string, input: MultiEditInput): Promise<MultiEditDetails> {
  const changedFiles: string[] = [];
  const lineCounts: MultiEditLineCount[] = [];
  for (const file of mergeFileInputs(input.files)) {
    const absolutePath = resolveInsideRoot(root, file.path);
    if (absolutePath === null) throw new Error(`Path is outside the project root: ${file.path}`);

    const original = await readFile(absolutePath, "utf8");
    const replacements: Replacement[] = [];
    for (const edit of file.edits) {
      if (!edit.oldText) throw new Error(`oldText cannot be empty for ${file.path}.`);
      const matches = countOccurrences(original, edit.oldText);
      if (matches.length !== 1) {
        throw new Error(
          `oldText for ${file.path} must match exactly once; found ${matches.length}. Use a more specific replacement.`,
        );
      }
      const start = matches[0]!;
      replacements.push({
        oldText: edit.oldText,
        newText: edit.newText,
        start,
        end: start + edit.oldText.length,
      });
    }

    assertNoOverlaps(file.path, replacements);
    const updated = applyReplacements(original, replacements);
    if (updated !== original) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, updated, "utf8");
      changedFiles.push(file.path);
      lineCounts.push({ path: file.path, ...countChangedLines(original, updated) });
    }
  }
  return { changedFiles, lineCounts };
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

export default function multiEdit(pi: ExtensionAPI): void {
  let previousToolCallWasEdit = false;
  const consecutiveEditCallIds = new Set<string>();

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
      const details = await applyMultiEdit(ctx.cwd, params);
      await awaitPostEditValidation(pi, toolCallId, details, ctx);
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
      return new MultiEditInputComponent(params, context.expanded, theme);
    },
    renderResult(result, _options, theme, context) {
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
      const lineCounts = result.details?.lineCounts ?? [];
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

  pi.on("session_start", () => {
    previousToolCallWasEdit = false;
    consecutiveEditCallIds.clear();
    const activeTools = pi.getActiveTools().filter((toolName) => toolName !== DISABLED_TOOL_NAME);
    if (!activeTools.includes(TOOL_NAME)) activeTools.push(TOOL_NAME);
    pi.setActiveTools(activeTools);
  });

  pi.on("tool_call", (event) => {
    const isEditCall = event.toolName === TOOL_NAME || event.toolName === DISABLED_TOOL_NAME;
    if (isEditCall && previousToolCallWasEdit) consecutiveEditCallIds.add(event.toolCallId);
    previousToolCallWasEdit = isEditCall;
    if (event.toolName !== DISABLED_TOOL_NAME) return;
    return { block: true, reason: "The edit tool is disabled. Use multi-edit instead." };
  });

  pi.on("tool_result", (event) => {
    if (!consecutiveEditCallIds.delete(event.toolCallId)) return;
    return {
      content: [...event.content, { type: "text" as const, text: CONSECUTIVE_EDIT_REMINDER }],
    };
  });
}
