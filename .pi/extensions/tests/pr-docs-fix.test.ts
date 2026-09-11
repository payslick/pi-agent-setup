import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-expect-error Plain JavaScript runtime modules intentionally have no declaration files.
const docsFixRuntime = await import("../pr-review/runtime/pr-update.js");
const {
  PR_DOCS_FIX_AGENT_TIMEOUT_MS,
  applyPrDocsFixEdits,
  buildPrDocsFixPrompt,
  prDocsFixCandidatePaths,
  runPrDocsFixAgent,
} = docsFixRuntime;

const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

describe("PR stale-docs repair", () => {
  test("uses a seven-minute agent timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-docs-fix-"));
    temporaryPaths.add(root);
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    const parsed = await runPrDocsFixAgent(
      {
        exec: async (_command: string, args: string[], options: { timeout?: number }) => {
          calls.push({ args, timeout: options.timeout });
          return {
            code: 0,
            stdout: JSON.stringify({
              edits: [{ oldText: "old/path.ts", newText: "new/path.ts" }],
            }),
            stderr: "",
          };
        },
      },
      { cwd: root },
      "prompt",
      "docs-fix-1",
      "docs/example.md",
    );

    expect(PR_DOCS_FIX_AGENT_TIMEOUT_MS).toBe(7 * 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeout).toBe(7 * 60_000);
    expect(calls[0]?.args).toContain("--no-tools");
    expect(parsed.edits).toHaveLength(1);
  });

  test("reports a timeout explicitly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-docs-timeout-"));
    temporaryPaths.add(root);

    await expect(
      runPrDocsFixAgent(
        {
          exec: async () => ({ code: 143, stdout: "", stderr: "" }),
        },
        { cwd: root },
        "prompt",
        "docs-fix-1",
        "docs/example.md",
      ),
    ).rejects.toThrow("timed out after 7 minutes while repairing docs/example.md");
  });

  test("requests small exact replacements instead of complete files", () => {
    const prompt = buildPrDocsFixPrompt(
      865,
      "docs/tags.md",
      [
        {
          docFile: "docs/tags.md",
          lineNumber: 100,
          reference: "src/components/tags/tags-table.tsx",
        },
      ],
      "See src/components/tags/tags-table.tsx for details.\n",
      ["src/components/tags/tags-table/tags-table.tsx"],
    );

    expect(prompt).toContain('"edits":[{"oldText"');
    expect(prompt).toContain("Do not return the complete file");
    expect(prompt).toContain("Candidate: src/components/tags/tags-table/tags-table.tsx");
    expect(prompt).not.toContain('"files":[{"path"');
  });

  test("ranks same-name and same-directory replacement candidates", () => {
    expect(
      prDocsFixCandidatePaths("src/components/tags/tags-table.tsx", [
        "src/components/tags/tag-dialog.tsx",
        "src/components/tags/tags-table/tags-table.tsx",
        "src/other/tags-table.tsx",
      ]),
    ).toEqual([
      "src/components/tags/tags-table/tags-table.tsx",
      "src/other/tags-table.tsx",
      "src/components/tags/tag-dialog.tsx",
    ]);
  });

  test("applies only unique edits containing every reported stale reference", () => {
    const content = "Use src/old/a.ts for A.\nUse src/old/b.ts for B.\nUnrelated wording stays.\n";
    const nextContent = applyPrDocsFixEdits(
      content,
      {
        edits: [
          { oldText: "src/old/a.ts", newText: "src/new/a.ts" },
          { oldText: "Use src/old/b.ts for B.", newText: "Use src/new/b.ts for B." },
        ],
      },
      "docs/example.md",
      ["src/old/a.ts", "src/old/b.ts"],
    );

    expect(nextContent).toBe(
      "Use src/new/a.ts for A.\nUse src/new/b.ts for B.\nUnrelated wording stays.\n",
    );
    expect(() =>
      applyPrDocsFixEdits(
        "src/old/a.ts and src/old/a.ts",
        { edits: [{ oldText: "src/old/a.ts", newText: "src/new/a.ts" }] },
        "docs/example.md",
        ["src/old/a.ts"],
      ),
    ).toThrow("must occur exactly once");
    expect(() =>
      applyPrDocsFixEdits(
        content,
        { edits: [{ oldText: "src/old/a.ts", newText: "src/new/a.ts" }] },
        "docs/example.md",
        ["src/old/a.ts", "src/old/b.ts"],
      ),
    ).toThrow("did not address src/old/b.ts");
  });
});
