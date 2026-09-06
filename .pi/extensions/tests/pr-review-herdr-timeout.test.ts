import { describe, expect, test } from "bun:test";

import {
  latestSessionMessageTimestamp,
  reviewAgentCompletionDeadline,
} from "../pr-review/herdr-agent";

describe("PR review Herdr timeout activity", () => {
  test("reads the latest persisted message timestamp", () => {
    const content = [
      { type: "session", timestamp: "2026-09-04T10:05:00.000Z" },
      { type: "message", timestamp: "2026-09-04T10:01:00.000Z", message: { role: "user" } },
      { type: "message", timestamp: "2026-09-04T10:04:00.000Z", message: { role: "assistant" } },
      { type: "message", timestamp: "invalid", message: { role: "toolResult" } },
    ]
      .map(JSON.stringify)
      .join("\n");

    expect(latestSessionMessageTimestamp(content)).toBe(
      Date.parse("2026-09-04T10:04:00.000Z"),
    );
  });

  test("uses the later of the 45-minute baseline and ten-minute activity grace", () => {
    const startedAt = 1_000;
    const timeout = 45 * 60_000;
    const inactivityTimeout = 10 * 60_000;

    expect(reviewAgentCompletionDeadline(startedAt, timeout, inactivityTimeout, undefined)).toBe(
      startedAt + timeout,
    );
    expect(
      reviewAgentCompletionDeadline(
        startedAt,
        timeout,
        inactivityTimeout,
        startedAt + 44 * 60_000,
      ),
    ).toBe(startedAt + 54 * 60_000);
  });
});
