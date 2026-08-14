import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const hunkRuntime = await import("../pr-review/runtime/hunk.js");
const { findingAtIssueNumber, hunkSessionIds, openReviewFindingInHunk } = hunkRuntime;

const originalHerdrEnv = process.env.HERDR_ENV;
const originalWorkspaceId = process.env.HERDR_WORKSPACE_ID;

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  if (originalWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = originalWorkspaceId;
});

const snapshot = {
  summaryInput: {
    pr: {
      base: { ref: "main", sha: "base-sha" },
      head: { ref: "feature", sha: "head-sha" },
    },
    findings: [
      {
        id: "low",
        laneId: "docs",
        type: "documentation",
        severity: "low",
        title: "Low finding",
        body: "Low details",
        location: { filePath: "docs/readme.md", line: 8 },
      },
      {
        id: "high",
        laneId: "security-api",
        type: "security",
        severity: "high",
        title: "Missing tenant filter",
        body: "The lookup can cross tenants.",
        location: { filePath: "src/invoices.ts", line: 87 },
      },
    ],
  },
};

describe("PR review Hunk integration", () => {
  test("maps report numbers using the rendered severity order", () => {
    expect(findingAtIssueNumber(snapshot, 1)?.id).toBe("high");
    expect(findingAtIssueNumber(snapshot, 2)?.id).toBe("low");
    expect(findingAtIssueNumber(snapshot, 3)).toBeUndefined();
  });

  test("parses live Hunk session identifiers", () => {
    expect(
      hunkSessionIds(
        JSON.stringify({
          sessions: [{ id: "one" }, { sessionId: "two" }, { session_id: "three" }],
        }),
      ),
    ).toEqual(["one", "two", "three"]);
  });

  test("opens a focused Herdr tab and focuses Hunk on the selected finding", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pr-review-hunk-"));
    const reportDirectory = join(cwd, "tmp", "session", "reports");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, "latest-results.json"), JSON.stringify(snapshot));
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    const calls: Array<{ command: string; args: string[] }> = [];
    let sessionLists = 0;
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "hunk" && args.join(" ") === "session list --json") {
          sessionLists += 1;
          return {
            code: 0,
            stdout: JSON.stringify({ sessions: sessionLists === 1 ? [] : [{ id: "hunk-1" }] }),
            stderr: "",
          };
        }
        if (command === "herdr" && args[0] === "tab") {
          return {
            code: 0,
            stdout: JSON.stringify({ result: { root_pane: { pane_id: "pane-1" } } }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "{}", stderr: "" };
      },
    };
    const ctx = {
      cwd,
      signal: undefined,
      sessionManager: { getSessionFile: () => "/sessions/session.jsonl" },
    };

    try {
      await openReviewFindingInHunk(pi as never, ctx as never, 1);

      const tabCall = calls.find(({ command, args }) => command === "herdr" && args[0] === "tab");
      expect(tabCall?.args).toContain("--focus");
      expect(tabCall?.args).toContain("Hunk-1");
      const runCall = calls.find(
        ({ command, args }) => command === "herdr" && args[0] === "pane" && args[1] === "run",
      );
      expect(runCall?.args).toContain("base-sha...head-sha");
      const commentCall = calls.find(
        ({ command, args }) => command === "hunk" && args[0] === "session" && args[1] === "comment",
      );
      expect(commentCall?.args).toContain("hunk-1");
      expect(commentCall?.args).toContain("src/invoices.ts");
      expect(commentCall?.args).toContain("87");
      expect(commentCall?.args).toContain("--focus");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
