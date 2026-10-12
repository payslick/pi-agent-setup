import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  agentArtifactPaths,
  agentIdentityFromEnvironment,
  checkpointFromInput,
  formatAgentHandoff,
  handoffFromInput,
  HERDR_RUN_SCHEMA_VERSION,
  readAgentHandoff,
  writeAgentCheckpoint,
  writeAgentHandoff,
  writeAgentStatus,
  writeSessionReference,
  writeSyntheticFailureHandoff,
  appendAgentEvent,
  type AgentArtifactPaths,
  type AgentArtifactStatus,
  type AgentCheckpoint,
  type AgentHandoff,
  type AgentRunEvent,
  type AgentRunIdentity,
  type PersistedWorkPacket,
} from "./artifacts";
import { validateFrozenTestStructures } from "./contract-validation";
import {
  IMPLEMENTATION_PROFILE_NAMES,
  type SubmitCheckpointInput,
  SubmitHandoffInput,
  SubagentSpec,
  SubagentWorkPacket,
} from "./schemas";
import type { SpawnedSubagentRecord, SubagentDoneEvent } from "./state";

export function artifactEnvironment(
  identity: AgentRunIdentity,
  paths: AgentArtifactPaths,
  packet: SubagentWorkPacket | undefined,
): Record<string, string> {
  return {
    PI_MAIN_SESSION_ID: identity.mainSessionId,
    HERDR_WORKSPACE_ID: identity.workspaceId,
    PI_TASK_ID: identity.taskId,
    PI_AGENT_ATTEMPT: String(identity.attempt),
    PI_AGENT_WORK_PACKET: paths.workPacketPath,
    PI_AGENT_PROMPT: paths.promptPath,
    PI_AGENT_STATUS: paths.statusPath,
    PI_AGENT_CHECKPOINT: paths.checkpointPath,
    PI_AGENT_HANDOFF: paths.handoffPath,
    PI_AGENT_EVENTS: paths.eventsPath,
    PI_AGENT_ERRORS: paths.errorsPath,
    PI_VALIDATION_PHASE: packet?.validationPhase ?? "green",
    PI_EXPECTED_FAILING_TESTS: JSON.stringify(packet?.expectedFailingTests ?? []),
    ...(identity.parentAgentId ? { PI_PARENT_AGENT_ID: identity.parentAgentId } : {}),
  };
}

const submittedHandoffStatus = (
  status: SubmitHandoffInput["status"],
): AgentArtifactStatus => {
  if (status === "error") return "failed";
  if (status === "aborted") return "aborted";
  if (status === "blocked" || status === "needs-main") return "blocked";
  return "working";
};

const submittedHandoffLevel = (status: AgentArtifactStatus): AgentRunEvent["level"] => {
  if (status === "failed") return "error";
  if (status === "blocked") return "warn";
  return "info";
};

export async function submitCheckpointFromEnvironment(
  input: SubmitCheckpointInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = agentIdentityFromEnvironment(environment);
  const projectRoot = environment.PI_ACCESS_PROJECT_ROOT;
  if (!identity || !projectRoot)
    throw new Error("submit_checkpoint requires a durable Herdr worker identity.");
  const paths = agentArtifactPaths(projectRoot, identity);
  await writeAgentCheckpoint(paths, checkpointFromInput(identity, input));
  await writeAgentStatus(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    status: input.blocker ? "blocked" : "working",
    updatedAt: Date.now(),
    ...(input.blocker ? { message: input.blocker } : {}),
  });
  await appendAgentEvent(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    timestamp: Date.now(),
    level: input.blocker ? "warn" : "info",
    event: "agent.checkpoint.submitted",
    ...(input.blocker ? { message: input.blocker } : {}),
  });
  return paths.checkpointPath;
}

export async function submitHandoffFromEnvironment(
  input: SubmitHandoffInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = agentIdentityFromEnvironment(environment);
  const projectRoot = environment.PI_ACCESS_PROJECT_ROOT;
  if (!identity || !projectRoot)
    throw new Error("submit_handoff requires a durable Herdr worker identity.");
  const paths = agentArtifactPaths(projectRoot, identity);
  await writeAgentHandoff(paths, handoffFromInput(identity, input));
  const status = submittedHandoffStatus(input.status);
  await writeAgentStatus(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    status,
    updatedAt: Date.now(),
    message: input.summary,
  });
  await appendAgentEvent(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    timestamp: Date.now(),
    level: submittedHandoffLevel(status),
    event: "agent.handoff.submitted",
    message: input.summary,
    data: { handoffStatus: input.status },
  });
  return paths.handoffPath;
}

export function artifactsForRecord(record: SpawnedSubagentRecord): {
  identity: AgentRunIdentity;
  paths: AgentArtifactPaths;
} {
  const identity = identityForRecord(record);
  return {
    identity,
    paths: agentArtifactPaths(record.projectRoot ?? record.cwd, identity),
  };
}

const serializedError = (
  error: unknown,
): { message: string; stack?: string } | undefined => {
  if (error === undefined) return undefined;
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
};

const hasPassingValidationEvidence = (validation: string[]): boolean => {
  const passing = /\b(?:pass|passed|green|success|succeeded)\b/i;
  const incomplete = /\b(?:fail|failed|failure|failures|aborted|timed out|not run|pending)\b/i;
  return (
    validation.length > 0 &&
    validation.every((entry) => passing.test(entry) && !incomplete.test(entry))
  );
};

const completionStatus = (
  status: AgentHandoff["status"],
): SubagentDoneEvent["status"] => {
  if (status === "success") return "success";
  if (status === "aborted") return "aborted";
  if (status === "error") return "error";
  return "blocked";
};

const eventLevel = (
  error: { message: string } | undefined,
  status: AgentArtifactStatus,
): AgentRunEvent["level"] => {
  if (error) return "error";
  if (status === "blocked" || status === "missing") return "warn";
  return "info";
};

export async function persistLifecycleTransition(
  record: SpawnedSubagentRecord,
  status: AgentArtifactStatus,
  event: string,
  options: { message?: string; error?: unknown; data?: Record<string, unknown> } = {},
): Promise<void> {
  const { identity, paths } = artifactsForRecord(record);
  record.lifecycleStatus = status;
  await writeAgentStatus(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    status,
    updatedAt: Date.now(),
    ...(options.message ? { message: options.message } : {}),
  });
  const error = serializedError(options.error);
  await appendAgentEvent(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    timestamp: Date.now(),
    level: eventLevel(error, status),
    event,
    ...(options.message ? { message: options.message } : {}),
    ...(options.data ? { data: options.data } : {}),
    ...(error ? { error } : {}),
  });
}

export async function runLoggedRecordOperation<T>(
  record: SpawnedSubagentRecord,
  failureEvent: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await persistLifecycleTransition(
      record,
      record.lifecycleStatus ?? "working",
      failureEvent,
      { error },
    );
    throw error;
  }
}

export async function ensureSyntheticFailureForRecord(
  record: SpawnedSubagentRecord,
  status: "error" | "aborted",
  message: string,
): Promise<void> {
  const { identity, paths } = artifactsForRecord(record);
  let existing: AgentHandoff | undefined;
  try {
    existing = await readAgentHandoff(paths.handoffPath);
  } catch {
    existing = undefined;
  }
  if (!existing) await writeSyntheticFailureHandoff(paths, identity, status, message);
}

export async function persistSessionForRecord(
  record: SpawnedSubagentRecord,
  sessionPath: string,
  agentSessionId?: string,
): Promise<void> {
  const { identity, paths } = artifactsForRecord(record);
  record.sessionPath = sessionPath;
  record.agentSessionId = agentSessionId;
  await writeSessionReference(paths, identity, sessionPath, agentSessionId);
}

export async function completionFromPersistedHandoff(
  record: SpawnedSubagentRecord,
  requireHandoff = false,
): Promise<SubagentDoneEvent | undefined> {
  const { paths } = artifactsForRecord(record);
  let handoff: AgentHandoff | undefined;
  try {
    handoff = await readAgentHandoff(paths.handoffPath);
  } catch (error) {
    return {
      type: "done",
      subagentId: record.id,
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      handoffPath: paths.handoffPath,
    };
  }
  if (!handoff) {
    return requireHandoff
      ? {
          type: "done",
          subagentId: record.id,
          status: "error",
          errorMessage: `Herdr agent ${record.name} stopped without a durable handoff.`,
          handoffPath: paths.handoffPath,
        }
      : undefined;
  }
  const status = completionStatus(handoff.status);
  return {
    type: "done",
    subagentId: record.id,
    status,
    result: formatAgentHandoff(handoff),
    ...(status === "error" ? { errorMessage: handoff.summary } : {}),
    handoffPath: paths.handoffPath,
  };
}

export function identityForRecord(record: SpawnedSubagentRecord): AgentRunIdentity {
  if (
    !record.mainSessionId ||
    !record.taskId ||
    !record.attempt ||
    !record.id ||
    !record.workspaceId
  ) {
    throw new Error(`Herdr agent ${record.name} is missing durable identity fields.`);
  }
  return {
    mainSessionId: record.mainSessionId,
    taskId: record.taskId,
    agentId: record.id,
    attempt: record.attempt,
    workspaceId: record.workspaceId,
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
  };
}

export async function loadSuccessfulHandoff(
  projectRoot: string,
  record: SpawnedSubagentRecord,
): Promise<AgentHandoff> {
  if (!record.handoffPath)
    throw new Error(`Herdr agent ${record.name} has no durable handoff path.`);
  const handoff = await readAgentHandoff(record.handoffPath);
  if (!handoff) throw new Error(`Herdr agent ${record.name} did not submit a handoff.`);
  if (handoff.status !== "success")
    throw new Error(`Herdr agent ${record.name} handoff status is ${handoff.status}.`);
  const implementation = IMPLEMENTATION_PROFILE_NAMES.includes(
    record.profile as (typeof IMPLEMENTATION_PROFILE_NAMES)[number],
  );
  if (implementation && !hasPassingValidationEvidence(handoff.validation))
    throw new Error(`Herdr agent ${record.name} has no passing validation evidence.`);
  const identity = identityForRecord(record);
  if (
    handoff.identity.mainSessionId !== identity.mainSessionId ||
    handoff.identity.taskId !== identity.taskId ||
    handoff.identity.agentId !== identity.agentId ||
    handoff.identity.attempt !== identity.attempt
  )
    throw new Error(`Herdr agent ${record.name} submitted a handoff for a different attempt.`);

  const structures = record.spec?.workPacket?.frozenTestStructure ?? [];
  if (structures.length) {
    const sources: Record<string, string> = {};
    await Promise.all(
      structures.map(async (structure) => {
        try {
          sources[structure.path] = await readFile(path.resolve(projectRoot, structure.path), "utf8");
        } catch {
          // The validator reports a stable missing-file error.
        }
      }),
    );
    const failures = validateFrozenTestStructures(structures, sources);
    if (failures.length)
      throw new Error(`Herdr agent ${record.name} frozen test structure changed: ${failures.join("; ")}`);
  }
  return handoff;
}

export function restartSpecFromPacket(
  packet: PersistedWorkPacket,
  checkpoint?: AgentCheckpoint,
): SubagentSpec {
  const spec = structuredClone(packet.spec);
  if (!checkpoint) return spec;
  const recovery = [
    `Recovery checkpoint from attempt ${checkpoint.identity.attempt}:`,
    `Summary: ${checkpoint.summary}`,
    `Completed:\n${checkpoint.completed.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Remaining:\n${checkpoint.remaining.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Changed files:\n${checkpoint.changedFiles.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Validation:\n${checkpoint.validation.map((item) => `- ${item}`).join("\n") || "- none"}`,
    checkpoint.blocker ? `Blocker: ${checkpoint.blocker}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return { ...spec, prompt: [spec.prompt, recovery].filter(Boolean).join("\n\n") };
}
