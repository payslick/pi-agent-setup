import { describe, expect, test } from "bun:test";
import { renderExecutiveSummary } from "../pr-review/summary";
import type { ExecutiveSummaryInput, PRMetadata, ReviewFinding } from "../pr-review/types";

const pr: PRMetadata = {
  ref: { owner: "acme", repo: "app", number: 42 },
  title: "Add invoice export",
  body: "Exports invoices to CSV for finance users.\n\nMore details.",
  author: "octo",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  base: { ref: "main", sha: "base" },
  head: { ref: "feature/invoice-export", sha: "head" },
};

function input(findings: readonly ReviewFinding[]): ExecutiveSummaryInput {
  return { pr, findings, reviewedLaneIds: ["correctness", "tests"] };
}

describe("pr review executive summary", () => {
  test("renders normal findings with function name in file column", () => {
    const markdown = renderExecutiveSummary(
      input([
        {
          id: "f1",
          laneId: "correctness",
          type: "bug",
          severity: "high",
          title: "CSV escaping can corrupt rows",
          body: "Values with commas are written raw.",
          location: {
            filePath: "src/features/billing/invoices/export/csv-writer.ts",
            line: 128,
            functionName: "writeInvoiceCsv",
          },
        },
      ]),
    );

    expect(markdown).toContain("| # | File | Issue |");
    expect(markdown).toContain(
      "| 🟠1 | ...eatures/billing/invoices/export/csv-writer.ts :128 #writeInvoiceCsv | 🐛 CSV escaping can corrupt rows |",
    );
  });

  test("renders group rows in the markdown table for renderer merging", () => {
    const markdown = renderExecutiveSummary({
      ...input([
        {
          id: "f1",
          laneId: "docs",
          type: "documentation",
          severity: "low",
          title: "Docs omit generated migration expectation",
          body: "Docs do not say whether to commit generated files.",
          location: { filePath: "docs/custom-db-migrations.md", line: 20 },
        },
        {
          id: "f2",
          laneId: "docs",
          type: "documentation",
          severity: "low",
          title: "Docs show copyable placeholder shell syntax",
          body: "The bash block contains placeholder syntax.",
          location: { filePath: "docs/custom-db-migrations.md", line: 40 },
        },
      ]),
      issueConsolidations: [
        {
          id: "custom-migration-guide",
          title: "Custom migration guide still has ambiguous or unsafe instructions",
          summary:
            "Both docs findings concern residual quality problems in the same custom migration guide.",
          findingIds: ["f1", "f2"],
        },
      ],
    });

    expect(markdown).toContain(
      "| G1 | — | **Custom migration guide still has ambiguous or unsafe instructions**",
    );
    expect(markdown).toContain("Applies to #1–#2.");
  });
});
