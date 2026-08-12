import { describe, expect, test } from "bun:test";

import { prepareDryRunPosting, renderFindingCommentBody } from "../pr-review/posting";
import type { ReviewFinding } from "../pr-review/types";

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
        ].join("\n"),
      },
    ]);
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
