import {
  completionFromPersistedHandoff,
  persistSessionForRecord,
} from "./lifecycle";
import { completionFromSession, sessionIdFromPath } from "./session";
import type { SpawnedSubagentRecord, SubagentDoneEvent } from "./state";

export interface AgentSessionReference {
  kind?: string;
  value?: string;
}

export async function settledCompletionFromReference(
  record: SpawnedSubagentRecord,
  session?: AgentSessionReference,
): Promise<SubagentDoneEvent | undefined> {
  if (!session?.value) return completionFromPersistedHandoff(record, true);
  if (record.mainSessionId && record.taskId && record.attempt)
    await persistSessionForRecord(
      record,
      session.kind === "path" ? session.value : record.sessionPath ?? "",
      session.kind === "id" ? session.value : sessionIdFromPath(session.value),
    );
  if (session.kind !== "path") return completionFromPersistedHandoff(record, true);
  return (
    (await completionFromSession(record, session.value)) ??
    completionFromPersistedHandoff(record, true)
  );
}
