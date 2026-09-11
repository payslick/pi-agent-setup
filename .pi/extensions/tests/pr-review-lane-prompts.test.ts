import { describe, expect, test } from "bun:test";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewAgentRuntime = await import("../pr-review/runtime/review-agents.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewArtifactRuntime = await import("../pr-review/runtime/artifacts.js");

const {
  buildReviewAgentArguments,
  buildReviewLaneSystemPrompt,
  DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_REVIEW_AGENT_TIMEOUT_MS,
  reviewAgentInactivityTimeout,
  reviewAgentTimeout,
  reviewAgentToolPolicy,
} = reviewAgentRuntime;
const {
  isAllowedCiAnalysisBashCall,
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
  REVIEW_AGENT_PROMPT_COMMAND,
  reviewAgentToolGuardSource,
} = reviewArtifactRuntime;

describe("PR review lane prompts and tool policy", () => {
  test("assembles shared policy and specialized lane requirements", () => {
    const testsPrompt = buildReviewLaneSystemPrompt("tests", true);
    const metadataPrompt = buildReviewLaneSystemPrompt("pr-metadata", true);
    const architecturePrompt = buildReviewLaneSystemPrompt("architecture", true);
    const performancePrompt = buildReviewLaneSystemPrompt("performance", true);
    const codeQualityPrompt = buildReviewLaneSystemPrompt("code-quality", true);
    const ciPrompt = buildReviewLaneSystemPrompt("ci-analysis", true);

    expect(testsPrompt).toContain("# PR review lane agent");
    expect(testsPrompt).toContain("## Tests lane");
    expect(testsPrompt).toContain("setup, action, and expected assertion");
    expect(testsPrompt).toContain("plausible production regression");
    expect(testsPrompt).toContain("exact existing utility");
    expect(testsPrompt).toContain("database as a black box");
    expect(testsPrompt).toContain("change and inspect application state through existing APIs or controllers");
    expect(testsPrompt).toContain("Builders are the only test utilities allowed to access the database directly");
    expect(testsPrompt).toContain("Before adding a builder, inspect the existing builders");
    expect(testsPrompt).toContain("New builders are tested and provide sensible default values");
    expect(testsPrompt).toContain("Test helpers never access the database directly unless they are builders");
    expect(testsPrompt).toContain("do not introduce lint-rule disable directives");
    expect(testsPrompt).toContain("reuse existing testing utilities rather than reimplementing");
    expect(testsPrompt).toContain("type-system guarantees, trivial assignments");
    expect(testsPrompt).toContain("Use `read-many-files-lines` for bounded file-content retrieval");
    expect(testsPrompt).toContain("Request only the minimum necessary line ranges");
    expect(testsPrompt).toContain("do not inspect testing guides");
    expect(testsPrompt).toContain("when a concrete candidate depends on that context");
    expect(testsPrompt).toContain("directory named `drizzle` at any depth");
    expect(testsPrompt).toContain("file with a `.sql` extension (case-insensitive)");
    expect(testsPrompt).toContain(
      "Do not use `read-many-files-lines` to access them directly or indirectly",
    );
    expect(testsPrompt).toContain("exclude them from every `read-many-files-lines` request");
    expect(testsPrompt).toContain(`Call \`${REVIEW_AGENT_PARTIAL_FINDING_TOOL}\` once`);
    expect(testsPrompt).toContain("Before requesting more evidence, record every finding");
    expect(testsPrompt).toContain(
      "Do not call `read-many-files-lines` merely to reread the packet",
    );
    expect(testsPrompt).not.toContain("get_data");
    expect(testsPrompt).toContain("Assume the supplied diff is the latest data");
    expect(testsPrompt).toContain(
      "Read repository files only when the diff is insufficient to review a specific hunk",
    );
    expect(testsPrompt).toContain(
      "Request additional context sparingly and ask for the minimum necessary line range",
    );
    expect(testsPrompt).toContain("after identifying a concrete candidate finding");
    expect(testsPrompt).toContain("Prefer one consolidated, narrowly scoped request");
    expect(testsPrompt).toContain("After a tool timeout or failure, take its output seriously");
    expect(testsPrompt).toContain("find another way to bypass the failure");
    expect(testsPrompt).toContain("even when it requires rethinking your approach");
    expect(testsPrompt).toContain("Bash is intentionally unavailable");
    expect(metadataPrompt).toContain("Load and follow the explicitly configured `pr-metadata` skill");
    expect(metadataPrompt).toContain('"type":"documentation|question"');
    expect(metadataPrompt).not.toContain('"path":"file"');
    expect(architecturePrompt).toContain("`ServerError` subclass, which derives from `TRPCError`");
    expect(architecturePrompt).toContain("database schema → API Zod schema → form schema");
    expect(architecturePrompt).toContain("`any`, `unknown`, `Record<string, unknown>`");
    expect(architecturePrompt).toContain("`Parameters<typeof fn>[index]`");
    expect(architecturePrompt).toContain("bypasses a lint rule with an `eslint-disable`");
    expect(architecturePrompt).not.toContain("one bounded query per data group");
    expect(architecturePrompt).not.toContain("code terminology—including identifiers");
    expect(performancePrompt).toContain("one bounded query per data group");
    expect(codeQualityPrompt).toContain("code terminology—including identifiers, exported types");
    expect(architecturePrompt).toContain(
      "no reasonable typed, structural, API, or configuration alternative",
    );
    expect(ciPrompt).toContain("## CI failure analysis lane");
    expect(ciPrompt).toContain("Use only the enabled tools");
    expect(ciPrompt).toContain("Bash is restricted to one direct, read-only");
    expect(ciPrompt).not.toContain("issues CI will not catch");
  });

  test("bounds lane runtime while allowing explicit overrides", () => {
    expect(DEFAULT_REVIEW_AGENT_TIMEOUT_MS).toBe(2_700_000);
    expect(DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS).toBe(600_000);
    expect(reviewAgentTimeout({})).toBe(DEFAULT_REVIEW_AGENT_TIMEOUT_MS);
    expect(reviewAgentInactivityTimeout({})).toBe(DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS);
    expect(reviewAgentTimeout({ PI_REVIEW_AGENT_TIMEOUT_MS: "120000" })).toBe(120_000);
    expect(
      reviewAgentInactivityTimeout({ PI_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS: "30000" }),
    ).toBe(30_000);
    expect(reviewAgentTimeout({ PI_REVIEW_AGENT_TIMEOUT_MS: "invalid" })).toBe(
      DEFAULT_REVIEW_AGENT_TIMEOUT_MS,
    );
    expect(
      reviewAgentInactivityTimeout({ PI_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS: "invalid" }),
    ).toBe(DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS);
  });

  test("enables repository inspection without exposing Bash to ordinary lanes", () => {
    const defaultPolicy = reviewAgentToolPolicy("correctness", false);
    const dedupePolicy = reviewAgentToolPolicy("dedupe", false);
    const ciPolicy = reviewAgentToolPolicy("ci-analysis", false);
    const fullPolicy = reviewAgentToolPolicy("correctness", true);

    expect(defaultPolicy).toEqual({
      toolsEnabled: true,
      allowedTools: [
        REVIEW_AGENT_PARTIAL_FINDING_TOOL,
        "read",
        "read-many-files-lines",
      ].join(","),
    });
    expect(dedupePolicy.allowedTools.split(",")).toContain("read-many-files-lines");
    expect(dedupePolicy.allowedTools.split(",")).not.toContain("get_data");
    expect(dedupePolicy.allowedTools.split(",")).not.toContain("bash");
    expect(ciPolicy.allowedTools.split(",")).toEqual([
      REVIEW_AGENT_PARTIAL_FINDING_TOOL,
      "read",
      "read-many-files-lines",
      "bash",
    ]);
    expect(fullPolicy.allowedTools.split(",")).toContain("read-many-files-lines");
    expect(fullPolicy.allowedTools.split(",")).not.toContain("get_data");
    expect(fullPolicy.allowedTools.split(",")).not.toContain("bash");
  });

  test("loads only the explicit skill for the metadata lane", () => {
    const args = buildReviewAgentArguments(
      { cwd: "/repo" },
      {
        laneId: "pr-metadata",
        thinking: "high",
        toolsEnabled: true,
        allowedTools: "read,read-many-files-lines",
        systemPrompt: "system",
        skillPath: "/repo/.pi/skills/pr-metadata/SKILL.md",
      },
    );

    expect(args.slice(args.indexOf("--no-skills"), args.indexOf("--no-skills") + 3)).toEqual([
      "--no-skills",
      "--skill",
      "/repo/.pi/skills/pr-metadata/SKILL.md",
    ]);
  });

  test("limits CI-analysis Bash to direct read-only GitHub CI inspection", () => {
    for (const command of [
      "gh pr checks 42 --json name,state,bucket,link,workflow",
      "gh run list --limit 20 --json databaseId,name,status,conclusion",
      "gh run view 123 --log-failed",
    ]) {
      expect(isAllowedCiAnalysisBashCall({ action: "read", command })).toBeTrue();
    }

    for (const input of [
      { action: "write", command: "gh run view 123 --log-failed" },
      { action: "read", command: "gh api repos/acme/app/actions/runs" },
      { action: "read", command: "gh workflow run deploy.yml" },
      { action: "read", command: "gh run view 123; rm -rf tmp" },
      { action: "read", command: "gh run view $(cat token)" },
      { action: "read", command: "git status" },
    ]) {
      expect(isAllowedCiAnalysisBashCall(input)).toBeFalse();
    }

    const guardedLaneSource = reviewAgentToolGuardSource(
      "tmp/session/ci-analysis",
      "tmp/session/shared",
      {
        allowCiAnalysisGhBash: true,
        promptFile: "tmp/session/ci-analysis/prompt.md",
        partialFindingsFile: "tmp/session/ci-analysis/partial-findings.jsonl",
      },
    );
    expect(guardedLaneSource).toContain("const allowCiAnalysisGhBash = true;");
    expect(guardedLaneSource).toContain(`pi.registerCommand("${REVIEW_AGENT_PROMPT_COMMAND}"`);
    expect(guardedLaneSource).not.toContain("getDataCallCount");
    expect(guardedLaneSource).toContain('await pi.sendUserMessage(prompt);');
    expect(guardedLaneSource).toContain(`name: "${REVIEW_AGENT_PARTIAL_FINDING_TOOL}"`);
    expect(guardedLaneSource).toContain('promptSnippet: "Record a confirmed PR review finding');
    expect(guardedLaneSource).toContain("promptGuidelines:");
    expect(guardedLaneSource).toContain('await appendFile(outputPath');
    expect(guardedLaneSource).toContain("Files under drizzle/ are outside review scope.");
    expect(guardedLaneSource).toContain('tmp/session/ci-analysis/prompt.md');
    expect(reviewAgentToolGuardSource("tmp/session/tests", "tmp/session/shared")).toContain(
      "const allowCiAnalysisGhBash = false;",
    );
    const metadataGuard = reviewAgentToolGuardSource(
      "tmp/session/pr-metadata",
      "tmp/session/shared",
      {
        partialFindingsFile: "tmp/session/pr-metadata/partial-findings.jsonl",
        allowUnlocatedFindings: true,
      },
    );
    expect(metadataGuard).toContain('required: ["severity","type","title","body"]');
    expect(metadataGuard).toContain('typeof finding.path === "string"');
  });
});
