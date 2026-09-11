import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const prMetadataRuntime = await import("../pr-review/runtime/pr-metadata.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const prLifecycleRuntime = await import("../pr-review/runtime/pr-lifecycle-shared.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const prCreateRuntime = await import("../pr-review/runtime/pr-create.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const prUpdateRuntime = await import("../pr-review/runtime/pr-update.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewAgentRuntime = await import("../pr-review/runtime/review-agents.js");
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const reviewArtifactRuntime = await import("../pr-review/runtime/artifacts.js");
const {
  PR_METADATA_AGENT_TOOLS,
  PR_METADATA_READ_EXTENSION_RELATIVE_PATH,
  PR_METADATA_SKILL_RELATIVE_PATH,
  prMetadataAgentOptions,
  resolvePrMetadataSkillPath,
} = prMetadataRuntime;
const { buildPrCreateDraftPrompt, lifecycleAgentArguments, normalizePrCreateDraft } =
  prLifecycleRuntime;
const { draftPrCreateTitleAndBody } = prCreateRuntime;
const { decidePrUpdateMetadata, maybeUpdatePrMetadata, renderPrUpdateReport } = prUpdateRuntime;
const { prepareLaneAgentRun } = reviewAgentRuntime;
const { writeSharedReviewArtifacts } = reviewArtifactRuntime;

const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) =>
      rm(temporaryPath, { recursive: true, force: true }),
    ),
  );
  temporaryPaths.clear();
});

async function projectWithMetadataSkill(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pr-metadata-skill-"));
  temporaryPaths.add(root);
  const skillPath = path.join(root, PR_METADATA_SKILL_RELATIVE_PATH);
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "---\nname: pr-metadata\n---\n", "utf8");
  return root;
}

describe("PR metadata skill integration", () => {
  test("selects only pr-metadata and enables its read tools", async () => {
    const root = await projectWithMetadataSkill();
    const ctx = { cwd: root };
    const skillPath = resolvePrMetadataSkillPath(ctx);
    const options = prMetadataAgentOptions(ctx);

    expect(skillPath).toBe(path.join(root, PR_METADATA_SKILL_RELATIVE_PATH));
    expect(options).toEqual({
      skillPath,
      tools: PR_METADATA_AGENT_TOOLS,
      extensions: [path.join(root, PR_METADATA_READ_EXTENSION_RELATIVE_PATH)],
    });

    const args = lifecycleAgentArguments(
      undefined,
      "system",
      "prompt",
      "off",
      options,
    );
    expect(args).toContain("--no-skills");
    expect(args.slice(args.indexOf("--skill"), args.indexOf("--skill") + 2)).toEqual([
      "--skill",
      skillPath,
    ]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "read,read-many-files-lines",
    ]);
    expect(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2)).toEqual([
      "--extension",
      path.join(root, PR_METADATA_READ_EXTENSION_RELATIVE_PATH),
    ]);
  });

  test("fails clearly when pr-metadata is not installed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "missing-pr-metadata-skill-"));
    temporaryPaths.add(root);

    expect(() => resolvePrMetadataSkillPath({ cwd: root })).toThrow(
      "npx skills add ~/payslick/skills --skill pr-metadata --agent pi --yes",
    );
  });

  test("keeps lifecycle agents skill-free unless explicitly configured", () => {
    const args = lifecycleAgentArguments(undefined, "system", "prompt");

    expect(args).toContain("--no-tools");
    expect(args).toContain("--no-skills");
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--extension");
  });

  test("PR-create keeps Herdr reporting enabled while loading pr-metadata tools", async () => {
    const root = await projectWithMetadataSkill();
    const sessionPath = path.join(root, "agent-session.jsonl");
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: JSON.stringify({ title: "Feat: add workflow", body: "Canonical body" }),
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    const previousHerdrEnv = process.env.HERDR_ENV;
    const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    const calls: string[][] = [];
    const pi = {
      exec: async (command: string, args: string[]) => {
        expect(command).toBe("herdr");
        calls.push(args);
        if (args[0] === "tab" && args[1] === "create")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } },
            }),
            stderr: "",
          };
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                agent: {
                  agent_status: "idle",
                  agent_session: { kind: "path", value: sessionPath },
                },
              },
            }),
            stderr: "",
          };
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };

    try {
      await draftPrCreateTitleAndBody(
        pi,
        { cwd: root },
        {
          branch: "feature/workflow",
          baseBranch: "main",
          changedFiles: ["src/workflow.ts"],
          commits: "abc Add workflow",
          diffStat: "1 file changed",
          diff: "+workflow",
          status: "clean",
        },
        [],
        "",
      );
    } finally {
      if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previousHerdrEnv;
      if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
    }

    const startCalls = calls.filter(
      (args) => args[0] === "agent" && args[1] === "start",
    );
    expect(startCalls).toHaveLength(1);
    const args = startCalls[0] ?? [];
    expect(args.slice(args.indexOf("--skill") - 1, args.indexOf("--skill") + 2)).toEqual([
      "--no-skills",
      "--skill",
      path.join(root, PR_METADATA_SKILL_RELATIVE_PATH),
    ]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "read,read-many-files-lines",
    ]);
    expect(args).not.toContain("--no-extensions");
  });

  test("the PR-update workflow surfaces agent failures while preserving metadata", async () => {
    const root = await projectWithMetadataSkill();
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return { code: 1, stdout: "", stderr: "agent unavailable" };
      },
    };
    const contextData = {
      branch: "feature/workflow",
      baseBranch: "main",
      changedFiles: ["src/workflow.ts"],
      commits: "abc Add workflow",
      diffStat: "1 file changed",
      diff: "+workflow",
      status: "clean",
    };

    const decision = await decidePrUpdateMetadata(pi, { cwd: root }, contextData, []);
    const result = await maybeUpdatePrMetadata(pi, { cwd: root }, 42, contextData, []);

    const invalidDecision = await decidePrUpdateMetadata(
      {
        exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
      },
      { cwd: root },
      contextData,
      [],
    );

    expect(decision).toMatchObject({ shouldUpdate: false, evaluationFailed: true });
    expect(invalidDecision).toMatchObject({ shouldUpdate: false, evaluationFailed: true });
    expect(invalidDecision.reason).toContain("invalid JSON");
    expect(result).toMatchObject({ updated: false, evaluationFailed: true });
    expect(result.reason).toContain("existing title and body were preserved");
    expect(calls[0]).toContain("--skill");
    expect(
      renderPrUpdateReport({
        pr: { number: 42 },
        branch: "feature/workflow",
        baseBranch: "main",
        rebase: { result: "up to date", iterations: 0, migrationRegenerated: false },
        docsFixed: false,
        checksSkipped: true,
        pushResult: "pushed",
        metadata: result,
        labels: [],
      }),
    ).toContain("PR metadata evaluation failed; title and body left unchanged");
  });

  test("the metadata review lane resolves the installed skill during preparation", async () => {
    const root = await projectWithMetadataSkill();
    const metadata = {
      ref: { owner: "acme", repo: "app", number: 42 },
      title: "Feat: add workflow",
      body: "Canonical body",
      author: "octo",
      url: "https://github.com/acme/app/pull/42",
      state: "OPEN",
      base: { ref: "main", sha: "base" },
      head: { ref: "feature/workflow", sha: "head" },
      commits: [{ sha: "abc", title: "Add workflow" }],
    };
    const files = [{ path: "src/workflow.ts", status: "modified" }];
    const fullPatch = "diff --git a/src/workflow.ts b/src/workflow.ts\n+workflow\n";
    const sharedArtifacts = await writeSharedReviewArtifacts(
      { cwd: root },
      { metadata, files, hunks: [], patch: fullPatch },
      [],
    );
    const prepared = await prepareLaneAgentRun(
      { getThinkingLevel: () => "high" },
      { cwd: root },
      metadata,
      {
        laneId: "pr-metadata",
        title: "PR metadata",
        focus: "Apply pr-metadata.",
        files,
        hunks: [],
      },
      sharedArtifacts,
    );

    const skillIndex = prepared.agentArguments.indexOf("--skill");
    expect(prepared.agentArguments.slice(skillIndex - 1, skillIndex + 2)).toEqual([
      "--no-skills",
      "--skill",
      path.join(root, PR_METADATA_SKILL_RELATIVE_PATH),
    ]);
    expect(sharedArtifacts.files).toContain("tmp/default/shared/commits.json");
    expect(sharedArtifacts.fullPatch).toBe(fullPatch);
    expect(prepared.prompt).toContain("## Complete commit history");
    expect(prepared.prompt).toContain("abc — Add workflow");
    expect(prepared.prompt).toContain("## Complete reviewable diff");
    expect(prepared.prompt).toContain("+workflow");
  });

  test("normalizes transport without defining metadata policy or fallbacks", () => {
    expect(normalizePrCreateDraft({ title: "  Exact   title ", body: "Body" })).toEqual({
      title: "Exact title",
      body: "Body\n",
    });
    expect(() => normalizePrCreateDraft({ title: "", body: "Body" })).toThrow("empty title");
    expect(() => normalizePrCreateDraft({ title: "Title", body: "" })).toThrow(
      "empty description",
    );
    expect(() =>
      normalizePrCreateDraft({ title: "Title", body: "Body" }, "![required](image.png)"),
    ).toThrow("omitted the required screenshot markdown");
  });

  test("draft context contains evidence but no duplicate metadata rules", () => {
    const prompt = buildPrCreateDraftPrompt(
      {
        branch: "feature/example",
        baseBranch: "main",
        changedFiles: ["src/example.ts"],
        commits: "abc Change example",
        diffStat: "1 file changed",
        diff: "+change",
        status: "clean",
      },
      ["server"],
      "",
    );

    expect(prompt).toContain("## Complete diff");
    expect(prompt).not.toContain("Required title style");
    expect(prompt).not.toContain("Required body sections");
    expect(prompt).not.toContain("## Testing");
  });
});
