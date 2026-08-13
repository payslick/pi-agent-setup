import { readFile } from "node:fs/promises";
import type { SpawnedSubagentRecord, SubagentDoneEvent, SubagentUsageStats } from "./state";

interface SessionContentPart {
  type?: string;
  text?: string;
}

interface SessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number | { total?: number };
  totalCost?: number;
  costTotal?: number;
}

interface SessionMessage {
  role?: string;
  content?: SessionContentPart[] | string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  provider?: string;
  usage?: SessionUsage;
}

interface SessionEntry {
  type?: string;
  message?: SessionMessage;
}

const numberValue = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const messageText = (message: SessionMessage): string => {
  if (typeof message.content === "string") return message.content.trim();
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
};

const usageCost = (usage: SessionUsage): number => {
  if (typeof usage.cost === "number") return numberValue(usage.cost);
  return numberValue(usage.cost?.total ?? usage.totalCost ?? usage.costTotal);
};

const addUsage = (total: Required<SubagentUsageStats>, usage: SessionUsage): void => {
  total.input += numberValue(usage.input);
  total.output += numberValue(usage.output);
  total.cacheRead += numberValue(usage.cacheRead);
  total.cacheWrite += numberValue(usage.cacheWrite);
  total.totalTokens += numberValue(usage.totalTokens);
  total.cost += usageCost(usage);
  total.turns += 1;
};

const completionStatus = (message: SessionMessage): SubagentDoneEvent["status"] => {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error" || message.errorMessage) return "error";
  return message.stopReason === "stop" ? "success" : "unknown";
};

const parseSessionEntries = (content: string): SessionEntry[] =>
  content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });

export const completionFromSession = async (
  record: SpawnedSubagentRecord,
  sessionPath: string,
): Promise<SubagentDoneEvent | undefined> => {
  const entries = parseSessionEntries(await readFile(sessionPath, "utf8"));
  const assistants = entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .map((entry) => entry.message as SessionMessage);
  const finalMessage = assistants.at(-1);
  if (!finalMessage) return undefined;

  const usage: Required<SubagentUsageStats> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
  };
  for (const message of assistants) addUsage(usage, message.usage ?? {});

  return {
    type: "done",
    task: record.promptPreview,
    result: messageText(finalMessage) || finalMessage.errorMessage,
    status: completionStatus(finalMessage),
    stopReason: finalMessage.stopReason,
    errorMessage: finalMessage.errorMessage,
    runtimeMs: Date.now() - record.createdAt,
    usage,
    effort: record.thinking,
    thinkingLevel: record.thinking,
    model: finalMessage.model ?? record.model,
    provider: finalMessage.provider ?? record.provider,
  };
};
