import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentArtifactPaths, readAgentHandoff } from "./artifacts";
import type { SubagentSpec } from "./schemas";
import {
  spawnOneHerdrSubagent,
  type SpawnSubagentContext,
  type SpawnSubagentRuntime,
} from "./spawn";
import type { SpawnedSubagentRecord } from "./state";

const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((entry) => rm(entry, { recursive: true, force: true })));
  temporaryPaths.clear();
});

async function setup(): Promise<{
  root: string;
  context: SpawnSubagentContext;
  spec: SubagentSpec;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-spawn-"));
  temporaryPaths.add(root);
  for (const skill of ["code-index", "testing"]) {
    const directory = path.join(root, ".pi/skills", skill);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `# ${skill}\n`);
  }
  return {
    root,
    context: {
      cwd: root,
      projectRoot: root,
      workspaceId: "workspace-1",
      mode: 3,
      parentSessionId: "main-1",
      defaults: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
    },
    spec: {
      name: "payroll-api",
      profile: "backend-implementer",
      workPacket: {
        taskId: "payroll-api",
        objective: "Implement payroll API.",
        writableFiles: ["app/src/payroll.ts"],
        contractFiles: ["app/tests/unit/payroll.test.ts"],
        acceptanceCriteria: ["Contract tests pass."],
        validationPhase: "green",
      },
    },
  };
}

describe("Herdr worker spawning", () => {
  test("starts through Herdr with durable correlation and exact file ownership", async () => {
    const { root, context, spec } = await setup();
    let environment: Record<string, string> = {};
    let args: string[] = [];
    const persisted: SpawnedSubagentRecord[] = [];
    const runtime: SpawnSubagentRuntime = {
      async createTab(_workspaceId, _cwd, _label, _focus, values) {
        environment = values;
        return { tab: { tab_id: "workspace-1:tab-1" }, root_pane: { pane_id: "workspace-1:pane-1" } };
      },
      async startAgent(_name, _paneId, values) {
        args = values;
        return { agent_session: { kind: "path", value: "/sessions/worker.jsonl" } };
      },
      async promptAgent() {},
      async cleanupFailedSpawn() {},
      persistRecord(record) {
        persisted.push(record);
      },
    };

    const record = await spawnOneHerdrSubagent(spec, context, runtime);

    expect(record).toMatchObject({
      projectRoot: root,
      mainSessionId: "main-1",
      taskId: "payroll-api",
      attempt: 1,
      lifecycleStatus: "working",
      writableFiles: ["app/src/payroll.ts"],
      contractFiles: ["app/tests/unit/payroll.test.ts"],
    });
    expect(environment.HERDR_WORKSPACE_ID).toBe("workspace-1");
    expect(environment.PI_AGENT_WRITABLE_FILES).toBe('["app/src/payroll.ts"]');
    expect(environment.PI_AGENT_HANDOFF).toBe(record.handoffPath);
    expect(environment.PI_AGENT_PROMPT).toBe(record.promptPath);
    expect(args).toContain("--name");
    expect(persisted).toEqual([record]);
    await expect(readFile(record.workPacketPath!, "utf8")).resolves.toContain("payroll-api");
  });

  test("preserves a failed startup attempt with a synthetic failure handoff", async () => {
    const { root, context, spec } = await setup();
    const persisted: SpawnedSubagentRecord[] = [];
    const runtime: SpawnSubagentRuntime = {
      async createTab() {
        return { tab: { tab_id: "workspace-1:tab-1" }, root_pane: { pane_id: "workspace-1:pane-1" } };
      },
      async startAgent() {
        throw new Error("agent startup failed");
      },
      async promptAgent() {},
      async cleanupFailedSpawn() {},
      persistRecord(record) {
        persisted.push(record);
      },
    };

    await expect(spawnOneHerdrSubagent(spec, context, runtime)).rejects.toThrow(
      "agent startup failed",
    );
    expect(persisted[0]?.lifecycleStatus).toBe("failed");
    const identity = {
      mainSessionId: "main-1",
      taskId: "payroll-api",
      agentId: persisted[0]!.id,
      attempt: 1,
      workspaceId: "workspace-1",
      profile: "backend-implementer",
    };
    const handoff = await readAgentHandoff(agentArtifactPaths(root, identity).handoffPath);
    expect(handoff).toMatchObject({ status: "error", summary: "agent startup failed" });
  });
});
