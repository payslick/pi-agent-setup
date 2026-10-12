import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubmitCheckpointInput, SubmitHandoffInput, SubagentSpec } from "./schemas";

export const HERDR_RUN_SCHEMA_VERSION = 1 as const;
export const HERDR_RUNS_DIRECTORY = ".pi/runs/herdr";

export type AgentArtifactStatus =
  | "created"
  | "starting"
  | "working"
  | "blocked"
  | "waiting-main"
  | "succeeded"
  | "failed"
  | "aborted"
  | "missing";

export interface AgentRunIdentity {
  mainSessionId: string;
  taskId: string;
  agentId: string;
  attempt: number;
  workspaceId: string;
  profile?: string;
  parentAgentId?: string;
}

export interface AgentArtifactPaths {
  runDirectory: string;
  taskDirectory: string;
  attemptDirectory: string;
  manifestPath: string;
  taskPath: string;
  workPacketPath: string;
  promptPath: string;
  systemPromptPath: string;
  statusPath: string;
  checkpointPath: string;
  handoffPath: string;
  eventsPath: string;
  errorsPath: string;
  outboxPath: string;
  sessionPath: string;
}

export interface PersistedWorkPacket {
  schemaVersion: typeof HERDR_RUN_SCHEMA_VERSION;
  identity: AgentRunIdentity;
  spec: SubagentSpec;
  createdAt: number;
}

export interface AgentStatusArtifact {
  schemaVersion: typeof HERDR_RUN_SCHEMA_VERSION;
  identity: AgentRunIdentity;
  status: AgentArtifactStatus;
  updatedAt: number;
  message?: string;
}

export interface AgentCheckpoint {
  schemaVersion: typeof HERDR_RUN_SCHEMA_VERSION;
  identity: AgentRunIdentity;
  summary: string;
  completed: string[];
  remaining: string[];
  changedFiles: string[];
  validation: string[];
  blocker?: string;
  updatedAt: number;
}

export interface ModuleImplementationRequest {
  taskId: string;
  objective: string;
  reason: string;
  profile:
    | "frontend-implementer"
    | "backend-implementer"
    | "database-implementer"
    | "builder-implementer";
  writableFiles: string[];
  contractFiles: string[];
  acceptanceCriteria: string[];
  nonGoals?: string[];
}

export interface AgentHandoff {
  schemaVersion: typeof HERDR_RUN_SCHEMA_VERSION;
  identity: AgentRunIdentity;
  status: "success" | "blocked" | "needs-main" | "error" | "aborted";
  summary: string;
  changedFiles: string[];
  validation: string[];
  deviations: string[];
  risks: string[];
  followUp: string[];
  moduleRequests?: ModuleImplementationRequest[];
  createdAt: number;
}

export interface AgentRunEvent {
  schemaVersion: typeof HERDR_RUN_SCHEMA_VERSION;
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  identity: AgentRunIdentity;
  message?: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
};

const writeJson = (filePath: string, value: unknown): Promise<void> =>
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);

const assertIdentity = (value: unknown): asserts value is AgentRunIdentity => {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Herdr handoff: identity is missing");
  const identity = value as Partial<AgentRunIdentity>;
  if (
    !isNonEmptyString(identity.mainSessionId) ||
    !isNonEmptyString(identity.taskId) ||
    !isNonEmptyString(identity.agentId) ||
    !isNonEmptyString(identity.workspaceId) ||
    !Number.isInteger(identity.attempt) ||
    Number(identity.attempt) < 1
  ) {
    throw new Error("Invalid Herdr handoff: identity is malformed");
  }
};

const assertCheckpoint = (value: unknown): asserts value is AgentCheckpoint => {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Herdr checkpoint: expected an object");
  const checkpoint = value as Partial<AgentCheckpoint>;
  assertIdentity(checkpoint.identity);
  if (
    checkpoint.schemaVersion !== HERDR_RUN_SCHEMA_VERSION ||
    !isNonEmptyString(checkpoint.summary) ||
    !isStringArray(checkpoint.completed) ||
    !isStringArray(checkpoint.remaining) ||
    !isStringArray(checkpoint.changedFiles) ||
    !isStringArray(checkpoint.validation) ||
    typeof checkpoint.updatedAt !== "number"
  )
    throw new Error("Invalid Herdr checkpoint: required fields are missing or malformed");
};

const assertHandoff = (value: unknown): asserts value is AgentHandoff => {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Herdr handoff: expected an object");
  const handoff = value as Partial<AgentHandoff>;
  assertIdentity(handoff.identity);
  const statuses = new Set(["success", "blocked", "needs-main", "error", "aborted"]);
  if (
    handoff.schemaVersion !== HERDR_RUN_SCHEMA_VERSION ||
    !handoff.status ||
    !statuses.has(handoff.status) ||
    !isNonEmptyString(handoff.summary) ||
    !isStringArray(handoff.changedFiles) ||
    !isStringArray(handoff.validation) ||
    !isStringArray(handoff.deviations) ||
    !isStringArray(handoff.risks) ||
    !isStringArray(handoff.followUp) ||
    typeof handoff.createdAt !== "number"
  ) {
    throw new Error("Invalid Herdr handoff: required fields are missing or malformed");
  }
};

export function agentIdentityFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AgentRunIdentity | undefined {
  const mainSessionId = environment.PI_MAIN_SESSION_ID;
  const taskId = environment.PI_TASK_ID;
  const agentId = environment.PI_SUBAGENT_ID;
  const workspaceId = environment.HERDR_WORKSPACE_ID;
  const attempt = Number(environment.PI_AGENT_ATTEMPT);
  if (
    !isNonEmptyString(mainSessionId) ||
    !isNonEmptyString(taskId) ||
    !isNonEmptyString(agentId) ||
    !isNonEmptyString(workspaceId) ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    return undefined;
  }
  return {
    mainSessionId,
    taskId,
    agentId,
    attempt,
    workspaceId,
    ...(isNonEmptyString(environment.PI_SUBAGENT_TYPE)
      ? { profile: environment.PI_SUBAGENT_TYPE }
      : {}),
    ...(isNonEmptyString(environment.PI_PARENT_AGENT_ID)
      ? { parentAgentId: environment.PI_PARENT_AGENT_ID }
      : {}),
  };
}

export function checkpointFromInput(
  identity: AgentRunIdentity,
  input: SubmitCheckpointInput,
  updatedAt = Date.now(),
): AgentCheckpoint {
  return {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    summary: input.summary,
    completed: [...input.completed],
    remaining: [...input.remaining],
    changedFiles: [...input.changedFiles],
    validation: [...input.validation],
    ...(input.blocker ? { blocker: input.blocker } : {}),
    updatedAt,
  };
}

export function handoffFromInput(
  identity: AgentRunIdentity,
  input: SubmitHandoffInput,
  createdAt = Date.now(),
): AgentHandoff {
  return {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    status: input.status,
    summary: input.summary,
    changedFiles: [...input.changedFiles],
    validation: [...input.validation],
    deviations: [...input.deviations],
    risks: [...input.risks],
    followUp: [...input.followUp],
    ...(input.moduleRequests
      ? { moduleRequests: input.moduleRequests.map((entry) => ({ ...entry })) }
      : {}),
    createdAt,
  };
}

export function safeArtifactSegment(value: string): string {
  const segment = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (!segment) throw new Error("Expected a non-empty artifact identifier.");
  return segment;
}

const resolveArtifactLocation = (location: string): string | null => {
  try {
    return realpathSync(location);
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(errorCode(error) ?? "")) return null;
    if (errorCode(error) !== "ENOENT") throw error;
    if (lstatSync(location, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    const parent = path.dirname(location);
    if (parent === location) return null;
    const resolvedParent = resolveArtifactLocation(parent);
    return resolvedParent === null ? null : path.join(resolvedParent, path.basename(location));
  }
};

const isLocalArtifactDirectory = (root: string | null, directory: string): boolean => {
  const resolved = resolveArtifactLocation(directory);
  if (root === null || resolved === null) return false;
  const relative = path.relative(root, resolved);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const herdrRunsDirectory = (projectRoot: string): string => {
  const root = resolveArtifactLocation(path.resolve(projectRoot));
  const legacy = path.resolve(projectRoot, HERDR_RUNS_DIRECTORY);
  const local = path.resolve(projectRoot, ".pi-runs/herdr");
  if (!existsSync(local) && isLocalArtifactDirectory(root, legacy)) return legacy;
  if (isLocalArtifactDirectory(root, local)) return local;
  throw new Error(`No safe Herdr artifact directory under ${projectRoot}: ${legacy}; ${local}`);
};

export function agentArtifactPaths(
  projectRoot: string,
  identity: AgentRunIdentity,
): AgentArtifactPaths {
  const runDirectory = path.resolve(
    herdrRunsDirectory(projectRoot),
    safeArtifactSegment(identity.mainSessionId),
  );
  const taskDirectory = path.join(runDirectory, safeArtifactSegment(identity.taskId));
  const attemptDirectory = path.join(taskDirectory, "attempts", String(identity.attempt));
  return {
    runDirectory,
    taskDirectory,
    attemptDirectory,
    manifestPath: path.join(runDirectory, "manifest.json"),
    taskPath: path.join(taskDirectory, "task.json"),
    workPacketPath: path.join(attemptDirectory, "work-packet.json"),
    promptPath: path.join(attemptDirectory, "prompt.md"),
    systemPromptPath: path.join(attemptDirectory, "system-prompt.md"),
    statusPath: path.join(attemptDirectory, "status.json"),
    checkpointPath: path.join(attemptDirectory, "checkpoint.json"),
    handoffPath: path.join(attemptDirectory, "handoff.json"),
    eventsPath: path.join(attemptDirectory, "events.jsonl"),
    errorsPath: path.join(attemptDirectory, "errors.jsonl"),
    outboxPath: path.join(attemptDirectory, "outbox.jsonl"),
    sessionPath: path.join(attemptDirectory, "session.json"),
  };
}

export async function initializeAgentArtifacts(
  projectRoot: string,
  identity: AgentRunIdentity,
  spec: SubagentSpec,
  systemPrompt?: string,
  prompt?: string,
): Promise<AgentArtifactPaths> {
  const paths = agentArtifactPaths(projectRoot, identity);
  const createdAt = Date.now();
  await mkdir(paths.attemptDirectory, { recursive: true });
  await Promise.all([
    writeJson(paths.manifestPath, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      mainSessionId: identity.mainSessionId,
      workspaceId: identity.workspaceId,
      updatedAt: createdAt,
    }),
    writeJson(paths.taskPath, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      mainSessionId: identity.mainSessionId,
      taskId: identity.taskId,
      latestAttempt: identity.attempt,
      updatedAt: createdAt,
    }),
    writeJson(paths.workPacketPath, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity,
      spec,
      createdAt,
    } satisfies PersistedWorkPacket),
    writeJson(paths.statusPath, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity,
      status: "created",
      updatedAt: createdAt,
    } satisfies AgentStatusArtifact),
    atomicWrite(paths.outboxPath, ""),
    atomicWrite(paths.eventsPath, ""),
    atomicWrite(paths.errorsPath, ""),
    ...(systemPrompt === undefined ? [] : [atomicWrite(paths.systemPromptPath, systemPrompt)]),
    ...(prompt === undefined ? [] : [atomicWrite(paths.promptPath, prompt)]),
  ]);
  await appendAgentEvent(paths, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    timestamp: createdAt,
    level: "info",
    event: "agent.artifacts.initialized",
    identity,
  });
  return paths;
}

export async function appendAgentEvent(
  paths: AgentArtifactPaths,
  event: AgentRunEvent,
): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  await mkdir(paths.attemptDirectory, { recursive: true });
  await appendFile(paths.eventsPath, line, { encoding: "utf8", mode: 0o600 });
  if (event.level === "error")
    await appendFile(paths.errorsPath, line, { encoding: "utf8", mode: 0o600 });
}

export async function writeAgentStatus(
  paths: AgentArtifactPaths,
  status: AgentStatusArtifact,
): Promise<void> {
  await writeJson(paths.statusPath, status);
}

export async function writeAgentCheckpoint(
  paths: AgentArtifactPaths,
  checkpoint: AgentCheckpoint,
): Promise<void> {
  await writeJson(paths.checkpointPath, checkpoint);
}

export async function writeAgentHandoff(
  paths: AgentArtifactPaths,
  handoff: AgentHandoff,
): Promise<void> {
  assertHandoff(handoff);
  await writeJson(paths.handoffPath, handoff);
}

export async function readAgentCheckpoint(
  checkpointPath: string,
): Promise<AgentCheckpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(checkpointPath, "utf8")) as unknown;
    assertCheckpoint(value);
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof SyntaxError)
      throw new Error(`Invalid Herdr checkpoint: ${error.message}`, { cause: error });
    throw error;
  }
}

export async function readAgentHandoff(handoffPath: string): Promise<AgentHandoff | undefined> {
  try {
    const value = JSON.parse(await readFile(handoffPath, "utf8")) as unknown;
    assertHandoff(value);
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof SyntaxError)
      throw new Error(`Invalid Herdr handoff: ${error.message}`, { cause: error });
    throw error;
  }
}

export async function readPersistedWorkPacket(
  workPacketPath: string,
): Promise<PersistedWorkPacket> {
  const value = JSON.parse(await readFile(workPacketPath, "utf8")) as Partial<PersistedWorkPacket>;
  if (
    value.schemaVersion !== HERDR_RUN_SCHEMA_VERSION ||
    !value.spec ||
    typeof value.spec !== "object" ||
    typeof value.createdAt !== "number"
  ) {
    throw new Error("Invalid persisted Herdr work packet.");
  }
  assertIdentity(value.identity);
  return value as PersistedWorkPacket;
}

export async function writeSessionReference(
  paths: AgentArtifactPaths,
  identity: AgentRunIdentity,
  sessionPath: string,
  agentSessionId?: string,
): Promise<void> {
  await writeJson(paths.sessionPath, {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    sessionPath,
    ...(agentSessionId ? { agentSessionId } : {}),
    updatedAt: Date.now(),
  });
}

export async function nextAgentAttempt(
  projectRoot: string,
  mainSessionId: string,
  taskId: string,
): Promise<number> {
  const attemptsDirectory = path.join(
    herdrRunsDirectory(projectRoot),
    safeArtifactSegment(mainSessionId),
    safeArtifactSegment(taskId),
    "attempts",
  );
  try {
    const entries = await readdir(attemptsDirectory, { withFileTypes: true });
    const attempts = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name));
    return attempts.length ? Math.max(...attempts) + 1 : 1;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 1;
    throw error;
  }
}

export async function writeSyntheticFailureHandoff(
  paths: AgentArtifactPaths,
  identity: AgentRunIdentity,
  status: "error" | "aborted",
  message: string,
  createdAt = Date.now(),
): Promise<AgentHandoff> {
  const handoff: AgentHandoff = {
    schemaVersion: HERDR_RUN_SCHEMA_VERSION,
    identity,
    status,
    summary: message,
    changedFiles: [],
    validation: [],
    deviations: [message],
    risks: ["The attempt ended before a successful validated handoff."],
    followUp: ["Restart from the persisted work packet and latest checkpoint."],
    createdAt,
  };
  await writeAgentHandoff(paths, handoff);
  return handoff;
}

const list = (values: readonly string[], empty = "none"): string =>
  values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;

export function formatAgentHandoff(handoff: AgentHandoff): string {
  return [
    "## Handoff",
    `- Summary: ${handoff.summary}`,
    `- Status: ${handoff.status}`,
    `- Changed files:\n${list(handoff.changedFiles)}`,
    `- Validation:\n${list(handoff.validation)}`,
    `- Deviations:\n${list(handoff.deviations)}`,
    `- Risks:\n${list(handoff.risks)}`,
    `- Follow-up:\n${list(handoff.followUp)}`,
    handoff.moduleRequests?.length
      ? `- Module requests:\n${handoff.moduleRequests.map((request) => `  - ${request.taskId}: ${request.objective}`).join("\n")}`
      : undefined,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}
