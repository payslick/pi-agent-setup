import { describe, expect, test } from "bun:test";

import { fetchPrReviewComments, type PiExec } from "../pr-review/github";

describe("PR review GitHub data", () => {
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
