import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSubagentOutbox } from "./outbox";
import type { SpawnedSubagentRecord } from "./state";

const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((entry) => rm(entry, { recursive: true, force: true })));
  temporaryPaths.clear();
});

async function setup(): Promise<{ file: string; record: SpawnedSubagentRecord }> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-outbox-"));
  temporaryPaths.add(root);
  const file = path.join(root, "outbox.jsonl");
  await writeFile(file, "");
  return {
    file,
    record: {
      id: "agent-1",
      name: "agent-1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      workspaceId: "w1",
      tabLabel: "BE-example",
      cwd: root,
      promptPreview: "Example",
      prompted: true,
      outboxPath: file,
      replaceSystemPrompt: false,
      createdAt: 1,
    },
  };
}

describe("Herdr subagent outbox", () => {
  test("returns new questions and a byte offset for restart-safe polling", async () => {
    const { file, record } = await setup();
    await appendFile(
      file,
      `${JSON.stringify({ id: "q1", type: "question", addressedTo: "main_agent", question: "Continue?" })}\n`,
    );

    const first = await readSubagentOutbox(record);
    expect(first.questions).toHaveLength(1);
    expect(first.questions[0]?.question).toBe("Continue?");
    expect(first.offset).toBeGreaterThan(0);
    await expect(readSubagentOutbox(record, first.offset)).resolves.toEqual({
      questions: [],
      offset: first.offset,
    });
  });

  test("resets the offset when a recovered outbox was truncated", async () => {
    const { file, record } = await setup();
    await appendFile(
      file,
      `${JSON.stringify({ id: "q2", type: "question", addressedTo: "main_agent", question: "Restart?" })}\n`,
    );

    const result = await readSubagentOutbox(record, 10_000);
    expect(result.questions[0]?.id).toBe("q2");
    expect(result.offset).toBeGreaterThan(0);
  });
});
