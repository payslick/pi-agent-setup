import type { SubagentSpec } from "./schemas";

export const CUSTOM_ENTRY_TYPE = "herdr-subagent";
export const COMPLETION_MESSAGE_TYPE = "herdr-subagent-completion";

export interface SpawnedSubagentRecord {
  id: string;
  name: string;
  tabId: string;
  paneId: string;
  workspaceId: string;
  tabLabel: string;
  cwd: string;
  promptPreview: string;
  prompted: boolean;
  promptGeneration?: number;
  completionDelivered?: boolean;
  waitingForAnswer?: boolean;
  outboxOffset?: number;
  profile?: NonNullable<SubagentSpec["profile"]>;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  writableFiles?: string[];
  contractFiles?: string[];
  outboxPath: string;
  replaceSystemPrompt: boolean;
  createdAt: number;
}

export type QuestionAudience = "main_agent" | "user" | "unsure";

export interface SubagentQuestion {
  id: string;
  type: "question";
  addressedTo: QuestionAudience;
  question: string;
  context?: string;
  whatDone?: string;
  options?: string[];
  timestamp?: number;
}

export interface SubagentUsageStats {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number;
  turns?: number;
}

export interface SubagentDoneEvent {
  type: "done";
  subagentId?: string;
  subagentName?: string;
  timestamp?: number;
  task?: string;
  result?: string;
  status?: "success" | "error" | "aborted" | "unknown";
  stopReason?: string;
  errorMessage?: string;
  runtimeMs?: number;
  agentRuntimeMs?: number;
  usage?: SubagentUsageStats;
  effort?: string;
  thinkingLevel?: string;
  model?: string;
  provider?: string;
}

export interface SubagentSessionEntry {
  type: string;
  customType?: string;
  data?: {
    version?: number;
    record?: SpawnedSubagentRecord;
    removedId?: string;
    completion?: SubagentDoneEvent;
  };
}

const PROFILE_LABELS: Record<NonNullable<SubagentSpec["profile"]>, string> = {
  "frontend-implementer": "FE",
  "backend-implementer": "BE",
  "unit-test-implementer": "UT",
  "e2e-test-implementer": "E2E",
  "test-reviewer": "TR",
};
const MAX_TAB_LABEL_LENGTH = 32;
const TASK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "exactly",
  "approved",
  "current",
  "existing",
  "for",
  "in",
  "new",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

const taskWords = (spec: SubagentSpec): string[] => {
  const task = spec.workPacket?.objective ?? spec.prompt ?? spec.name ?? "idle";
  const words = task
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => !TASK_STOP_WORDS.has(word));
  return (words?.length ? words : ["idle"]).slice(0, 2);
};

export const tabLabelForSpec = (spec: SubagentSpec): string =>
  [spec.profile ? PROFILE_LABELS[spec.profile] : "AG", ...taskWords(spec)]
    .join("-")
    .slice(0, MAX_TAB_LABEL_LENGTH)
    .replace(/-$/, "");

export const sessionNameForSpec = (spec: SubagentSpec, parentSessionId: string): string =>
  `${spec.workPacket ? "Work packet" : tabLabelForSpec(spec)} [spawned by ${parentSessionId}]`;

const agentNameBase = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return normalized || "agent";
};

export const agentNameForSpec = (spec: SubagentSpec, id: string): string => {
  const suffix = id
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 4)
    .padEnd(4, "0");
  const base = agentNameBase(spec.name ?? tabLabelForSpec(spec));
  return `${base.slice(0, 27)}-${suffix}`.slice(0, 32);
};

export const shortenHomePath = (
  filePath: string | undefined,
  homeDir = process.env.HOME,
): string => {
  if (!filePath || !homeDir) return filePath ?? "";
  if (filePath === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return filePath.startsWith(prefix) ? `~/${filePath.slice(prefix.length)}` : filePath;
};

export const restoreRecordsForWorkspace = (
  entries: SubagentSessionEntry[],
  workspaceId: string,
): Map<string, SpawnedSubagentRecord> => {
  const restored = new Map<string, SpawnedSubagentRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.removedId) {
      restored.delete(data.removedId);
      continue;
    }
    if (data?.record?.workspaceId === workspaceId) {
      const record = data.record;
      restored.set(record.id, {
        ...record,
        prompted: record.prompted ?? record.promptPreview !== "(idle)",
      });
    }
  }
  return restored;
};

export const questionNeedsUserPrompt = (question: SubagentQuestion): boolean =>
  question.addressedTo !== "main_agent";

export const formatQuestionForMainAgent = (
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
  recentOutput: string,
): string => {
  const audience = questionNeedsUserPrompt(question)
    ? "Prompt the user in this conversation before answering."
    : "Answer it directly if no user decision is needed.";
  const sections = [
    `Subagent "${record.name}" in Herdr tab "${record.tabLabel}" has a question.`,
    audience,
    `Task: ${record.promptPreview}`,
    `Question: ${question.question.trim()}`,
    question.options?.length
      ? `Options:\n${question.options.map((value) => `- ${value}`).join("\n")}`
      : undefined,
    question.context?.trim() ? `Context:\n${question.context.trim()}` : undefined,
    question.whatDone?.trim() ? `Work completed so far:\n${question.whatDone.trim()}` : undefined,
    recentOutput.trim() ? `Recent agent output:\n${recentOutput.trim()}` : undefined,
    `Send the answer with manage_subagents action="prompt" id="${record.id}".`,
  ];
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
};

const finiteNumber = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const truncateText = (text: string, maxLength: number): string =>
  text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 28))}\n…(truncated ${text.length - maxLength} chars)`;

const formatTokens = (count: number): string => {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
};

export const formatSubagentDuration = (ms: number | undefined): string => {
  const value = finiteNumber(ms);
  if (value === undefined || value < 0) return "unknown";
  const totalSeconds = Math.round(value / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const digits = (part: number) => `${part}`.padStart(2, "0");
  return hours ? `${hours}:${digits(minutes)}:${digits(seconds)}` : `${minutes}:${digits(seconds)}`;
};

export const formatSubagentModel = (
  provider: string | undefined,
  model: string | undefined,
): string => {
  const providerValue = provider?.trim();
  const modelValue = model?.trim();
  if (!providerValue) return modelValue || "unknown";
  if (!modelValue || modelValue === providerValue || modelValue.startsWith(`${providerValue}/`))
    return modelValue || providerValue;
  return `${providerValue}/${modelValue}`;
};

const sumKnownTokens = (values: Array<number | undefined>): number | undefined => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? known.reduce((total, value) => total + value, 0) : undefined;
};

const normalizeEffort = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
};

export const formatSubagentEffort = (
  record: SpawnedSubagentRecord,
  completion?: SubagentDoneEvent,
): string =>
  normalizeEffort(completion?.effort) ??
  normalizeEffort(completion?.thinkingLevel) ??
  normalizeEffort(record.thinking) ??
  "unknown";

export const formatSubagentUsage = (
  usage: SubagentUsageStats | undefined,
  runtimeMs?: number,
  effort?: string,
): string => {
  const parts: string[] = [];
  const duration = formatSubagentDuration(runtimeMs);
  if (duration !== "unknown") parts.push(duration);
  if (effort) parts.push(`effort:${effort}`);
  if (!usage) return parts.length ? `${parts.join(" ")} usage:unknown` : "unknown";
  const turns = finiteNumber(usage.turns);
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const total =
    finiteNumber(usage.totalTokens) ?? sumKnownTokens([input, output, cacheRead, cacheWrite]);
  if (turns !== undefined) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (input) parts.push(`↑${formatTokens(input)}`);
  if (output) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
  if (total) parts.push(`total:${formatTokens(total)}`);
  const cost = finiteNumber(usage.cost);
  if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
  return parts.length ? parts.join(" ") : "unknown";
};

const statusEmoji = (status: SubagentDoneEvent["status"]): string => {
  if (status === "success") return "✅";
  if (status === "error") return "❌";
  if (status === "aborted") return "⏹️";
  return "❔";
};

const compactLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const resultSummary = (completion: SubagentDoneEvent): string => {
  const fallback = completion.status === "success" ? "Completed." : "No result captured.";
  const line = (completion.result || completion.errorMessage || "")
    .split(/\r?\n/)
    .map((value) =>
      compactLine(value.replace(/^[-*#]+\s*/, ""))
        .replace(/^Summary:\s*/i, "")
        .replace(/^Error:\s*/i, ""),
    )
    .find((value) => value && value.toLowerCase() !== "handoff" && value !== "---");
  return truncateText(line || fallback, 220);
};

const REQUIRED_HANDOFF_FIELDS = [
  "Summary",
  "Changed files",
  "Validation",
  "Deviations",
  "Risks",
  "Follow-up",
];

const handoffLabel = (record: SpawnedSubagentRecord, result: string): string => {
  if (!record.profile) return "Handoff";
  const missing = REQUIRED_HANDOFF_FIELDS.filter(
    (field) => !new RegExp(`^\\s*-\\s*${field}:`, "im").test(result),
  );
  return missing.length ? `Unstructured handoff; missing ${missing.join(", ")}` : "Handoff";
};

export const formatSubagentCompletionSummary = (
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): string => {
  const runtimeMs =
    finiteNumber(completion.runtimeMs) ??
    finiteNumber(completion.timestamp ? completion.timestamp - record.createdAt : undefined);
  const result = completion.result?.trim() || completion.errorMessage?.trim() || "";
  return [
    `Task: ${truncateText(compactLine(completion.task || record.promptPreview), 220)}`,
    formatSubagentUsage(completion.usage, runtimeMs, formatSubagentEffort(record, completion)),
    `${statusEmoji(completion.status)} ${resultSummary(completion)}`,
    result ? `${handoffLabel(record, result)}:\n${truncateText(result, 4000)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};
