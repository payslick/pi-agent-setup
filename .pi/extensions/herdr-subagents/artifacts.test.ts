import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentArtifactPaths,
  agentIdentityFromEnvironment,
  appendAgentEvent,
  checkpointFromInput,
  formatAgentHandoff,
  handoffFromInput,
  HERDR_RUN_SCHEMA_VERSION,
  initializeAgentArtifacts,
  nextAgentAttempt,
  readAgentCheckpoint,
  readAgentHandoff,
  readPersistedWorkPacket,
  safeArtifactSegment,
  writeAgentCheckpoint,
  writeAgentHandoff,
  writeAgentStatus,
  writeSessionReference,
  writeSyntheticFailureHandoff,
  type AgentHandoff,
  type AgentRunIdentity,
} from "./artifacts";
import type { SubagentSpec } from "./schemas";

const temporaryPaths = new Set<string>();

const identity = (overrides: Partial<AgentRunIdentity> = {}): AgentRunIdentity => ({
  mainSessionId: "main/session",
  taskId: "payroll calculation",
  agentId: "agent-1",
  attempt: 1,
  workspaceId: "workspace-1",
  profile: "backend-implementer",
  ...overrides,
});

const spec: SubagentSpec = {
  profile: "backend-implementer",
  workPacket: {
    taskId: "payroll calculation",
    objective: "Implement payroll calculation.",
    writableFiles: ["app/src/payroll.ts"],
    contractFiles: ["app/tests/unit/payroll.test.ts"],
    acceptanceCriteria: ["The contract tests pass."],
    validationPhase: "green",
  },
};

const handoff = (runIdentity: AgentRunIdentity): AgentHandoff => ({
  schemaVersion: HERDR_RUN_SCHEMA_VERSION,
  identity: runIdentity,
  status: "success",
  summary: "Implemented payroll calculation.",
  changedFiles: ["app/src/payroll.ts"],
  validation: ["bun --cwd app test tests/unit/payroll.test.ts: passed"],
  deviations: [],
  risks: [],
  followUp: [],
  createdAt: 20,
});

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((entry) => rm(entry, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-artifacts-"));
  temporaryPaths.add(root);
  return root;
}

describe("Herdr run identity", () => {
  test("loads complete correlation identity from the worker environment", () => {
    expect(
      agentIdentityFromEnvironment({
        PI_MAIN_SESSION_ID: "main-1",
        PI_TASK_ID: "payroll",
        PI_SUBAGENT_ID: "agent-1",
        PI_AGENT_ATTEMPT: "2",
        HERDR_WORKSPACE_ID: "workspace-1",
        PI_SUBAGENT_TYPE: "backend-implementer",
        PI_PARENT_AGENT_ID: "parent-1",
      }),
    ).toEqual({
      mainSessionId: "main-1",
      taskId: "payroll",
      agentId: "agent-1",
      attempt: 2,
      workspaceId: "workspace-1",
      profile: "backend-implementer",
      parentAgentId: "parent-1",
    });
    expect(agentIdentityFromEnvironment({})).toBeUndefined();
  });

  test("creates canonical checkpoints and handoffs from tool input", () => {
    const runIdentity = identity();
    expect(
      checkpointFromInput(
        runIdentity,
        {
          summary: "Started.",
          completed: ["Read contracts."],
          remaining: ["Implement."],
          changedFiles: [],
          validation: [],
        },
        10,
      ),
    ).toMatchObject({ identity: runIdentity, summary: "Started.", updatedAt: 10 });
    expect(
      handoffFromInput(
        runIdentity,
        {
          status: "success",
          summary: "Done.",
          changedFiles: ["app/src/payroll.ts"],
          validation: ["passed"],
          deviations: [],
          risks: [],
          followUp: [],
        },
        11,
      ),
    ).toMatchObject({ identity: runIdentity, status: "success", createdAt: 11 });
  });
});

describe("Herdr run artifact paths", () => {
  test("normalizes identifiers without allowing path traversal", () => {
    expect(safeArtifactSegment(" payroll / calculation ")).toBe("payroll-calculation");
    expect(safeArtifactSegment("../../outside")).toBe("outside");
    expect(() => safeArtifactSegment("---")).toThrow("non-empty artifact identifier");
  });

  test("keeps every attempt beneath the main session and logical task", () => {
    const paths = agentArtifactPaths("/repo", identity());

    expect(paths.attemptDirectory).toBe(
      "/repo/.pi/runs/herdr/main-session/payroll-calculation/attempts/1",
    );
    expect(paths.workPacketPath).toEndWith("/work-packet.json");
    expect(paths.promptPath).toEndWith("/prompt.md");
    expect(paths.handoffPath).toEndWith("/handoff.json");
    expect(paths.outboxPath).toEndWith("/outbox.jsonl");
  });
});

describe("Herdr run artifacts", () => {
  test("initializes a restartable packet, status, prompt, and append-only event log", async () => {
    const root = await temporaryRoot();
    const runIdentity = identity();
    const paths = await initializeAgentArtifacts(
      root,
      runIdentity,
      spec,
      "System instructions",
      "Full work packet prompt",
    );

    const persisted = await readPersistedWorkPacket(paths.workPacketPath);
    expect(persisted.identity).toEqual(runIdentity);
    expect(persisted.spec).toEqual(spec);
    expect(await readFile(paths.systemPromptPath, "utf8")).toBe("System instructions");
    expect(await readFile(paths.promptPath, "utf8")).toBe("Full work packet prompt");
    expect(JSON.parse(await readFile(paths.statusPath, "utf8"))).toMatchObject({
      status: "created",
      identity: runIdentity,
    });

    const events = (await readFile(paths.eventsPath, "utf8")).trim().split("\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!)).toMatchObject({ event: "agent.artifacts.initialized" });
  });

  test("atomically updates status, checkpoint, handoff, and session references", async () => {
    const root = await temporaryRoot();
    const runIdentity = identity();
    const paths = await initializeAgentArtifacts(root, runIdentity, spec);

    await writeAgentStatus(paths, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity: runIdentity,
      status: "working",
      updatedAt: 10,
    });
    await writeAgentCheckpoint(paths, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      identity: runIdentity,
      summary: "Contract inspected.",
      completed: ["Read the API tests."],
      remaining: ["Implement the controller."],
      changedFiles: [],
      validation: [],
      updatedAt: 11,
    });
    await writeAgentHandoff(paths, handoff(runIdentity));
    await writeSessionReference(paths, runIdentity, "/sessions/agent.jsonl", "agent-session-1");

    expect(JSON.parse(await readFile(paths.statusPath, "utf8")).status).toBe("working");
    await expect(readAgentCheckpoint(paths.checkpointPath)).resolves.toMatchObject({
      summary: "Contract inspected.",
      remaining: ["Implement the controller."],
    });
    expect(await readAgentHandoff(paths.handoffPath)).toEqual(handoff(runIdentity));
    expect(JSON.parse(await readFile(paths.sessionPath, "utf8"))).toMatchObject({
      identity: runIdentity,
      sessionPath: "/sessions/agent.jsonl",
      agentSessionId: "agent-session-1",
    });
  });

  test("appends correlated events and errors as JSON lines", async () => {
    const root = await temporaryRoot();
    const runIdentity = identity();
    const paths = await initializeAgentArtifacts(root, runIdentity, spec);

    await appendAgentEvent(paths, {
      schemaVersion: HERDR_RUN_SCHEMA_VERSION,
      timestamp: 30,
      level: "error",
      event: "agent.prompt.failed",
      identity: runIdentity,
      error: { message: "Herdr failed", stack: "stack" },
    });

    const events = (await readFile(paths.eventsPath, "utf8")).trim().split("\n");
    const errors = (await readFile(paths.errorsPath, "utf8")).trim().split("\n");
    expect(JSON.parse(events.at(-1)!)).toMatchObject({
      event: "agent.prompt.failed",
      identity: runIdentity,
    });
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({
      error: { message: "Herdr failed" },
    });
  });

  test("creates a structured synthetic handoff for failed attempts", async () => {
    const root = await temporaryRoot();
    const runIdentity = identity();
    const paths = await initializeAgentArtifacts(root, runIdentity, spec);

    const result = await writeSyntheticFailureHandoff(
      paths,
      runIdentity,
      "error",
      "Agent disappeared before completing its task.",
      40,
    );

    expect(result).toMatchObject({
      status: "error",
      summary: "Agent disappeared before completing its task.",
      createdAt: 40,
    });
    expect(await readAgentHandoff(paths.handoffPath)).toEqual(result);
    expect(formatAgentHandoff(result)).toContain("Agent disappeared before completing its task.");
  });

  test("allocates a new immutable attempt after previous attempts", async () => {
    const root = await temporaryRoot();
    await initializeAgentArtifacts(root, identity({ attempt: 1 }), spec);
    await initializeAgentArtifacts(root, identity({ attempt: 3 }), spec);

    await expect(nextAgentAttempt(root, "main/session", "payroll calculation")).resolves.toBe(4);
  });

  test.each([".pi", ".pi/runs", ".pi/runs/herdr"])(
    "persists restartable artifacts when %s is a symlink loop",
    async (relativePath) => {
      const root = await temporaryRoot();
      const loop = path.join(root, relativePath);
      await mkdir(path.dirname(loop), { recursive: true });
      await symlink(loop, loop);

      await expect(nextAgentAttempt(root, "main/session", "payroll calculation")).resolves.toBe(1);
      const paths = await initializeAgentArtifacts(root, identity(), spec);

      expect(paths.runDirectory).toBe(path.join(root, ".pi-runs/herdr/main-session"));
      expect((await readPersistedWorkPacket(paths.workPacketPath)).spec).toEqual(spec);
      await expect(nextAgentAttempt(root, "main/session", "payroll calculation")).resolves.toBe(2);
      expect(await readlink(loop)).toBe(loop);
    },
  );

  test("keeps artifacts local when Pi config is shared outside the project", async () => {
    const root = await temporaryRoot();
    const sharedConfig = await temporaryRoot();
    await symlink(sharedConfig, path.join(root, ".pi"));

    const paths = await initializeAgentArtifacts(root, identity(), spec);

    expect(paths.runDirectory).toBe(path.join(root, ".pi-runs/herdr/main-session"));
    expect((await readPersistedWorkPacket(paths.workPacketPath)).identity).toEqual(identity());
    await expect(
      readFile(path.join(sharedConfig, "runs/herdr/main-session/manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("continues fallback attempts after the legacy symlink is repaired", async () => {
    const root = await temporaryRoot();
    const loop = path.join(root, ".pi");
    await symlink(loop, loop);
    const first = await initializeAgentArtifacts(root, identity(), spec);
    await rm(loop);
    await mkdir(loop);

    const attempt = await nextAgentAttempt(root, "main/session", "payroll calculation");
    const next = await initializeAgentArtifacts(root, identity({ attempt }), spec);

    expect(attempt).toBe(2);
    expect(next.runDirectory).toBe(first.runDirectory);
    expect((await readPersistedWorkPacket(first.workPacketPath)).identity.attempt).toBe(1);
    expect((await readPersistedWorkPacket(next.workPacketPath)).identity.attempt).toBe(2);
  });

  test("rejects an external fallback without writing outside the project", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, ".pi"));
    await symlink(outside, path.join(root, ".pi-runs"));

    await expect(initializeAgentArtifacts(root, identity(), spec)).rejects.toThrow(
      `No safe Herdr artifact directory under ${root}`,
    );
    await expect(
      readFile(path.join(outside, "herdr/main-session/manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(outside, "runs/herdr/main-session/manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects malformed handoffs instead of treating them as successful", async () => {
    const root = await temporaryRoot();
    const paths = await initializeAgentArtifacts(root, identity(), spec);
    await Bun.write(paths.handoffPath, JSON.stringify({ status: "success" }));

    await expect(readAgentHandoff(paths.handoffPath)).rejects.toThrow("Invalid Herdr handoff");
  });
});
