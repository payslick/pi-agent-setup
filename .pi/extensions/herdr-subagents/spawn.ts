import { randomUUID } from "node:crypto";
import type { AccessMode } from "../access-mode/state";
import { piArgsForSpec, resolveSubagentCwd, subagentAccessEnvironment } from "./access";
import {
  appendAgentEvent,
  HERDR_RUN_SCHEMA_VERSION,
  initializeAgentArtifacts,
  nextAgentAttempt,
  writeAgentStatus,
  writeSessionReference,
  writeSyntheticFailureHandoff,
  type AgentArtifactPaths,
  type AgentRunIdentity,
} from "./artifacts";
import { contractFilesForSpec, writableFilesForSpec } from "./assignments";
import { artifactEnvironment } from "./lifecycle";
import { resolveSubagentSpec } from "./profiles";
import type { SubagentSpec } from "./schemas";
import { sessionIdFromPath } from "./session";
import {
  agentNameForSpec,
  sessionNameForSpec,
  tabLabelForSpec,
  type SpawnedSubagentRecord,
} from "./state";

export interface SpawnedHerdrAgent {
  agent_session?: {
    kind?: string;
    value?: string;
  };
}

export interface CreatedHerdrTab {
  tab: { tab_id: string };
  root_pane: { pane_id: string };
}

export interface SpawnSubagentRuntime {
  createTab(
    workspaceId: string,
    cwd: string,
    label: string,
    focus: boolean,
    environment: Record<string, string>,
  ): Promise<CreatedHerdrTab>;
  startAgent(name: string, paneId: string, args: string[]): Promise<SpawnedHerdrAgent>;
  promptAgent(name: string, prompt: string): Promise<void>;
  cleanupFailedSpawn(tabId: string): Promise<void>;
  persistRecord(record: SpawnedSubagentRecord): void;
}

export interface SpawnSubagentContext {
  cwd: string;
  projectRoot: string;
  workspaceId: string;
  mode: AccessMode;
  parentSessionId: string;
  defaults: Pick<SubagentSpec, "model" | "thinking">;
  restart?: { taskId: string; attempt: number; parentAgentId?: string };
}

const previewText = (text: string | undefined, maxLength = 140): string => {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "(idle)";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
};

const errorFields = (error: unknown): { message: string; stack?: string } =>
  error instanceof Error
    ? { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { message: String(error) };

const taskIdForSpec = (spec: SubagentSpec, id: string): string =>
  spec.workPacket?.taskId?.trim() || spec.name?.trim() || `${tabLabelForSpec(spec)}-${id.slice(0, 8)}`;

const statusArtifact = (
  identity: AgentRunIdentity,
  status: Parameters<typeof writeAgentStatus>[1]["status"],
  message?: string,
) => ({
  schemaVersion: HERDR_RUN_SCHEMA_VERSION,
  identity,
  status,
  updatedAt: Date.now(),
  ...(message ? { message } : {}),
});

const logAgentEvent = async (
  paths: AgentArtifactPaths,
  identity: AgentRunIdentity,
  level: "info" | "error",
  event: string,
  options: { data?: Record<string, unknown>; error?: unknown } = {},
): Promise<void> =>
  appendAgentEvent(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    timestamp: Date.now(),
    level,
    event,
    identity,
    ...(options.data ? { data: options.data } : {}),
    ...(options.error === undefined ? {} : { error: errorFields(options.error) }),
  });

export async function spawnOneHerdrSubagent(
  spec: SubagentSpec,
  context: SpawnSubagentContext,
  runtime: SpawnSubagentRuntime,
): Promise<SpawnedSubagentRecord> {
  const resolved = resolveSubagentSpec(spec, context.defaults, context.parentSessionId);
  const id = randomUUID();
  const taskId = context.restart?.taskId ?? taskIdForSpec(resolved, id);
  const attempt =
    context.restart?.attempt ??
    (await nextAgentAttempt(context.projectRoot, context.parentSessionId, taskId));
  const identity: AgentRunIdentity = {
    mainSessionId: context.parentSessionId,
    taskId,
    agentId: id,
    attempt,
    workspaceId: context.workspaceId,
    ...(resolved.profile ? { profile: resolved.profile } : {}),
    ...(context.restart?.parentAgentId
      ? { parentAgentId: context.restart.parentAgentId }
      : {}),
  };
  const name = agentNameForSpec(resolved, id);
  const tabLabel = tabLabelForSpec(resolved);
  const sessionName = sessionNameForSpec(resolved, context.parentSessionId);
  const cwd = await resolveSubagentCwd(
    context.cwd,
    resolved.cwd,
    context.mode,
    context.projectRoot,
  );
  const paths = await initializeAgentArtifacts(
    context.projectRoot,
    identity,
    spec,
    resolved.systemPrompt,
    resolved.prompt,
  );
  const systemPromptPath = resolved.systemPrompt?.trim() ? paths.systemPromptPath : undefined;
  const writableFiles = writableFilesForSpec(resolved, context.projectRoot);
  const contractFiles = contractFilesForSpec(resolved, context.projectRoot);
  let created: CreatedHerdrTab;
  try {
    await writeAgentStatus(paths, statusArtifact(identity, "starting"));
    await logAgentEvent(paths, identity, "info", "agent.spawn.requested", {
      data: { profile: resolved.profile, cwd, tabLabel },
    });
    created = await runtime.createTab(
      context.workspaceId,
      cwd,
      tabLabel,
      resolved.focus ?? false,
      {
        PI_SUBAGENT_ID: id,
        PI_SUBAGENT_NAME: name,
        PI_SUBAGENT_TYPE: resolved.profile ?? "subagent",
        PI_SUBAGENT_OUTBOX: paths.outboxPath,
        ...(resolved.workPacket
          ? { PI_AGENT_WRITABLE_FILES: JSON.stringify(writableFiles ?? []) }
          : {}),
        ...artifactEnvironment(identity, paths, resolved.workPacket),
        ...subagentAccessEnvironment(context.mode, context.projectRoot),
      },
    );
  } catch (error) {
    await writeAgentStatus(paths, statusArtifact(identity, "failed", errorFields(error).message));
    await logAgentEvent(paths, identity, "error", "agent.spawn.failed", { error });
    await writeSyntheticFailureHandoff(paths, identity, "error", errorFields(error).message);
    throw error;
  }
  const record: SpawnedSubagentRecord = {
    id,
    name,
    tabId: created.tab.tab_id,
    paneId: created.root_pane.pane_id,
    workspaceId: context.workspaceId,
    tabLabel,
    cwd,
    projectRoot: context.projectRoot,
    promptPreview: previewText(resolved.prompt),
    prompted: Boolean(resolved.prompt?.trim()),
    promptGeneration: resolved.prompt?.trim() ? 1 : 0,
    profile: resolved.profile,
    model: resolved.model,
    provider: resolved.provider,
    thinking: resolved.thinking,
    tools: resolved.tools,
    skills: resolved.skills,
    writableFiles,
    contractFiles,
    outboxPath: paths.outboxPath,
    replaceSystemPrompt: resolved.replaceSystemPrompt ?? false,
    createdAt: Date.now(),
    mainSessionId: context.parentSessionId,
    taskId,
    attempt,
    parentAgentId: context.restart?.parentAgentId,
    lifecycleStatus: "starting",
    workPacketPath: paths.workPacketPath,
    promptPath: paths.promptPath,
    statusPath: paths.statusPath,
    checkpointPath: paths.checkpointPath,
    handoffPath: paths.handoffPath,
    eventsPath: paths.eventsPath,
    errorsPath: paths.errorsPath,
    systemPromptPath,
    spec: resolved,
  };
  try {
    const agent = await runtime.startAgent(name, record.paneId, [
      ...piArgsForSpec(resolved, context.projectRoot, systemPromptPath, context.mode),
      "--name",
      sessionName,
      "--append-system-prompt",
      `You are Herdr subagent ${name}. Use ask_main_agent when blocked. Persist checkpoints and a final handoff with the dedicated tools.`,
    ]);
    const session = agent.agent_session;
    if (session?.kind === "path" && session.value) {
      record.sessionPath = session.value;
      record.agentSessionId = sessionIdFromPath(session.value);
      await writeSessionReference(paths, identity, session.value, record.agentSessionId);
    }
    if (resolved.prompt?.trim()) await runtime.promptAgent(name, resolved.prompt);
    record.lifecycleStatus = "working";
    await writeAgentStatus(paths, statusArtifact(identity, "working"));
    await logAgentEvent(paths, identity, "info", "agent.started", {
      data: { tabId: record.tabId, paneId: record.paneId },
    });
    runtime.persistRecord(record);
    return record;
  } catch (error) {
    record.lifecycleStatus = "failed";
    runtime.persistRecord(record);
    await writeAgentStatus(paths, statusArtifact(identity, "failed", errorFields(error).message));
    await logAgentEvent(paths, identity, "error", "agent.start.failed", { error });
    await writeSyntheticFailureHandoff(paths, identity, "error", errorFields(error).message);
    try {
      await runtime.cleanupFailedSpawn(record.tabId);
    } catch (cleanupError) {
      await logAgentEvent(paths, identity, "error", "agent.cleanup.failed", {
        error: cleanupError,
      });
    }
    throw error;
  }
}
