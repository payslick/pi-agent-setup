import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../../scripts/test.ts", import.meta.url));
const passingTest = 'import { test } from "bun:test"; test("selected test runs", () => {});';
const failingTest = 'import { test } from "bun:test"; test("unrelated test", () => { throw new Error("UNRELATED_TEST_RAN"); });';

async function projectFixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "selected-test-runner-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return {
    root,
    async [Symbol.asyncDispose]() { await rm(root, { recursive: true, force: true }); },
  };
}

test("the test script runs only explicit test paths rather than the default suite", async () => {
  await using fixture = await projectFixture({
    "tests/selected.test.ts": passingTest,
    ".pi/extensions/unrelated.test.ts": failingTest,
    "tests/unrelated.test.ts": failingTest,
  });
  const result = spawnSync(process.execPath, [runner, "./tests/selected.test.ts"], {
    cwd: fixture.root, encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("selected test runs");
  expect(result.stderr).not.toContain("UNRELATED_TEST_RAN");
});

test("the test script retains the extensions suite when no test paths are supplied", async () => {
  await using fixture = await projectFixture({
    ".pi/extensions/default.test.ts": passingTest,
    "tests/unrelated.test.ts": failingTest,
  });
  const result = spawnSync(process.execPath, [runner], { cwd: fixture.root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("selected test runs");
  expect(result.stderr).not.toContain("UNRELATED_TEST_RAN");
});
