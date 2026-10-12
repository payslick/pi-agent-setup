import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handoffFromInput,
  initializeAgentArtifacts,
  writeAgentHandoff,
  type AgentRunIdentity,
} from "./artifacts";
import { settledCompletionFromReference } from "./completion";
import type { SpawnedSubagentRecord } from "./state";

const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((entry) => rm(entry, { recursive: true, force: true })));
  temporaryPaths.clear();
});

describe("settled Herdr completion", () => {
  test("uses the canonical handoff when Herdr reports only an agent session ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "herdr-completion-"));
    temporaryPaths.add(root);
    const identity: AgentRunIdentity = {
      mainSessionId: "main-1",
      taskId: "task-1",
      agentId: "agent-1",
      attempt: 1,
      workspaceId: "workspace-1",
    };
    const paths = await initializeAgentArtifacts(root, identity, {});
    await writeAgentHandoff(
      paths,
      handoffFromInput(identity, {
        status: "success",
        summary: "Implemented the contract.",
        changedFiles: ["app/src/example.ts"],
        validation: ["passed"],
        deviations: [],
        risks: [],
        followUp: [],
      }),
    );
    const record: SpawnedSubagentRecord = {
      id: identity.agentId,
      name: "agent-1",
      tabId: "workspace-1:tab-1",
      paneId: "workspace-1:pane-1",
      workspaceId: identity.workspaceId,
      tabLabel: "BE-example",
      cwd: root,
      projectRoot: root,
      promptPreview: "Implement example",
      prompted: true,
      outboxPath: paths.outboxPath,
      replaceSystemPrompt: false,
      createdAt: 1,
      mainSessionId: identity.mainSessionId,
      taskId: identity.taskId,
      attempt: identity.attempt,
      handoffPath: paths.handoffPath,
    };

    await expect(
      settledCompletionFromReference(record, { kind: "id", value: "agent-session-1" }),
    ).resolves.toMatchObject({ status: "success", handoffPath: paths.handoffPath });
    await expect(readFile(paths.sessionPath, "utf8")).resolves.toContain("agent-session-1");
  });
});
