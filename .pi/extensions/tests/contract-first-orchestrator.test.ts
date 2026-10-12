import { describe, expect, test } from "bun:test";
import { appendContractFirstOrchestration } from "../contract-first-orchestrator";

describe("contract-first orchestration prompt", () => {
  test("requires the main thread to define APIs and complete active public contract tests", () => {
    const prompt = appendContractFirstOrchestration("Base prompt", false);

    expect(prompt).toContain("# Shared test quality policy");
    expect(prompt).toContain("complete active unit or integration tests");
    expect(prompt).toContain("Tests must not be skipped or marked todo");
    expect(prompt).toContain("public API surface");
    expect(prompt).toContain("logical data schema");
    expect(prompt).toContain("expected red failures");
  });

  test("keeps Herdr orchestration centralized while allowing internal module proposals", () => {
    const prompt = appendContractFirstOrchestration("Base prompt", false);

    expect(prompt).toContain("Only you use Herdr to launch and manage workers");
    expect(prompt).toContain("internal module");
    expect(prompt).toContain("complete active unit tests");
    expect(prompt).toContain("durable `needs-main` handoff");
    expect(prompt).toContain("launch a separate implementer through Herdr");
  });

  test("requires durable packets, checkpoints, handoffs, and session-correlated logs", () => {
    const prompt = appendContractFirstOrchestration("Base prompt", false);

    expect(prompt).toContain("work-packet.json");
    expect(prompt).toContain("submit_checkpoint");
    expect(prompt).toContain("submit_handoff");
    expect(prompt).toContain("main session ID");
    expect(prompt).toContain("restart");
  });

  test("does not inject main-thread orchestration into a worker and is idempotent", () => {
    expect(appendContractFirstOrchestration("Base prompt", true)).toBe("Base prompt");

    const first = appendContractFirstOrchestration("Base prompt", false);
    expect(appendContractFirstOrchestration(first, false)).toBe(first);
  });
});
