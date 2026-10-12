import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentArtifactPaths,
  HERDR_RUN_SCHEMA_VERSION,
  initializeAgentArtifacts,
  writeAgentHandoff,
  type AgentHandoff,
  type AgentRunIdentity,
  type PersistedWorkPacket,
} from "./artifacts";
import {
  artifactEnvironment,
  completionFromPersistedHandoff,
  identityForRecord,
  loadSuccessfulHandoff,
  restartSpecFromPacket,
  submitCheckpointFromEnvironment,
  submitHandoffFromEnvironment,
} from "./lifecycle";
import type { SpawnedSubagentRecord } from "./state";

const temporaryPaths = new Set<string>();

const identity: AgentRunIdentity = {
  mainSessionId: "main-1",
  taskId: "employee-e2e",
  agentId: "agent-1",
  attempt: 2,
  workspaceId: "workspace-1",
  profile: "e2e-test-implementer",
};

const packet = {
  taskId: "employee-e2e",
  objective: "Complete the employee journey.",
  writableFiles: ["tests/e2e/employees.test.ts"],
  contractFiles: ["src/generated/urls.ts"],
  acceptanceCriteria: ["The journey passes."],
  validationPhase: "green" as const,
  expectedFailingTests: [
    {
      path: "tests/e2e/employees.test.ts",
      title: "creates an employee",
      expectedReason: "The journey body is pending.",
      outputPattern: "E2E_CONTRACT_PENDING",
    },
  ],
  frozenTestStructure: [
    {
      path: "tests/e2e/employees.test.ts",
      orderedTitles: ["Creating an employee", "creates an employee", "Open the page"],
      requiredText: ["URLS.employees.new()"],
    },
  ],
};

const record = (root: string): SpawnedSubagentRecord => {
  const paths = agentArtifactPaths(root, identity);
  return {
    id: identity.agentId,
    name: "employee-e2e",
    tabId: "w1:t2",
    paneId: "w1:p2",
    workspaceId: identity.workspaceId,
    tabLabel: "E2E-employee",
    cwd: root,
    promptPreview: packet.objective,
    prompted: true,
    profile: "e2e-test-implementer",
    outboxPath: paths.outboxPath,
    replaceSystemPrompt: false,
    createdAt: 1,
    mainSessionId: identity.mainSessionId,
    taskId: identity.taskId,
    attempt: identity.attempt,
    handoffPath: paths.handoffPath,
    workPacketPath: paths.workPacketPath,
    statusPath: paths.statusPath,
    checkpointPath: paths.checkpointPath,
    eventsPath: paths.eventsPath,
    errorsPath: paths.errorsPath,
    lifecycleStatus: "working",
    spec: { profile: "e2e-test-implementer", workPacket: packet },
  };
};

const successfulHandoff = (): AgentHandoff => ({
  schemaVersion: HERDR_RUN_SCHEMA_VERSION,
  identity,
  status: "success",
  summary: "Completed the journey.",
  changedFiles: ["tests/e2e/employees.test.ts"],
  validation: ["passed"],
  deviations: [],
  risks: [],
  followUp: [],
  createdAt: 20,
});

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((entry) => rm(entry, { recursive: true, force: true })));
  temporaryPaths.clear();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-lifecycle-"));
  temporaryPaths.add(root);
  return root;
}

describe("Herdr worker artifact environment", () => {
  test("passes durable paths and correlation identifiers to the worker", () => {
    const paths = agentArtifactPaths("/repo", identity);
    expect(artifactEnvironment(identity, paths, packet)).toEqual({
      PI_MAIN_SESSION_ID: "main-1",
      HERDR_WORKSPACE_ID: "workspace-1",
      PI_TASK_ID: "employee-e2e",
      PI_AGENT_ATTEMPT: "2",
      PI_AGENT_WORK_PACKET: paths.workPacketPath,
      PI_AGENT_PROMPT: paths.promptPath,
      PI_AGENT_STATUS: paths.statusPath,
      PI_AGENT_CHECKPOINT: paths.checkpointPath,
      PI_AGENT_HANDOFF: paths.handoffPath,
      PI_AGENT_EVENTS: paths.eventsPath,
      PI_AGENT_ERRORS: paths.errorsPath,
      PI_VALIDATION_PHASE: "green",
      PI_EXPECTED_FAILING_TESTS: JSON.stringify(packet.expectedFailingTests),
    });
  });

  test("requires complete persisted correlation fields on a live record", () => {
    expect(identityForRecord(record("/repo"))).toEqual(identity);
    expect(() => identityForRecord({ ...record("/repo"), taskId: undefined })).toThrow(
      "missing durable identity",
    );
  });
});

describe("worker submissions", () => {
  test("writes checkpoints and canonical handoffs to the correlated attempt", async () => {
    const root = await temporaryRoot();
    const paths = await initializeAgentArtifacts(
      root,
      identity,
      { profile: "e2e-test-implementer", workPacket: packet },
    );
    const environment = {
      PI_ACCESS_PROJECT_ROOT: root,
      PI_MAIN_SESSION_ID: identity.mainSessionId,
      PI_TASK_ID: identity.taskId,
      PI_SUBAGENT_ID: identity.agentId,
      PI_AGENT_ATTEMPT: String(identity.attempt),
      HERDR_WORKSPACE_ID: identity.workspaceId,
      PI_SUBAGENT_TYPE: identity.profile,
    };

    await expect(
      submitCheckpointFromEnvironment(
        {
          summary: "Journey inspected.",
          completed: ["Read contract."],
          remaining: ["Implement selectors."],
          changedFiles: [],
          validation: [],
        },
        environment,
      ),
    ).resolves.toBe(paths.checkpointPath);
    await expect(
      submitHandoffFromEnvironment(
        {
          status: "success",
          summary: "Journey implemented.",
          changedFiles: ["tests/e2e/employees.test.ts"],
          validation: ["passed"],
          deviations: [],
          risks: [],
          followUp: [],
        },
        environment,
      ),
    ).resolves.toBe(paths.handoffPath);
  });

  test("rejects submissions outside a correlated Herdr worker", async () => {
    await expect(
      submitHandoffFromEnvironment(
        {
          status: "success",
          summary: "Done.",
          changedFiles: [],
          validation: [],
          deviations: [],
          risks: [],
          followUp: [],
        },
        {},
      ),
    ).rejects.toThrow("durable Herdr worker identity");
  });
});

describe("successful Herdr handoff", () => {
  test("requires a valid success handoff and unchanged frozen E2E structure", async () => {
    const root = await temporaryRoot();
    const liveRecord = record(root);
    const paths = await initializeAgentArtifacts(root, identity, liveRecord.spec!);
    await mkdir(path.join(root, "tests/e2e"), { recursive: true });
    await writeFile(
      path.join(root, "tests/e2e/employees.test.ts"),
      [
        'test.describe("Creating an employee", () => {',
        'test("creates an employee", async () => {',
        'test.step("Open the page", async () => {',
        "await page.goto(URLS.employees.new());",
      ].join("\n"),
    );
    await writeAgentHandoff(paths, successfulHandoff());

    await expect(loadSuccessfulHandoff(root, liveRecord)).resolves.toEqual(successfulHandoff());
    await expect(completionFromPersistedHandoff(liveRecord, true)).resolves.toMatchObject({
      subagentId: liveRecord.id,
      status: "success",
      handoffPath: paths.handoffPath,
    });
  });

  test("rejects missing handoffs, non-success handoffs, and modified structure", async () => {
    const root = await temporaryRoot();
    const liveRecord = record(root);
    const paths = await initializeAgentArtifacts(root, identity, liveRecord.spec!);

    await expect(loadSuccessfulHandoff(root, liveRecord)).rejects.toThrow(
      "did not submit a handoff",
    );

    await writeAgentHandoff(paths, { ...successfulHandoff(), status: "blocked" });
    await expect(loadSuccessfulHandoff(root, liveRecord)).rejects.toThrow(
      "handoff status is blocked",
    );

    await writeAgentHandoff(paths, { ...successfulHandoff(), validation: ["aborted"] });
    await expect(loadSuccessfulHandoff(root, liveRecord)).rejects.toThrow(
      "has no passing validation evidence",
    );

    await writeAgentHandoff(paths, successfulHandoff());
    await mkdir(path.join(root, "tests/e2e"), { recursive: true });
    await writeFile(
      path.join(root, "tests/e2e/employees.test.ts"),
      'test("creates an employee", () => URLS.employees.new());',
    );
    await expect(loadSuccessfulHandoff(root, liveRecord)).rejects.toThrow(
      "frozen test structure changed",
    );
  });
});

describe("Herdr restart packets", () => {
  test("reuses the persisted specification, stable task ID, and latest checkpoint", () => {
    const persisted: PersistedWorkPacket = {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity,
      spec: { profile: "e2e-test-implementer", workPacket: packet },
      createdAt: 1,
    };

    const restarted = restartSpecFromPacket(persisted, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity,
      summary: "Selectors inspected.",
      completed: ["Read the contract."],
      remaining: ["Implement the journey."],
      changedFiles: ["tests/e2e/employees.test.ts"],
      validation: ["Expected red observed."],
      updatedAt: 2,
    });
    expect(restarted).not.toBe(persisted.spec);
    expect(restarted.workPacket?.taskId).toBe("employee-e2e");
    expect(restarted.prompt).toContain("Recovery checkpoint from attempt 2");
    expect(restarted.prompt).toContain("Implement the journey.");
  });
});
