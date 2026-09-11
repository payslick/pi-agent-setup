import { describe, expect, test } from "bun:test";

import { fetchPrReviewComments, type PiExec } from "../pr-review/github";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const { fetchPrData } = await import("../pr-review/runtime/github.js");

describe("PR review GitHub data", () => {
  test("fetches the complete commit list with the PR patch", async () => {
    const calls: string[] = [];
    const exec: PiExec = async (command, args = []) => {
      calls.push([command, ...args].join(" "));
      if (args[1] === "view")
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Feat: export invoices",
            body: "Body",
            author: { login: "octo" },
            url: "https://github.com/acme/app/pull/42",
            baseRefName: "main",
            baseRefOid: "base",
            headRefName: "feature/export",
            headRefOid: "head",
            files: [{ path: "src/export.ts", status: "modified" }],
            commits: [
              {
                oid: "abc123",
                messageHeadline: "Add export",
                messageBody: "Include finance fields.",
              },
              { oid: "def456", messageHeadline: "Cover export" },
            ],
          }),
          stderr: "",
        };
      return {
        code: 0,
        stdout: "diff --git a/src/export.ts b/src/export.ts\n+export\n",
        stderr: "",
      };
    };

    const data = await fetchPrData(exec, "/repo", 42);

    expect(calls[0]).toContain("files,commits");
    expect(data.metadata.commits).toEqual([
      { sha: "abc123", title: "Add export", body: "Include finance fields." },
      { sha: "def456", title: "Cover export", body: undefined },
    ]);
    expect(data.patch).toContain("+export");
  });

  test("uses the helper bundled with the active Pi extension", async () => {
    const calls: string[] = [];
    const exec: PiExec = async (command, args = []) => {
      calls.push([command, ...args].join(" "));
      return {
        code: 0,
        stdout: '{"viewerLogin":"omryn","reviewThreads":[],"comments":[]}',
        stderr: "",
      };
    };

    const comments = await fetchPrReviewComments(exec, "/repo", 648);

    expect(comments.viewerLogin).toBe("omryn");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(".pi/skills/finito-scripts/scripts/getPrComments.ts");
  });
});
