import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

const TOOL_NAME = "multi-edit";
const PARENT_PATH_SEGMENT = "." + ".";

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

type MultiEditInput = Static<typeof multiEditSchema>;

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

function mergeFileInputs(
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

async function applyMultiEdit(
  root: string,
  input: MultiEditInput,
): Promise<{ changedFiles: string[] }> {
  const changedFiles: string[] = [];
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
    }
  }
  return { changedFiles };
}

export default function multiEdit(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Multi Edit",
    description: "Edit any number of files using exact text replacements.",
    promptSnippet: "Edit any number of files using exact text replacements.",
    promptGuidelines: [
      "Use multi-edit instead of multiple edit calls when changing more than one file.",
      "For multi-edit, each oldText must match a unique, non-overlapping region in the original file content.",
    ],
    parameters: multiEditSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = ctx.cwd;
      const { changedFiles } = await applyMultiEdit(root, params);
      const lines = [
        `Successfully edited ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`,
        changedFiles.length
          ? `Changed files:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`
          : "No file contents changed.",
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { changedFiles },
      };
    },
  });
}
