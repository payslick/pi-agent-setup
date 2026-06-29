import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

const STATUS_KEY = "screenshot";
const WIDGET_KEY = "screenshot";
const DEFAULT_LOCALE = "en";
const DEFAULT_WAIT_MS = 3000;
const DEFAULT_ELEMENT_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = positiveIntegerEnv("PI_SCREENSHOT_TIMEOUT_SECONDS", 120);
const SCREENSHOT_PROMPT_MARKER = "Screenshot extension workflow:";
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(extensionDir, "..", "finito-scripts", "scripts");
const loadedEnvRoots = new Set<string>();

const screenshotSchema = Type.Object({
  urlOrAlias: Type.String({
    description:
      "Friendly URL alias such as employees, employee settings, dashboard, or a route/full URL.",
  }),
  highlights: Type.Optional(
    Type.Array(Type.String(), {
      description: "CSS/Playwright selectors to highlight with a red outline before capture.",
    }),
  ),
  actions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Playwright JavaScript snippets to run before highlighting, e.g. clicking a tab or opening a modal.",
    }),
  ),
  upload: Type.Optional(
    Type.Boolean({ description: "Upload to the GitHub screenshots release for PR embedding." }),
  ),
  locale: Type.Optional(
    Type.String({ description: `Locale for URL resolution. Defaults to ${DEFAULT_LOCALE}.` }),
  ),
  wait: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 300_000,
      description: `Wait time in ms after page load. Defaults to ${DEFAULT_WAIT_MS}.`,
    }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300_000,
      description: `Element visibility timeout in ms. Defaults to ${DEFAULT_ELEMENT_TIMEOUT_MS}.`,
    }),
  ),
  commandTimeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 600,
      description: `Overall screenshot command timeout. Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS}s.`,
    }),
  ),
});

type ScreenshotInput = Static<typeof screenshotSchema>;
type ScreenshotOptionsInput = Partial<Omit<ScreenshotInput, "urlOrAlias">>;
type ArrayOption = "highlights" | "actions";
type NumericOption = "wait" | "timeout" | "commandTimeoutSeconds";

interface ScreenshotRunResult {
  target: string;
  appRoot: string;
  args: string[];
  output: string;
  localPath?: string;
  githubUrl?: string;
  markdown?: string;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAppRoot(cwd: string): Promise<string> {
  const override =
    process.env.PI_SCREENSHOT_APP_ROOT?.trim() || process.env.PI_DEBUG_UI_APP_ROOT?.trim();
  if (override) return path.resolve(cwd, override);
  const nestedApp = path.join(cwd, "app");
  return (await pathExists(path.join(nestedApp, "package.json"))) ? nestedApp : cwd;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)).trim();
}

function parseEnvLine(line: string): [string, string] | undefined {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match?.[1]) return undefined;
  return [match[1], unquoteEnvValue(match[2] ?? "")];
}

async function loadEnvFile(filePath: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function loadAppEnv(appRoot: string): Promise<void> {
  if (loadedEnvRoots.has(appRoot)) return;
  loadedEnvRoots.add(appRoot);
  await loadEnvFile(path.join(appRoot, ".env.local"));
  await loadEnvFile(path.join(appRoot, ".env"));
}

async function ensureScript(name: string): Promise<string> {
  const filePath = path.join(scriptsDir, name);
  if (await pathExists(filePath)) return filePath;
  throw new Error(`finito script not found: ${filePath}`);
}

function trimOutput(result: ExecResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
}

function troubleshootingHint(output: string): string {
  const hints: Array<[RegExp, string]> = [
    [
      /dev server|findPort|ECONNREFUSED|connection refused|could not.*port|no server/i,
      "the app dev server must already be running; ask the user to run bun dev.",
    ],
    [/No payroll specialist found/i, "seed the database before taking screenshots."],
    [
      /gh: command not found|not logged in|HTTP 40[13]|release.*does not exist|push access/i,
      "GitHub upload requires gh auth and access to the screenshots release repository.",
    ],
  ];
  const hint = hints.find(([pattern]) => pattern.test(output))?.[1];
  return hint ? `Hint: ${hint}` : "";
}

function execError(label: string, result: ExecResult): Error {
  const output = trimOutput(result);
  const hint = troubleshootingHint(output);
  const message = `${label} failed with exit ${result.code}${output ? `:\n${output}` : ""}`;
  return new Error([message, hint].filter(Boolean).join("\n"));
}

async function runBunScript(
  pi: ExtensionAPI,
  appRoot: string,
  scriptName: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeout = DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000,
): Promise<ExecResult> {
  await loadAppEnv(appRoot);
  const script = await ensureScript(scriptName);
  return pi.exec("bun", [script, ...args], { cwd: appRoot, signal, timeout });
}

function appendRepeatedArgs(
  args: string[],
  option: string,
  values: readonly string[] | undefined,
): void {
  for (const value of values ?? []) args.push(option, value);
}

function screenshotArgs(params: ScreenshotInput): string[] {
  const args = [params.urlOrAlias];
  appendRepeatedArgs(args, "--highlight", params.highlights);
  appendRepeatedArgs(args, "--action", params.actions);
  if (params.upload) args.push("--upload");
  if (params.locale) args.push("--locale", params.locale);
  if (params.wait !== undefined) args.push("--wait", String(params.wait));
  if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
  return args;
}

function lastCapture(text: string, pattern: RegExp): string | undefined {
  let value: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const captured = match[1]?.trim();
    if (captured) value = captured;
  }
  return value;
}

function parseScreenshotOutput(
  output: string,
): Pick<ScreenshotRunResult, "localPath" | "githubUrl" | "markdown"> {
  return {
    localPath: lastCapture(output, /(?:Screenshot saved:|Local:)\s*(\S+\.png)/g),
    githubUrl: lastCapture(output, /(?:Screenshot URL:\s*|^)(https:\/\/github\.com\/\S+)/gm),
    markdown: lastCapture(output, /(!\[[^\]]*]\(https:\/\/github\.com\/[^)]+\))/g),
  };
}

async function runScreenshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: ScreenshotInput,
  signal?: AbortSignal,
): Promise<ScreenshotRunResult> {
  const appRoot = await resolveAppRoot(ctx.cwd);
  const args = screenshotArgs(params);
  const timeout = (params.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000;
  const result = await runBunScript(pi, appRoot, "takeScreenshot.ts", args, signal, timeout);
  const output = trimOutput(result) || "[no output]";
  if (result.code !== 0) throw execError("take_screenshot", result);
  return { target: params.urlOrAlias, appRoot, args, output, ...parseScreenshotOutput(output) };
}

function resultLines(result: ScreenshotRunResult): string[] {
  const lines = [`Target: ${result.target}`];
  if (result.localPath) lines.push(`Local: ${result.localPath}`);
  if (result.githubUrl) lines.push(`GitHub: ${result.githubUrl}`);
  if (result.markdown) lines.push(`Markdown: ${result.markdown}`);
  if (!result.localPath && !result.githubUrl)
    lines.push("No screenshot path detected; inspect the log.");
  return lines;
}

function formatScreenshotResult(result: ScreenshotRunResult): string {
  return [
    "# Screenshot",
    ...resultLines(result).map((line) => `- ${line}`),
    "",
    "## Log",
    result.output,
  ].join("\n");
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function setWidget(ctx: ExtensionCommandContext, lines: string[]): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}

function errorWidgetLines(message: string): string[] {
  return ["Screenshot failed:", ...message.split(/\r?\n/).slice(0, 12)];
}

function usageLines(): string[] {
  return [
    "Usage: /screenshot <url-or-alias> [-H <selector>...] [-a <code>...] [--upload]",
    "Options: --locale en, --wait 3000, --timeout 20000",
    "Aliases: employees, employee, employee settings, dashboard, payslips summary, companies.",
    "Selectors: prefer [data-testid]/[data-slot], then role/text, then CSS.",
  ];
}

function pushCurrent(words: string[], current: string, tokenStarted: boolean): [string, boolean] {
  if (tokenStarted) words.push(current);
  return ["", false];
}

function splitCommand(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (quote) {
      tokenStarted = true;
      if (char === "\\" && quote === '"' && next) {
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

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === "\\" && next) {
      current += next;
      tokenStarted = true;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      [current, tokenStarted] = pushCurrent(words, current, tokenStarted);
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) throw new Error(`Unclosed ${quote} quote in /screenshot arguments.`);
  pushCurrent(words, current, tokenStarted);
  return words;
}

function longOptionValue(word: string, option: string): string | undefined {
  const prefix = `${option}=`;
  return word.startsWith(prefix) ? word.slice(prefix.length) : undefined;
}

function requiredValue(words: readonly string[], index: number, option: string): [string, number] {
  const value = words[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value.`);
  return [value, index + 1];
}

function appendArrayOption(
  params: ScreenshotOptionsInput,
  option: ArrayOption,
  value: string,
): void {
  params[option] = [...(params[option] ?? []), value];
}

function setNumericOption(
  params: ScreenshotOptionsInput,
  option: NumericOption,
  value: string,
  min: number,
): void {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${option} must be >= ${min}.`);
  params[option] = parsed;
}

function parseBoolean(value: string, option: string): boolean {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${option} must be true or false.`);
}

function applyLongOption(params: ScreenshotOptionsInput, word: string): boolean {
  const longOptions: Array<[string, (value: string) => void]> = [
    ["--highlight", (value) => appendArrayOption(params, "highlights", value)],
    ["--action", (value) => appendArrayOption(params, "actions", value)],
    ["--locale", (value) => (params.locale = value)],
    ["--wait", (value) => setNumericOption(params, "wait", value, 0)],
    ["--timeout", (value) => setNumericOption(params, "timeout", value, 1)],
    [
      "--command-timeout-seconds",
      (value) => setNumericOption(params, "commandTimeoutSeconds", value, 1),
    ],
    ["--upload", (value) => (params.upload = parseBoolean(value, "upload"))],
  ];
  const option = longOptions.find(([name]) => longOptionValue(word, name) !== undefined);
  if (!option) return false;
  option[1](longOptionValue(word, option[0]) ?? "");
  return true;
}

function parseScreenshotCommand(input: string): ScreenshotInput {
  const words = splitCommand(input);
  const params: ScreenshotOptionsInput = {};
  const positionals: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (applyLongOption(params, word)) continue;

    if (word === "--highlight" || word === "-H") {
      const [value, nextIndex] = requiredValue(words, index, word);
      appendArrayOption(params, "highlights", value);
      index = nextIndex;
      continue;
    }
    if (word === "--action" || word === "-a") {
      const [value, nextIndex] = requiredValue(words, index, word);
      appendArrayOption(params, "actions", value);
      index = nextIndex;
      continue;
    }
    if (word === "--locale" || word === "-l") {
      const [value, nextIndex] = requiredValue(words, index, word);
      params.locale = value;
      index = nextIndex;
      continue;
    }
    if (word === "--wait" || word === "-w") {
      const [value, nextIndex] = requiredValue(words, index, word);
      setNumericOption(params, "wait", value, 0);
      index = nextIndex;
      continue;
    }
    if (word === "--timeout" || word === "-t") {
      const [value, nextIndex] = requiredValue(words, index, word);
      setNumericOption(params, "timeout", value, 1);
      index = nextIndex;
      continue;
    }
    if (word === "--command-timeout-seconds") {
      const [value, nextIndex] = requiredValue(words, index, word);
      setNumericOption(params, "commandTimeoutSeconds", value, 1);
      index = nextIndex;
      continue;
    }
    if (word === "--upload" || word === "-u") {
      params.upload = true;
      continue;
    }
    if (word === "--no-upload") {
      params.upload = false;
      continue;
    }
    if (word.startsWith("-")) throw new Error(`Unknown screenshot option: ${word}`);
    positionals.push(word);
  }

  const urlOrAlias = positionals.join(" ").trim();
  if (!urlOrAlias) throw new Error("A URL or alias is required.");
  return { ...params, urlOrAlias };
}

function screenshotPrompt(): string {
  return `${SCREENSHOT_PROMPT_MARKER}
- Use take_screenshot for standalone app page screenshots with optional highlights/actions/GitHub upload.
- urlOrAlias accepts aliases such as employees, employee, employee settings, dashboard, payslips summary, companies, route patterns, or localhost URLs.
- Use highlights for changed elements; prefer [data-testid]/[data-slot], then role/text selectors, then CSS.
- Use actions to click tabs, open modals, scroll, or otherwise prepare state before highlighting.
- Use upload=true when the screenshot should be embedded in a PR.
- The app dev server and seeded database must already be running; do not start the dev server yourself.`;
}

function appendScreenshotPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(SCREENSHOT_PROMPT_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${screenshotPrompt()}`;
}

function looksLikeScreenshotPrompt(prompt: string): boolean {
  return /\b(screenshot|screen shot|capture (?:the )?(?:page|screen)|upload.+screenshot|highlight.+screenshot)\b/i.test(
    prompt,
  );
}

function registerScreenshotPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!looksLikeScreenshotPrompt(event.prompt)) return undefined;
    return { systemPrompt: appendScreenshotPrompt(event.systemPrompt) };
  });
}

function registerScreenshotTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "take_screenshot",
    label: "Take Screenshot",
    description:
      "Take screenshots of application pages with optional element highlighting. Can upload to GitHub releases for PR embedding.",
    promptSnippet:
      "Take an app screenshot from a URL alias/path with optional highlights/actions and GitHub upload.",
    promptGuidelines: [
      "Use urlOrAlias for aliases such as employees, employee settings, dashboard, or a route/full URL.",
      "Use highlights to add a red outline around changed elements before capture.",
      "Prefer [data-testid]/[data-slot], role/text selectors, then CSS selectors for highlights.",
      "Use actions for pre-screenshot clicks, modal opening, tab selection, or scrolling.",
      "Set upload=true when the screenshot should be embedded in a PR.",
      "If the dev server is unavailable, ask the user to start it; do not start it yourself.",
    ],
    parameters: screenshotSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: ScreenshotInput, signal, _onUpdate, ctx) {
      const result = await runScreenshot(pi, ctx, params, signal);
      return {
        content: [{ type: "text" as const, text: formatScreenshotResult(result) }],
        details: result,
      };
    },
  });
}

function registerScreenshotCommand(pi: ExtensionAPI): void {
  pi.registerCommand("screenshot", {
    description:
      "Take an app screenshot: /screenshot <url-or-alias> [-H selector...] [-a code...] [--upload]",
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
        setWidget(ctx, usageLines());
        return;
      }

      setStatus(ctx, "screenshot:running");
      try {
        const result = await runScreenshot(pi, ctx, parseScreenshotCommand(trimmed), ctx.signal);
        setWidget(ctx, resultLines(result));
        if (ctx.hasUI)
          ctx.ui.notify(result.githubUrl ? "Screenshot uploaded." : "Screenshot saved.", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWidget(ctx, errorWidgetLines(message));
        if (ctx.hasUI) ctx.ui.notify(`Screenshot failed: ${firstLine(message)}`, "error");
      } finally {
        setStatus(ctx, undefined);
      }
    },
  });
}

export default function screenshotExtension(pi: ExtensionAPI): void {
  registerScreenshotPrompt(pi);
  registerScreenshotTool(pi);
  registerScreenshotCommand(pi);
}
