import { describe, expect, test } from "bun:test";
import { formatWorkPacket, resolveSubagentSpec } from "./profiles";

const workPacket = {
  objective: "Implement approved controller bodies.",
  writableFiles: ["app/src/server/controllers/example.ts"],
  contractFiles: ["app/src/server/api/schemas/example.ts"],
  acceptanceCriteria: ["Focused tests pass."],
  nonGoals: ["Changing API contracts."],
};

describe("formatWorkPacket", () => {
  test("makes ownership and acceptance criteria explicit", () => {
    expect(formatWorkPacket(workPacket)).toContain(
      "Contract files (main-owned, read-only):\n- app/src/server/api/schemas/example.ts",
    );
    expect(formatWorkPacket(workPacket)).toContain("Non-goals:\n- Changing API contracts.");
  });

  test("identifies the spawning Pi session in the title", () => {
    expect(formatWorkPacket(workPacket, "pi-session-123")).toStartWith(
      "Work packet [spawned by pi-session-123]",
    );
  });
});

describe("resolveSubagentSpec", () => {
  test("inherits the spawning agent model and thinking level", () => {
    const resolved = resolveSubagentSpec(
      {
        profile: "backend-implementer",
        workPacket,
        prompt: "Use the existing transaction helper.",
      },
      { model: "anthropic/claude-sonnet-4", thinking: "xhigh" },
      "pi-session-123",
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4");
    expect(resolved.thinking).toBe("xhigh");
    expect(resolved.excludeTools).toEqual(["spawn_subagents", "manage_subagents"]);
    expect(resolved.tools).toContain("ask_main_agent");
    expect(resolved.systemPrompt).toContain("Prefer SQL queries over server code");
    expect(resolved.systemPrompt).toContain("Inspect examples under `app/src`");
    expect(resolved.prompt?.startsWith("Work packet [spawned by pi-session-123]")).toBe(true);
    expect(resolved.prompt?.endsWith("Use the existing transaction helper.")).toBe(true);
  });

  test("preserves explicit overrides without enabling worker coordination", () => {
    const resolved = resolveSubagentSpec(
      {
        profile: "frontend-implementer",
        model: "custom/model",
        thinking: "high",
        tools: ["read", "spawn_subagents"],
        excludeTools: ["write"],
        systemPrompt: "Use the supplied design reference.",
      },
      { model: "parent/model", thinking: "medium" },
    );

    expect(resolved.model).toBe("custom/model");
    expect(resolved.thinking).toBe("high");
    expect(resolved.tools).toEqual(["read", "spawn_subagents"]);
    expect(resolved.excludeTools).toEqual(["spawn_subagents", "manage_subagents", "write"]);
    expect(resolved.systemPrompt).toContain("# Frontend implementer");
    expect(resolved.systemPrompt?.endsWith("Use the supplied design reference.")).toBe(true);
  });

  test("allows a provider-only override to clear the inherited model", () => {
    const resolved = resolveSubagentSpec(
      {
        profile: "backend-implementer",
        provider: "custom-provider",
        workPacket,
      },
      { model: "parent/model", thinking: "medium" },
    );

    expect(resolved.provider).toBe("custom-provider");
    expect(resolved.model).toBeUndefined();
  });

  test("configures the unit-test implementation specialist", () => {
    const resolved = resolveSubagentSpec({ profile: "unit-test-implementer", workPacket });

    expect(resolved.tools).toContain("edit");
    expect(resolved.skills).toContain(".pi/skills/testing/SKILL.md");
    expect(resolved.systemPrompt).toContain("Do not test type-system guarantees");
    expect(resolved.systemPrompt).toContain("Do not define test-only types");
    expect(resolved.systemPrompt).toContain("Do not use dynamic imports in tests");
    expect(resolved.systemPrompt).toContain("Never mock another application hook");
    expect(resolved.systemPrompt).toContain("Before writing any helper in a test file");
  });

  test("configures the E2E implementation specialist with browser tools", () => {
    const resolved = resolveSubagentSpec({ profile: "e2e-test-implementer", workPacket });

    expect(resolved.tools).toContain("debug_ui_run");
    expect(resolved.skills).toContain(".pi/skills/playwright-guide/SKILL.md");
    expect(resolved.systemPrompt).toContain(
      "Use configured waits and web assertions instead of sleeps",
    );
  });

  test("keeps test review read-only", () => {
    const resolved = resolveSubagentSpec({ profile: "test-reviewer", workPacket });

    expect(resolved.tools).not.toContain("edit");
    expect(resolved.tools).not.toContain("write");
    expect(resolved.systemPrompt).toContain("This role is read-only");
  });
});
