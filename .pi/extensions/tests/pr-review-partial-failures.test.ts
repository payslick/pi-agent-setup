import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewAgentRuntime = await import("../pr-review/runtime/review-agents.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewArtifactRuntime = await import("../pr-review/runtime/artifacts.js");
const herdrAgentRuntime = await import("../pr-review/herdr-agent.ts");
const { readPartialReviewFindings, runLaneAgent } = reviewAgentRuntime;
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { prepareDryRunPosting } = await import("../pr-review/runtime/posting.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { runReviewAgentSafely } = await import("../pr-review/runtime/review.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { renderExecutiveSummary } = await import("../pr-review/runtime/summary.js");

const rawFinding = {
  severity: "high",
  type: "bug",
  path: "src/example.ts",
  line: 7,
  title: "Recovered issue",
  body: "This confirmed issue was recorded before the lane failed.",
  confidence: 0.9,
};

describe("failed PR review lane partial findings", () => {
  test("recovers valid deduplicated partial findings and excludes generated migrations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pr-review-partials-"));
    const partialFindingsPath = path.join(directory, "partial-findings.jsonl");
    try {
      await writeFile(
        partialFindingsPath,
        [
          JSON.stringify(rawFinding),
          JSON.stringify(rawFinding),
          "{malformed",
          JSON.stringify({ ...rawFinding, path: "drizzle/0100_generated.sql" }),
        ].join("\n"),
        "utf8",
      );

      const findings = await readPartialReviewFindings(partialFindingsPath, "correctness");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        laneId: "correctness",
        partial: true,
        title: "Recovered issue",
        location: { filePath: "src/example.ts", line: 7 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers metadata-only partial findings without a code location", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pr-review-metadata-partials-"));
    const partialFindingsPath = path.join(directory, "partial-findings.jsonl");
    try {
      await writeFile(
        partialFindingsPath,
        `${JSON.stringify({
          severity: "medium",
          type: "documentation",
          title: "Testing claim is stale",
          body: "The description names coverage that the branch removed.",
          confidence: 0.9,
        })}\n`,
        "utf8",
      );

      const findings = await readPartialReviewFindings(partialFindingsPath, "pr-metadata");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        laneId: "pr-metadata",
        partial: true,
        title: "Testing claim is stale",
        location: undefined,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists valid final findings with a legacy write-only artifact writer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pr-review-legacy-artifacts-"));
    const artifactDir = path.join("tmp", "review-session", "correctness");
    const absoluteArtifactDir = path.join(directory, artifactDir);
    const partialFindingsPath = path.join(absoluteArtifactDir, "partial-findings.jsonl");
    const existingFinding = { ...rawFinding, title: "Previously recorded issue" };
    const finalFinding = {
      ...rawFinding,
      line: 12,
      title: "Final response issue",
      body: "This valid finding came from the completed lane response.",
    };
    const artifactFiles: string[] = [];
    const writtenFileNames: string[] = [];
    const legacyArtifacts = {
      artifactDir,
      artifactFiles,
      write: async (fileName: string, content: string) => {
        await mkdir(absoluteArtifactDir, { recursive: true });
        await writeFile(path.join(absoluteArtifactDir, fileName), content, "utf8");
        writtenFileNames.push(fileName);
        const artifactPath = path.posix.join(artifactDir, fileName);
        if (!artifactFiles.includes(artifactPath)) artifactFiles.push(artifactPath);
      },
    };
    const createWriter = spyOn(
      reviewArtifactRuntime,
      "createLaneArtifactWriter",
    ).mockResolvedValue(legacyArtifacts);
    const runHerdrAgent = spyOn(herdrAgentRuntime, "runPiAgentInHerdr").mockImplementation(
      async () => {
        await writeFile(partialFindingsPath, `${JSON.stringify(existingFinding)}\n`, "utf8");
        return {
          code: 0,
          stdout: JSON.stringify({ findings: [finalFinding] }),
          stderr: "",
          tabId: "tab-1",
        };
      },
    );

    try {
      const result = await runLaneAgent(
        { getThinkingLevel: () => "medium" },
        {
          cwd: directory,
          sessionManager: { getSessionFile: () => path.join(directory, "review-session.jsonl") },
        },
        {
          title: "Fix review persistence",
          body: "Keep partial findings while persisting final findings.",
          url: "https://github.com/acme/app/pull/42",
          base: { ref: "main", sha: "base" },
          head: { ref: "fix", sha: "head" },
        },
        {
          laneId: "correctness",
          title: "Correctness",
          focus: "Check behavior.",
          files: [{ path: "src/example.ts", status: "modified" }],
          hunks: [],
        },
        { sharedDir: "tmp/review-session/shared", files: [] },
      );

      expect(result.error).toBeUndefined();
      expect(result.findings).toHaveLength(1);
      expect(createWriter).toHaveBeenCalledTimes(1);
      expect("append" in legacyArtifacts).toBeFalse();
      expect(runHerdrAgent).toHaveBeenCalledTimes(1);
      expect(writtenFileNames).toContain("findings.json");
      expect(writtenFileNames.filter((fileName) => fileName === "partial-findings.jsonl")).toHaveLength(
        2,
      );
      expect(writtenFileNames).not.toContain("parse-error.txt");
      expect(writtenFileNames).not.toContain("repair-stdout.txt");
      const persistedLines = (await readFile(partialFindingsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(persistedLines).toHaveLength(2);
      expect(persistedLines[0]).toEqual(existingFinding);
      expect(persistedLines[1]).toMatchObject({
        path: finalFinding.path,
        line: finalFinding.line,
        title: finalFinding.title,
      });
    } finally {
      createWriter.mockRestore();
      runHerdrAgent.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("isolates an unexpected lane failure and recovers its partial findings", async () => {
    const recovered = [{ laneId: "tests", title: "Partial", partial: true }];
    const result = await runReviewAgentSafely(
      "tests",
      async () => {
        throw new Error("lane crashed");
      },
      undefined,
      async () => recovered,
    );

    expect(result).toEqual({
      laneId: "tests",
      findings: recovered,
      partialFindingCount: 1,
      error: "lane crashed",
    });
  });

  test("labels recovered findings in reports but excludes them from comment drafts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pr-review-partials-"));
    const partialFindingsPath = path.join(directory, "partial-findings.jsonl");
    try {
      await writeFile(partialFindingsPath, `${JSON.stringify(rawFinding)}\n`, "utf8");
      const findings = await readPartialReviewFindings(partialFindingsPath, "correctness");
      const summary = renderExecutiveSummary({
        pr: {
          ref: { owner: "acme", repo: "app", number: 42 },
          title: "Change behavior",
          body: "Changes behavior.",
        },
        findings,
        reviewedLaneIds: [],
        omittedLaneIds: ["correctness"],
        omittedLaneReasons: [{ laneId: "correctness", reason: "timed out" }],
      });
      const posting = prepareDryRunPosting({
        findings,
        hunks: [],
        issueConsolidations: [],
        existingComments: [],
      });

      expect(summary).toContain("Recovered partial findings from failed lanes: 1");
      expect(summary).toContain("Recovered issue _(partial from failed lane)_");
      expect(posting.drafts).toEqual([]);
      expect(posting.replies).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
