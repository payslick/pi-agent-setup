import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { analyzeBashCommand } from "../bash-guard";
import { assertProjectPath, PROJECT_PATH_ERROR } from "./path-policy";
import { getAccessMode, getAccessProjectRoot, type AccessMode } from "./state";

const CHILD_WRITE_TOOL_NAMES = new Set(["edit", "write", "multi-edit"]);
const CHILD_WRITE_ERROR = "The get_data retrieval child cannot edit or write files.";
const CHILD_BASH_ERROR =
  "The get_data retrieval child permits read-only diagnostic Bash commands only.";
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "cd",
  "df",
  "du",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "lsof",
  "printenv",
  "ps",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
  "which",
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  "blame",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "show",
  "status",
]);

function pathInputs(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown>;
  switch (event.toolName) {
    case "read":
      return typeof input.path === "string" ? [input.path] : [];
    case "grep":
    case "find":
    case "ls":
      return typeof input.path === "string" ? [input.path] : ["."];
    default:
      return [];
  }
}

function hasMutatingReadCommandOptions(executable: string, words: readonly string[]): boolean {
  if (executable === "find")
    return words.some((word) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"].includes(
        word,
      ),
    );
  if (executable === "git")
    return words.some(
      (word) =>
        word === "--ext-diff" ||
        word === "--textconv" ||
        word === "--paginate" ||
        word === "-p" ||
        word === "--output" ||
        word.startsWith("--output="),
    );
  return false;
}

function isReadOnlyBashCommand(command: string): boolean {
  if (/(?:^|[^<])>{1,2}|`|\$\(/.test(command)) return false;
  const segments = command.split(/&&|\|\||[;|\n]/).map((segment) => segment.trim());
  return segments.every((segment) => {
    const words = segment.split(/\s+/).filter(Boolean);
    const executable = words[0]?.replace(/^['"]|['"]$/g, "") ?? "";
    if (!READ_ONLY_COMMANDS.has(executable)) return false;
    if (hasMutatingReadCommandOptions(executable, words)) return false;
    return executable !== "git" || READ_ONLY_GIT_COMMANDS.has(words[1] ?? "");
  });
}

function bashBlock(event: ToolCallEvent, mode: AccessMode): ToolCallEventResult | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = (event.input as Record<string, unknown>).command;
  if (typeof command !== "string") {
    return { block: true, reason: "The get_data child requires a Bash command string." };
  }
  const violation = analyzeBashCommand(command, mode, { requireExecute: false });
  if (violation) return { block: true, reason: violation.detail };
  return isReadOnlyBashCommand(command) ? undefined : { block: true, reason: CHILD_BASH_ERROR };
}

export async function childGuardBlock(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  mode: AccessMode = getAccessMode(),
  projectRoot = getAccessProjectRoot(ctx.cwd),
): Promise<ToolCallEventResult | undefined> {
  if (CHILD_WRITE_TOOL_NAMES.has(event.toolName)) {
    return { block: true, reason: CHILD_WRITE_ERROR };
  }
  const blockedBash = bashBlock(event, mode);
  if (blockedBash) return blockedBash;
  if (mode === 4) return undefined;

  try {
    for (const filePath of pathInputs(event)) await assertProjectPath(projectRoot, filePath, mode);
  } catch {
    return {
      block: true,
      reason: `${PROJECT_PATH_ERROR} The get_data child is project-scoped in access mode ${mode}.`,
    };
  }
  return undefined;
}

export default function childGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", childGuardBlock);
}
