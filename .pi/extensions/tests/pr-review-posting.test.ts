import { describe, expect, test } from "bun:test";

import {
  appendGithubCommentSignature,
  prepareDryRunPosting,
  renderFindingCommentBody,
} from "../pr-review/posting";
import type { ReviewComment, ReviewFinding } from "../pr-review/types";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    laneId: "correctness",
    type: "bug",
    severity: "high",
    title: "Duplicate submissions overwrite data",
    body: "A second request can finish last and replace the first result.",
    location: { filePath: "src/save.ts", line: 12 },
    ...overrides,
  };
}

function existingComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "comment-1",
    databaseId: 101,
    body: "Duplicate submissions can overwrite data when the second request finishes last.",
    path: "src/save.ts",
    line: 12,
    author: { login: "reviewer" },
    url: "https://github.com/acme/app/pull/42#discussion_r101",
    ...overrides,
  };
}

describe("pr review comment posting", () => {
  test("renders an exact replacement before its explanation", () => {
    const body = renderFindingCommentBody(
      finding({ replacement: "if (isSaving) return;\nawait save();" }),
    );

    expect(body).toBe(
      [
        "```suggestion",
        "if (isSaving) return;",
        "await save();",
        "```",
        "",
        "**Why:** A second request can finish last and replace the first result.",
        "",
        "[correctness - gpt-5.6-sol]",
      ].join("\n"),
    );
  });

  test("renders a typed example before prose", () => {
    const body = renderFindingCommentBody(
      finding({
        replacement: undefined,
        example: { code: "const total = sumDebts(debts);", language: "ts" },
        body: "Prefer the existing project helper.",
      }),
    );

    expect(body).toBe(
      [
        "```ts",
        "const total = sumDebts(debts);",
        "```",
        "",
        "**Prefer:** Prefer the existing project helper.",
        "",
        "[correctness - gpt-5.6-sol]",
      ].join("\n"),
    );
  });

  test("includes GitHub multi-line suggestion coordinates", () => {
    const result = prepareDryRunPosting({
      findings: [
        finding({
          replacement: "return activeRows;",
          location: { filePath: "src/save.ts", startLine: 10, endLine: 12 },
        }),
      ],
    });

    expect(result.payload.comments).toEqual([
      {
        path: "src/save.ts",
        line: 12,
        side: "RIGHT",
        start_line: 10,
        start_side: "RIGHT",
        body: [
          "```suggestion",
          "return activeRows;",
          "```",
          "",
          "**Why:** A second request can finish last and replace the first result.",
          "",
          "[correctness - gpt-5.6-sol]",
        ].join("\n"),
      },
    ]);
  });

  test("uses a model-only signature outside review comments", () => {
    expect(appendGithubCommentSignature("Updated the PR description.")).toBe(
      "Updated the PR description.\n\n[gpt-5.6-sol]",
    );
  });

  test("chains agent types when multiple lanes report the same issue", () => {
    const result = prepareDryRunPosting({
      findings: [
        finding({ id: "dedupe", laneId: "dedupe" }),
        finding({ id: "security", laneId: "security-api" }),
      ],
      issueConsolidations: [
        {
          id: "duplicate-submission",
          title: "Duplicate submissions overwrite data",
          summary: "Both lanes found the same race.",
          findingIds: ["dedupe", "security"],
        },
      ],
    });

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.body).toEndWith("[dedupe, security - gpt-5.6-sol]");
  });

  test("keeps consolidated findings at different locations separate", () => {
    const result = prepareDryRunPosting({
      findings: [
        finding({ id: "dedupe", laneId: "dedupe" }),
        finding({
          id: "security",
          laneId: "security-api",
          location: { filePath: "src/save.ts", line: 20 },
        }),
      ],
      issueConsolidations: [
        {
          id: "duplicate-submission",
          title: "Duplicate submissions overwrite data",
          summary: "Related findings occur at separate call sites.",
          findingIds: ["dedupe", "security"],
        },
      ],
    });

    expect(result.drafts.map(({ body }) => body.split("\n").at(-1))).toEqual([
      "[dedupe - gpt-5.6-sol]",
      "[security - gpt-5.6-sol]",
    ]);
  });

  test("omits a finding equivalent to an existing review comment", () => {
    const result = prepareDryRunPosting({
      findings: [finding()],
      existingComments: [existingComment()],
    });

    expect(result.drafts).toEqual([]);
    expect(result.replies).toEqual([]);
    expect(result.skippedFindings.map(({ message }) => message)).toContain(
      "Equivalent existing review comment: https://github.com/acme/app/pull/42#discussion_r101",
    );
  });

  test("replies when an equivalent finding adds substantial evidence", () => {
    const result = prepareDryRunPosting({
      findings: [
        finding({
          body: "A second request can finish last and overwrite the first persisted result because both writes use the stale revision.",
          evidence: ["tests/save-race.test.ts reproduces two concurrent writes"],
        }),
      ],
      existingComments: [existingComment({ body: "Duplicate submissions can overwrite data." })],
    });

    expect(result.drafts).toEqual([]);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.inReplyTo).toBe(101);
  });

  test("keeps distinct existing comments from suppressing a finding", () => {
    const result = prepareDryRunPosting({
      findings: [finding()],
      existingComments: [existingComment({ body: "Rename this function for clarity." })],
    });

    expect(result.drafts).toHaveLength(1);
    expect(result.replies).toEqual([]);
  });

  test("keeps unlocated PR metadata findings in the report without treating them as invalid", () => {
    const result = prepareDryRunPosting({
      findings: [
        finding({
          laneId: "pr-metadata",
          type: "documentation",
          location: undefined,
        }),
      ],
    });

    expect(result.drafts).toEqual([]);
    expect(result.skippedFindings).toContainEqual({
      level: "warning",
      findingId: "f1",
      message: "PR metadata finding is report-only because it has no code location.",
    });
  });

  test("rejects repeated and overlong prose", () => {
    const repeated = prepareDryRunPosting({
      findings: [finding({ body: "Duplicate submissions overwrite data" })],
    });
    const long = prepareDryRunPosting({
      findings: [finding({ body: `${"Long explanation ".repeat(30)}.` })],
    });

    expect(repeated.drafts).toEqual([]);
    expect(repeated.skippedFindings.map((message) => message.message)).toContain(
      "Finding body repeats the title.",
    );
    expect(long.drafts).toEqual([]);
    expect(long.skippedFindings.map((message) => message.message)).toContain(
      "Rendered comment prose exceeds 400 characters.",
    );
  });
});
