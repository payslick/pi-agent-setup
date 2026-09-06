import type {
  ExtensionAPI,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { PROJECT_PATH_ERROR, projectPathIsAllowed } from "./access-mode/path-policy";
import { isBashActionAllowed } from "./access-mode/tool-policy";
import {
  canAccessHostPaths,
  canExecute,
  getAccessMode,
  getAccessProjectRoot,
  type AccessMode,
} from "./access-mode/state";

type ToolResultPatch = {
  content?: ToolResultEvent["content"];
  details?: ToolResultEvent["details"];
  isError?: boolean;
};

const BASH_ACCESS_ERROR = "The current access mode blocks Bash execution.";
const WORKDIR_ERROR =
  "work only in the current dir, never use `cd ..`, `cd /`, `git -C`, or other directory-changing tricks";
const AD_HOC_SCRIPT_ERROR = `Blocked: ad hoc interpreter scripts are not allowed when dedicated tools or simple commands can perform the task.
The command was not run and no files were changed. Do not retry it in Python, JavaScript/TypeScript, Bun, Node, Ruby, Perl, AWK, shell, another language, a heredoc, or a temporary script.
Use structured read/search tools, \`rg\` for searching and filtering, \`jq\` for JSON, \`multi-edit\` for existing-file changes, or an existing checked-in project command.`;
const DEV_SERVER_ERROR = "never run the dev server; use `bun scripts/find-port.ts --wait` instead";
const EXTENSION_FAILURE_ERROR = "bash guard extension failed";
const EXIT_CODE_ONE = "Exit code: 1";
const EXIT_CODE_UNKNOWN = "Exit code: unknown";
const RG_REPLACEMENT_PREFIX = "using rg instead";
const UNSUPPORTED_FIND_REWRITE_ERROR = "find command uses unsupported arguments for rg rewrite";
const FIND_RG_GUIDANCE =
  "Use `rg --files [path]` directly (`-type f` is implicit). Map `-name` or `-path` to `-g '<glob>'`, pruning/exclusion to `-g '!<glob>'`, and `-maxdepth` to `--max-depth <n>`. " +
  "Example: `rg --files --hidden --no-ignore . -g '*.ts' -g '!node_modules/**'`. Do not retry the `find` command.";

export interface RuleViolation {
  rule: "access-mode" | "workdir" | "ad-hoc-script" | "dev-server";
  detail: string;
}

export interface BashAnalysisOptions {
  requireExecute?: boolean;
}

interface ShellToken {
  text: string;
  quoted: boolean;
}

interface RebuiltShellToken {
  text: string;
  operator: boolean;
}

interface SearchRewriteResult {
  command: string;
}

interface SegmentRewriteResult {
  words: string[];
  changed: boolean;
}

interface SplitCommandWords {
  assignments: string[];
  commandWords: string[];
}

export class SearchRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchRewriteError";
  }
}

const shellOperators = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);
const commandBreakers = new Set([";", "&&", "||", "|", "(", ")", "&", "<", ">", "\n"]);
const pythonCommands = new Set(["python", "python3", "python2", "pythonw", "pypy", "pypy3", "py"]);
const shellCommands = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const pythonInlineFlags = new Set(["-c"]);
const shellInlineFlags = new Set(["-c"]);
const inlineFlagCommands = new Map<string, Set<string>>([
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["bun", new Set(["-e", "--eval", "-p", "--print"])],
  ["tsx", new Set(["-e", "--eval", "-p", "--print"])],
  ["ts-node", new Set(["-e", "--eval", "-p", "--print"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e", "-E"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
  ["r", new Set(["-e", "--expr"])],
  ["rscript", new Set(["-e", "--expr"])],
]);
const interpreterInfoFlags = new Set(["-h", "--help", "-v", "-V", "--version"]);
const temporaryScriptPathPattern = /(?:^|\/)(?:\.pi\/tmp|tmp|temp)\//i;
const devPackageManagers = new Set(["npm", "pnpm", "yarn"]);
const devFrameworkCommands = new Set(["next", "vite", "nuxt", "astro", "remix"]);
const pathOptionNames = new Set([
  "--cwd",
  "--prefix",
  "--dir",
  "--directory",
  "--work-tree",
  "--git-dir",
  "--pathspec-from-file",
]);
const pathAssignmentNames = new Set(["GIT_DIR", "GIT_WORK_TREE", "PWD", "OLDPWD", "INIT_CWD"]);
const destructiveGhApiFlags = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const grepSearchCommands = new Set(["grep", "egrep", "fgrep", "ggrep", "git-grep"]);
const directSearchCommands = new Set(["ag", "ack", "sift", "pt", "the_silver_searcher"]);
const rgReplacementByToolCallId = new Map<string, string>();

function block(reason: string): ToolCallEventResult {
  return { block: true, reason: `${reason}\n${EXIT_CODE_ONE}` };
}

function normalizeCommandName(value: string): string {
  const withoutPath = value.split("/").filter(Boolean).at(-1) ?? value;
  const withoutExtension = withoutPath.replace(/\.(?:cmd|exe|ps1)$/i, "");
  return withoutExtension.toLowerCase();
}

function shellTokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "" = "";
  let tokenQuoted = false;

  function pushCurrent() {
    if (!current && !tokenQuoted) return;
    tokens.push({ text: current, quoted: tokenQuoted });
    current = "";
    tokenQuoted = false;
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
        tokenQuoted = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      tokenQuoted = true;
      continue;
    }

    if (char === "\\" && next) {
      current += next;
      index += 1;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushCurrent();
      tokens.push({ text: `${char}${next}`, quoted: false });
      index += 1;
      continue;
    }

    if (shellOperators.has(char)) {
      pushCurrent();
      tokens.push({ text: char, quoted: false });
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "#" && !current) {
      while (index < command.length && command[index] !== "\n") index += 1;
      index -= 1;
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
    if (commandBreakers.has(token.text)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token.text);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function stripLeadingAssignments(words: string[]): string[] {
  const firstCommandIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
  if (firstCommandIndex === -1) return [];
  return words.slice(firstCommandIndex);
}

function commandWord(words: string[]): string {
  const runnableWords = stripLeadingAssignments(words);
  return normalizeCommandName(runnableWords[0] ?? "");
}

function splitCommandWords(words: string[]): SplitCommandWords {
  const firstCommandIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
  if (firstCommandIndex === -1) return { assignments: words, commandWords: [] };
  return {
    assignments: words.slice(0, firstCommandIndex),
    commandWords: words.slice(firstCommandIndex),
  };
}

function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function joinShellTokens(tokens: RebuiltShellToken[]): string {
  return tokens
    .reduce((command, token) => {
      if (token.text === "\n") return `${command.trimEnd()}\n`;
      if (token.operator) return `${command.trimEnd()} ${token.text} `;
      const separator = command && !command.endsWith(" ") && !command.endsWith("\n") ? " " : "";
      return `${command}${separator}${shellQuote(token.text)}`;
    }, "")
    .trim();
}

function rewriteGrepWords(words: string[]): string[] {
  const command = normalizeCommandName(words[0] ?? "");
  const rewritten = command === "fgrep" ? ["rg", "-F"] : ["rg"];

  for (const word of words.slice(1)) {
    if (["-R", "-r", "--recursive"].includes(word)) continue;
    if (["-E", "--extended-regexp"].includes(word)) continue;
    if (word.startsWith("--include=")) {
      rewritten.push("-g", word.slice("--include=".length));
      continue;
    }
    if (word.startsWith("--exclude=")) {
      rewritten.push("-g", `!${word.slice("--exclude=".length)}`);
      continue;
    }
    if (/^-[A-Za-z]+$/.test(word) && /[RrE]/.test(word)) {
      const flags = word.slice(1).replace(/[RrE]/g, "");
      if (flags) rewritten.push(`-${flags}`);
      continue;
    }
    rewritten.push(word);
  }

  return rewritten;
}

function unsupportedFindArgument(argument: string): never {
  throw new SearchRewriteError(
    `${UNSUPPORTED_FIND_REWRITE_ERROR}: ${argument}\n${FIND_RG_GUIDANCE}`,
  );
}

function requiredFindArgument(words: string[], index: number): string {
  const word = words[index] ?? "";
  const value = words[index + 1] ?? "";
  if (!value) unsupportedFindArgument(`${word} needs a value`);
  return value;
}

function requiredFindDepth(words: string[], index: number): string {
  const word = words[index] ?? "";
  const depth = requiredFindArgument(words, index);
  if (!/^\d+$/.test(depth)) unsupportedFindArgument(`${word} ${depth}`);
  return depth;
}

function normalizeFindPathGlob(pattern: string): string {
  return pattern.startsWith("./") ? pattern.slice(2) : pattern;
}

function pushFindGlob(rewritten: string[], predicate: string, pattern: string, negated = false) {
  const caseInsensitive = predicate === "-iname" || predicate === "-ipath";
  const pathPredicate = predicate === "-path" || predicate === "-ipath";
  const glob = pathPredicate ? normalizeFindPathGlob(pattern) : pattern;
  rewritten.push(caseInsensitive ? "--iglob" : "-g", negated ? `!${glob}` : glob);
}

function parseFindRoots(words: string[]): {
  roots: string[];
  followsSymlinks: boolean;
  index: number;
} {
  const roots: string[] = [];
  let followsSymlinks = false;
  let index = 1;

  while (index < words.length) {
    const word = words[index] ?? "";
    if (word === "-L") {
      followsSymlinks = true;
      index += 1;
      continue;
    }
    if (word === "-H" || word === "-P" || /^-O\d*$/.test(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-") || word === "!" || word === "(" || word === ")") break;
    roots.push(word);
    index += 1;
  }

  return { roots, followsSymlinks, index };
}

function rewriteFindWords(words: string[]): string[] {
  const rewritten = ["rg", "--files", "--hidden", "--no-ignore"];
  const parsed = parseFindRoots(words);
  let index = parsed.index;

  if (parsed.followsSymlinks) rewritten.push("--follow");
  rewritten.push(...(parsed.roots.length > 0 ? parsed.roots : ["."]));

  while (index < words.length) {
    const word = words[index] ?? "";
    const next = words[index + 1] ?? "";

    if (word === "-maxdepth") {
      rewritten.push("--max-depth", requiredFindDepth(words, index));
      index += 2;
      continue;
    }
    if (word === "-mindepth") {
      const depth = requiredFindDepth(words, index);
      if (depth !== "0" && depth !== "1") unsupportedFindArgument(`${word} ${depth}`);
      index += 2;
      continue;
    }
    if (word === "-type") {
      const type = requiredFindArgument(words, index);
      if (type !== "f") unsupportedFindArgument(`${word} ${type}`);
      index += 2;
      continue;
    }
    if (["-name", "-iname", "-path", "-ipath"].includes(word)) {
      pushFindGlob(rewritten, word, requiredFindArgument(words, index));
      index += 2;
      continue;
    }
    if (
      (word === "!" || word === "-not") &&
      ["-name", "-iname", "-path", "-ipath"].includes(next)
    ) {
      const pattern = words[index + 2] ?? "";
      if (!pattern) unsupportedFindArgument(`${word} ${next} needs a value`);
      pushFindGlob(rewritten, next, pattern, true);
      index += 3;
      continue;
    }
    if ((word === "!" || word === "-not") && next === "-type") {
      const type = words[index + 2] ?? "";
      if (!type) unsupportedFindArgument(`${word} ${next} needs a value`);
      if (type !== "d") unsupportedFindArgument(`${word} ${next} ${type}`);
      index += 3;
      continue;
    }
    if (word === "-L") {
      rewritten.push("--follow");
      index += 1;
      continue;
    }
    if (word === "-print0") {
      rewritten.push("-0");
      index += 1;
      continue;
    }
    if (
      [
        "-print",
        "-true",
        "-a",
        "-and",
        "-o",
        "-or",
        "-H",
        "-P",
        "-xdev",
        "-mount",
        "-depth",
        "(",
        ")",
      ].includes(word)
    ) {
      index += 1;
      continue;
    }

    unsupportedFindArgument(word);
  }

  return rewritten;
}

function rewriteFdWords(words: string[]): string[] {
  const rewritten = ["rg", "--files"];
  let pattern = "";

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const next = words[index + 1] ?? "";

    if (["-e", "--extension"].includes(word) && next) {
      rewritten.push("-g", `*.${next}`);
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    if (!pattern) {
      pattern = word;
      continue;
    }
    rewritten.push(word);
  }

  if (pattern && pattern !== ".") rewritten.push("-g", `*${pattern}*`);
  return rewritten;
}

function rewriteLocateWords(words: string[]): string[] {
  const pattern = words.find((word, index) => index > 0 && !word.startsWith("-"));
  return pattern ? ["rg", "--files", ".", "-g", `*${pattern}*`] : ["rg", "--files", "."];
}

function rewriteSearchSegment(words: string[]): SegmentRewriteResult {
  const split = splitCommandWords(words);
  const first = normalizeCommandName(split.commandWords[0] ?? "");
  const second = normalizeCommandName(split.commandWords[1] ?? "");

  if (first === "git" && second === "grep") {
    return {
      words: [...split.assignments, ...rewriteGrepWords(split.commandWords.slice(1))],
      changed: true,
    };
  }
  if (grepSearchCommands.has(first)) {
    return {
      words: [...split.assignments, ...rewriteGrepWords(split.commandWords)],
      changed: true,
    };
  }
  if (directSearchCommands.has(first)) {
    return { words: [...split.assignments, "rg", ...split.commandWords.slice(1)], changed: true };
  }
  if (first === "find") {
    return {
      words: [...split.assignments, ...rewriteFindWords(split.commandWords)],
      changed: true,
    };
  }
  if (first === "fd" || first === "fdfind") {
    return { words: [...split.assignments, ...rewriteFdWords(split.commandWords)], changed: true };
  }
  if (first === "locate") {
    return {
      words: [...split.assignments, ...rewriteLocateWords(split.commandWords)],
      changed: true,
    };
  }

  return { words, changed: false };
}

export function replaceSearchCommand(command: string): SearchRewriteResult | null {
  const tokens = shellTokenize(command);
  const rebuiltTokens: RebuiltShellToken[] = [];
  let segment: ShellToken[] = [];
  let changed = false;

  function flushSegment() {
    if (segment.length === 0) return;
    const rewrite = rewriteSearchSegment(segment.map((token) => token.text));
    changed = changed || rewrite.changed;
    rebuiltTokens.push(...rewrite.words.map((word) => ({ text: word, operator: false })));
    segment = [];
  }

  for (const token of tokens) {
    if (commandBreakers.has(token.text)) {
      flushSegment();
      rebuiltTokens.push({ text: token.text, operator: true });
      continue;
    }
    segment.push(token);
  }

  flushSegment();
  return changed ? { command: joinShellTokens(rebuiltTokens) } : null;
}

function hasRawDirectoryTrick(command: string): boolean {
  const patterns = [
    /(^|[\s;&|()])(?:builtin\s+|command\s+)?(?:cd|pushd|popd)(?=$|[\s;&|()])/i,
    /(^|[\s;&|()])(?:git|hub|make|env|tar|pnpm)\s+(?:[^\n;&|]*\s)?-C(?=$|[\s=])/i,
    /(?:^|[\s;&|])(?:GIT_DIR|GIT_WORK_TREE|PWD|OLDPWD|INIT_CWD)=/i,
    /(?:^|[\s;&|])(?:bash|sh|zsh|fish|env)\s+[^\n;&|]*(?:\bcd\b|\bpushd\b|\bpopd\b)/i,
    /(?:\$\(\s*pwd\s*\)|`\s*pwd\s*`|\$\{?PWD\}?|\$\{?HOME\}?)/i,
  ];
  return patterns.some((pattern) => pattern.test(command));
}

function isPythonCommand(word: string): boolean {
  const command = normalizeCommandName(word);
  return pythonCommands.has(command) || /^python\d+(?:\.\d+)?$/.test(command);
}

function isScriptInterpreterCommand(word: string): boolean {
  const command = normalizeCommandName(word);
  return (
    isPythonCommand(command) ||
    shellCommands.has(command) ||
    inlineFlagCommands.has(command) ||
    ["awk", "gawk", "mawk", "nawk", "deno"].includes(command)
  );
}

function unwrapOneCommandWrapper(words: string[]): string[] {
  const runnableWords = stripLeadingAssignments(words);
  const first = normalizeCommandName(runnableWords[0] ?? "");

  if (["command", "exec", "time", "noglob"].includes(first)) return runnableWords.slice(1);

  if (["uv", "poetry", "pipenv", "rye", "hatch"].includes(first) && runnableWords[1] === "run") {
    return runnableWords.slice(2);
  }

  if (["npx", "bunx"].includes(first)) return runnableWords.slice(1);
  if (["npm", "pnpm", "yarn"].includes(first) && ["exec", "dlx"].includes(runnableWords[1] ?? ""))
    return runnableWords.slice(runnableWords[2] === "--" ? 3 : 2);

  if (first === "env") {
    const commandIndex = runnableWords.findIndex((word, index) => {
      if (index === 0) return false;
      if (word.startsWith("-")) return false;
      return !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
    });
    return commandIndex === -1 ? [] : runnableWords.slice(commandIndex);
  }

  if (first === "xargs") {
    const commandIndex = runnableWords.findIndex(
      (word, index) => index > 0 && isScriptInterpreterCommand(word),
    );
    return commandIndex === -1 ? runnableWords : runnableWords.slice(commandIndex);
  }

  return runnableWords;
}

function unwrapCommandWrappers(words: string[]): string[] {
  let current = stripLeadingAssignments(words);
  while (current.length > 0) {
    const unwrapped = unwrapOneCommandWrapper(current);
    if (unwrapped.length === current.length && unwrapped.every((word, index) => word === current[index]))
      return current;
    current = unwrapped;
  }
  return current;
}

function hasInlineFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    if (flags.has(arg)) return true;
    return [...flags].some((flag) => {
      if (!flag.startsWith("-") || flag.startsWith("--")) return false;
      return (
        arg.startsWith(flag) ||
        (flag.length === 2 && arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(flag[1] ?? ""))
      );
    });
  });
}

function isInformationalInvocation(args: string[]): boolean {
  return args.length > 0 && args.every((arg) => interpreterInfoFlags.has(arg));
}

function hasTemporaryScriptPath(args: string[]): boolean {
  return args.some((arg) => temporaryScriptPathPattern.test(arg));
}

function isAdHocInterpreterInvocation(words: string[]): boolean {
  const runnableWords = unwrapCommandWrappers(words);
  const command = normalizeCommandName(runnableWords[0] ?? "");
  const args = runnableWords.slice(1);
  if (!isScriptInterpreterCommand(command)) return false;
  if (hasTemporaryScriptPath(args)) return true;

  if (isPythonCommand(command)) {
    if (args.includes("-") || hasInlineFlag(args, pythonInlineFlags)) return true;
    return args.length === 0;
  }
  if (shellCommands.has(command)) {
    if (args.includes("-s") || hasInlineFlag(args, shellInlineFlags)) return true;
    return args.length === 0;
  }
  if (command === "deno") return args[0] === "eval";
  if (["awk", "gawk", "mawk", "nawk"].includes(command)) {
    if (isInformationalInvocation(args)) return false;
    return !args.includes("-f");
  }

  const inlineFlags = inlineFlagCommands.get(command);
  if (!inlineFlags) return false;
  if (args.includes("-") || hasInlineFlag(args, inlineFlags)) return true;
  return args.length === 0;
}

function hasInterpreterHeredoc(command: string): boolean {
  return /(?:^|[\s;&|])(?:python\d*(?:\.\d+)?|pythonw|pypy\d?|py|node|bun|tsx|ts-node|deno|ruby|perl|php|lua|rscript|r|bash|dash|fish|ksh|sh|zsh)(?:\s+[^\n;&|]*)?\s*<</i.test(
    command,
  );
}

function hasAdHocScriptUsage(command: string, tokens: ShellToken[]): boolean {
  return (
    hasInterpreterHeredoc(command) ||
    commandSegments(tokens).some((segment) => isAdHocInterpreterInvocation(segment))
  );
}

function hasRawDevServerTrick(command: string): boolean {
  return /(?:^|[\s;&|])(?:bash|sh|zsh|fish|env)\s+[^\n;&|]*(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|preview|serve)\b|\bnext\s+(?:dev|start)\b)/i.test(
    command,
  );
}

function hasDevServerUsage(command: string, tokens: ShellToken[]): boolean {
  if (hasRawDevServerTrick(command)) return true;

  return commandSegments(tokens).some((segment) => {
    const words = stripLeadingAssignments(segment);
    const first = normalizeCommandName(words[0] ?? "");
    const second = words[1] ?? "";
    const third = words[2] ?? "";
    const normalizedSecond = normalizeCommandName(second);
    const normalizedThird = normalizeCommandName(third);

    if (first === "bun") {
      if (["dev", "start", "preview", "preview:watch"].includes(second)) return true;
      if (second === "run" && ["dev", "start", "preview", "preview:watch"].includes(third))
        return true;
      if (/^(?:\.\/)?scripts\/dev(?:\.ts|\.js)?$/.test(second)) return true;
      if (normalizedSecond === "next") return true;
    }

    if (devPackageManagers.has(first)) {
      if (["dev", "start", "preview", "serve"].includes(second)) return true;
      if (second === "run" && ["dev", "start", "preview", "serve"].includes(third)) return true;
      if (first === "pnpm" && second === "dlx" && normalizedThird === "next") return true;
      if (first === "yarn" && second === "dlx" && normalizedThird === "next") return true;
    }

    if (["npx", "bunx"].includes(first) && normalizedSecond === "next") return true;
    if (first === "node" && ["dev", "next"].includes(normalizedSecond)) return true;
    if (first === "node" && /^(?:\.\/)?scripts\/dev(?:\.ts|\.js)?$/.test(second)) return true;
    if (devFrameworkCommands.has(first)) return true;
    if (first === "webpack" && second === "serve") return true;
    if (first === "turbo" && second === "dev") return true;
    if (/^(?:\.\/)?node_modules\/\.bin\/(?:next|vite|nuxt|astro|remix)$/.test(words[0] ?? "")) {
      return true;
    }

    return false;
  });
}

function isGhApiEndpoint(words: string[], index: number): boolean {
  const command = commandWord(words);
  const apiIndex = words.findIndex((word) => word === "api");
  if (command !== "gh" || apiIndex === -1 || index <= apiIndex) return false;
  const hasDestructiveMethod = words.some((word, wordIndex) => {
    if (word !== "-X" && word !== "--method") return false;
    return destructiveGhApiFlags.has((words[wordIndex + 1] ?? "").toUpperCase());
  });
  return !hasDestructiveMethod;
}

function isUnsafePathToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return false;
  if (trimmed === "--") return false;

  const value = trimmed.replace(/^["']|["']$/g, "");
  const pathValue = value.includes("=") ? value.slice(value.indexOf("=") + 1) : value;

  if (!pathValue || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(pathValue)) return false;
  if (pathValue === "/") return true;
  if (pathValue.startsWith("/") || pathValue.startsWith("~/") || pathValue === "~") return true;
  if (/^\$\{?HOME\}?($|\/)/.test(pathValue)) return true;
  if (/^\$\{?PWD\}?($|\/)/.test(pathValue)) return true;
  if (/\$\(\s*pwd\s*\)|`\s*pwd\s*`/.test(pathValue)) return true;
  if (/(^|\/)\.\.($|\/)/.test(pathValue)) return true;
  if (pathValue.startsWith("file://")) return true;

  return false;
}

function hasDirectoryFlagViolation(tokens: ShellToken[]): boolean {
  return commandSegments(tokens).some((segment) => {
    const words = stripLeadingAssignments(segment);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      const [flagName] = word.split("=", 1);
      if (pathOptionNames.has(flagName ?? word)) return true;
      if (
        word.startsWith("--cwd=") ||
        word.startsWith("--prefix=") ||
        word.startsWith("--directory=")
      ) {
        return true;
      }
    }
    return false;
  });
}

function hasUnsafePathUsage(tokens: ShellToken[]): boolean {
  return commandSegments(tokens).some((segment) => {
    const words = stripLeadingAssignments(segment);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      const assignmentName = word.includes("=") ? word.slice(0, word.indexOf("=")) : "";
      if (pathAssignmentNames.has(assignmentName)) return true;
      if (isGhApiEndpoint(words, index)) continue;
      if (isUnsafePathToken(word)) return true;
    }
    return false;
  });
}

function bashPathCandidates(command: string): string[] {
  const candidates = new Set<string>();
  for (const words of commandSegments(shellTokenize(command))) {
    const commandWords = stripLeadingAssignments(words);
    for (let index = 1; index < commandWords.length; index += 1) {
      const word = commandWords[index] ?? "";
      if (
        !word ||
        word === "--" ||
        word.startsWith("-") ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word) ||
        isGhApiEndpoint(commandWords, index)
      )
        continue;
      candidates.add(word);
    }
  }
  for (const match of command.matchAll(/[<>]{1,2}\s*([^\s;&|]+)/g)) {
    const target = match[1]?.replace(/^['"]|['"]$/g, "");
    if (target && target !== "&1" && target !== "&2") candidates.add(target);
  }
  return [...candidates];
}

async function canonicalPathViolation(
  command: string,
  root: string,
  mode: AccessMode,
): Promise<string | null> {
  for (const candidate of bashPathCandidates(command))
    if (!(await projectPathIsAllowed(root, candidate, mode))) return candidate;
  return null;
}

function canonicalPathViolationError(candidate: string): string {
  return `${PROJECT_PATH_ERROR}
Rejected Bash path: ${JSON.stringify(candidate)}. The path may be outside the project lexically or resolve there through a symlink.
The command was not run. Use a path whose resolved target is inside the project, or ask the user to switch to access mode 4. Do not retry the same path through another command or script.`;
}

export function analyzeBashCommand(
  command: string,
  mode: AccessMode = getAccessMode(),
  options: BashAnalysisOptions = {},
): RuleViolation | null {
  if ((options.requireExecute ?? true) && !canExecute(mode))
    return { rule: "access-mode", detail: BASH_ACCESS_ERROR };

  const tokens = shellTokenize(command);
  if (
    !canAccessHostPaths(mode) &&
    (hasRawDirectoryTrick(command) ||
      hasDirectoryFlagViolation(tokens) ||
      hasUnsafePathUsage(tokens))
  ) {
    return { rule: "workdir", detail: WORKDIR_ERROR };
  }

  if (hasAdHocScriptUsage(command, tokens)) {
    return { rule: "ad-hoc-script", detail: AD_HOC_SCRIPT_ERROR };
  }

  if (hasDevServerUsage(command, tokens)) {
    return { rule: "dev-server", detail: DEV_SERVER_ERROR };
  }

  return null;
}

function appendUnknownExitCode(text: string): string {
  if (/exit(?:ed)?\s+(?:with\s+)?code|exit code/i.test(text)) return text;
  return `${text ? `${text}\n\n` : ""}${EXIT_CODE_UNKNOWN}`;
}

function prefixRgReplacement(text: string, command: string): string {
  return `${RG_REPLACEMENT_PREFIX}: ${command}\n${text}`;
}

function patchBashResultContent(event: ToolResultEvent): ToolResultPatch | undefined {
  if (!isBashToolResult(event)) return undefined;

  const replacementCommand = rgReplacementByToolCallId.get(event.toolCallId);
  rgReplacementByToolCallId.delete(event.toolCallId);

  if (!replacementCommand && !event.isError) return undefined;

  let content = event.content;

  if (replacementCommand) {
    const firstTextIndex = content.findIndex((part) => part.type === "text");
    if (firstTextIndex === -1) {
      content = [
        { type: "text" as const, text: `${RG_REPLACEMENT_PREFIX}: ${replacementCommand}\n` },
        ...content,
      ];
    } else {
      content = content.map((part, index) =>
        index === firstTextIndex && part.type === "text"
          ? { ...part, text: prefixRgReplacement(part.text, replacementCommand) }
          : part,
      );
    }
  }

  if (!event.isError) return { content };

  const lastTextIndex = content.findLastIndex((part) => part.type === "text");
  if (lastTextIndex === -1) {
    return { content: [...content, { type: "text" as const, text: EXIT_CODE_UNKNOWN }] };
  }

  return {
    content: content.map((part, index) =>
      index === lastTextIndex && part.type === "text"
        ? { ...part, text: appendUnknownExitCode(part.text) }
        : part,
    ),
  };
}

export default function bashGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    try {
      const mode = getAccessMode();
      const action = (event.input as { action?: unknown }).action;
      if (!isBashActionAllowed(action, mode)) return block(BASH_ACCESS_ERROR);

      const replacement = replaceSearchCommand(event.input.command);
      if (replacement) {
        event.input.command = replacement.command;
        rgReplacementByToolCallId.set(event.toolCallId, replacement.command);
      }

      const violation = analyzeBashCommand(event.input.command, mode, { requireExecute: false });
      if (violation) {
        rgReplacementByToolCallId.delete(event.toolCallId);
        return block(violation.detail);
      }
      const projectRoot = getAccessProjectRoot(ctx.cwd);
      const rejectedPath = await canonicalPathViolation(event.input.command, projectRoot, mode);
      if (rejectedPath) {
        rgReplacementByToolCallId.delete(event.toolCallId);
        return block(canonicalPathViolationError(rejectedPath));
      }
      return undefined;
    } catch (error) {
      rgReplacementByToolCallId.delete(event.toolCallId);
      if (error instanceof SearchRewriteError) return block(error.message);
      const detail = error instanceof Error ? error.message : String(error);
      return block(`${EXTENSION_FAILURE_ERROR}: ${detail}`);
    }
  });

  pi.on("tool_result", (event) => patchBashResultContent(event));
}
