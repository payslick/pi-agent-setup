import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getAccessMode, getAccessProjectRoot, type AccessMode } from "../access-mode/state";
import { assertSubagentExecuteAccess } from "./access";
export {
  assertSubagentExecuteAccess,
  piArgsForSpec,
  resolveSubagentCwd,
  subagentAccessEnvironment,
} from "./access";
import { parseManageCommand, parseSpawnArgs, promptForSubagent } from "./commands";
import { settledCompletionFromReference } from "./completion";
import { validateImplementationAssignments } from "./assignments";
import {
  formatAgentHandoff,
  nextAgentAttempt,
  readAgentCheckpoint,
  readPersistedWorkPacket,
} from "./artifacts";
import {
  ensureSyntheticFailureForRecord,
  loadSuccessfulHandoff,
  persistLifecycleTransition,
  runLoggedRecordOperation,
  restartSpecFromPacket,
  submitCheckpointFromEnvironment,
  submitHandoffFromEnvironment,
} from "./lifecycle";
import { readSubagentOutbox } from "./outbox";
import { formatSpawnedSubagents, formatSubagentRecord } from "./records";
import { renderSubagentCompletionMessage } from "./render";
export { renderSubagentCompletionMessage } from "./render";
import { spawnOneHerdrSubagent } from "./spawn";
import {
  askMainAgentSchema,
  DEFAULT_READ_LINES,
  DEFAULT_SUBAGENT_MODEL,
  manageSubagentsSchema,
  MAX_SUBAGENTS_PER_CALL,
  spawnSubagentsSchema,
  submitCheckpointSchema,
  submitHandoffSchema,
  type AskMainAgentInput,
  type ManageSubagentsInput,
  type SpawnSubagentsInput,
  type SubmitCheckpointInput,
  type SubmitHandoffInput,
  type SubagentSpec,
} from "./schemas";
import {
  COMPLETION_MESSAGE_TYPE,
  CUSTOM_ENTRY_TYPE,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  restoreRecordsForWorkspace,
  type SpawnedSubagentRecord,
  type SubagentDoneEvent,
  type SubagentQuestion,
  type SubagentSessionEntry,
} from "./state";

const EXTENSION_NAME = "herdr-subagents";
const SPAWN_TOOL_NAME = "herdr_spawn_agents";
const MANAGE_TOOL_NAME = "herdr_manage_agents";
const ASK_MAIN_TOOL_NAME = "ask_main_agent";
const SUBMIT_CHECKPOINT_TOOL_NAME = "submit_checkpoint";
const SUBMIT_HANDOFF_TOOL_NAME = "submit_handoff";
const MAX_READ_LINES = 1000;
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

const clampReadLines = (lines: number | undefined): number => {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_READ_LINES;
  return Math.max(1, Math.min(MAX_READ_LINES, Math.floor(lines)));
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

export const agentPromptArgs = (target: string, prompt: string): string[] => [
  "agent",
  "prompt",
  target,
  prompt,
];

const promptAgent = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  target: string,
  prompt: string,
  waitForWorking: boolean,
): Promise<void> => {
  const args = agentPromptArgs(target, prompt);
  if (waitForWorking) args.push("--wait", "--until", "working", "--timeout", "5000");
  await runHerdr(pi, args, signal, 7000);
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
    version: 5,
    removedId: record.id,
    removedAt: Date.now(),
    reason,
    completion,
  });
};

const cleanupFailedSpawn = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  tabId: string,
): Promise<void> => {
  await closeTab(pi, signal, tabId).catch(() => undefined);
};

const spawningAgentDefaults = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Pick<SubagentSpec, "model" | "thinking"> => ({
  model:
    process.env.PI_SUBAGENT_DEFAULT_MODEL?.trim() ||
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_SUBAGENT_MODEL),
  thinking: pi.getThinkingLevel(),
});

const spawnOneSubagent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workspaceId: string,
  spec: SubagentSpec,
  mode: AccessMode,
  projectRoot: string,
  restart?: { taskId: string; attempt: number; parentAgentId?: string },
): Promise<SpawnedSubagentRecord> =>
  spawnOneHerdrSubagent(
    spec,
    {
      cwd: ctx.cwd,
      projectRoot,
      workspaceId,
      mode,
      parentSessionId: ctx.sessionManager.getSessionId(),
      defaults: spawningAgentDefaults(pi, ctx),
      restart,
    },
    {
      createTab: (targetWorkspace, cwd, label, focus, environment) =>
        createTab(pi, ctx, targetWorkspace, cwd, label, focus, environment),
      startAgent: (name, paneId, args) => startAgent(pi, ctx, name, paneId, args),
      promptAgent: (name, prompt) => promptAgent(pi, ctx.signal, name, prompt, true),
      cleanupFailedSpawn: (tabId) => cleanupFailedSpawn(pi, ctx.signal, tabId),
      persistRecord(record) {
        registry.set(record.id, record);
        pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
      },
    },
  );

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
    const mode = getAccessMode();
    assertSubagentExecuteAccess(mode);
    const projectRoot = getAccessProjectRoot(ctx.cwd);
    const herdr = ensureHerdr();
    await pruneMissingRecords(pi, ctx.signal, herdr.workspaceId);
    validateImplementationAssignments(input.agents, [...registry.values()], projectRoot);
    const records: SpawnedSubagentRecord[] = [];
    for (const spec of input.agents) {
      records.push(await spawnOneSubagent(pi, ctx, herdr.workspaceId, spec, mode, projectRoot));
    }
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
  let missing = 0;
  for (const record of registry.values()) {
    if (record.workspaceId !== workspaceId) {
      registry.delete(record.id);
      continue;
    }
    if (record.lifecycleStatus === "missing" || (await getAgent(pi, signal, record.paneId))) continue;
    if (!record.mainSessionId || !record.taskId || !record.attempt) {
      removeRecord(pi, record, "missing-agent-without-durable-packet");
      missing += 1;
      continue;
    }
    record.prompted = false;
    await persistLifecycleTransition(record, "missing", "agent.missing", {
      message: "Herdr no longer reports this agent.",
    });
    await ensureSyntheticFailureForRecord(
      record,
      "error",
      "Herdr no longer reports this agent.",
    );
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
    missing += 1;
  }
  return missing;
};

const formatRecord = async (
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  record: SpawnedSubagentRecord,
): Promise<string> =>
  formatSubagentRecord(record, (await getAgent(pi, signal, record.paneId))?.agent_status);

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
    artifactPath: params.artifactPath,
    timestamp: Date.now(),
  };
  await appendFile(outboxPath, `${JSON.stringify(question)}\n`, "utf8");
  return "Question sent to the main agent. Wait for an answer before continuing.";
};

const readOutboxEvents = async (record: SpawnedSubagentRecord): Promise<SubagentQuestion[]> => {
  const result = await readSubagentOutbox(
    record,
    outboxOffsets.get(record.id) ?? record.outboxOffset ?? 0,
  );
  outboxOffsets.set(record.id, result.offset);
  return result.questions;
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
  if (record.mainSessionId && record.taskId && record.attempt)
    await persistLifecycleTransition(record, "waiting-main", "agent.question.sent", {
      message: question.question,
      data: { artifactPath: question.artifactPath },
    });
  const recent = await readAgent(pi, ctx.signal, record.paneId, 80).catch(() => "");
  sendMainMessage(pi, ctx, formatQuestionForMainAgent(record, question, recent));
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
};

const finishSuccessfulSubagent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): Promise<void> => {
  try {
    const handoff = await loadSuccessfulHandoff(record.projectRoot ?? ctx.cwd, record);
    completion.result = formatAgentHandoff(handoff);
    completion.handoffPath = record.handoffPath;
    await persistLifecycleTransition(record, "succeeded", "agent.succeeded", {
      data: { handoffPath: record.handoffPath },
    });
  } catch (error) {
    record.prompted = false;
    await persistLifecycleTransition(record, "blocked", "agent.handoff.invalid", { error });
    sendMainMessage(
      pi,
      ctx,
      `Herdr agent ${record.name} cannot complete: ${error instanceof Error ? error.message : String(error)}\nDurable attempt: ${record.workPacketPath ?? "unknown"}`,
      COMPLETION_MESSAGE_TYPE,
    );
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
    return;
  }
  if (!record.completionDelivered) {
    sendMainMessage(
      pi,
      ctx,
      formatSubagentCompletionSummary(record, completion),
      COMPLETION_MESSAGE_TYPE,
    );
    record.completionDelivered = true;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
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
  if (
    completion.status === "error" ||
    completion.status === "aborted" ||
    completion.status === "blocked"
  ) {
    const status = completion.status === "error" ? "failed" : completion.status;
    const message = completion.errorMessage || completion.result || `Agent ${completion.status}.`;
    if (record.mainSessionId && record.taskId && record.attempt) {
      await persistLifecycleTransition(record, status, `agent.${completion.status}`, {
        message,
        ...(completion.status === "error" ? { error: new Error(message) } : {}),
      });
      if (completion.status !== "blocked")
        await ensureSyntheticFailureForRecord(record, completion.status, message);
    }
    sendMainMessage(
      pi,
      ctx,
      formatSubagentCompletionSummary(record, completion),
      COMPLETION_MESSAGE_TYPE,
    );
    record.prompted = false;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
  }
};

const pollSubagentOutboxes = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  for (const record of registry.values()) {
    const questions = await readOutboxEvents(record);
    for (const question of questions) await forwardQuestion(pi, ctx, record, question);
    if (!questions.length) continue;
    record.outboxOffset = outboxOffsets.get(record.id);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
  }
};

const pollSubagentStates = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  for (const record of registry.values()) {
    const agent = await getAgent(pi, ctx.signal, record.paneId);
    if (!agent) {
      if (record.lifecycleStatus !== "missing") {
        record.prompted = false;
        if (record.mainSessionId && record.taskId && record.attempt) {
          await persistLifecycleTransition(record, "missing", "agent.missing", {
            message: "Herdr no longer reports this agent.",
          });
          await ensureSyntheticFailureForRecord(
            record,
            "error",
            "Herdr no longer reports this agent.",
          );
          pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
        } else removeRecord(pi, record, "missing-agent-without-durable-packet");
      }
      updateSubagentStatus(ctx);
      continue;
    }
    if (agent.agent_status === "working") {
      record.prompted = true;
      awaitingWorking.delete(record.id);
      settledPolls.delete(record.id);
      continue;
    }
    const settled =
      agent.agent_status === "idle" ||
      agent.agent_status === "done" ||
      agent.agent_status === "blocked";
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
        pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
      }
      if (pendingQuestions.has(record.id)) continue;
      const completion = await settledCompletionFromReference(record, agent.agent_session);
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
    } catch (error) {
      for (const record of registry.values()) {
        if (!record.mainSessionId || !record.taskId || !record.attempt) continue;
        await persistLifecycleTransition(
          record,
          record.lifecycleStatus ?? "working",
          "maintenance.failed",
          { error },
        ).catch(() => undefined);
      }
      updateSubagentStatus(ctx);
    } finally {
      maintenanceRunning = false;
    }
  };
  void tick();
  maintenanceTimer = setInterval(() => void tick(), HERDR_POLL_INTERVAL_MS);
};

export const missingSubagentActionResult = (input: ManageSubagentsInput): string => {
  if (input.action === "abort" || input.action === "close") return "";
  throw new Error(`Unknown subagent: ${input.id ?? "(missing id)"}.`);
};

const handleManageAction = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: ManageSubagentsInput,
): Promise<string> => {
  assertSubagentExecuteAccess();
  const herdr = ensureHerdr();
  const removed = await pruneMissingRecords(pi, ctx.signal, herdr.workspaceId);
  if (input.action === "list") {
    const records = await listRecords(pi, ctx.signal);
    return removed ? `Marked ${removed} missing subagent record(s).\n\n${records}` : records;
  }
  const record = findRecord(input.id);
  if (!record) return missingSubagentActionResult(input);
  if (input.action === "restart") {
    if (!record.workPacketPath || !record.mainSessionId || !record.taskId)
      throw new Error(`${record.name} has no durable work packet and cannot be restarted.`);
    const { packet, checkpoint } = await runLoggedRecordOperation(
      record,
      "agent.restart.artifacts.invalid",
      async () => ({
        packet: await readPersistedWorkPacket(record.workPacketPath!),
        checkpoint: record.checkpointPath
          ? await readAgentCheckpoint(record.checkpointPath)
          : undefined,
      }),
    );
    const spec = restartSpecFromPacket(packet, checkpoint);
    const mode = getAccessMode();
    const projectRoot = getAccessProjectRoot(ctx.cwd);
    const attempt = await nextAgentAttempt(projectRoot, record.mainSessionId, record.taskId);
    const existing = await getAgent(pi, ctx.signal, record.paneId);
    if (existing)
      await runLoggedRecordOperation(record, "agent.restart.close.failed", () =>
        closeTab(pi, ctx.signal, record.tabId),
      );
    await persistLifecycleTransition(record, "aborted", "agent.restart.requested", {
      message: `Restarting as attempt ${attempt}.`,
    });
    await ensureSyntheticFailureForRecord(
      record,
      "aborted",
      `Attempt ${record.attempt ?? "legacy"} was replaced by restart attempt ${attempt}.`,
    );
    removeRecord(pi, record, "restarted");
    validateImplementationAssignments([spec], [...registry.values()], projectRoot);
    const restarted = await spawnOneSubagent(
      pi,
      ctx,
      herdr.workspaceId,
      spec,
      mode,
      projectRoot,
      { taskId: record.taskId, attempt, parentAgentId: record.id },
    );
    return `Restarted ${record.name} as ${restarted.name} attempt ${attempt}.`;
  }
  if (input.action === "read")
    return runLoggedRecordOperation(record, "agent.read.failed", () =>
      readAgent(pi, ctx.signal, record.paneId, clampReadLines(input.lines)),
    );
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
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
    try {
      await promptAgent(pi, ctx.signal, record.paneId, input.message, false);
      awaitingWorking.delete(record.id);
      if (record.mainSessionId && record.taskId && record.attempt)
        await persistLifecycleTransition(record, "working", "agent.prompt.delivered", {
          message: "The main thread delivered a follow-up prompt.",
        });
      return `Prompted ${record.name}.`;
    } catch (error) {
      awaitingWorking.delete(record.id);
      record.promptGeneration = Math.max(0, (record.promptGeneration ?? 1) - 1);
      if (wasWaitingForAnswer) pendingQuestions.add(record.id);
      record.waitingForAnswer = wasWaitingForAnswer;
      pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 5, record });
      if (record.mainSessionId && record.taskId && record.attempt)
        await persistLifecycleTransition(record, "blocked", "agent.prompt.failed", { error });
      throw error;
    } finally {
      promptLocks.delete(record.id);
    }
  }
  if (input.action === "focus") {
    await runLoggedRecordOperation(record, "agent.focus.failed", () =>
      runHerdr(pi, ["agent", "focus", record.paneId], ctx.signal),
    );
    return `Focused ${record.name}.`;
  }
  if (input.action === "abort") {
    await runLoggedRecordOperation(record, "agent.abort.failed", () =>
      runHerdr(pi, ["agent", "send-keys", record.paneId, "ctrl+c"], ctx.signal),
    );
    if (record.mainSessionId && record.taskId && record.attempt)
      await persistLifecycleTransition(record, "aborted", "agent.abort.requested", {
        message: "The main thread requested an abort.",
      });
    return `Sent abort to ${record.name}.`;
  }
  if (record.mainSessionId && record.taskId && record.attempt) {
    await persistLifecycleTransition(record, "aborted", "agent.closed", {
      message: "The main thread closed this attempt.",
    });
    await ensureSyntheticFailureForRecord(
      record,
      "aborted",
      "The main thread closed this attempt.",
    );
  }
  await runLoggedRecordOperation(record, "agent.close.failed", () =>
    closeTab(pi, ctx.signal, record.tabId),
  );
  removeRecord(pi, record, "closed");
  return `Closed ${record.name} and tab ${record.tabLabel}.`;
};

const registerLifecycle = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, renderSubagentCompletionMessage);
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
    name: SUBMIT_CHECKPOINT_TOOL_NAME,
    label: "Persist Herdr checkpoint",
    description:
      "For Herdr workers: persist restartable progress, remaining work, validation, and blockers in the current attempt.",
    parameters: submitCheckpointSchema,
    async execute(_toolCallId, params: SubmitCheckpointInput) {
      const checkpointPath = await submitCheckpointFromEnvironment(params);
      return {
        content: [{ type: "text" as const, text: `Checkpoint saved: ${checkpointPath}` }],
        details: { checkpointPath },
      };
    },
  });

  pi.registerTool({
    name: SUBMIT_HANDOFF_TOOL_NAME,
    label: "Persist Herdr handoff",
    description:
      "For Herdr workers: persist the canonical completion, blocked, error, or internal-module-request handoff for the current attempt.",
    parameters: submitHandoffSchema,
    async execute(_toolCallId, params: SubmitHandoffInput) {
      const handoffPath = await submitHandoffFromEnvironment(params);
      return {
        content: [{ type: "text" as const, text: `Handoff saved: ${handoffPath}` }],
        details: { handoffPath },
      };
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
      "Use herdr_manage_agents to inspect, prompt, focus, abort, close, or restart workers.",
      "Workers must persist checkpoints and a canonical handoff before completion.",
    ],
    parameters: spawnSubagentsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const records = await spawnSubagents(pi, ctx, params);
      updateSubagentStatus(ctx);
      return {
        content: [{ type: "text" as const, text: formatSpawnedSubagents(records) }],
        details: { records },
      };
    },
    renderCall(args, theme) {
      const agents = Array.isArray(args.agents) ? args.agents : [];
      return new Text(
        `${theme.fg("toolTitle", theme.bold("herdr_spawn_agents "))}${theme.fg("accent", `${agents.length} Herdr tab${agents.length === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: MANAGE_TOOL_NAME,
    label: "Manage Herdr subagents",
    description: "List, read, prompt, focus, abort, close, or restart Herdr-managed subagents.",
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
        ctx.ui.notify(formatSpawnedSubagents(records), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description: "Manage Herdr subagents: list, read, prompt, focus, abort, close, or restart.",
    handler: async (args, ctx) => {
      try {
        const input = parseManageCommand(args);
        const text = await handleManageAction(pi, ctx, input);
        updateSubagentStatus(ctx);
        if (input.action === "list" || input.action === "read") {
          await ctx.ui.editor(`Subagents ${input.action}`, text);
          return;
        }
        if (text) ctx.ui.notify(text, "info");
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
