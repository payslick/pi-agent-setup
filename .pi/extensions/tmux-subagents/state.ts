export const CUSTOM_ENTRY_TYPE = "tmux-subagent";
export const COMPLETION_MESSAGE_TYPE = "tmux-subagent-completion";

export type SplitDirection = "right" | "below";

export interface SpawnedSubagentRecord {
  id: string;
  name: string;
  paneId: string;
  windowId?: string;
  cwd: string;
  promptPreview: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string[];
  bridgePath: string;
  configPath: string;
  controlPath: string;
  outboxPath?: string;
  runScriptPath: string;
  promptPath?: string;
  systemPromptPath?: string;
  replaceSystemPrompt: boolean;
  noSession: boolean;
  createdAt: number;
}

export interface SubagentPlacementPlan {
  split: SplitDirection;
  target: "main" | "stack";
  size?: string;
}

const FRIENDLY_ADJECTIVES = [
  "amber",
  "brave",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "daring",
  "eager",
  "gentle",
  "happy",
  "lucky",
  "nimble",
  "rapid",
  "silver",
  "steady",
  "swift",
];

const FRIENDLY_NOUNS = [
  "badger",
  "falcon",
  "fox",
  "koala",
  "lynx",
  "otter",
  "owl",
  "panda",
  "raven",
  "seal",
  "tiger",
  "turtle",
  "whale",
  "wolf",
  "yak",
  "zebra",
];

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
    killedId?: string;
    completion?: SubagentDoneEvent;
  };
}

function numericHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function friendlySubagentName(id: string): string {
  const compactId = id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const hash = numericHash(compactId || id);
  const adjective = FRIENDLY_ADJECTIVES[hash % FRIENDLY_ADJECTIVES.length];
  const noun =
    FRIENDLY_NOUNS[Math.floor(hash / FRIENDLY_ADJECTIVES.length) % FRIENDLY_NOUNS.length];
  const suffix = (compactId || hash.toString(16)).slice(0, 4).padEnd(4, "0");
  return `${adjective}-${noun}-${suffix}`;
}

export function shortenHomePath(filePath: string | undefined, homeDir = process.env.HOME): string {
  if (!filePath) return "";
  if (!homeDir) return filePath;
  if (filePath === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return filePath.startsWith(prefix) ? `~/${filePath.slice(prefix.length)}` : filePath;
}

export function planSubagentPlacement(
  hasStackTarget: boolean,
  explicitSplit: SplitDirection | undefined,
  requestedSize: string | undefined,
): SubagentPlacementPlan {
  const split: SplitDirection = explicitSplit ?? (hasStackTarget ? "below" : "right");
  const target = explicitSplit === "right" || !hasStackTarget ? "main" : "stack";
  const size = requestedSize ?? (!explicitSplit && split === "right" ? "40%" : undefined);
  return size ? { split, target, size } : { split, target };
}

export function restoreRecordsForWindow(
  entries: SubagentSessionEntry[],
  windowId: string,
): Map<string, SpawnedSubagentRecord> {
  const restored = new Map<string, SpawnedSubagentRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.killedId) {
      restored.delete(data.killedId);
      continue;
    }
    if (!data?.record?.id) continue;
    if (data.record.windowId !== windowId) continue;
    restored.set(data.record.id, data.record);
  }
  return restored;
}

export function questionNeedsUserPrompt(question: SubagentQuestion): boolean {
  return question.addressedTo === "user" || question.addressedTo === "unsure";
}

export function formatQuestionForMainAgent(
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
  recentPaneOutput: string,
): string {
  const audienceLine = questionNeedsUserPrompt(question)
    ? "The subagent says this is for the user, or it is unsure. Prompt the user in this main conversation before answering."
    : "The subagent says this is for the main agent. Answer it if you can without asking the user.";
  const options = question.options?.length
    ? `\nOptions:\n${question.options.map((option) => `- ${option}`).join("\n")}`
    : "";
  const context = question.context?.trim()
    ? `\nContext from subagent:\n${question.context.trim()}\n`
    : "";
  const whatDone = question.whatDone?.trim()
    ? `\nWhat the subagent says it did so far:\n${question.whatDone.trim()}\n`
    : "";
  const recent = recentPaneOutput.trim()
    ? `\nRecent pane output:\n${recentPaneOutput.trim()}\n`
    : "";

  return [
    `Subagent "${record.name}" (${record.paneId}) has a question.`,
    audienceLine,
    `Task: ${record.promptPreview}`,
    `Question: ${question.question.trim()}${options}`,
    context.trimEnd(),
    whatDone.trimEnd(),
    recent.trimEnd(),
    `After you have the answer, send it back with subagent_panes action="send" id="${record.id}".`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 28))}\n…(truncated ${text.length - maxLength} chars)`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatSubagentDuration(ms: number | undefined): string {
  const value = finiteNumber(ms);
  if (value === undefined || value < 0) return "unknown";

  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const twoDigits = (part: number) => `${part}`.padStart(2, "0");
  return hours
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
}

export function formatSubagentCost(usage: SubagentUsageStats | undefined): string {
  const cost = finiteNumber(usage?.cost);
  return cost === undefined ? "unknown" : `$${cost.toFixed(2)}`;
}

export function formatSubagentModel(
  provider: string | undefined,
  model: string | undefined,
): string {
  const providerValue = provider?.trim();
  const modelValue = model?.trim();
  if (providerValue && modelValue) {
    const providerPrefix = `${providerValue}/`;
    return modelValue === providerValue || modelValue.startsWith(providerPrefix)
      ? modelValue
      : `${providerValue}/${modelValue}`;
  }
  return modelValue || providerValue || "unknown";
}

function sumKnownTokens(values: Array<number | undefined>): number | undefined {
  let total = 0;
  let sawValue = false;
  for (const value of values) {
    if (value === undefined) continue;
    total += value;
    sawValue = true;
  }
  return sawValue ? total : undefined;
}

const KNOWN_EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeSubagentEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return KNOWN_EFFORT_LEVELS.has(lower) ? lower : trimmed;
}

function effortFromModelPattern(model: string | undefined): string | undefined {
  const match = model?.trim().match(/[:@](off|minimal|low|medium|high|xhigh)$/i);
  return normalizeSubagentEffort(match?.[1]);
}

export function formatSubagentEffort(
  record: SpawnedSubagentRecord,
  completion?: SubagentDoneEvent,
): string {
  return (
    normalizeSubagentEffort(completion?.effort) ??
    normalizeSubagentEffort(completion?.thinkingLevel) ??
    normalizeSubagentEffort(record.thinking) ??
    effortFromModelPattern(record.model) ??
    effortFromModelPattern(completion?.model) ??
    "unknown"
  );
}

export function formatSubagentUsage(
  usage: SubagentUsageStats | undefined,
  runtimeMs?: number,
  effort?: string,
): string {
  const parts: string[] = [];
  const duration = formatSubagentDuration(runtimeMs);
  if (duration !== "unknown") parts.push(duration);
  const effortValue = normalizeSubagentEffort(effort);
  if (effortValue) parts.push(`effort:${effortValue}`);
  if (!usage) return parts.length ? `${parts.join(" ")} usage:unknown` : "unknown";

  const turns = finiteNumber(usage.turns);
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const explicitTotal = finiteNumber(usage.totalTokens);
  const computedTotal = sumKnownTokens([input, output, cacheRead, cacheWrite]);
  const totalTokens = explicitTotal && explicitTotal > 0 ? explicitTotal : computedTotal;
  if (turns !== undefined) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (input && input > 0) parts.push(`↑${formatTokens(input)}`);
  if (output && output > 0) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead && cacheRead > 0) parts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite && cacheWrite > 0) parts.push(`W${formatTokens(cacheWrite)}`);
  if (totalTokens && totalTokens > 0) parts.push(`total:${formatTokens(totalTokens)}`);
  const cost = formatSubagentCost(usage);
  if (cost !== "unknown") parts.push(cost);
  return parts.length ? parts.join(" ") : "unknown";
}

function subagentCompletionStatus(completion: SubagentDoneEvent): string {
  if (completion.status) return completion.status;
  if (completion.stopReason === "aborted") return "aborted";
  if (completion.stopReason === "error" || completion.errorMessage) return "error";
  return completion.stopReason ? "success" : "unknown";
}

function subagentStatusEmoji(status: string | undefined): string {
  const normalized = (status ?? "").toLowerCase();
  if (["success", "succeeded", "complete", "completed"].includes(normalized)) return "✅";
  if (["error", "failed", "failure"].includes(normalized)) return "❌";
  if (["aborted", "abort", "cancelled", "canceled"].includes(normalized)) return "⏹️";
  return "❔";
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function stripMarkdownPrefix(text: string): string {
  return text
    .replace(/^[-*]\s+/, "")
    .replace(/^#+\s+/, "")
    .trim();
}

function stripLeadingStatusEmoji(text: string): string {
  return text.replace(/^(?:✅|❌|⏹️|❔|⚠️)\s*/u, "").trim();
}

function isUsageSummaryLine(text: string): boolean {
  return /^\d+:\d{2}(?::\d{2})?(?:\s+effort:[^\s]+)?(?:\s+\d+\s+turns?)?(?:\s+[↑↓RW]|\s+total:|\s+\$|\s+usage:)/.test(
    compactLine(text),
  );
}

function completionFallback(status: string): string {
  if (status === "success") return "Completed.";
  if (status === "aborted") return "Aborted.";
  if (status === "error") return "Errored before completing.";
  return "No result captured.";
}

function summarizeCompletionResult(rawResult: string, status: string): string {
  const lines = rawResult
    .split(/\r?\n/)
    .map((line) => compactLine(stripMarkdownPrefix(line)))
    .filter(Boolean);
  const emojiLine = lines.find((line) => /^(?:✅|❌|⏹️|❔|⚠️)/u.test(line));
  const candidates = [...(emojiLine ? [emojiLine] : []), ...lines];

  for (const candidate of candidates) {
    const cleaned = stripLeadingStatusEmoji(candidate)
      .replace(/^Result:\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .replace(/^Status:\s*/i, "")
      .trim();
    if (
      !cleaned ||
      isUsageSummaryLine(cleaned) ||
      cleaned === "---" ||
      cleaned.startsWith("```") ||
      /^\[[^\]]+\]$/.test(cleaned)
    ) {
      continue;
    }
    return truncateText(truncateWords(cleaned, 25), 220);
  }

  return completionFallback(status);
}

export function formatSubagentCompletionSummary(
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): string {
  const runtimeMs =
    finiteNumber(completion.runtimeMs) ??
    finiteNumber(completion.timestamp ? completion.timestamp - record.createdAt : undefined);
  const task = completion.task?.trim() || record.promptPreview || "(unknown task)";
  const status = subagentCompletionStatus(completion);
  const statusEmoji = subagentStatusEmoji(status);
  const result = completion.result?.trim() || completion.errorMessage?.trim() || "";
  const effort = formatSubagentEffort(record, completion);
  const usageLine = formatSubagentUsage(completion.usage, runtimeMs, effort);
  const resultSummary = summarizeCompletionResult(result, status);

  return [
    `Task: ${truncateText(compactLine(task), 220)}`,
    usageLine,
    `${statusEmoji} ${resultSummary}`,
  ].join("\n");
}
