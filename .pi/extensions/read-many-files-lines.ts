import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { replaceSearchCommand } from "./bash-guard";

const TOOL_NAME = "read-many-files-lines";
const EXIT_CODE_ONE = "Exit code: 1";
const FILE_READER_ERROR = `Do not use bash file readers/pagers/post-processors such as cat, head, tail, sed, awk, less, more, nl, wc, cut, sort, uniq, or similar commands. Use ${TOOL_NAME} instead when reading file contents.`;
const FILE_SEARCH_PIPELINE_ERROR =
  "Do not use bash file-listing/search pipelines with file readers/pagers/post-processors such as sort, head, tail, wc, cut, or similar commands.";
const WHOLE_FILE_END = Number.MAX_SAFE_INTEGER;

const readManyFilesLinesSchema = Type.Object({
  specs: Type.Array(
    Type.String({
      description:
        "Filesystem range spec. Formats: path, path:line, path:start:end, path:start:, or path::end. Examples: src/app.ts:1:80, package.json.",
    }),
    { description: "Files and line ranges to read." },
  ),
});

type ReadManyFilesLinesInput = Static<typeof readManyFilesLinesSchema>;

interface FileLineRange {
  raw: string;
  file: string;
  startLine: number;
  endLine: number;
}

interface ShellToken {
  text: string;
  operator: boolean;
}

const commandBreakers = new Set([";", "&&", "||", "|", "(", ")", "&", "<", ">", "\n"]);
const fileReaderCommands = new Set([
  "awk",
  "bat",
  "batcat",
  "cat",
  "cut",
  "head",
  "less",
  "more",
  "nl",
  "od",
  "sed",
  "sort",
  "strings",
  "tac",
  "tail",
  "uniq",
  "wc",
  "xxd",
]);
const shellWrapperCommands = new Set(["bash", "env", "fish", "sh", "zsh"]);
const shellOperators = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);

function parseRange(raw: string): FileLineRange {
  const trimmed = raw.trim();
  const fullRangeMatch = trimmed.match(/^(.+):(\d+):(\d+)$/);
  if (fullRangeMatch) {
    const file = fullRangeMatch[1] ?? "";
    const startLine = Number.parseInt(fullRangeMatch[2] ?? "1", 10);
    const endLine = Number.parseInt(fullRangeMatch[3] ?? String(WHOLE_FILE_END), 10);
    return { raw, file, startLine, endLine };
  }

  const openEndMatch = trimmed.match(/^(.+):(\d+):$/);
  if (openEndMatch) {
    const file = openEndMatch[1] ?? "";
    const startLine = Number.parseInt(openEndMatch[2] ?? "1", 10);
    return { raw, file, startLine, endLine: WHOLE_FILE_END };
  }

  const openStartMatch = trimmed.match(/^(.+)::(\d+)$/);
  if (openStartMatch) {
    const file = openStartMatch[1] ?? "";
    const endLine = Number.parseInt(openStartMatch[2] ?? String(WHOLE_FILE_END), 10);
    return { raw, file, startLine: 1, endLine };
  }

  const singleLineMatch = trimmed.match(/^(.+):(\d+)$/);
  if (singleLineMatch) {
    const file = singleLineMatch[1] ?? "";
    const line = Number.parseInt(singleLineMatch[2] ?? "1", 10);
    return { raw, file, startLine: line, endLine: line };
  }

  return { raw, file: trimmed, startLine: 1, endLine: WHOLE_FILE_END };
}

function resolveInsideRoot(root: string, filePath: string): string | null {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
}

async function readRange(root: string, range: FileLineRange): Promise<string> {
  if (!range.file) return `=== ${range.raw} ===\n[ERROR: empty file path]\n`;
  if (range.startLine < 1) return `=== ${range.raw} ===\n[ERROR: start line must be >= 1]\n`;
  if (range.endLine < range.startLine)
    return `=== ${range.raw} ===\n[ERROR: end line must be >= start line]\n`;

  const absolutePath = resolveInsideRoot(root, range.file);
  if (absolutePath === null)
    return `=== ${range.raw} ===\n[ERROR: path is outside the current working directory]\n`;

  try {
    const text = await readFile(absolutePath, "utf8");
    const lines = text.split(/\r?\n/);
    const endLine = Math.min(range.endLine, lines.length);
    const selectedLines = lines.slice(range.startLine - 1, endLine);
    const body = selectedLines.join("\n");
    return `=== ${range.raw} ===\n${selectedLines.length > 0 ? body : "[no lines in range]"}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `=== ${range.raw} ===\n[ERROR: ${message}]\n`;
  }
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "" = "";

  function pushCurrent() {
    if (!current) return;
    tokens.push({ text: current, operator: false });
    current = "";
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (quote) {
      if (char === "\\" && quote !== "'" && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = "";
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "\\" && next) {
      current += next;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushCurrent();
      tokens.push({ text: `${char}${next}`, operator: true });
      index += 1;
      continue;
    }

    if (shellOperators.has(char)) {
      pushCurrent();
      tokens.push({ text: char, operator: true });
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function commandSegments(tokens: ShellToken[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token.operator && commandBreakers.has(token.text)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    if (!token.operator) current.push(token.text);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function stripLeadingAssignments(words: string[]): string[] {
  const firstCommandIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
  if (firstCommandIndex === -1) return [];
  return words.slice(firstCommandIndex);
}

function normalizeCommandName(value: string): string {
  const parts = value.split("/").filter(Boolean);
  const lastPart = parts.length > 0 ? (parts[parts.length - 1] ?? value) : value;
  return lastPart.replace(/\.(?:cmd|exe|ps1)$/i, "").toLowerCase();
}

function unwrapWrapper(words: string[]): string[] {
  const runnableWords = stripLeadingAssignments(words);
  const first = normalizeCommandName(runnableWords[0] ?? "");

  if (["command", "exec", "time", "noglob"].includes(first)) return runnableWords.slice(1);

  if (first === "env") {
    const commandIndex = runnableWords.findIndex((word, index) => {
      if (index === 0) return false;
      if (word.startsWith("-")) return false;
      return !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
    });
    return commandIndex === -1 ? [] : runnableWords.slice(commandIndex);
  }

  return runnableWords;
}

function hasRawShellWrappedFileRead(command: string): boolean {
  return /(?:^|[\s;&|])(?:bash|sh|zsh|fish|env)\s+[^\n;&|]*\b(?:cat|head|tail|sed|awk|less|more|nl|wc|cut|sort|uniq|od|strings|tac|xxd|bat|batcat)\b/i.test(
    command,
  );
}

function hasBashFileReader(command: string): boolean {
  if (hasRawShellWrappedFileRead(command)) return true;
  return commandSegments(tokenizeShell(command)).some((segment) => {
    const words = unwrapWrapper(segment);
    const commandName = normalizeCommandName(words[0] ?? "");
    if (
      shellWrapperCommands.has(commandName) &&
      words.some((word) => fileReaderCommands.has(normalizeCommandName(word)))
    ) {
      return true;
    }
    return fileReaderCommands.has(commandName);
  });
}

function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function joinShellWords(words: string[]): string {
  return words.map(shellQuote).join(" ");
}

function firstRgCommand(command: string): string | null {
  for (const segment of commandSegments(tokenizeShell(command))) {
    const words = unwrapWrapper(segment);
    if (normalizeCommandName(words[0] ?? "") === "rg") return joinShellWords(words);
  }
  return null;
}

function suggestedRgRetry(command: string): string | null {
  const directRgCommand = firstRgCommand(command);
  if (directRgCommand) return directRgCommand;

  try {
    const rewritten = replaceSearchCommand(command)?.command;
    return rewritten ? firstRgCommand(rewritten) : null;
  } catch {
    return null;
  }
}

function fileReaderBlockReason(command: string): string {
  const rgCommand = suggestedRgRetry(command);
  if (!rgCommand) return FILE_READER_ERROR;

  return `${FILE_SEARCH_PIPELINE_ERROR} Retry with rg directly: \`${rgCommand}\`. Do not pipe it to sort/head; bash output is already truncated. Use ${TOOL_NAME} only when reading file contents.`;
}

export default function readManyFilesLines(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Read many file line ranges",
    description: "Read multiple filesystem files or specific line ranges in one tool call.",
    parameters: readManyFilesLinesSchema,
    promptSnippet:
      "Read multiple files or specific line ranges from the current filesystem in one call",
    promptGuidelines: [
      `Prefer ${TOOL_NAME} over the normal read tool when reading files, especially when reading multiple files or line ranges.`,
      `Use ${TOOL_NAME} instead of bash commands like cat, head, tail, sed, awk, less, or more for viewing file contents.`,
      "For file listing/searching, use rg directly (for example, rg --files or rg -n); do not use find/sort/head pipelines.",
    ],
    async execute(_toolCallId, params: ReadManyFilesLinesInput) {
      const root = process.cwd();
      const ranges = params.specs.map(parseRange);
      const chunks = await Promise.all(ranges.map((range) => readRange(root, range)));
      return {
        content: [{ type: "text" as const, text: chunks.join("\n") }],
        details: { files: ranges.length },
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const command = event.input.command as string;
    if (!hasBashFileReader(command)) return;
    return { block: true, reason: `${fileReaderBlockReason(command)}\n${EXIT_CODE_ONE}` };
  });
}
