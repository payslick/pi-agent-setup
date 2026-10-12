import { describe, expect, test } from "bun:test";
import { formatSubagentRecord } from "./records";
import type { SpawnedSubagentRecord } from "./state";

describe("Herdr record diagnostics", () => {
  test("shows main and agent correlation identifiers and durable handoff location", () => {
    const record: SpawnedSubagentRecord = {
      id: "agent-1",
      name: "payroll-agent",
      tabId: "w1:t2",
      paneId: "w1:p2",
      workspaceId: "w1",
      tabLabel: "BE-payroll",
      cwd: "/repo",
      promptPreview: "Implement payroll",
      prompted: true,
      outboxPath: "/repo/outbox.jsonl",
      replaceSystemPrompt: false,
      createdAt: 1,
      mainSessionId: "main-1",
      agentSessionId: "agent-session-1",
      taskId: "payroll",
      attempt: 2,
      handoffPath: "/repo/.pi/runs/herdr/main-1/payroll/attempts/2/handoff.json",
    };

    const formatted = formatSubagentRecord(record, "working");
    expect(formatted).toContain("payroll-agent [working]");
    expect(formatted).toContain("task: payroll attempt:2");
    expect(formatted).toContain("main session: main-1");
    expect(formatted).toContain("agent session: agent-session-1");
    expect(formatted).toContain("handoff:");
  });
});
