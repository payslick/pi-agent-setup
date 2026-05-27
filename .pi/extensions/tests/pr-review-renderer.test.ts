import { describe, expect, test } from "bun:test";
import { mergeRenderedIssueGroupRows } from "../pr-review/index";

describe("pr review rendered issue table", () => {
  test("merges and reflows only group rows across the remaining table width", () => {
    const lines = [
      "┌────┬──────────┬────────────┐",
      "│ #  │ File     │ Issue      │",
      "├────┼──────────┼────────────┤",
      "│ G1 │ —        │ Group:     │",
      "│    │          │ Custom     │",
      "│    │          │ migration  │",
      "├────┼──────────┼────────────┤",
      "│ 1  │ file.ts  │ 🐛 issue   │",
      "└────┴──────────┴────────────┘",
    ];

    const merged = mergeRenderedIssueGroupRows(lines);

    expect(merged[3]).toMatch(/^│ G1 │ Group: Custom\s+│$/);
    expect(merged[4]).toMatch(/^│    │ migration\s+│$/);
    expect(merged[3]).not.toContain("—");
    expect(merged).not.toContain("│    │          │ Custom     │");
    expect(merged).toContain("│ 1  │ file.ts  │ 🐛 issue   │");
  });
});
