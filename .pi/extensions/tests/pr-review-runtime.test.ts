import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import prReviewExtension from "../pr-review/impl.js";
// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const prCreateRuntime = await import("../pr-review/runtime/pr-create.js");
const {
  choosePrCreateBaseBranch,
  extractPrCreateTicketReferences,
  isPrCreateScreenshotPath,
  planPrCreateScreenshots,
  updateExistingPr,
} = prCreateRuntime;

const expectedCommands = [
  "pr-create",
  "pr-review",
  "pr-review-demo",
  "pr-review-local",
  "pr-review-process",
  "pr-review-rerender",
  "pr-review-status",
  "pr-review-update",
  "pr-review-visual",
  "pr-update",
];

describe("pr review plain JavaScript runtime", () => {
  test("registers every command from readable modules", () => {
    const commands: string[] = [];
    const renderers: string[] = [];
    prReviewExtension({
      events: { on: () => () => {} },
      on: () => {},
      registerCommand: (name: string) => commands.push(name),
      registerMessageRenderer: (name: string) => renderers.push(name),
    });

    expect(commands.sort()).toEqual(expectedCommands);
    expect(renderers).toEqual(["pr-review-report"]);
  });

  test("removes the legacy standalone PR extension", async () => {
    await expect(stat(new URL("../pr.ts", import.meta.url))).rejects.toThrow();
  });

  test("does not load a Base64 implementation payload", async () => {
    const implementationSource = await readFile(
      new URL("../pr-review/impl.js", import.meta.url),
      "utf8",
    );

    expect(implementationSource).not.toContain("impl.bundle.txt");
    expect(implementationSource).not.toContain('Buffer.from(encodedImplementation, "base64")');
    await expect(stat(new URL("../pr-review/impl.bundle.txt", import.meta.url))).rejects.toThrow();
  });

  test("commits and initially pushes before fetching and rebasing", async () => {
    const source = await readFile(
      new URL("../pr-review/runtime/pr-create.js", import.meta.url),
      "utf8",
    );
    const flow = source.slice(
      source.indexOf("async function executePrCreateCommand"),
      source.indexOf("async function preparePrCreateTarget"),
    );
    const operations = [
      "repairExistingPrDocs",
      "runPreflightChecks",
      "commitAllWorktreeChanges",
      "pushPrCreateBranch(pi, ctx, target.branch, false)",
      "syncPrCreateBranch",
    ];
    for (let index = 1; index < operations.length; index += 1)
      expect(flow.indexOf(operations[index - 1])).toBeLessThan(flow.indexOf(operations[index]));
    expect(flow).not.toContain("commitRelatedWorktreeChanges");
  });

  test("confirms an existing PR base change and can retain the branch base", async () => {
    const accepted = {
      existingPrNumber: 17,
      requestedBaseBranch: "release",
      branchBaseBranch: "main",
      baseBranch: "main",
      baseChanged: false,
    };
    const acceptedBase = await choosePrCreateBaseBranch(
      {
        hasUI: true,
        ui: { select: async (_prompt: string, choices: string[]) => choices[0] },
      },
      accepted,
    );
    expect(acceptedBase).toBe("release");
    expect(accepted).toMatchObject({ baseBranch: "release", baseChanged: true });

    const retained = { ...accepted, baseBranch: "main", baseChanged: false };
    const retainedBase = await choosePrCreateBaseBranch(
      {
        hasUI: true,
        ui: { select: async (_prompt: string, choices: string[]) => choices[1] },
      },
      retained,
    );
    expect(retainedBase).toBe("main");
    expect(retained).toMatchObject({ baseBranch: "main", baseChanged: false });

    await expect(
      choosePrCreateBaseBranch(
        { hasUI: false, ui: {} },
        { ...accepted, baseBranch: "main", baseChanged: false },
      ),
    ).rejects.toThrow("Run interactively to choose");
  });

  test("extracts and deduplicates related GitHub references", () => {
    expect(
      extractPrCreateTicketReferences(
        "[PR #42](https://github.com/acme/widgets/pull/42) Issue 9 Ticket #11 Fixes #12",
        "prd/widget.md",
      ),
    ).toEqual([
      {
        kind: "pr",
        number: 42,
        repo: "acme/widgets",
        source: "prd/widget.md",
        explicit: true,
      },
      {
        kind: "issue",
        number: 9,
        repo: undefined,
        source: "prd/widget.md",
        explicit: true,
      },
      {
        kind: "unknown",
        number: 11,
        repo: undefined,
        source: "prd/widget.md",
        explicit: true,
      },
      {
        kind: "unknown",
        number: 12,
        repo: undefined,
        source: "prd/widget.md",
        explicit: true,
      },
    ]);
    expect(extractPrCreateTicketReferences("ui/widget-redesign-787", "branch", true)).toEqual([
      {
        kind: "unknown",
        number: 787,
        repo: undefined,
        source: "branch",
        explicit: false,
      },
    ]);
  });

  test("only TSX files qualify for automatic screenshots", () => {
    expect(isPrCreateScreenshotPath("app/settings/page.tsx")).toBe(true);
    expect(isPrCreateScreenshotPath("components/Card.TSX")).toBe(true);
    expect(isPrCreateScreenshotPath("app/settings/page.ts")).toBe(false);
    expect(isPrCreateScreenshotPath("styles/page.css")).toBe(false);
    expect(isPrCreateScreenshotPath("README.md")).toBe(false);
  });

  test("stages the large screenshot brief instead of pasting it through Herdr", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pr-screenshot-prompt-"));
    const sessionPath = path.join(directory, "screenshot-agent.jsonl");
    const previousHerdrEnv = process.env.HERDR_ENV;
    const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: '{"captures":[],"failures":[]}' }],
        },
      })}\n`,
      "utf8",
    );
    const calls: string[][] = [];
    const session = { kind: "path", value: sessionPath };
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
        if (args[0] === "agent" && args[1] === "prompt")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { agent: { agent_status: "working", agent_session: session } },
            }),
            stderr: "",
          };
        if (args[0] === "agent" && ["get", "wait"].includes(args[1] ?? ""))
          return {
            code: 0,
            stdout: JSON.stringify({
              result: { agent: { agent_status: "idle", agent_session: session } },
            }),
            stderr: "",
          };
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const diff = `DIFF_PAYLOAD_START\n${"x".repeat(70_000)}\nDIFF_PAYLOAD_END`;

    try {
      const result = await planPrCreateScreenshots(
        pi,
        {
          cwd: directory,
          signal: undefined,
          sessionManager: {
            getSessionFile: () => path.join(directory, "review-session.jsonl"),
          },
        },
        {
          changedFiles: ["src/components/Card.tsx"],
          diffStat: "1 file changed",
          diff,
          relatedTickets: "",
        },
        ["src/components/Card.tsx"],
      );

      expect(result).toEqual({ captures: [], markdown: "", failures: [] });
      const promptCall = calls.find(
        (args) => args[0] === "agent" && args[1] === "prompt",
      );
      const submittedPrompt = promptCall?.[3] ?? "";
      expect(submittedPrompt).toBe("/run-pr-review-lane");
      expect(submittedPrompt).not.toContain("DIFF_PAYLOAD_START");
      const brief = await readFile(
        path.join(
          directory,
          "tmp",
          "review-session",
          "pr-create",
          "screenshots-plan-prompt.md",
        ),
        "utf8",
      );
      expect(brief).toContain("DIFF_PAYLOAD_START");
      expect(brief).toContain("DIFF_PAYLOAD_END");
      const bootstrapExtensionPath = path.join(
        directory,
        "tmp",
        "review-session",
        "pr-create",
        "screenshots-plan-bootstrap.ts",
      );
      const bootstrapExtension = await readFile(bootstrapExtensionPath, "utf8");
      expect(bootstrapExtension).toContain('pi.registerCommand("run-pr-review-lane"');
      expect(bootstrapExtension).toContain("await pi.sendUserMessage(prompt);");
      expect(bootstrapExtension).toContain(
        "tmp/review-session/pr-create/screenshots-plan-prompt.md",
      );
      const startCall = calls.find(
        (args) => args[0] === "agent" && args[1] === "start",
      );
      expect(startCall).not.toContain("--no-extensions");
      expect(startCall).toContain(bootstrapExtensionPath);
      expect(startCall).toContain(
        "read,read-many-files-lines,project_index_status,project_index_refresh,project_index_search",
      );
    } finally {
      if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previousHerdrEnv;
      if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("updates an existing PR base only after a confirmed base change", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "gh" && args[1] === "view")
          return {
            code: 0,
            stdout: JSON.stringify({ number: 17, title: "Fix(ui): Widget", url: "https://pr" }),
            stderr: "",
          };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const ctx = { cwd: "/tmp", signal: new AbortController().signal };
    const draft = { title: "Fix(ui): Widget", body: "body" };

    await updateExistingPr(pi, ctx, 17, draft, "body.md", ["ui"], "release", true);
    const changedBaseEdit = calls.find((call) => call[0] === "gh" && call[2] === "edit");
    expect(changedBaseEdit).toContain("--base");
    expect(changedBaseEdit).toContain("release");

    calls.length = 0;
    await updateExistingPr(pi, ctx, 17, draft, "body.md", ["ui"], "main", false);
    const unchangedBaseEdit = calls.find((call) => call[0] === "gh" && call[2] === "edit");
    expect(unchangedBaseEdit).not.toContain("--base");
  });
});
