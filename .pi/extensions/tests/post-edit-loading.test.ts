import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const cliPath = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const extensionPath = fileURLToPath(new URL("../post-edit-checks.ts", import.meta.url));

test("Pi loads post-edit checks without circular export errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "post-edit-loading-"));
  try {
    const result = spawnSync(
      "node",
      [cliPath, "--offline", "-ne", "-e", extensionPath, "--no-session", "--mode", "rpc"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, PI_CODING_AGENT_DIR: root },
        input: '{"type":"get_state","id":"startup"}\n',
      },
    );
    expect(result.stderr).not.toContain("Failed to load extension");
    expect(result.status).toBe(0);
    const responses = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: "startup",
        type: "response",
        command: "get_state",
        success: true,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
