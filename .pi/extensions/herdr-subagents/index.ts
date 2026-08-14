import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  contractFilesForSpec,
  validateImplementationAssignments,
  writableFilesForSpec,
} from "./assignments";
import { resolveSubagentSpec } from "./profiles";
import { completionFromSession } from "./session";
import {
  askMainAgentSchema,
  DEFAULT_READ_LINES,
  DEFAULT_SUBAGENT_MODEL,
  manageSubagentsSchema,
  MAX_SUBAGENTS_PER_CALL,
  spawnSubagentsSchema,
  type AskMainAgentInput,
  type ManageSubagentsInput,
  type SpawnSubagentsInput,
  type SubagentSpec,
} from "./schemas";
import {
  agentNameForSpec,
  COMPLETION_MESSAGE_TYPE,
  CUSTOM_ENTRY_TYPE,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  restoreRecordsForWorkspace,
  shortenHomePath,
  tabLabelForSpec,
  type SpawnedSubagentRecord,
  type SubagentDoneEvent,
  type SubagentQuestion,
  type SubagentSessionEntry,
} from "./state";

const EXTENSION_NAME = "herdr-subagents";
const SPAWN_TOOL_NAME = "spawn_subagents";
const MANAGE_TOOL_NAME = "manage_subagents";
const ASK_MAIN_TOOL_NAME = "ask_main_agent";
const MAX_READ_LINES = 1000;
const OUTBOX_ROOT = path.join(".pi", "tmp", "herdr-subagents");
const HERDR_POLL_INTERVAL_MS = 1000;

type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label?: string;
}

interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused?: boolean;
}

interface HerdrAgent extends HerdrPane {
  agent_status: HerdrAgentStatus;
  agent_session?: {
    kind?: string;
    value?: string;
  };
}

interface HerdrCommandResult<T> {
  result: T;
}

interface HerdrContext {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

let registry = new Map<string, SpawnedSubagentRecord>();
let outboxOffsets = new Map<string, number>();
let seenQuestionIds = new Set<string>();
let pendingQuestions = new Set<string>();
let completionInFlight = new Set<string>();
let awaitingWorking = new Set<string>();
let settledPolls = new Map<string, number>();
let promptLocks = new Set<string>();
let spawnLock = false;
let maintenanceRunning = false;
let maintenanceTimer: NodeJS.Timeout | undefined;

const previewText = (text: string | undefined, maxLength = 140): string => {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "(idle)";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
};

const clampReadLines = (lines: number | undefined): number => {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_READ_LINES;
  return Math.max(1, Math.min(MAX_READ_LINES, Math.floor(lines)));
};

const resolveCwd = (root: string, requested: string | undefined): string =>
  requested ? path.resolve(root, requested) : root;

const resolveProjectPath = (root: string, requested: string): string => {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Subagent skill must stay inside ${root}: ${requested}`);
  return resolved;
};

const appendSkillArgs = (args: string[], spec: SubagentSpec, projectRoot: string): void => {
  if (spec.skills !== undefined) {
    args.push("--no-skills");
    for (const skill of spec.skills) args.push("--skill", resolveProjectPath(projectRoot, skill));
    return;
  }
  if (spec.noSkills) args.push("--no-skills");
};

export const piArgsForSpec = (
  spec: SubagentSpec,
  projectRoot: string,
  systemPromptArgument = spec.systemPrompt?.replace(/\s+/g, " ").trim(),
): string[] => {
  const args: string[] = [];
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model || !spec.provider) args.push("--model", spec.model ?? DEFAULT_SUBAGENT_MODEL);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.noTools) args.push("--no-tools");
  if (!spec.noTools && spec.noBuiltinTools) args.push("--no-builtin-tools");
  if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
  if (spec.excludeTools?.length) args.push("--exclude-tools", spec.excludeTools.join(","));
  if (spec.inheritContext === false) args.push("--no-context-files");
  if (spec.noExtensions) args.push("--no-extensions");
  appendSkillArgs(args, spec, projectRoot);
  if (spec.noPromptTemplates) args.push("--no-prompt-templates");
  if (systemPromptArgument) {
    args.push(
      spec.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt",
      systemPromptArgument,
    );
  }
  return args;
};

const runHerdr = async <T>(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 30_000,
): Promise<T> => {
  const result = await pi.exec("herdr", args, { signal, timeout });
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `herdr exited with ${result.code}`;
    throw new Error(detail);
  }
  try {
    return (JSON.parse(result.stdout) as HerdrCommandResult<T>).result;
  } catch {
    throw new Error(`Invalid Herdr response: ${result.stdout.trim() || "(empty)"}`);
  }
};

const ensureHerdr = (): HerdrContext => {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId || !tabId || !workspaceId) {
    throw new Error("Herdr subagents require Pi to run inside a Herdr-managed pane.");
  }
  return { paneId, tabId, workspaceId };
};

export const shouldPlayMainAgentSound = (
  environment: NodeJS.ProcessEnv,
  focused: boolean,
): boolean => environment.HERDR_ENV === "1" && !environment.PI_SUBAGENT_ID && !focused;

const playMainAgentSound = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  if (process.env.HERDR_ENV !== "1" || process.env.PI_SUBAGENT_ID) return;
  const current = await runHerdr<{ pane: HerdrPane }>(
    pi,
    ["pane", "current", "--current"],
    ctx.signal,
  );
  if (!shouldPlayMainAgentSound(process.env, current.pane.focused ?? false)) return;
  await runHerdr(pi, ["notification", "show", "Pi completed", "--sound", "done"], ctx.signal);
};

const createTab = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workspaceId: string,
  cwd: string,
  label: string,
  focus: boolean,
  environment: Record<string, string>,
): Promise<{ tab: HerdrTab; root_pane: HerdrPane }> => {
  const environmentArgs = Object.entries(environment).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
  return runHerdr(
    pi,
    [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      ...environmentArgs,
      focus ? "--focus" : "--no-focus",
    ],
    ctx.signal,
  );
};

const startAgent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  recordName: string,
  paneId: string,
  args: string[],
): Promise<HerdrAgent> => {
  const result = await runHerdr<{ agent: HerdrAgent }>(
    pi,
    [
      "agent",
      "start",
      recordName,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--timeout",
      "60000",
      "--",
      ...args,
    ],
    ctx.signal,
    70_000,
  );
  return result.agent;
};

const promptAgent = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  target: string,
  prompt: string,
): Promise<void> => {
  await runHerdr(
    pi,
    ["agent", "prompt", target, prompt, "--wait", "--until", "working", "--timeout", "5000"],
    signal,
    7000,
  );
};

const readAgent = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  target: string,
  lines = DEFAULT_READ_LINES,
): Promise<string> => {
  const result = await pi.exec(
    "herdr",
    ["agent", "read", target, "--source", "recent-unwrapped", "--lines", `${lines}`],
    { signal, timeout: 30_000 },
  );
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `herdr exited with ${result.code}`,
    );
  return result.stdout.trim();
};

const herdrErrorCode = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return (JSON.parse(message) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

const getAgent = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  target: string,
): Promise<HerdrAgent | undefined> => {
  try {
    const result = await runHerdr<{ agent: HerdrAgent }>(pi, ["agent", "get", target], signal);
    return result.agent;
  } catch (error) {
    if (herdrErrorCode(error) === "agent_not_found") return undefined;
    throw error;
  }
};

const closeTab = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  tabId: string,
): Promise<void> => {
  await runHerdr(pi, ["tab", "close", tabId], signal);
};

const removeRecord = (
  pi: ExtensionAPI,
  record: SpawnedSubagentRecord,
  reason: string,
  completion?: SubagentDoneEvent,
): void => {
  registry.delete(record.id);
  outboxOffsets.delete(record.id);
  completionInFlight.delete(record.id);
  awaitingWorking.delete(record.id);
  settledPolls.delete(record.id);
  pendingQuestions.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, {
    version: 4,
    removedId: record.id,
    removedAt: Date.now(),
    reason,
    completion,
  });
};

const writeOutboxEnv = async (root: string, id: string): Promise<string> => {
  const directory = path.resolve(root, OUTBOX_ROOT);
  await mkdir(directory, { recursive: true });
  const outboxPath = path.join(directory, `${id}.jsonl`);
  await appendFile(outboxPath, "", { encoding: "utf8", mode: 0o600 });
  return outboxPath;
};

const writeSystemPromptFile = async (
  root: string,
  id: string,
  systemPrompt: string | undefined,
): Promise<string | undefined> => {
  if (!systemPrompt?.trim()) return undefined;
  const directory = path.resolve(root, OUTBOX_ROOT);
  await mkdir(directory, { recursive: true });
  const systemPromptPath = path.join(directory, `${id}.system-prompt.md`);
  await writeFile(systemPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  return systemPromptPath;
};

const cleanupFailedSpawn = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  tabId: string,
): Promise<void> => {
  await closeTab(pi, signal, tabId).catch(() => undefined);
};

const spawnOneSubagent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workspaceId: string,
  spec: SubagentSpec,
): Promise<SpawnedSubagentRecord> => {
  const resolved = resolveSubagentSpec(spec);
  const id = randomUUID();
  const name = agentNameForSpec(resolved, id);
  const tabLabel = tabLabelForSpec(resolved);
  const cwd = resolveCwd(ctx.cwd, resolved.cwd);
  const outboxPath = await writeOutboxEnv(ctx.cwd, id);
  const systemPromptPath = await writeSystemPromptFile(ctx.cwd, id, resolved.systemPrompt);
  const created = await createTab(pi, ctx, workspaceId, cwd, tabLabel, resolved.focus ?? false, {
    PI_SUBAGENT_ID: id,
    PI_SUBAGENT_NAME: name,
    PI_SUBAGENT_OUTBOX: outboxPath,
  });
  const record: SpawnedSubagentRecord = {
    id,
    name,
    tabId: created.tab.tab_id,
    paneId: created.root_pane.pane_id,
    workspaceId,
    tabLabel,
    cwd,
    promptPreview: previewText(resolved.prompt),
    prompted: Boolean(resolved.prompt?.trim()),
    promptGeneration: resolved.prompt?.trim() ? 1 : 0,
    profile: resolved.profile,
    model: resolved.model,
    provider: resolved.provider,
    thinking: resolved.thinking,
    tools: resolved.tools,
    skills: resolved.skills,
    writableFiles: writableFilesForSpec(resolved, ctx.cwd),
    contractFiles: contractFilesForSpec(resolved, ctx.cwd),
    outboxPath,
    replaceSystemPrompt: resolved.replaceSystemPrompt ?? false,
    createdAt: Date.now(),
  };
  try {
    await startAgent(pi, ctx, name, record.paneId, [
      ...piArgsForSpec(resolved, ctx.cwd, systemPromptPath),
      "--name",
      tabLabel,
      "--append-system-prompt",
      `You are Herdr subagent ${name}. Use ask_main_agent when blocked.`,
    ]);
    if (resolved.prompt?.trim()) await promptAgent(pi, ctx.signal, name, resolved.prompt);
    registry.set(record.id, record);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
    return record;
  } catch (error) {
    registry.delete(record.id);
    await cleanupFailedSpawn(pi, ctx.signal, record.tabId);
    throw error;
  }
};

const spawnSubagents = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: SpawnSubagentsInput,
): Promise<SpawnedSubagentRecord[]> => {
  if (spawnLock) throw new Error("Another subagent spawn is already in progress.");
  spawnLock = true;
  try {
    if (input.agents.length > MAX_SUBAGENTS_PER_CALL)
      throw new Error(`Too many subagents; max is ${MAX_SUBAGENTS_PER_CALL}.`);
    const herdr = ensureHerdr();
    await pruneMissingRecords(pi, ctx.signal, herdr.workspaceId);
    validateImplementationAssignments(input.agents, [...registry.values()], ctx.cwd);
    const records: SpawnedSubagentRecord[] = [];
    for (const spec of input.agents)
      records.push(await spawnOneSubagent(pi, ctx, herdr.workspaceId, spec));
    return records;
  } finally {
    spawnLock = false;
  }
};

const findRecord = (idOrName: string | undefined): SpawnedSubagentRecord | undefined => {
  if (!idOrName) return undefined;
  return [...registry.values()].find(
    (record) =>
      record.id === idOrName ||
      record.id.startsWith(idOrName) ||
      record.name === idOrName ||
      record.tabId === idOrName ||
      record.paneId === idOrName,
  );
};

const pruneMissingRecords = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  workspaceId: string,
): Promise<number> => {
  let removed = 0;
  for (const record of registry.values()) {
    if (record.workspaceId !== workspaceId) {
      registry.delete(record.id);
      removed += 1;
      continue;
    }
    if (await getAgent(pi, signal, record.paneId)) continue;
    removeRecord(pi, record, "missing-agent");
    removed += 1;
  }
  return removed;
};

const formatRecord = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  record: SpawnedSubagentRecord,
): Promise<string> => {
  const agent = await getAgent(pi, signal, record.paneId);
  return [
    `${record.name} [${agent?.agent_status ?? "missing"}] tab=${record.tabLabel} ${record.tabId}`,
    `  cwd: ${shortenHomePath(record.cwd)}`,
    `  task: ${record.promptPreview}`,
    `  profile: ${record.profile ?? "none"}`,
  ].join("\n");
};

const listRecords = async (pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<string> => {
  if (!registry.size) return "No live Herdr subagents in this session branch.";
  const records: string[] = [];
  for (const record of registry.values()) records.push(await formatRecord(pi, signal, record));
  return records.join("\n\n");
};

const updateSubagentStatus = (ctx: ExtensionContext): void => {
  if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, `herdr-agents:${registry.size}`);
};

const appendSubagentQuestion = async (params: AskMainAgentInput): Promise<string> => {
  const outboxPath = process.env.PI_SUBAGENT_OUTBOX;
  if (!outboxPath) return `${ASK_MAIN_TOOL_NAME} only works inside a Herdr subagent.`;
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
  return "Question sent to the main agent. Wait for an answer before continuing.";
};

const readOutboxEvents = async (record: SpawnedSubagentRecord): Promise<SubagentQuestion[]> => {
  let fileStat;
  try {
    fileStat = await stat(record.outboxPath);
  } catch {
    return [];
  }
  let offset = outboxOffsets.get(record.id) ?? record.outboxOffset ?? 0;
  if (fileStat.size < offset) offset = 0;
  if (fileStat.size === offset) return [];
  const buffer = Buffer.alloc(fileStat.size - offset);
  const handle = await open(record.outboxPath, "r");
  try {
    await handle.read(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }
  outboxOffsets.set(record.id, fileStat.size);
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as SubagentQuestion;
        return event.type === "question" ? [event] : [];
      } catch {
        return [];
      }
    });
};

const sendMainMessage = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: string,
  customType?: string,
): void => {
  const options = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
  if (!customType) {
    pi.sendUserMessage(content, options);
    return;
  }
  pi.sendMessage({ customType, content, display: true }, options);
};

const forwardQuestion = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
): Promise<void> => {
  if (seenQuestionIds.has(question.id)) return;
  seenQuestionIds.add(question.id);
  if (record.waitingForAnswer || pendingQuestions.has(record.id))
    throw new Error(
      `${record.name} emitted another question before its previous question was answered.`,
    );
  pendingQuestions.add(record.id);
  record.waitingForAnswer = true;
  const recent = await readAgent(pi, ctx.signal, record.paneId, 80).catch(() => "");
  sendMainMessage(pi, ctx, formatQuestionForMainAgent(record, question, recent));
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
};

const finishSuccessfulSubagent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): Promise<void> => {
  if (!record.completionDelivered) {
    sendMainMessage(
      pi,
      ctx,
      formatSubagentCompletionSummary(record, completion),
      COMPLETION_MESSAGE_TYPE,
    );
    record.completionDelivered = true;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
  }
  await closeTab(pi, ctx.signal, record.tabId);
  removeRecord(pi, record, "success", completion);
  updateSubagentStatus(ctx);
};

const handleCompletion = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): Promise<void> => {
  if (completion.status === "success") {
    await finishSuccessfulSubagent(pi, ctx, record, completion);
    return;
  }
  if (completion.status === "error" || completion.status === "aborted") {
    sendMainMessage(
      pi,
      ctx,
      formatSubagentCompletionSummary(record, completion),
      COMPLETION_MESSAGE_TYPE,
    );
    record.prompted = false;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
  }
};

const pollSubagentOutboxes = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  for (const record of registry.values()) {
    const questions = await readOutboxEvents(record);
    for (const question of questions) await forwardQuestion(pi, ctx, record, question);
    if (!questions.length) continue;
    record.outboxOffset = outboxOffsets.get(record.id);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
  }
};

const settledCompletion = async (
  record: SpawnedSubagentRecord,
  agent: HerdrAgent,
): Promise<SubagentDoneEvent | undefined> => {
  const session = agent.agent_session;
  if (session?.kind === "path" && session.value)
    return completionFromSession(record, session.value);
  return undefined;
};

const pollSubagentStates = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  for (const record of registry.values()) {
    const agent = await getAgent(pi, ctx.signal, record.paneId);
    if (!agent) {
      removeRecord(pi, record, "missing-agent");
      updateSubagentStatus(ctx);
      continue;
    }
    if (agent.agent_status === "working") {
      record.prompted = true;
      awaitingWorking.delete(record.id);
      settledPolls.delete(record.id);
      continue;
    }
    const settled = agent.agent_status === "idle" || agent.agent_status === "done";
    if (
      !settled ||
      !record.prompted ||
      awaitingWorking.has(record.id) ||
      pendingQuestions.has(record.id)
    )
      continue;
    const observations = (settledPolls.get(record.id) ?? 0) + 1;
    settledPolls.set(record.id, observations);
    if (observations < 2 || completionInFlight.has(record.id)) continue;
    completionInFlight.add(record.id);
    const generation = record.promptGeneration ?? 0;
    try {
      const questions = await readOutboxEvents(record);
      for (const question of questions) await forwardQuestion(pi, ctx, record, question);
      if (questions.length) {
        record.outboxOffset = outboxOffsets.get(record.id);
        pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
      }
      if (pendingQuestions.has(record.id)) continue;
      const completion = await settledCompletion(record, agent);
      if (
        completion &&
        generation === (record.promptGeneration ?? 0) &&
        !awaitingWorking.has(record.id)
      )
        await handleCompletion(pi, ctx, record, completion);
    } finally {
      completionInFlight.delete(record.id);
    }
  }
};

const startMaintenanceLoop = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const tick = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await pollSubagentOutboxes(pi, ctx);
      await pollSubagentStates(pi, ctx);
      updateSubagentStatus(ctx);
    } catch {
      updateSubagentStatus(ctx);
    } finally {
      maintenanceRunning = false;
    }
  };
  void tick();
  maintenanceTimer = setInterval(() => void tick(), HERDR_POLL_INTERVAL_MS);
};

const handleManageAction = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: ManageSubagentsInput,
): Promise<string> => {
  const herdr = ensureHerdr();
  const removed = await pruneMissingRecords(pi, ctx.signal, herdr.workspaceId);
  if (input.action === "list") {
    const records = await listRecords(pi, ctx.signal);
    return removed ? `Pruned ${removed} stale subagent record(s).\n\n${records}` : records;
  }
  const record = findRecord(input.id);
  if (!record) throw new Error(`Unknown subagent: ${input.id ?? "(missing id)"}.`);
  if (input.action === "read")
    return readAgent(pi, ctx.signal, record.paneId, clampReadLines(input.lines));
  if (input.action === "prompt") {
    if (!input.message?.trim()) throw new Error("Message is required for action=prompt.");
    if (promptLocks.has(record.id))
      throw new Error(`${record.name} already has a prompt in progress.`);
    promptLocks.add(record.id);
    const wasWaitingForAnswer = record.waitingForAnswer ?? false;
    pendingQuestions.delete(record.id);
    awaitingWorking.add(record.id);
    settledPolls.delete(record.id);
    record.prompted = true;
    record.promptGeneration = (record.promptGeneration ?? 0) + 1;
    record.waitingForAnswer = false;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
    try {
      await promptAgent(pi, ctx.signal, record.paneId, input.message);
      awaitingWorking.delete(record.id);
      return `Prompted ${record.name}.`;
    } catch (error) {
      awaitingWorking.delete(record.id);
      record.promptGeneration = Math.max(0, (record.promptGeneration ?? 1) - 1);
      if (wasWaitingForAnswer) pendingQuestions.add(record.id);
      record.waitingForAnswer = wasWaitingForAnswer;
      pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 4, record });
      throw error;
    } finally {
      promptLocks.delete(record.id);
    }
  }
  if (input.action === "focus") {
    await runHerdr(pi, ["agent", "focus", record.paneId], ctx.signal);
    return `Focused ${record.name}.`;
  }
  if (input.action === "abort") {
    await runHerdr(pi, ["agent", "send-keys", record.paneId, "ctrl+c"], ctx.signal);
    return `Sent abort to ${record.name}.`;
  }
  await closeTab(pi, ctx.signal, record.tabId);
  removeRecord(pi, record, "closed");
  return `Closed ${record.name} and tab ${record.tabLabel}.`;
};

const spawnResultText = (records: SpawnedSubagentRecord[]): string =>
  [
    `Started ${records.length} Herdr subagent${records.length === 1 ? "" : "s"}.`,
    ...records.map(
      (record) =>
        `- ${record.name}: tab ${record.tabLabel} (${record.tabId})\n  task: ${record.promptPreview}`,
    ),
  ].join("\n");

const parseSpawnArgs = (args: string): SpawnSubagentsInput | null => {
  const trimmed = args.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
    return { agents: [{ prompt: trimmed }] };
  const parsed = JSON.parse(trimmed) as SpawnSubagentsInput | SubagentSpec[] | SubagentSpec;
  if (Array.isArray(parsed)) return { agents: parsed };
  if ("agents" in parsed) return parsed;
  return { agents: [parsed] };
};

const promptForSubagent = async (ctx: ExtensionContext): Promise<SpawnSubagentsInput | null> => {
  if (!ctx.hasUI) return null;
  const prompt = await ctx.ui.editor("Subagent task (optional; blank starts idle)", "");
  const focus = await ctx.ui.confirm("Focus new Herdr tab?", "No keeps the current tab focused.");
  return { agents: [{ prompt: prompt?.trim() || undefined, focus }] };
};

const parseManageCommand = (args: string): ManageSubagentsInput => {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const [action, id, third, ...rest] = trimmed.split(/\s+/);
  if (action === "prompt")
    return { action, id, message: [third, ...rest].filter(Boolean).join(" ") };
  if (!["list", "read", "focus", "abort", "close"].includes(action))
    throw new Error(
      "Usage: /agents [list|read <id> [lines]|prompt <id> <message>|focus <id>|abort <id>|close <id>]",
    );
  return {
    action: action as ManageSubagentsInput["action"],
    id,
    lines: third ? Number(third) : undefined,
  };
};

const registerLifecycle = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(
    COMPLETION_MESSAGE_TYPE,
    (message) => new Text(String(message.content ?? ""), 0, 0),
  );
  pi.on("session_start", async (_event, ctx) => {
    const herdr = ensureHerdr();
    registry = restoreRecordsForWorkspace(
      ctx.sessionManager.getBranch() as SubagentSessionEntry[],
      herdr.workspaceId,
    );
    outboxOffsets = new Map(
      [...registry.values()].map((record) => [record.id, record.outboxOffset ?? 0]),
    );
    seenQuestionIds = new Set();
    pendingQuestions = new Set(
      [...registry.values()].filter((record) => record.waitingForAnswer).map((record) => record.id),
    );
    completionInFlight = new Set();
    awaitingWorking = new Set();
    settledPolls = new Map();
    promptLocks = new Set();
    spawnLock = false;
    maintenanceRunning = false;
    await pruneMissingRecords(pi, ctx.signal, herdr.workspaceId).catch(() => undefined);
    updateSubagentStatus(ctx);
    startMaintenanceLoop(pi, ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await playMainAgentSound(pi, ctx).catch(() => undefined);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, undefined);
  });
};

const registerTools = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: ASK_MAIN_TOOL_NAME,
    label: "Ask main agent",
    description: "For Herdr subagents: ask the main Pi agent or user a question with context.",
    parameters: askMainAgentSchema,
    async execute(_toolCallId, params) {
      const text = await appendSubagentQuestion(params);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: SPAWN_TOOL_NAME,
    label: "Start Herdr subagents",
    description:
      "Start independent Pi subagents in separate tabs of the current Herdr workspace. Tabs use abbreviated type/task labels of at most three words and close automatically after successful completion.",
    promptGuidelines: [
      "Use structured workPacket ownership for implementation profiles.",
      "Never overlap writableFiles or let workers modify contractFiles.",
      "Use manage_subagents to inspect, prompt, focus, abort, or close workers.",
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
      return new Text(
        `${theme.fg("toolTitle", theme.bold("spawn_subagents "))}${theme.fg("accent", `${agents.length} Herdr tab${agents.length === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: MANAGE_TOOL_NAME,
    label: "Manage Herdr subagents",
    description: "List, read, prompt, focus, abort, or close Herdr-managed subagents.",
    parameters: manageSubagentsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await handleManageAction(pi, ctx, params);
      updateSubagentStatus(ctx);
      return { content: [{ type: "text" as const, text }], details: { action: params.action } };
    },
  });
};

const registerCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("agent", {
    description: "Start a Pi subagent in a new tab of the current Herdr workspace.",
    handler: async (args, ctx) => {
      try {
        const input = parseSpawnArgs(args) ?? (await promptForSubagent(ctx));
        if (!input) return;
        const records = await spawnSubagents(pi, ctx, input);
        updateSubagentStatus(ctx);
        ctx.ui.notify(spawnResultText(records), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description: "Manage Herdr subagents: list, read, prompt, focus, abort, or close.",
    handler: async (args, ctx) => {
      try {
        const input = parseManageCommand(args);
        const text = await handleManageAction(pi, ctx, input);
        updateSubagentStatus(ctx);
        if (input.action === "list" || input.action === "read")
          await ctx.ui.editor(`Subagents ${input.action}`, text);
        else ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
};

export default function herdrSubagents(pi: ExtensionAPI) {
  registerLifecycle(pi);
  registerTools(pi);
  registerCommands(pi);
}
