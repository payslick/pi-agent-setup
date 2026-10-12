import { shortenHomePath, type SpawnedSubagentRecord } from "./state";

export const formatSpawnedSubagents = (records: SpawnedSubagentRecord[]): string =>
  [
    `Started ${records.length} Herdr subagent${records.length === 1 ? "" : "s"}.`,
    ...records.map(
      (record) =>
        `- ${record.name}: tab ${record.tabLabel} (${record.tabId})\n  task: ${record.promptPreview}`,
    ),
  ].join("\n");

export function formatSubagentRecord(
  record: SpawnedSubagentRecord,
  observedStatus?: string,
): string {
  return [
    `${record.name} [${observedStatus ?? record.lifecycleStatus ?? "missing"}] tab=${record.tabLabel} ${record.tabId}`,
    `  cwd: ${shortenHomePath(record.cwd)}`,
    `  task: ${record.taskId ?? record.promptPreview} attempt:${record.attempt ?? "legacy"}`,
    `  profile: ${record.profile ?? "none"}`,
    `  main session: ${record.mainSessionId ?? "legacy"}`,
    record.agentSessionId ? `  agent session: ${record.agentSessionId}` : undefined,
    record.handoffPath ? `  handoff: ${shortenHomePath(record.handoffPath)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
