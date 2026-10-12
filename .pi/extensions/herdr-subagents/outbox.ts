import { open, stat } from "node:fs/promises";
import { persistLifecycleTransition } from "./lifecycle";
import type { SpawnedSubagentRecord, SubagentQuestion } from "./state";

export interface ReadOutboxResult {
  questions: SubagentQuestion[];
  offset: number;
}

const previewText = (text: string, maxLength = 140): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
};

export async function readSubagentOutbox(
  record: SpawnedSubagentRecord,
  previousOffset = 0,
): Promise<ReadOutboxResult> {
  let fileStat;
  try {
    fileStat = await stat(record.outboxPath);
  } catch {
    return { questions: [], offset: previousOffset };
  }
  const offset = fileStat.size < previousOffset ? 0 : previousOffset;
  if (fileStat.size === offset) return { questions: [], offset };
  const buffer = Buffer.alloc(fileStat.size - offset);
  const handle = await open(record.outboxPath, "r");
  try {
    await handle.read(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }
  const questions: SubagentQuestion[] = [];
  for (const line of buffer.toString("utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line) as SubagentQuestion;
      if (event.type === "question") questions.push(event);
    } catch (error) {
      if (record.mainSessionId && record.taskId && record.attempt)
        await persistLifecycleTransition(
          record,
          record.lifecycleStatus ?? "working",
          "agent.outbox.invalid",
          { error, data: { linePreview: previewText(line) } },
        );
    }
  }
  return { questions, offset: fileStat.size };
}
