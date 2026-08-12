import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  contractFilesForSpec,
  validateImplementationAssignments,
  writableFilesForSpec,
} from "./assignments";
import { BRIDGE_SCRIPT } from "./bridge-script";
import {
  askMainAgentSchema,
  DEFAULT_CAPTURE_LINES,
  DEFAULT_SUBAGENT_MODEL,
  MAX_SUBAGENTS_PER_CALL,
  panesSchema,
  spawnSubagentsSchema,
  SUBAGENT_PROFILE_NAMES,
  type AskMainAgentInput,
  type PanesInput,
  type SpawnSubagentsInput,
  type SubagentSpec,
} from "./schemas";
import { resolveSubagentSpec } from "./profiles";
import {
  COMPLETION_MESSAGE_TYPE,
  CUSTOM_ENTRY_TYPE,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  friendlySubagentName,
  planSubagentPlacement,
  restoreRecordsForWindow,
  shortenHomePath,
  type SpawnedSubagentRecord,
  type SubagentDoneEvent,
  type SubagentQuestion,
  type SplitDirection,
  type SubagentSessionEntry,
} from "./state";

const EXTENSION_NAME = "tmux-subagents";
const SPAWN_TOOL_NAME = "spawn_subagents";
const PANES_TOOL_NAME = "subagent_panes";
const ASK_MAIN_TOOL_NAME = "ask_main_agent";
const MAX_CAPTURE_LINES = 1000;
const TMP_ROOT = path.join(".pi", "tmp", "subagents");

type LayoutMode = "none" | "tiled" | "even-horizontal" | "even-vertical";
type PaneAction = "list" | "capture" | "kill" | "send" | "abort";
type MessageDelivery = "prompt" | "steer" | "follow_up";
type SubagentOutboxEvent = SubagentQuestion | SubagentDoneEvent;

interface PaneStatus {
  exists: boolean;
  dead?: boolean;
  currentCommand?: string;
  title?: string;
  windowId?: string;
  error?: string;
}

interface TmuxContext {
  paneId: string;
  windowId: string;
}

let registry = new Map<string, SpawnedSubagentRecord>();
let outboxOffsets = new Map<string, number>();
let seenQuestionIds = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | undefined;

function previewText(text: string | undefined, maxLength = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "(idle)";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function sanitizeName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "subagent";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clampCaptureLines(lines: number | undefined): number {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_CAPTURE_LINES;
  return Math.max(1, Math.min(MAX_CAPTURE_LINES, Math.floor(lines)));
}

function resolveInsideRoot(root: string, requested: string | undefined): string {
  const resolved = requested ? path.resolve(root, requested) : root;
  const relative = path.relative(root, resolved);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside) throw new Error(`Subagent cwd must stay inside ${root}: ${requested}`);
  return resolved;
}

function validateSplitSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  if (!/^\d+%?$/.test(size))
    throw new Error(`Invalid tmux split size: ${size}. Use digits with optional %, e.g. 40%.`);
  return size;
}

function appendSkillArgs(args: string[], spec: SubagentSpec, projectRoot: string): void {
  if (spec.skills !== undefined) {
    args.push("--no-skills");
    for (const skill of spec.skills) args.push("--skill", resolveInsideRoot(projectRoot, skill));
    return;
  }
  if (spec.noSkills) args.push("--no-skills");
}

export function piArgsForSpec(spec: SubagentSpec, projectRoot: string): string[] {
  const args: string[] = [];
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model || !spec.provider) args.push("--model", spec.model ?? DEFAULT_SUBAGENT_MODEL);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.noTools) args.push("--no-tools");
  if (!spec.noTools && spec.noBuiltinTools) args.push("--no-builtin-tools");
  if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
  if (spec.excludeTools?.length) args.push("--exclude-tools", spec.excludeTools.join(","));
  if (spec.noSession) args.push("--no-session");
  if (spec.inheritContext === false) args.push("--no-context-files");
  if (spec.noExtensions) args.push("--no-extensions");
  appendSkillArgs(args, spec, projectRoot);
  if (spec.noPromptTemplates) args.push("--no-prompt-templates");
  return args;
}

function buildRunScript(options: {
  name: string;
  cwd: string;
  bridgePath: string;
  configPath: string;
}): string {
  return `#!/usr/bin/env bash
set -u
printf '\\033]2;%s\\007' ${shellQuote(`pi rpc subagent: ${options.name}`)}
cd ${shellQuote(options.cwd)} || exit 1
if command -v node >/dev/null 2>&1; then
  exec node ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
if command -v bun >/dev/null 2>&1; then
  exec bun ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
echo 'Neither node nor bun was found; cannot run Pi RPC bridge.'
exec /bin/sh
`;
}

async function writeSubagentFiles(
  ctx: ExtensionContext,
  spec: SubagentSpec,
  id: string,
  name: string,
  cwd: string,
) {
  const dir = path.resolve(ctx.cwd, TMP_ROOT, `${safeFilename(name)}-${id}`);
  await mkdir(dir, { recursive: true });

  const promptPath = spec.prompt !== undefined ? path.join(dir, "prompt.md") : undefined;
  if (promptPath) await writeFile(promptPath, spec.prompt ?? "", { encoding: "utf8", mode: 0o600 });

  const systemPromptPath = spec.systemPrompt?.trim() ? path.join(dir, "system.md") : undefined;
  if (systemPromptPath)
    await writeFile(systemPromptPath, spec.systemPrompt ?? "", { encoding: "utf8", mode: 0o600 });

  const bridgePath = path.join(dir, "bridge.mjs");
  const configPath = path.join(dir, "config.json");
  const controlPath = path.join(dir, "control.jsonl");
  const outboxPath = path.join(dir, "outbox.jsonl");
  const runScriptPath = path.join(dir, "run.sh");

  await writeFile(bridgePath, BRIDGE_SCRIPT, { encoding: "utf8", mode: 0o700 });
  await chmod(bridgePath, 0o700);
  await writeFile(controlPath, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(outboxPath, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        id,
        name,
        cwd,
        promptPreview: previewText(spec.prompt),
        piArgs: piArgsForSpec(spec, ctx.cwd),
        thinking: spec.thinking,
        promptPath,
        systemPromptPath,
        replaceSystemPrompt: spec.replaceSystemPrompt ?? false,
        controlPath,
        outboxPath,
        stayOpen: spec.stayOpen ?? true,
        closeOnAgentEnd: true,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(runScriptPath, buildRunScript({ name, cwd, bridgePath, configPath }), {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(runScriptPath, 0o700);

  return {
    id,
    dir,
    promptPath,
    systemPromptPath,
    bridgePath,
    configPath,
    controlPath,
    outboxPath,
    runScriptPath,
  };
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 10_000,
) {
  const result = await pi.exec("tmux", args, { signal, timeout });
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `tmux exited with code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
}

async function ensureTmux(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<TmuxContext> {
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) {
    throw new Error(
      "tmux subagents require running pi inside tmux (TMUX/TMUX_PANE are not set). Start tmux, then run pi again.",
    );
  }
  await runTmux(pi, ["-V"], signal);
  const windowId = await runTmux(
    pi,
    ["display-message", "-p", "-t", paneId, "#{window_id}"],
    signal,
  );
  return { paneId, windowId };
}

async function findLatestLiveSubagentPane(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string,
): Promise<string | undefined> {
  const records = Array.from(registry.values()).sort((a, b) => b.createdAt - a.createdAt);
  for (const record of records) {
    if (record.windowId !== windowId) continue;
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) return record.paneId;
  }
  return undefined;
}

async function spawnOneSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetPane: string,
  split: SplitDirection,
  size: string | undefined,
  spec: SubagentSpec,
  windowId: string,
): Promise<SpawnedSubagentRecord> {
  const resolvedSpec = resolveSubagentSpec(spec);
  const id = randomUUID();
  const name = sanitizeName(resolvedSpec.name, friendlySubagentName(id));
  const cwd = resolveInsideRoot(ctx.cwd, resolvedSpec.cwd);
  const validatedSize = validateSplitSize(size);
  const files = await writeSubagentFiles(ctx, resolvedSpec, id, name, cwd);

  const tmuxArgs = ["split-window", "-P", "-F", "#{pane_id}", "-t", targetPane];
  if (!resolvedSpec.focus) tmuxArgs.push("-d");
  tmuxArgs.push(split === "right" ? "-h" : "-v");
  if (validatedSize) tmuxArgs.push("-l", validatedSize);
  tmuxArgs.push("-c", cwd, `bash ${shellQuote(files.runScriptPath)}`);

  const paneId = await runTmux(pi, tmuxArgs, ctx.signal);
  await runTmux(pi, ["select-pane", "-t", paneId, "-T", `pi:${name}`], ctx.signal).catch(
    () => undefined,
  );

  const record: SpawnedSubagentRecord = {
    id: files.id,
    name,
    paneId,
    windowId,
    cwd,
    promptPreview: previewText(resolvedSpec.prompt),
    profile: resolvedSpec.profile,
    model: resolvedSpec.model,
    provider: resolvedSpec.provider,
    thinking: resolvedSpec.thinking,
    tools: resolvedSpec.tools,
    skills: resolvedSpec.skills,
    writableFiles: writableFilesForSpec(resolvedSpec, ctx.cwd),
    contractFiles: contractFilesForSpec(resolvedSpec, ctx.cwd),
    bridgePath: files.bridgePath,
    configPath: files.configPath,
    controlPath: files.controlPath,
    outboxPath: files.outboxPath,
    runScriptPath: files.runScriptPath,
    promptPath: files.promptPath,
    systemPromptPath: files.systemPromptPath,
    replaceSystemPrompt: resolvedSpec.replaceSystemPrompt ?? false,
    noSession: resolvedSpec.noSession ?? false,
    createdAt: Date.now(),
  };
  registry.set(record.id, record);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, record });
  return record;
}

async function spawnSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: SpawnSubagentsInput,
): Promise<SpawnedSubagentRecord[]> {
  if (input.agents.length > MAX_SUBAGENTS_PER_CALL) {
    throw new Error(
      `Too many subagents (${input.agents.length}); max is ${MAX_SUBAGENTS_PER_CALL}.`,
    );
  }

  const tmux = await ensureTmux(pi, ctx.signal);
  await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  validateImplementationAssignments(input.agents, Array.from(registry.values()), ctx.cwd);
  const records: SpawnedSubagentRecord[] = [];
  let stackTargetPane = await findLatestLiveSubagentPane(pi, ctx.signal, tmux.windowId);

  for (let index = 0; index < input.agents.length; index += 1) {
    const spec = input.agents[index];
    const placement = planSubagentPlacement(Boolean(stackTargetPane), spec.split, spec.size);
    const targetPane = placement.target === "main" ? tmux.paneId : (stackTargetPane ?? tmux.paneId);
    const record = await spawnOneSubagent(
      pi,
      ctx,
      targetPane,
      placement.split,
      placement.size,
      spec,
      tmux.windowId,
    );
    records.push(record);
    stackTargetPane = record.paneId;
  }

  const layout: LayoutMode = input.layout ?? "none";
  if (layout !== "none" && records.length > 1) {
    await runTmux(pi, ["select-layout", "-t", tmux.paneId, layout], ctx.signal).catch(
      () => undefined,
    );
  }

  return records;
}

function restoreRegistry(ctx: ExtensionContext, windowId: string | undefined) {
  registry = windowId
    ? restoreRecordsForWindow(ctx.sessionManager.getBranch() as SubagentSessionEntry[], windowId)
    : new Map();
}

function formatRecord(record: SpawnedSubagentRecord, status?: PaneStatus): string {
  const state =
    status?.exists === false
      ? "missing"
      : status?.dead
        ? "dead"
        : status?.currentCommand || "running";
  const profile = record.profile ? ` profile=${record.profile}` : "";
  const model = record.model ? ` model=${record.model}` : "";
  const provider = record.provider ? ` provider=${record.provider}` : "";
  return [
    `${record.name} ${record.paneId} [${state}]`,
    `  cwd: ${shortenHomePath(record.cwd)}`,
    `  task: ${record.promptPreview}`,
    `  control: ${shortenHomePath(record.controlPath)}`,
    `  run: ${shortenHomePath(record.runScriptPath)}${profile}${model}${provider}`,
  ].join("\n");
}

function findRecord(idOrName: string | undefined): SpawnedSubagentRecord | undefined {
  if (!idOrName) return undefined;
  for (const record of registry.values()) {
    if (record.id === idOrName || record.paneId === idOrName || record.name === idOrName)
      return record;
    if (record.id.startsWith(idOrName)) return record;
  }
  return undefined;
}

async function paneStatus(
  pi: ExtensionAPI,
  paneId: string,
  signal: AbortSignal | undefined,
): Promise<PaneStatus> {
  try {
    const output = await runTmux(
      pi,
      [
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_dead}\t#{pane_current_command}\t#{pane_title}\t#{window_id}",
      ],
      signal,
    );
    const [dead, currentCommand, title, windowId] = output.split("\t");
    return { exists: true, dead: dead === "1", currentCommand, title, windowId };
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pruneMissingRecords(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string | undefined,
): Promise<number> {
  if (!process.env.TMUX || !windowId) return 0;
  let removed = 0;
  for (const record of Array.from(registry.values())) {
    if (record.windowId !== windowId) {
      registry.delete(record.id);
      removed += 1;
      continue;
    }
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) continue;
    registry.delete(record.id);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, {
      version: 3,
      killedId: record.id,
      killedAt: Date.now(),
      reason: status.dead ? "dead-pane" : status.exists ? "different-window" : "missing-pane",
    });
    removed += 1;
  }
  return removed;
}

function updateSubagentStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(EXTENSION_NAME, `agents:${registry.size}`);
}

async function appendSubagentQuestion(params: AskMainAgentInput): Promise<string> {
  const outboxPath = process.env.PI_SUBAGENT_OUTBOX;
  if (!outboxPath) {
    return `${ASK_MAIN_TOOL_NAME} only works inside a tmux subagent spawned by ${SPAWN_TOOL_NAME}.`;
  }

  const question: SubagentQuestion = {
    id: randomUUID(),
    type: "question",
    addressedTo: params.addressedTo ?? "unsure",
    question: params.question,
    context: params.context,
    whatDone: params.whatDone,
    options: params.options,
    timestamp: Date.now(),
  };
  await appendFile(outboxPath, `${JSON.stringify(question)}\n`, "utf8");
  return "Question sent to the main agent. Wait for the answer before continuing.";
}

async function readOutboxEvents(record: SpawnedSubagentRecord): Promise<SubagentOutboxEvent[]> {
  if (!record.outboxPath) return [];
  let fileStat;
  try {
    fileStat = await stat(record.outboxPath);
  } catch {
    return [];
  }

  let offset = outboxOffsets.get(record.id) ?? 0;
  if (fileStat.size < offset) offset = 0;
  if (fileStat.size === offset) return [];

  const length = fileStat.size - offset;
  const buffer = Buffer.alloc(length);
  const handle = await open(record.outboxPath, "r");
  try {
    await handle.read(buffer, 0, length, offset);
  } finally {
    await handle.close();
  }
  outboxOffsets.set(record.id, fileStat.size);

  const events: SubagentOutboxEvent[] = [];
  for (const rawLine of buffer.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as SubagentOutboxEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed) events.push(parsed);
    } catch {
      // Ignore partial or malformed outbox lines.
    }
  }
  return events;
}

async function markSubagentDone(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  reason: string,
  completion?: SubagentDoneEvent,
): Promise<void> {
  if (!registry.has(record.id)) return;
  registry.delete(record.id);
  outboxOffsets.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, {
    version: 3,
    killedId: record.id,
    killedAt: Date.now(),
    reason,
    completion,
  });
  await runTmux(pi, ["kill-pane", "-t", record.paneId], ctx.signal).catch(() => undefined);
  updateSubagentStatus(ctx);
}

async function forwardSubagentQuestion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
): Promise<void> {
  if (seenQuestionIds.has(question.id)) return;
  seenQuestionIds.add(question.id);
  const recentOutput = await capturePane(pi, record.paneId, 80, ctx.signal).catch(() => "");
  const message = formatQuestionForMainAgent(record, question, recentOutput);
  if (ctx.isIdle()) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function forwardSubagentCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): void {
  const message = formatSubagentCompletionSummary(record, completion);
  const payload = {
    customType: COMPLETION_MESSAGE_TYPE,
    content: message,
    display: true,
    details: {
      subagentId: record.id,
      subagentName: record.name,
      paneId: record.paneId,
      completion,
    },
  };
  if (ctx.isIdle()) pi.sendMessage(payload);
  else pi.sendMessage(payload, { deliverAs: "followUp" });
}

async function pollSubagentOutboxes(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  for (const record of Array.from(registry.values())) {
    const events = await readOutboxEvents(record);
    for (const event of events) {
      if (event.type === "done") {
        try {
          forwardSubagentCompletion(pi, ctx, record, event);
        } catch {
          // Keep cleanup reliable even if automatic summary injection fails.
        }
        await markSubagentDone(pi, ctx, record, "agent-ended", event);
        break;
      }
      if (event.type === "question") await forwardSubagentQuestion(pi, ctx, record, event);
    }
  }
}

function startMaintenanceLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  windowId: string | undefined,
) {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (!windowId) return;
  const tick = async () => {
    await pollSubagentOutboxes(pi, ctx).catch(() => undefined);
    await pruneMissingRecords(pi, ctx.signal, windowId).catch(() => undefined);
    updateSubagentStatus(ctx);
  };
  void tick();
  maintenanceTimer = setInterval(() => void tick(), 1000);
}

async function listRecords(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<string> {
  if (registry.size === 0) return "No live subagents in this Pi session branch.";
  const chunks: string[] = [];
  for (const record of registry.values()) {
    chunks.push(formatRecord(record, await paneStatus(pi, record.paneId, signal)));
  }
  return chunks.join("\n\n");
}

async function capturePane(
  pi: ExtensionAPI,
  paneId: string,
  lines: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return runTmux(pi, ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`], signal);
}

async function sendToSubagent(
  record: SpawnedSubagentRecord,
  message: string,
  delivery: MessageDelivery | undefined,
): Promise<string> {
  if (!message.trim()) throw new Error("Message is required for action=send.");
  if (!record.controlPath)
    throw new Error(
      `Subagent ${record.name} has no control path; respawn it with the updated extension.`,
    );
  await appendFile(
    record.controlPath,
    `${JSON.stringify({ type: "send", message, delivery: delivery ?? "prompt", timestamp: Date.now() })}\n`,
    "utf8",
  );
  return `Queued message to ${record.name} ${record.paneId}.`;
}

async function handlePaneAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: PanesInput,
): Promise<string> {
  const tmux = await ensureTmux(pi, ctx.signal);
  const removed = await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  if (input.action === "list") {
    const text = await listRecords(pi, ctx.signal);
    return removed > 0
      ? `Pruned ${removed} stale subagent record${removed === 1 ? "" : "s"}.\n\n${text}`
      : text;
  }

  const record = findRecord(input.id);
  if (!record) {
    const known = Array.from(registry.values())
      .map((r) => `${r.name} (${r.paneId})`)
      .join(", ");
    throw new Error(`Unknown subagent: ${input.id ?? "(missing id)"}. Known: ${known || "none"}`);
  }

  if (input.action === "capture") {
    const lines = clampCaptureLines(input.lines);
    const output = await capturePane(pi, record.paneId, lines, ctx.signal);
    return `Captured last ${lines} lines from ${record.name} ${record.paneId}:\n\n${output || "(no pane output)"}`;
  }

  if (input.action === "send") return sendToSubagent(record, input.message ?? "", input.delivery);

  if (input.action === "abort") {
    await appendFile(
      record.controlPath,
      `${JSON.stringify({ type: "abort", timestamp: Date.now() })}\n`,
      "utf8",
    );
    return `Queued abort for ${record.name} ${record.paneId}.`;
  }

  await runTmux(pi, ["kill-pane", "-t", record.paneId], ctx.signal);
  registry.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, killedId: record.id, killedAt: Date.now() });
  return `Killed subagent ${record.name} ${record.paneId}.`;
}

function spawnResultText(records: SpawnedSubagentRecord[]): string {
  return [
    `Spawned ${records.length} RPC subagent pane${records.length === 1 ? "" : "s"}.`,
    ...records.map(
      (record) =>
        `- ${record.name}: ${record.paneId}\n  task: ${record.promptPreview}\n  control: ${shortenHomePath(record.controlPath)}`,
    ),
  ].join("\n");
}

function parseSpawnArgs(args: string): SpawnSubagentsInput | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as
      | SpawnSubagentsInput
      | SubagentSpec[]
      | SubagentSpec
      | unknown;
    if (Array.isArray(parsed)) return { agents: parsed as SubagentSpec[] };
    if (!parsed || typeof parsed !== "object")
      throw new Error("Subagent JSON must be an object or array.");
    if ("agents" in parsed) return parsed as SpawnSubagentsInput;
    return { agents: [parsed as SubagentSpec] };
  }
  return { agents: [{ prompt: trimmed }] };
}

async function promptForSubagent(ctx: ExtensionContext): Promise<SpawnSubagentsInput | null> {
  if (!ctx.hasUI) return null;
  const prompt = await ctx.ui.editor("Subagent prompt/task (optional; blank starts idle)", "");
  const nameInput = (await ctx.ui.input("Subagent name (optional)", "auto-generated")) || "";
  const name =
    nameInput.trim() && nameInput.trim() !== "auto-generated" ? nameInput.trim() : undefined;
  const profileChoice = (await ctx.ui.select("Worker profile", [
    "none",
    ...SUBAGENT_PROFILE_NAMES,
  ])) as SubagentSpec["profile"] | "none" | undefined;
  const systemPrompt = await ctx.ui.editor("System instructions to append (optional)", "");
  const model = (await ctx.ui.input("Model (optional)", DEFAULT_SUBAGENT_MODEL)) || undefined;
  const toolsText = (await ctx.ui.input("Tool allowlist (optional comma-separated)", "")) || "";
  const splitChoice = (await ctx.ui.select("Split pane", ["auto", "right", "below"])) as
    | "auto"
    | SplitDirection
    | undefined;
  const saveSession = await ctx.ui.confirm(
    "Save subagent session?",
    "Yes = normal Pi session history. No = --no-session.",
  );
  const focus = await ctx.ui.confirm(
    "Focus new pane?",
    "No keeps you in the current Pi pane while the subagent runs.",
  );

  return {
    agents: [
      {
        name,
        profile: profileChoice && profileChoice !== "none" ? profileChoice : undefined,
        prompt: prompt?.trim() ? prompt : undefined,
        systemPrompt: systemPrompt?.trim() ? systemPrompt : undefined,
        model: model?.trim() ? model.trim() : undefined,
        tools: toolsText.trim()
          ? toolsText
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean)
          : undefined,
        split: splitChoice && splitChoice !== "auto" ? splitChoice : undefined,
        noSession: !saveSession,
        focus,
      },
    ],
  };
}

function parseSubagentsCommand(args: string): PanesInput {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const [actionRaw, id, third, ...rest] = trimmed.split(/\s+/);
  const action = (actionRaw || "list") as PaneAction;
  if (!["list", "capture", "kill", "send", "abort"].includes(action)) {
    throw new Error(
      "Usage: /agents [list|capture <id> [lines]|kill <id>|abort <id>|send <id> <message>]",
    );
  }
  if (action === "send") return { action, id, message: [third, ...rest].filter(Boolean).join(" ") };
  return { action, id, lines: third ? Number(third) : undefined };
}

export default function tmuxSubagents(pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    COMPLETION_MESSAGE_TYPE,
    (message) => new Text(String(message.content ?? ""), 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
    const tmux = await ensureTmux(pi, ctx.signal).catch(() => undefined);
    restoreRegistry(ctx, tmux?.windowId);
    outboxOffsets = new Map();
    seenQuestionIds = new Set();
    await pruneMissingRecords(pi, ctx.signal, tmux?.windowId).catch(() => undefined);
    updateSubagentStatus(ctx);
    startMaintenanceLoop(pi, ctx, tmux?.windowId);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, undefined);
  });

  pi.registerTool({
    name: ASK_MAIN_TOOL_NAME,
    label: "Ask main agent",
    description:
      "For tmux subagents only: ask the main Pi agent a question. If the question is for the user or unclear, the main agent will prompt the user with context.",
    promptSnippet: "Let a spawned tmux subagent ask the main Pi agent or user a question",
    promptGuidelines: [
      "Use ask_main_agent from a spawned subagent when blocked by a question instead of guessing.",
      "When using ask_main_agent, include whatDone and context so the main agent can answer or prompt the user.",
      "Set ask_main_agent addressedTo to user for product/intent decisions, main_agent for implementation coordination, and unsure if unclear.",
    ],
    parameters: askMainAgentSchema,
    async execute(_toolCallId, params) {
      const text = await appendSubagentQuestion(params);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: SPAWN_TOOL_NAME,
    label: "Spawn tmux RPC subagents",
    description: [
      "Spawn one or more independent Pi subagents in new tmux panes.",
      "Each pane runs a small readable bridge that starts `pi --mode rpc`, displays the conversation, accepts direct typed messages,",
      "and receives messages from the main agent through subagent_panes(action='send').",
      "Each subagent can use a domain profile and structured work packet, plus its own prompt, system prompt, model, thinking level, tools, skills, cwd, and session mode.",
    ].join(" "),
    promptSnippet:
      "Spawn independent Pi RPC subagents in visible tmux panes with custom prompts/models/system instructions",
    promptGuidelines: [
      "Use spawn_subagents when work can be delegated to independent agents that the user should be able to watch in tmux panes.",
      "For implementation, use frontend-implementer, backend-implementer, unit-test-implementer, or e2e-test-implementer with a workPacket that declares exclusive writableFiles, read-only contractFiles, acceptanceCriteria, and nonGoals.",
      "Never give concurrent implementation subagents overlapping writableFiles; route all contract changes through the main agent.",
      "Use subagent_panes with action send to communicate with spawned subagents, and action capture to inspect pane output.",
    ],
    parameters: spawnSubagentsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const records = await spawnSubagents(pi, ctx, params);
      updateSubagentStatus(ctx);
      return {
        content: [{ type: "text" as const, text: spawnResultText(records) }],
        details: { records },
      };
    },
    renderCall(args, theme) {
      const agents = Array.isArray(args.agents) ? args.agents : [];
      let text = theme.fg("toolTitle", theme.bold("spawn_subagents "));
      text += theme.fg("accent", `${agents.length || 0} rpc pane${agents.length === 1 ? "" : "s"}`);
      for (const agent of agents.slice(0, 4)) {
        text += `\n  ${theme.fg("accent", agent.name || "subagent")}: ${theme.fg("dim", previewText(agent.prompt, 72))}`;
      }
      if (agents.length > 4) text += `\n  ${theme.fg("muted", `... +${agents.length - 4} more`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const records =
        (result.details as { records?: SpawnedSubagentRecord[] } | undefined)?.records ?? [];
      if (records.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no subagents)", 0, 0);
      }
      let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("spawned "))}${theme.fg(
        "accent",
        `${records.length} rpc pane${records.length === 1 ? "" : "s"}`,
      )}`;
      for (const record of records) {
        text += `\n  ${theme.fg("accent", record.name)} ${theme.fg("muted", record.paneId)} ${theme.fg(
          "dim",
          record.promptPreview,
        )}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: PANES_TOOL_NAME,
    label: "Manage subagent panes",
    description:
      "List known tmux subagent panes, capture recent output, send messages to RPC subagents, abort, or kill panes.",
    promptSnippet:
      "List, capture, send messages to, abort, or kill tmux subagent panes spawned by spawn_subagents",
    parameters: panesSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await handlePaneAction(pi, ctx, params);
      updateSubagentStatus(ctx);
      return { content: [{ type: "text" as const, text }], details: { action: params.action } };
    },
  });

  pi.registerCommand("agent", {
    description: "Spawn a Pi RPC subagent in a new tmux pane. Args: prompt text or JSON spec.",
    handler: async (args, ctx) => {
      let input: SpawnSubagentsInput | null;
      try {
        const parsed = parseSpawnArgs(args);
        input = parsed ?? (await promptForSubagent(ctx));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!input) {
        ctx.ui.notify("No subagent config provided.", "warning");
        return;
      }
      try {
        const records = await spawnSubagents(pi, ctx, input);
        updateSubagentStatus(ctx);
        ctx.ui.notify(spawnResultText(records), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description:
      "List/capture/send/abort/kill spawned subagent panes. Usage: /agents [list|capture <id> [lines]|send <id> <msg>|abort <id>|kill <id>]",
    handler: async (args, ctx) => {
      let input: PanesInput;
      try {
        input = parseSubagentsCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      try {
        const text = await handlePaneAction(pi, ctx, input);
        updateSubagentStatus(ctx);
        if (input.action === "list" || input.action === "capture")
          await ctx.ui.editor(`Subagents ${input.action}`, text);
        else ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
