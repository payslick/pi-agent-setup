import { describe, expect, test } from "bun:test";
import { sessionIdFromPath } from "./session";

describe("Pi session correlation", () => {
  test("extracts the agent session ID from a persisted Pi transcript path", () => {
    expect(
      sessionIdFromPath(
        "/Users/example/.pi/agent/sessions/project/2026-09-11T09-17-37-885Z_01a08fc2-1ad5-720d-bb6e-562cedeb428e.jsonl",
      ),
    ).toBe("01a08fc2-1ad5-720d-bb6e-562cedeb428e");
    expect(sessionIdFromPath("/sessions/custom-name.jsonl")).toBeUndefined();
  });
});
