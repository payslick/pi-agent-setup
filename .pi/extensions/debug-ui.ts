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
import { assertProjectPath } from "./access-mode/path-policy";
import { canExecute, getAccessProjectRoot } from "./access-mode/state";

const STATUS_KEY = "debug-ui";
const DEFAULT_URL = "/en/payroll";
const DEFAULT_TTL_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEBUG_UI_PROMPT_MARKER = "Debug UI extension workflow:";
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(extensionDir, "..", "finito-scripts", "scripts");
const loadedEnvRoots = new Set<string>();

const startSchema = Type.Object({
  url: Type.Optional(
    Type.String({
      description: `Relative path or full URL to navigate to. Defaults to ${DEFAULT_URL}.`,
    }),
  ),
  headed: Type.Optional(Type.Boolean({ default: true })),
  ttlSeconds: Type.Optional(
    Type.Integer({ minimum: 30, maximum: 86_400, default: DEFAULT_TTL_SECONDS }),
  ),
});
const runSchema = Type.Object({
  sessionId: Type.Optional(Type.String({ description: "Session ID. Defaults to active session." })),
  code: Type.String({
    description:
      "JavaScript to run with page, gotoAppUrl, getRef, getRefs, and resetRefs in scope.",
  }),
});
const closeSchema = Type.Object({
  sessionId: Type.Optional(Type.String({ description: "Session ID. Defaults to active session." })),
});
const serverLogsSchema = Type.Object({
  level: Type.Optional(
    Type.Union([
      Type.Literal("error"),
      Type.Literal("warn"),
      Type.Literal("log"),
      Type.Literal("info"),
      Type.Literal("debug"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  clear: Type.Optional(Type.Boolean({ default: false })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
});

type StartInput = Static<typeof startSchema>;
type RunInput = Static<typeof runSchema>;
type CloseInput = Static<typeof closeSchema>;
type ServerLogsInput = Static<typeof serverLogsSchema>;

interface DebugSession {
  id: string;
  appRoot: string;
  headed: boolean;
  startedAt: string;
  url?: string;
}

interface InitResponse {
  sessionId?: string;
}

let activeSession: DebugSession | undefined;
let debugUiMode = false;
let lastPrompt = "";

function scriptPath(name: string): string {
  return path.join(scriptsDir, name);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function allowedAppRoot(cwd: string, appRoot: string): Promise<string> {
  await assertProjectPath(getAccessProjectRoot(cwd), appRoot);
  return appRoot;
}

async function resolveAppRoot(cwd: string): Promise<string> {
  const override = process.env.PI_DEBUG_UI_APP_ROOT?.trim();
  if (override) return allowedAppRoot(cwd, path.resolve(cwd, override));
  const nestedApp = path.join(cwd, "app");
  const appRoot = (await pathExists(path.join(nestedApp, "package.json"))) ? nestedApp : cwd;
  return allowedAppRoot(cwd, appRoot);
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
  const filePath = scriptPath(name);
  if (await pathExists(filePath)) return filePath;
  throw new Error(`finito script not found: ${filePath}`);
}

function trimOutput(result: ExecResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
}

function execError(label: string, result: ExecResult): Error {
  const output = trimOutput(result);
  return new Error(`${label} failed with exit ${result.code}${output ? `:\n${output}` : ""}`);
}

async function runBunScript(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  appRoot: string,
  scriptName: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  await loadAppEnv(appRoot);
  const script = await ensureScript(scriptName);
  return pi.exec("bun", [script, ...args], { cwd: appRoot, signal, timeout });
}

function parseJsonObject<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start)
    throw new Error(`No JSON object in output:\n${text}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function sessionStatus(session: DebugSession): string {
  return `ui:${session.id}${session.url ? ` ${session.url}` : ""}`;
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, activeSession ? sessionStatus(activeSession) : undefined);
}

async function closeDirectorSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  appRoot: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runBunScript(
    pi,
    ctx,
    appRoot,
    "director.ts",
    ["-s", sessionId, "-c"],
    signal,
  );
  if (result.code !== 0) throw execError(`close debug UI session ${sessionId}`, result);
  if (activeSession?.id === sessionId) activeSession = undefined;
  updateStatus(ctx);
  return trimOutput(result) || `Session closed: ${sessionId}`;
}

async function runDirectorCode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  code: string,
  signal?: AbortSignal,
): Promise<string> {
  const appRoot =
    activeSession?.id === sessionId
      ? await allowedAppRoot(ctx.cwd, activeSession.appRoot)
      : await resolveAppRoot(ctx.cwd);
  const result = await runBunScript(
    pi,
    ctx,
    appRoot,
    "director.ts",
    ["-s", sessionId, "-r", code],
    signal,
  );
  const output = trimOutput(result);
  if (result.code !== 0) throw execError(`run debug UI code in ${sessionId}`, result);
  return output || "[no output]";
}

async function startDebugSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: StartInput,
  signal?: AbortSignal,
): Promise<DebugSession> {
  const appRoot = await resolveAppRoot(ctx.cwd);
  const headed = params.headed ?? true;
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const initArgs = ["-i", "--ttl", String(ttlSeconds), ...(headed ? ["--headed"] : [])];
  const init = await runBunScript(pi, ctx, appRoot, "director.ts", initArgs, signal);
  if (init.code !== 0) throw execError("start debug UI session", init);
  const sessionId = parseJsonObject<InitResponse>(init.stdout).sessionId;
  if (!sessionId) throw new Error(`Director did not return a sessionId:\n${init.stdout}`);
  const session: DebugSession = {
    id: sessionId,
    appRoot,
    headed,
    startedAt: new Date().toISOString(),
    url: params.url || DEFAULT_URL,
  };
  activeSession = session;
  debugUiMode = true;
  updateStatus(ctx);

  try {
    if (session.url)
      await runDirectorCode(
        pi,
        ctx,
        session.id,
        `await gotoAppUrl(${JSON.stringify(session.url)})`,
        signal,
      );
  } catch (error) {
    await closeDirectorSession(pi, ctx, appRoot, session.id, signal).catch(() => undefined);
    throw error;
  }

  return session;
}

function quotedSession(session: DebugSession): string {
  return `session ${session.id}${session.url ? ` at ${session.url}` : ""}`;
}

function promptForCommand(session: DebugSession, args: string): string {
  const trimmed = args.trim();
  if (!trimmed) {
    return `Debug UI ${quotedSession(session)} is open in a headed browser. Ask me what I want to look at.`;
  }
  return `Debug UI ${quotedSession(session)} is open in a headed browser. Investigate this UI request: ${trimmed}`;
}

function firstNavigationTarget(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed) return DEFAULT_URL;
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  if (/^https?:\/\//.test(first) || first.startsWith("/")) return first;
  if (!trimmed.includes(" ")) return first;
  if (/^[a-z]{2}\//i.test(first)) return `/${first}`;
  return DEFAULT_URL;
}

function sendCommandPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): void {
  if (ctx.isIdle()) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

async function detectPort(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  appRoot: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runBunScript(pi, ctx, appRoot, "findPort.ts", [], signal, 15_000);
  if (result.code !== 0) throw execError("detect app dev-server port", result);
  const port = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(port))
    throw new Error(`Could not parse dev-server port:\n${trimOutput(result)}`);
  return port;
}

function serverLogsQuery(params: ServerLogsInput): string {
  const input: Record<string, string | number> = {};
  if (params.level) input.level = params.level;
  if (params.limit) input.limit = params.limit;
  if (Object.keys(input).length === 0) return "";
  return `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
}

async function responseBody(response: Response): Promise<string> {
  const text = await response.text();
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function fetchServerLogs(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: ServerLogsInput,
  signal?: AbortSignal,
): Promise<string> {
  const appRoot = await resolveAppRoot(ctx.cwd);
  await loadAppEnv(appRoot);
  const authId = process.env.AUTH_ID;
  if (!authId) throw new Error("AUTH_ID not found in .env or process environment.");
  const port = params.port ?? (await detectPort(pi, ctx, appRoot, signal));
  const procedure = params.clear ? "status.clearLogs" : "status.getLogs";
  const url = `http://localhost:${port}/api/trpc/${procedure}${params.clear ? "" : serverLogsQuery(params)}`;
  const response = await fetch(url, {
    method: params.clear ? "POST" : "GET",
    headers: { "x-test-only-mock-auth-id": authId },
    signal,
  });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(`Server logs request failed with ${response.status}:\n${body}`);
  return body || "[empty response]";
}

function looksLikeDebugUiPrompt(prompt: string): boolean {
  return (
    /\b(debug[- ]?ui|visual bug|layout issue|broken page|browser|console error|network failure|screenshot|right-click)\b/i.test(
      prompt,
    ) || /\{\d+\}/.test(prompt)
  );
}

function debugUiPrompt(): string {
  const active = activeSession
    ? `Active debug UI session: ${activeSession.id}${activeSession.url ? ` at ${activeSession.url}` : ""}.`
    : "No active debug UI session. Start one with debug_ui_start when needed.";
  return `${DEBUG_UI_PROMPT_MARKER}
${active}
- Use debug_ui_start, debug_ui_run, debug_ui_close, and debug_ui_server_logs instead of ad hoc Playwright setup.
- Never start the app dev server yourself; if gotoAppUrl cannot detect one, ask the user to run it.
- For visual/UI changes while a debug session is active, live-edit in the browser with page.evaluate or locator.evaluate first. Do not edit source files unless the user explicitly says "save".
- debug_ui_run code has page, gotoAppUrl, getRef, getRefs, and resetRefs in scope.
- When the user mentions {1}, {2}, etc., call getRef(n) first. If alive is false, say the ref is stale and ask the user to right-click it again.
- Page errors, console errors, and 4xx/5xx network failures are reported by debug_ui_run; use debug_ui_server_logs for server-side failures.`;
}

function appendDebugUiPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(DEBUG_UI_PROMPT_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${debugUiPrompt()}`;
}

function isSourceMutationTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "write" || toolName === "multi-edit";
}

function installDebugUiHooks(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("before_agent_start", (event) => {
    lastPrompt = event.prompt;
    if (!activeSession && !debugUiMode && !looksLikeDebugUiPrompt(event.prompt)) return undefined;
    return { systemPrompt: appendDebugUiPrompt(event.systemPrompt) };
  });
  pi.on("tool_call", (event) => {
    if (!activeSession || !isSourceMutationTool(event.toolName) || /\bsave\b/i.test(lastPrompt)) {
      return undefined;
    }
    return {
      block: true,
      reason:
        "Debug UI live-edit first: apply visual/UI changes in the browser with debug_ui_run. Edit source files only after the user explicitly says save.\nExit code: 1",
    };
  });
}

function registerStartTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "debug_ui_start",
    label: "Debug UI Start",
    description:
      "Start a Playwright director session for app UI debugging. Opens a headed browser by default, navigates with gotoAppUrl, sets auth from .env, and auto-detects the app dev-server port.",
    promptSnippet: "Start a headed Playwright director session for app UI debugging.",
    promptGuidelines: [
      "Use debug_ui_start for browser/UI debugging instead of starting Playwright manually.",
      "Use the default headed session when the user may right-click elements to create refs like {1}.",
    ],
    parameters: startSchema,
    async execute(_toolCallId, params: StartInput, signal, _onUpdate, ctx) {
      const session = await startDebugSession(pi, ctx, params, signal);
      return {
        content: [{ type: "text" as const, text: `Started ${quotedSession(session)}` }],
        details: session,
      };
    },
  });
}

function registerRunTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "debug_ui_run",
    label: "Debug UI Run",
    description:
      "Run JavaScript in an active Playwright director session. The code receives page, gotoAppUrl, getRef, getRefs, and resetRefs in scope; diagnostics are included in output.",
    promptSnippet: "Run JavaScript in the active debug UI browser session.",
    promptGuidelines: [
      "Use debug_ui_run to click, inspect DOM, live-edit styles, capture screenshots, and read refs.",
      "For refs, call getRef(n) before acting and do not use stale refs.",
    ],
    parameters: runSchema,
    async execute(_toolCallId, params: RunInput, signal, _onUpdate, ctx) {
      const sessionId = params.sessionId ?? activeSession?.id;
      if (!sessionId) throw new Error("No active debug UI session. Call debug_ui_start first.");
      const output = await runDirectorCode(pi, ctx, sessionId, params.code, signal);
      return { content: [{ type: "text" as const, text: output }], details: { sessionId } };
    },
  });
}

function registerCloseTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "debug_ui_close",
    label: "Debug UI Close",
    description: "Close a Playwright director debug UI session. Defaults to the active session.",
    promptSnippet: "Close the active debug UI browser session.",
    parameters: closeSchema,
    async execute(_toolCallId, params: CloseInput, signal, _onUpdate, ctx) {
      const sessionId = params.sessionId ?? activeSession?.id;
      if (!sessionId) throw new Error("No active debug UI session to close.");
      const appRoot =
        activeSession?.id === sessionId
          ? await allowedAppRoot(ctx.cwd, activeSession.appRoot)
          : await resolveAppRoot(ctx.cwd);
      const output = await closeDirectorSession(pi, ctx, appRoot, sessionId, signal);
      debugUiMode = false;
      return { content: [{ type: "text" as const, text: output }], details: { sessionId } };
    },
  });
}

function registerServerLogsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "debug_ui_server_logs",
    label: "Debug UI Server Logs",
    description:
      "Fetch or clear app server-side console logs through the status.getLogs/status.clearLogs tRPC endpoints. Requires AUTH_ID and finito.dev permission.",
    promptSnippet: "Fetch app server-side logs while debugging UI issues.",
    promptGuidelines: [
      "Use debug_ui_server_logs when browser diagnostics do not explain a UI failure.",
      "Clear logs before reproducing when noisy previous entries obscure the current issue.",
    ],
    parameters: serverLogsSchema,
    async execute(_toolCallId, params: ServerLogsInput, signal, _onUpdate, ctx) {
      const output = await fetchServerLogs(pi, ctx, params, signal);
      return { content: [{ type: "text" as const, text: output }], details: params };
    },
  });
}

function registerDebugUiTools(pi: ExtensionAPI): void {
  registerStartTool(pi);
  registerRunTool(pi);
  registerCloseTool(pi);
  registerServerLogsTool(pi);
}

async function handleCloseCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): Promise<boolean> {
  if (!/^(close|stop)\b/i.test(command)) return false;
  const sessionId = command.split(/\s+/)[1] || activeSession?.id;
  if (!sessionId) {
    ctx.ui.notify("No active debug UI session to close.", "warning");
    return true;
  }
  const appRoot =
    activeSession?.id === sessionId
      ? await allowedAppRoot(ctx.cwd, activeSession.appRoot)
      : await resolveAppRoot(ctx.cwd);
  await closeDirectorSession(pi, ctx, appRoot, sessionId, ctx.signal);
  debugUiMode = false;
  ctx.ui.notify(`Closed debug UI session ${sessionId}.`, "info");
  return true;
}

function handleStatusCommand(ctx: ExtensionCommandContext, command: string): boolean {
  if (!/^status\b/i.test(command)) return false;
  ctx.ui.notify(
    activeSession ? `Active ${quotedSession(activeSession)}` : "No active debug UI session.",
    "info",
  );
  return true;
}

async function handleKillCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): Promise<boolean> {
  if (!/^kill\b/i.test(command)) return false;
  const appRoot = await resolveAppRoot(ctx.cwd);
  const result = await runBunScript(pi, ctx, appRoot, "director.ts", ["-k"], ctx.signal);
  if (result.code !== 0) throw execError("kill debug UI director server", result);
  activeSession = undefined;
  debugUiMode = false;
  updateStatus(ctx);
  ctx.ui.notify(trimOutput(result) || "Debug UI director server stopped.", "info");
  return true;
}

async function handleOpenCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "ui:starting");
  const session = await startDebugSession(
    pi,
    ctx,
    { url: firstNavigationTarget(command), headed: true, ttlSeconds: DEFAULT_TTL_SECONDS },
    ctx.signal,
  );
  ctx.ui.notify(`Opened ${quotedSession(session)}.`, "info");
  sendCommandPrompt(pi, ctx, promptForCommand(session, command));
}

function registerDebugUiCommand(pi: ExtensionAPI): void {
  pi.registerCommand("debug-ui", {
    description: "Open a headed app UI debugging session: /debug-ui [url-or-issue]",
    async handler(args, ctx) {
      const command = args.trim();
      try {
        if (handleStatusCommand(ctx, command)) return;
        if (!canExecute()) throw new Error("Debug UI requires access mode 3 or 4.");
        if (await handleCloseCommand(pi, ctx, command)) return;
        if (await handleKillCommand(pi, ctx, command)) return;
        await handleOpenCommand(pi, ctx, command);
      } catch (error) {
        activeSession = undefined;
        updateStatus(ctx);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

export default function debugUiExtension(pi: ExtensionAPI): void {
  installDebugUiHooks(pi);
  registerDebugUiTools(pi);
  registerDebugUiCommand(pi);
}
