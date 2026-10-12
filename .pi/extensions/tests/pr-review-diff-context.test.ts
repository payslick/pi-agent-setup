import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatReviewDiffContext,
  prepareReviewDiff,
  type ReviewDiffTarget,
} from "../pr-review/diff-context";
import type { PiExec } from "../pr-review/github";
import { buildLaneReviewPrompt, routeReviewLanes } from "../pr-review/lanes";
import type { PRMetadata } from "../pr-review/types";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { runReviewCommand } = await import("../pr-review/runtime/review.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { writeSharedReviewArtifacts } = await import("../pr-review/runtime/artifacts.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { prepareLaneAgentRun } = await import("../pr-review/runtime/review-agents.js");

const exec: PiExec = async (command, args = [], options = {}) => {
  const result = spawnSync(command, [...args], { cwd: options.cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

async function withReviewRepo(
  run: (repo: {
    cwd: string;
    git: (...args: string[]) => string;
    write: (file: string, content: string | Uint8Array) => void;
    target: ReviewDiffTarget;
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "review-diff-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const write = (file: string, content: string | Uint8Array) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Review test");
    git("config", "user.email", "review@example.test");
    git("config", "commit.gpgsign", "false");
    write(".gitignore", "tmp/\n");
    write(
      ".pi/skills/pr-metadata/SKILL.md",
      readFileSync(new URL("../../skills/pr-metadata/SKILL.md", import.meta.url), "utf8"),
    );
    write("src/value.ts", "export const value = 1;\n");
    write("src/remove.ts", "export const removed = true;\n");
    write("script.sh", "echo reviewed\n");
    write("docs/old name.md", "Documentation retained through rename.\n");
    git("add", ".");
    git("commit", "-m", "Base");
    const baseSha = git("rev-parse", "HEAD");
    git("switch", "-c", "reviewed");
    write("src/value.ts", "export const value = 2;\n");
    git("add", ".");
    git("commit", "-m", "Reviewed change");
    await run({
      cwd,
      git,
      write,
      target: { branch: "reviewed", headSha: git("rev-parse", "HEAD"), baseSha },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const diffLines = (patch: string, start: number, end: number) =>
  patch
    .split("\n")
    .slice(start - 1, end)
    .join("\n");

describe("review diff preparation", () => {
  test("stops the review command before remote diff retrieval or agent startup when the checkout is dirty", async () => {
    await withReviewRepo(async ({ cwd, write, target }) => {
      write("untracked.txt", "Keep this work\n");
      const reviewExec: PiExec = async (command, args = [], options = {}) => {
        if (command === "git") return exec(command, args, options);
        if (command === "gh" && args[1] === "view")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              number: 42,
              title: "Review",
              body: "Review changes",
              url: "https://github.com/acme/app/pull/42",
              baseRefName: "main",
              baseRefOid: target.baseSha,
              headRefName: target.branch,
              headRefOid: target.headSha,
            }),
          };
        throw new Error(`Unexpected review command: ${command} ${args.join(" ")}`);
      };
      const displayed = { status: "", lines: [] as string[] };
      const ctx = {
        cwd,
        hasUI: true,
        ui: {
          setStatus: (_key: string, status: string) => {
            displayed.status = status;
          },
          setWidget: (_key: string, lines: string[]) => {
            displayed.lines = lines;
          },
        },
      };
      await expect(runReviewCommand({ exec: reviewExec }, ctx, "42", false)).rejects.toThrow(
        "Commit or stash",
      );
      expect(displayed.status).toBe("❌:stopped");
      expect(displayed.lines.join("\n")).toContain("Commit or stash");
      expect(existsSync(path.join(cwd, "tmp/review/diff/full"))).toBe(false);
    });
  });

  test("the standalone script writes the full diff and prints its index", async () => {
    await withReviewRepo(async ({ cwd, target }) => {
      const result = spawnSync(
        process.execPath,
        [
          new URL("../../scripts/review-diff.ts", import.meta.url).pathname,
          target.baseSha,
          target.headSha,
          target.branch,
        ],
        { cwd, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("tmp/review/diff/full:");
      expect(result.stdout).toContain("src/value.ts");
      expect(readFileSync(path.join(cwd, "tmp/review/diff/full"), "utf8")).toContain(
        "+export const value = 2;",
      );
    });
  });

  test("local review persists a Complete context report without requiring GitHub or launching agents", async () => {
    await withReviewRepo(async ({ cwd, target }) => {
      const localExec: PiExec = (command, args, options) => {
        if (command !== "git") throw new Error(`Unexpected external command: ${command}`);
        return exec(command, args, options);
      };
      await runReviewCommand(
        { exec: localExec, sendMessage: () => {} },
        { cwd, hasUI: false },
        `${target.baseSha} --no-agents`,
        true,
      );
      const report = JSON.parse(
        readFileSync(path.join(cwd, "tmp/default/reports/latest-results.json"), "utf8"),
      );
      expect(report.summaryInput.coverage.items).toContainEqual({
        id: "changed-files",
        label: "Diff context",
        status: "complete",
        details:
          "1 change range(s) indexed in tmp/review/diff/full. Local branch and commit verified; working tree clean. Drizzle directories excluded.",
      });
    });
  });

  test("delivers the complete index and read instructions through shared artifacts to each lane", async () => {
    await withReviewRepo(async ({ cwd, target }) => {
      const prepared = await prepareReviewDiff(exec, cwd, target);
      const pr: PRMetadata = {
        ref: { owner: "acme", repo: "app", number: 42 },
        title: "Review",
        body: "Review changes",
        author: "reviewer",
        url: "https://github.com/acme/app/pull/42",
        state: "OPEN",
        base: { ref: "main", sha: target.baseSha },
        head: { ref: target.branch, sha: target.headSha },
      };
      const data = { ...prepared, metadata: pr, prNumber: 42, diffContext: prepared.context };
      const lanes = routeReviewLanes({ pr, files: data.files, hunks: data.hunks }, [
        "api-safety",
        "pr-metadata",
      ]);
      const ctx = {
        cwd,
        sessionManager: { getSessionFile: () => path.join(cwd, "review-session.jsonl") },
      };
      const shared = await writeSharedReviewArtifacts(ctx, data, lanes);
      for (const lane of lanes) {
        const typedPrompt = buildLaneReviewPrompt(pr, lane, {
          laneDir: `tmp/review-session/${lane.laneId}`,
          sharedDir: shared.sharedDir,
          sharedFiles: shared.files,
          diffContext: prepared.context,
        });
        const runtime = await prepareLaneAgentRun(
          { getThinkingLevel: () => "medium" },
          ctx,
          pr,
          lane,
          shared,
        );
        for (const prompt of [typedPrompt, runtime.prompt]) {
          expect(prompt).toContain("These are all the changes");
          expect(prompt).toContain("tmp/review/diff/full:");
          expect(prompt).toContain("single tool call");
          expect(prompt).not.toContain("+export const value = 2");
          expect(prompt).not.toContain("unless a specific truncated hunk");
        }
      }
    });
  });
  test("stops on a different branch even at the reviewed commit without writing artifacts", async () => {
    await withReviewRepo(async ({ cwd, git, target }) => {
      git("switch", "-c", "other");
      await expect(prepareReviewDiff(exec, cwd, target)).rejects.toThrow("switch to reviewed");
      expect(existsSync(path.join(cwd, "tmp/review/diff/full"))).toBe(false);
    });
  });

  test("stops on a detached checkout with a branch-switch suggestion", async () => {
    await withReviewRepo(async ({ cwd, git, target }) => {
      git("checkout", "--detach");
      await expect(prepareReviewDiff(exec, cwd, target)).rejects.toThrow("switch to reviewed");
    });
  });

  test("stops when the branch name matches but its commit differs from the PR head", async () => {
    await withReviewRepo(async ({ cwd, git, target }) => {
      git("commit", "--allow-empty", "-m", "Unreviewed commit");
      await expect(prepareReviewDiff(exec, cwd, target)).rejects.toThrow(
        "does not match the reviewed head",
      );
      expect(existsSync(path.join(cwd, "tmp/review/diff/full"))).toBe(false);
    });
  });

  test.each(["unstaged", "staged", "untracked"] as const)(
    "stops with commit/stash guidance for %s changes without modifying them",
    async (state) => {
      await withReviewRepo(async ({ cwd, git, write, target }) => {
        const file = state === "untracked" ? "notes.txt" : "src/value.ts";
        write(file, "Uncommitted work\n");
        if (state === "staged") git("add", file);
        const before = git("status", "--porcelain");
        await expect(prepareReviewDiff(exec, cwd, target)).rejects.toThrow("Commit or stash");
        expect(git("status", "--porcelain")).toBe(before);
        expect(readFileSync(path.join(cwd, file), "utf8")).toBe("Uncommitted work\n");
        expect(existsSync(path.join(cwd, "tmp/review/diff/full"))).toBe(false);
      });
    },
  );

  test("saves the complete net diff, excludes drizzle at any depth and includes SQL and docs elsewhere", async () => {
    await withReviewRepo(async ({ cwd, git, write, target }) => {
      write("src/value.ts", "export const value = 3;\n");
      write("drizzle/001.sql", "EXCLUDED ROOT\n");
      write("packages/db/drizzle/schema.ts", "EXCLUDED NESTED\n");
      write("queries/report.SQL", "SELECT 1;\n");
      write("docs/guide.md", "Reviewed documentation.\n");
      git("add", ".");
      git("commit", "-m", "More changes");
      target.headSha = git("rev-parse", "HEAD");
      const result = await prepareReviewDiff(exec, cwd, target);
      expect(result.context.path).toBe("tmp/review/diff/full");
      expect(readFileSync(path.join(cwd, result.context.path), "utf8")).toBe(result.patch);
      expect(result.patch).toContain("-export const value = 1;");
      expect(result.patch).toContain("+export const value = 3;");
      expect(result.patch).not.toContain("export const value = 2;");
      expect(result.patch).not.toContain("EXCLUDED");
      expect(result.files.map((file) => file.path)).toEqual([
        "docs/guide.md",
        "queries/report.SQL",
        "src/value.ts",
      ]);
      for (const change of result.context.changes) {
        expect(diffLines(result.patch, change.diffRange.start, change.diffRange.end)).toStartWith(
          "@@ ",
        );
        expect(change.sourceRange).toEqual({ start: 1, end: 1 });
        expect(change.diffRange.end).toBeGreaterThan(change.diffRange.start);
      }
      expect(git("status", "--porcelain")).toBe("");
      expect((await prepareReviewDiff(exec, cwd, target)).patch).toBe(result.patch);
    });
  });

  test("indexes deletion, rename-only, binary and mode-only changes without inventing source lines", async () => {
    await withReviewRepo(async ({ cwd, git, write, target }) => {
      git("rm", "src/remove.ts");
      git("mv", "docs/old name.md", "docs/new name.md");
      write("image.bin", new Uint8Array([0, 1, 2, 3]));
      chmodSync(path.join(cwd, "script.sh"), 0o755);
      git("add", "image.bin", "script.sh");
      git("commit", "-m", "Nonstandard changes");
      target.headSha = git("rev-parse", "HEAD");
      const result = await prepareReviewDiff(exec, cwd, target);
      const changeFor = (file: string) =>
        result.context.changes.find((change) => change.filePath === file);
      expect(changeFor("src/remove.ts")).toMatchObject({
        status: "D",
        sourceRange: null,
        oldRange: { start: 1, end: 1 },
      });
      expect(changeFor("docs/new name.md")).toMatchObject({
        kind: "metadata",
        previousPath: "docs/old name.md",
        sourceRange: null,
      });
      expect(changeFor("image.bin")).toMatchObject({ kind: "binary", sourceRange: null });
      expect(changeFor("script.sh")).toMatchObject({ kind: "metadata", sourceRange: null });
      for (const file of ["docs/new name.md", "image.bin"]) {
        const change = changeFor(file)!;
        expect(diffLines(result.patch, change.diffRange.start, change.diffRange.end)).toStartWith(
          "diff --git ",
        );
      }
      const context = formatReviewDiffContext(result.context);
      expect(context).toContain("no surviving source lines");
      expect(context).toContain("binary");
      expect(context).toContain("docs/new name.md");
    });
  });

  test("indexes separate hunks in a Unicode path with exact source and diff boundaries", async () => {
    await withReviewRepo(async ({ cwd, git, write, target }) => {
      const file = "src/ערך name.ts";
      const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
      write(file, lines.join("\n") + "\n");
      git("add", ".");
      git("commit", "-m", "Before separated changes");
      target.baseSha = git("rev-parse", "HEAD");
      lines[0] = "first change";
      lines[29] = "last change";
      write(file, lines.join("\n"));
      git("add", ".");
      git("commit", "-m", "Separated changes");
      target.headSha = git("rev-parse", "HEAD");
      const result = await prepareReviewDiff(exec, cwd, target);
      expect(
        result.context.changes.map((change) => ({
          filePath: change.filePath,
          sourceRange: change.sourceRange,
        })),
      ).toEqual([
        { filePath: file, sourceRange: { start: 1, end: 4 } },
        { filePath: file, sourceRange: { start: 27, end: 30 } },
      ]);
      const [first, last] = result.context.changes;
      expect(diffLines(result.patch, first!.diffRange.start, first!.diffRange.end)).not.toContain(
        "last change",
      );
      expect(diffLines(result.patch, last!.diffRange.start, last!.diffRange.end)).toContain(
        "+last change",
      );
      expect(last!.diffRange.start).toBe(first!.diffRange.end + 1);
      expect(result.hunks.map((hunk) => hunk.filePath)).toEqual([file, file]);
    });
  });

  test("keeps every hunk and line reference beyond the old inline limits", async () => {
    await withReviewRepo(async ({ cwd, git, write, target }) => {
      for (let index = 0; index < 85; index++)
        write(`src/entry-${index}.ts`, `export const entry = ${index};\n`);
      write(
        "docs/large.md",
        Array.from({ length: 240 }, (_, index) => `line ${index}`).join("\n") + "\n",
      );
      git("add", ".");
      git("commit", "-m", "Large diff");
      target.headSha = git("rev-parse", "HEAD");
      const result = await prepareReviewDiff(exec, cwd, target);
      expect(result.context.changes).toHaveLength(87);
      const large = result.context.changes.find((change) => change.filePath === "docs/large.md")!;
      expect(large.sourceRange).toEqual({ start: 1, end: 240 });
      expect(diffLines(result.patch, large.diffRange.start, large.diffRange.end)).toContain(
        "+line 239",
      );
      const context = formatReviewDiffContext(result.context);
      expect(context).toContain("src/entry-84.ts");
      expect(context).toContain(
        `tmp/review/diff/full:${large.diffRange.start}:${large.diffRange.end}`,
      );
      expect(context).toContain("These are all the changes");
      expect(context).toContain("single tool call");
      expect(context).toContain("local files are of the reviewed branch");
      expect(context).not.toContain("Diff context truncated");
      expect(context).not.toContain("+line 239");
    });
  });

  test("writes an empty full diff and an explicit empty index when only drizzle changed", async () => {
    await withReviewRepo(async ({ cwd, git, write, target }) => {
      target.baseSha = target.headSha;
      write("drizzle/001.sql", "Excluded\n");
      git("add", ".");
      git("commit", "-m", "Only generated changes");
      target.headSha = git("rev-parse", "HEAD");
      const result = await prepareReviewDiff(exec, cwd, target);
      expect(result.patch).toBe("");
      expect(result.files).toEqual([]);
      expect(result.hunks).toEqual([]);
      expect(result.context.changes).toEqual([]);
      expect(readFileSync(path.join(cwd, result.context.path), "utf8")).toBe("");
      expect(formatReviewDiffContext(result.context)).toContain("No reviewable changes");
    });
  });
});
