import { describe, expect, test } from "bun:test";
import {
  extractPolicyHints,
  inferLaneImprovementsFromPolicyHints,
  inferNewLaneProposals,
} from "../pr-review/index";
import type { ReviewComment } from "../pr-review/types";

const comments: ReviewComment[] = [
  {
    id: "c1",
    databaseId: 1,
    body: "NEVER return raw IDs in validation errors.",
    path: "src/api/user.ts",
    line: 42,
    author: { login: "reviewer" },
    url: "https://example.com/c1",
  },
  {
    id: "c2",
    databaseId: 2,
    body: "ALWAYS add a regression test to guard this behavior from recurring.",
    path: "tests/user.test.ts",
    line: 10,
    author: { login: "reviewer" },
    url: "https://example.com/c2",
  },
  {
    id: "c3",
    databaseId: 3,
    body: "ANTIPATTERN: schema constraints drift from API validation.",
    path: "src/server/schema.ts",
    line: 88,
    author: { login: "reviewer" },
    url: "https://example.com/c3",
  },
];

describe("pr review after", () => {
  test("extracts only all-caps policy hints from reviewer language", () => {
    const hints = extractPolicyHints(comments);
    const patterns = hints.map((hint) => hint.pattern);

    expect(patterns).toContain("NEVER");
    expect(patterns).toContain("ALWAYS");
    expect(patterns).toContain("ANTIPATTERN");
    expect(hints.some((hint) => hint.commentId === "c1")).toBeTrue();
  });

  test("ignores lowercase, mixed-case, and retired policy wording", () => {
    const hints = extractPolicyHints([
      {
        id: "ignored",
        databaseId: 4,
        body: "never, Always, Antipattern, must, should, and prevent this behavior are not policy markers.",
        author: { login: "reviewer" },
        url: "https://example.com/ignored",
      },
    ]);

    expect(hints).toEqual([]);
  });

  test("infers practical lane improvements from policy hints", () => {
    const hints = extractPolicyHints(comments);
    const improvements = inferLaneImprovementsFromPolicyHints(hints);
    const laneIds = improvements.map((item) => item.laneId);

    expect(laneIds).toContain("security-api");
    expect(laneIds).toContain("tests");
    expect(laneIds).toContain("data");
  });

  test("proposes regression-guards lane when repeated all-caps policy hints appear", () => {
    const hints = extractPolicyHints(comments);
    const proposals = inferNewLaneProposals(hints);

    expect(proposals.length).toBe(1);
    expect(proposals[0]?.proposedLaneId).toBe("regression-guards");
    expect(proposals[0]?.evidenceCommentIds.length).toBeGreaterThanOrEqual(3);
  });
});
