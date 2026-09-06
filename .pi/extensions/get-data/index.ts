import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  buildSessionContext,
  convertToLlm,
  createBashToolDefinition,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

import { filterToolsForAccessMode, isBashActionAllowed } from "../access-mode/tool-policy";
import {
  ACCESS_MODE_ENV,
  ACCESS_PROJECT_ROOT_ENV,
  getAccessMode,
  getAccessProjectRoot,
  type AccessMode,
} from "../access-mode/state";

export const GET_DATA_TOOL_NAME = "get_data";
export const GET_DATA_CHILD_MODEL = "openai-codex/gpt-5.6-luna";
export const GET_DATA_CHILD_THINKING = "minimal";
const STATUS_KEY = "get-data";
const CHILD_ENV_KEY = "PI_GET_DATA_CHILD";
const DEFAULT_PARENT_CONTEXT_CHARS = 16_000;
const DEFAULT_CHILD_TIMEOUT_MS = 10 * 60_000;
const PROMPT_MARKER = "Parent data-acquisition boundary:";
const PROMPT_END_MARKER = "<!-- pi-get-data:end -->";
const CHILD_BUILTIN_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const CHILD_GUARD_PATH = fileURLToPath(new URL("../access-mode/child-guard.ts", import.meta.url));

const evidenceSchema = StringEnum(["exact", "dense", "summary"] as const, {
  description:
    "Evidence density. exact preserves source excerpts/signatures, dense favors compact cited findings, summary is highest level.",
  default: "dense",
});
const bashActionSchema = StringEnum(["read", "write"] as const, {
  description:
    "Primary purpose of the command. Use read when output informs later work and write for state-changing operations. Access mode 1 permits only read actions.",
});

const getDataSchema = Type.Object({
  objective: Type.String({
    description: "The concrete information to find or derive.",
  }),
  relevance: Type.String({
    description:
      "Why the information is needed and what makes a result relevant in the current task/session.",
  }),
  scope: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 20,
      description: "Optional paths, domains, URLs, systems, or other retrieval boundaries.",
    }),
  ),
  evidence: Type.Optional(evidenceSchema),
  maxFindings: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      default: 20,
      description: "Maximum relevant findings to return. Default: 20.",
    }),
  ),
});

const bashSchema = Type.Object({
  action: bashActionSchema,
  purpose: Type.String({
    description:
      "Why this command is being run. Classify by primary purpose: observing/diagnosing is read; changing state is write.",
  }),
  command: Type.String({ description: "Bash command to execute." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)." })),
});

export type GetDataInput = Static<typeof getDataSchema>;
type ParentBashInput = Static<typeof bashSchema>;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface GetDataDetails {
  objective: string;
  evidence: NonNullable<GetDataInput["evidence"]>;
  findingLimit: number;
  model?: string;
  usage: UsageStats;
  parentContextChars: number;
  parentContextTruncated: boolean;
}

interface ChildResult {
  output: string;
  stderr: string;
  exitCode: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageStats;
}

function parentInstructions(mode: AccessMode): string {
  const getDataGuidance =
    mode === 1
      ? "- `get_data` is unavailable in mode 1; use direct read/data tools."
      : "- `get_data` is an optional delegation tool for broad or parallel retrieval. Direct read/data tools remain available and may be more efficient for focused lookups.";
  const bashGuidance =
    mode === 1
      ? '- Bash is available only with `action="read"`; write actions are blocked.'
      : '- Bash accepts `action="read"` and `action="write"`, classified by primary purpose.';
  return `${PROMPT_MARKER}
- Access mode ${mode} permits normal direct read/data tools, including text and image reads, search, index, web, and log tools allowed by the access-mode policy.
${getDataGuidance}
${bashGuidance}
- In modes 1–3, Bash remains project-scoped and cannot change to an external directory.
${PROMPT_END_MARKER}`;
}

const CHILD_INSTRUCTIONS = `You are the retrieval worker behind the parent agent's get_data tool.

Your job is data acquisition only. Use the available read, search, and read-only diagnostic Bash tools to investigate thoroughly, but do not edit files, run mutating shell commands, change repository state, install dependencies, launch workflows, or delegate to other agents. Obey the inherited access mode and its project-root boundary when project-scoped.

Decide relevance using the parent-context snapshot and the request's relevance criteria. Before finishing, verify important findings against primary sources whenever possible.

Return only an information-dense handoff optimized for another LLM's context. Do not describe your search process or include a prose preamble. Use these source-aware forms where applicable:
- project code: path:startLine-endLine exactSignature \`dense relevance summary\`
- web/API: URL#section-or-locator \`dense relevance summary\`
- command/index evidence: stable-source-or-command-locator \`dense relevance summary\`

End with compact coverage and uncertainty lines. State truncation or incomplete coverage explicitly. Never return raw bulk output when a cited exact excerpt or dense finding is sufficient.

If all retrieved content is relevant, or compression would lose essential structure or meaning and there is no effective dense format, you may return the complete content verbatim. Label it with its source and state that it is complete; do not force a lossy summary merely for brevity.`;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function parentActiveTools(
  activeTools: readonly string[],
  mode: AccessMode = getAccessMode(),
): string[] {
  const retained = activeTools.filter((name) => name !== GET_DATA_TOOL_NAME || mode !== 1);
  const required = mode === 1 ? ["read", "bash"] : ["read", GET_DATA_TOOL_NAME, "bash"];
  return filterToolsForAccessMode([...new Set([...retained, ...required])], mode);
}

export function appendGetDataInstructions(
  systemPrompt: string,
  mode: AccessMode = getAccessMode(),
): string {
  const instructions = parentInstructions(mode);
  const start = systemPrompt.indexOf(PROMPT_MARKER);
  if (start < 0) return `${systemPrompt}\n\n${instructions}`;
  const end = systemPrompt.indexOf(PROMPT_END_MARKER, start);
  return `${systemPrompt.slice(0, start)}${instructions}${
    end < 0 ? "" : systemPrompt.slice(end + PROMPT_END_MARKER.length)
  }`;
}

export function bashActionRejection(
  input: Pick<ParentBashInput, "action" | "purpose" | "command">,
  mode: AccessMode,
): string {
  return [
    `Access mode ${mode} blocks Bash action=${JSON.stringify(input.action)}.`,
    "",
    `Requested purpose: ${input.purpose}`,
    `Rejected command: ${input.command}`,
    "",
    "Mode 1 permits only self-reported read actions; switch modes before running a write action.",
  ].join("\n");
}

export function buildGetDataPrompt(
  input: GetDataInput,
  parentContext: string,
  parentContextTruncated = false,
): string {
  const scope = input.scope?.length
    ? input.scope.map((item) => `- ${item}`).join("\n")
    : "- unrestricted";
  return [
    "## Retrieval request",
    `Objective: ${input.objective}`,
    `Relevance criteria: ${input.relevance}`,
    `Evidence mode: ${input.evidence ?? "dense"}`,
    `Maximum findings: ${input.maxFindings ?? 20}`,
    "Scope:",
    scope,
    "",
    "Return dense cited findings using path:startLine-endLine exactSignature `summary` for project code and equivalent stable locators for other sources.",
    "If all content is relevant or cannot be formatted densely without losing essential meaning, you may return the complete content verbatim and label it as complete.",
    "",
    "## Parent-context snapshot",
    parentContextTruncated
      ? "[Earlier parent context omitted to fit the get_data context budget.]"
      : "[Complete compaction-aware parent context through the initiating user message.]",
    parentContext || "(no prior parent conversation)",
  ].join("\n");
}

function boundedParentContext(messages: readonly AgentMessage[]): {
  text: string;
  truncated: boolean;
} {
  const maxChars = positiveIntegerEnv(
    "PI_GET_DATA_PARENT_CONTEXT_CHARS",
    DEFAULT_PARENT_CONTEXT_CHARS,
  );
  const serialized = convertToLlm([...messages]).map((message) =>
    serializeConversation([message]).trim(),
  );
  const totalChars = serialized.reduce((total, text) => total + text.length + 2, 0);
  if (totalChars <= maxChars)
    return { text: serialized.filter(Boolean).join("\n\n"), truncated: false };

  const selected: string[] = [];
  let selectedChars = 0;
  for (let index = serialized.length - 1; index >= 0; index -= 1) {
    const text = serialized[index];
    if (!text) continue;
    const nextChars = text.length + (selected.length ? 2 : 0);
    if (selected.length && selectedChars + nextChars > maxChars) break;
    if (!selected.length && nextChars > maxChars) {
      selected.unshift(text.slice(-maxChars));
      selectedChars = maxChars;
      break;
    }
    selected.unshift(text);
    selectedChars += nextChars;
  }
  return { text: selected.join("\n\n"), truncated: true };
}

function parentContextThroughLatestUser(ctx: ExtensionContext): {
  text: string;
  truncated: boolean;
} {
  const branch = ctx.sessionManager.getBranch();
  const latestUser = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!latestUser) return { text: "", truncated: false };
  const context = buildSessionContext(ctx.sessionManager.getEntries(), latestUser.id);
  return boundedParentContext(context.messages);
}

function getFinalOutput(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content.findLast((part) => part.type === "text");
    if (text?.type === "text" && text.text.trim()) return text.text.trim();
  }
  return "";
}

export function childIsolationArgs(
  mode: AccessMode = getAccessMode(),
  projectRoot = getAccessProjectRoot(process.cwd()),
): string[] {
  void projectRoot;
  return [
    "--no-extensions",
    "--extension",
    CHILD_GUARD_PATH,
    "--tools",
    CHILD_BUILTIN_TOOLS.join(","),
  ];
}

export function childAccessEnvironment(
  mode: AccessMode,
  projectRoot: string,
): Record<string, string> {
  return {
    [ACCESS_MODE_ENV]: String(mode),
    [ACCESS_PROJECT_ROOT_ENV]: projectRoot,
  };
}

export function childModelArgs(): string[] {
  return ["--model", GET_DATA_CHILD_MODEL, "--thinking", GET_DATA_CHILD_THINKING];
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

async function writeChildPrompts(
  requestPrompt: string,
): Promise<{ directory: string; systemFile: string; requestFile: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-get-data-"));
  const systemFile = path.join(directory, "system.md");
  const requestFile = path.join(directory, "request.md");
  await Promise.all([
    writeFile(systemFile, CHILD_INSTRUCTIONS, { encoding: "utf8", mode: 0o600 }),
    writeFile(requestFile, requestPrompt, { encoding: "utf8", mode: 0o600 }),
  ]);
  return { directory, systemFile, requestFile };
}

async function runChild(
  ctx: ExtensionContext,
  input: GetDataInput,
  signal: AbortSignal | undefined,
  onProgress: (turns: number) => void,
): Promise<{ result: ChildResult; parentContext: { text: string; truncated: boolean } }> {
  const parentContext = parentContextThroughLatestUser(ctx);
  const prompt = buildGetDataPrompt(input, parentContext.text, parentContext.truncated);
  const temporary = await writeChildPrompts(prompt);
  const accessMode = getAccessMode();
  const projectRoot = getAccessProjectRoot(ctx.cwd);
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    ...childIsolationArgs(accessMode, projectRoot),
    ...childModelArgs(),
  ];
  args.push("--append-system-prompt", temporary.systemFile, `@${temporary.requestFile}`);

  const messages: Message[] = [];
  const result: ChildResult = {
    output: "",
    stderr: "",
    exitCode: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };

  try {
    const invocation = getPiInvocation(args);
    const timeoutMs = positiveIntegerEnv("PI_GET_DATA_CHILD_TIMEOUT_MS", DEFAULT_CHILD_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: projectRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...childAccessEnvironment(accessMode, projectRoot),
          [CHILD_ENV_KEY]: "1",
          PI_SUBAGENT_ID: `get-data-${ctx.sessionManager.getSessionId()}`,
        },
      });
      let buffer = "";
      let settled = false;
      let timedOut = false;

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      };
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: Message };
        try {
          event = JSON.parse(line) as { type?: string; message?: Message };
        } catch {
          return;
        }
        if (event.type !== "message_end" || !event.message) return;
        messages.push(event.message);
        if (event.message.role !== "assistant") return;
        result.usage.turns += 1;
        result.usage.input += event.message.usage?.input ?? 0;
        result.usage.output += event.message.usage?.output ?? 0;
        result.usage.cacheRead += event.message.usage?.cacheRead ?? 0;
        result.usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
        result.usage.cost += event.message.usage?.cost?.total ?? 0;
        result.model ??= event.message.model;
        result.stopReason = event.message.stopReason;
        result.errorMessage = event.message.errorMessage;
        onProgress(result.usage.turns);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (data: Buffer) => {
        result.stderr += data.toString("utf8");
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        result.exitCode = code ?? 1;
        if (timedOut) {
          finish(
            new Error(`get_data child timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`),
          );
          return;
        }
        if (signal?.aborted) {
          finish(new Error("get_data child was aborted."));
          return;
        }
        finish();
      });
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });
    result.output = getFinalOutput(messages);
    return { result, parentContext };
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
}

function childFailure(result: ChildResult): string {
  return (
    result.errorMessage?.trim() ||
    result.stderr.trim() ||
    result.output.trim() ||
    `get_data child exited with code ${result.exitCode}.`
  );
}

let activeChildren = 0;

function updateStatus(ctx: ExtensionContext, turns?: number): void {
  if (!ctx.hasUI) return;
  if (!activeChildren) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(
    STATUS_KEY,
    `get-data:${activeChildren}${turns ? ` ${turns} turn${turns === 1 ? "" : "s"}` : ""}`,
  );
}

function enforceParentTools(pi: ExtensionAPI): void {
  const next = parentActiveTools(pi.getActiveTools());
  const current = pi.getActiveTools();
  if (next.length === current.length && next.every((name, index) => name === current[index]))
    return;
  pi.setActiveTools(next);
}

function getDataDetails(
  input: GetDataInput,
  result: ChildResult,
  parentContext: { text: string; truncated: boolean },
): GetDataDetails {
  return {
    objective: input.objective,
    evidence: input.evidence ?? "dense",
    findingLimit: input.maxFindings ?? 20,
    model: result.model,
    usage: result.usage,
    parentContextChars: parentContext.text.length,
    parentContextTruncated: parentContext.truncated,
  };
}

async function executeGetData(
  params: GetDataInput,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[3],
  ctx: ExtensionContext,
) {
  activeChildren += 1;
  updateStatus(ctx);
  try {
    const child = await runChild(ctx, params, signal, (turns) => {
      updateStatus(ctx, turns);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `get_data retrieval in progress (${turns} child turn${turns === 1 ? "" : "s"})…`,
          },
        ],
        details: {
          objective: params.objective,
          evidence: params.evidence ?? "dense",
          findingLimit: params.maxFindings ?? 20,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
          parentContextChars: 0,
          parentContextTruncated: false,
        } satisfies GetDataDetails,
      });
    });
    const { result, parentContext } = child;
    const failed =
      result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
    return {
      content: [
        {
          type: "text" as const,
          text: failed || !result.output.trim() ? childFailure(result) : result.output.trim(),
        },
      ],
      details: getDataDetails(params, result, parentContext),
      isError: failed || !result.output.trim() || undefined,
    };
  } finally {
    activeChildren = Math.max(0, activeChildren - 1);
    updateStatus(ctx);
  }
}

function registerGetDataTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GET_DATA_TOOL_NAME,
    label: "Get Data",
    description:
      "Optionally delegates broad or parallel file, project, web, API, log, diagnostic, and read-oriented shell investigation to an isolated child Pi and returns a dense cited handoff.",
    promptSnippet:
      "Delegate broad or parallel retrieval to an isolated child when that is more efficient than direct read/data tools.",
    promptGuidelines: [
      "Direct read/data tools remain available. Use get_data when delegated broad or parallel retrieval would reduce parent context or tool calls.",
      "If a delegated result is insufficient, call get_data again with a narrower objective or clearer relevance criteria, or use a focused direct read/data tool.",
      "Provide enough relevance context for the child to distinguish useful evidence from incidental matches.",
    ],
    parameters: getDataSchema,
    renderCall(params, theme) {
      const title = theme.fg("toolTitle", theme.bold(GET_DATA_TOOL_NAME));
      const objective = theme.fg("toolOutput", params.objective);
      return new Text(`${title}\n${objective}`, 0, 0);
    },
    execute: (_toolCallId, params, signal, onUpdate, ctx) =>
      executeGetData(params, signal, onUpdate, ctx),
  });
}

function registerParentBash(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description:
      "Execute Bash with an explicit self-reported primary action. Mode 1 permits read actions only; higher modes permit read and write actions subject to project-path policy.",
    promptSnippet:
      "Execute Bash with action classified by primary purpose: observing is read and state changes are write.",
    promptGuidelines: [
      "Set action=read when output informs later work and action=write for installation, generation, migration, moves, deletion, commits, deployment, and other mutations.",
      "Do not mislabel a state-changing command as read. Modes 1–3 cannot change to or access an external directory.",
    ],
    parameters: bashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mode = getAccessMode();
      if (!isBashActionAllowed(params.action, mode)) {
        return {
          content: [{ type: "text", text: bashActionRejection(params, mode) }],
          details: { action: params.action, mode, purpose: params.purpose },
          isError: true,
        };
      }
      return createBashToolDefinition(ctx.cwd).execute(
        toolCallId,
        { command: params.command, timeout: params.timeout },
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}

function registerParentPolicy(pi: ExtensionAPI): void {
  pi.on("session_start", () => enforceParentTools(pi));
  pi.on("session_tree", () => enforceParentTools(pi));
  pi.on("before_agent_start", (event) => {
    enforceParentTools(pi);
    const systemPrompt = appendGetDataInstructions(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
}

export default function getDataExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV_KEY] === "1") return;
  registerGetDataTool(pi);
  registerParentBash(pi);
  registerParentPolicy(pi);
}
