import { describe, expect, test } from "bun:test";
import { formatBranchPrStatus, loadBranchPrStatus, type PrStatusCommand } from "../pr-link-status";

const pr = {
  number: 1089,
  url: "https://github.com/finito-org/pi-agent-setup/pull/1089",
  headRefName: "omry/footer",
};
const link = (label: string) => `\u001B]8;;${pr.url}\u001B\\${label}\u001B]8;;\u001B\\`;

const commands =
  ({
    branch = "omry/footer",
    upstream = "origin\trefs/heads/omry/footer",
    prs = [pr],
    failedLookup = false,
  }: {
    branch?: string;
    upstream?: string;
    prs?: (typeof pr)[];
    failedLookup?: boolean;
  } = {}): PrStatusCommand =>
  async (command, args) => {
    if (command === "git" && args.join(" ") === "branch --show-current")
      return { stdout: branch, stderr: "", code: 0 };
    if (command === "git" && args[0] === "for-each-ref")
      return { stdout: upstream, stderr: "", code: 0 };
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const head = args[args.indexOf("--head") + 1];
      const openOnly = args[args.indexOf("--state") + 1] === "open";
      return {
        stdout: JSON.stringify(openOnly ? prs.filter((item) => item.headRefName === head) : []),
        stderr: failedLookup ? "GitHub unavailable" : "",
        code: failedLookup ? 1 : 0,
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

describe("branch PR label", () => {
  test("marks branches without an open PR and trims only the leading omry prefix", () => {
    expect(formatBranchPrStatus("omry/footer", null, null)).toBe("[No PR] footer");
    expect(formatBranchPrStatus("feature/omry/footer", null, null)).toBe(
      "[No PR] feature/omry/footer",
    );
  });

  test("links the complete label and collapses identical tracked branch names to the remote", () => {
    expect(
      formatBranchPrStatus("omry/footer", { remote: "origin", branch: "omry/footer" }, pr),
    ).toBe(link("#1089 footer (origin)"));
  });

  test("keeps the full tracked branch name when it differs from the local branch", () => {
    expect(
      formatBranchPrStatus("omry/local", { remote: "origin", branch: "omry/footer" }, pr),
    ).toBe(link("#1089 local (origin/omry/footer)"));
  });

  test("compares full branch names before trimming the local display", () => {
    expect(formatBranchPrStatus("omry/footer", { remote: "upstream", branch: "footer" }, pr)).toBe(
      link("#1089 footer (upstream/footer)"),
    );
  });

  test("omits the remote suffix when no upstream is configured", () => {
    expect(formatBranchPrStatus("feature/footer", null, pr)).toBe(link("#1089 feature/footer"));
  });
});

describe("branch PR lookup", () => {
  test("finds the open PR for a differently named tracked branch", async () => {
    expect(await loadBranchPrStatus("/project", commands({ branch: "omry/local" }))).toBe(
      link("#1089 local (origin/omry/footer)"),
    );
  });

  test("looks up the local branch when no upstream is configured", async () => {
    expect(await loadBranchPrStatus("/project", commands({ upstream: "" }))).toBe(
      link("#1089 footer"),
    );
  });

  test("shows No PR instead of using an unrelated open pull request", async () => {
    expect(
      await loadBranchPrStatus("/project", commands({ prs: [{ ...pr, headRefName: "other" }] })),
    ).toBe("[No PR] footer");
  });

  test("does not claim No PR when GitHub lookup fails", async () => {
    expect(await loadBranchPrStatus("/project", commands({ failedLookup: true }))).toBeUndefined();
  });

  test("omits branch PR status in detached HEAD", async () => {
    expect(await loadBranchPrStatus("/project", commands({ branch: "" }))).toBeUndefined();
  });
});
