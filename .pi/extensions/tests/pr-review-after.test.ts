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
    body: "We should never return raw IDs in validation errors.",
    path: "src/api/user.ts",
    line: 42,
    author: { login: "reviewer" },
    url: "https://example.com/c1",
  },
  {
    id: "c2",
    databaseId: 2,
    body: "Always add a regression test to prevent this behavior from recurring.",
    path: "tests/user.test.ts",
    line: 10,
    author: { login: "reviewer" },
    url: "https://example.com/c2",
  },
  {
    id: "c3",
    databaseId: 3,
    body: "Must keep schema constraints aligned with API validation to prevent this behavior.",
    path: "src/server/schema.ts",
    line: 88,
    author: { login: "reviewer" },
    url: "https://example.com/c3",
  },
];

describe("pr review after", () => {
  test("extracts policy hints from reviewer language", () => {
    const hints = extractPolicyHints(comments);
    const patterns = hints.map((hint) => hint.pattern);

    expect(patterns).toContain("never");
    expect(patterns).toContain("always");
    expect(patterns).toContain("prevent");
    expect(hints.some((hint) => hint.commentId === "c1")).toBeTrue();
  });

  test("infers practical lane improvements from policy hints", () => {
    const hints = extractPolicyHints(comments);
    const improvements = inferLaneImprovementsFromPolicyHints(hints);
    const laneIds = improvements.map((item) => item.laneId);

    expect(laneIds).toContain("security-api");
    expect(laneIds).toContain("tests");
    expect(laneIds).toContain("data");
  });

  test("proposes regression-guards lane when repeated prevention hints appear", () => {
    const hints = extractPolicyHints(comments);
    const proposals = inferNewLaneProposals(hints);

    expect(proposals.length).toBe(1);
    expect(proposals[0]?.proposedLaneId).toBe("regression-guards");
    expect(proposals[0]?.evidenceCommentIds.length).toBeGreaterThanOrEqual(3);
  });
});
