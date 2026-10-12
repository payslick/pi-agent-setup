import { describe, expect, test } from "bun:test";
import { parseManageCommand, parseSpawnArgs } from "./commands";

describe("Herdr command parsing", () => {
  test("turns plain text and structured JSON into Herdr spawn requests", () => {
    expect(parseSpawnArgs("Investigate payroll")).toEqual({
      agents: [{ prompt: "Investigate payroll" }],
    });
    expect(
      parseSpawnArgs(
        JSON.stringify({
          profile: "backend-implementer",
          workPacket: {
            objective: "Implement payroll.",
            writableFiles: ["app/src/payroll.ts"],
            acceptanceCriteria: ["Tests pass."],
          },
        }),
      ),
    ).toMatchObject({ agents: [{ profile: "backend-implementer" }] });
    expect(parseSpawnArgs("  ")).toBeNull();
  });

  test("supports main-thread restart and prompt management commands", () => {
    expect(parseManageCommand("restart backend-payroll")).toEqual({
      action: "restart",
      id: "backend-payroll",
      lines: undefined,
    });
    expect(parseManageCommand("prompt backend-payroll Continue from the checkpoint")).toEqual({
      action: "prompt",
      id: "backend-payroll",
      message: "Continue from the checkpoint",
    });
    expect(() => parseManageCommand("spawn backend-payroll")).toThrow("Usage: /agents");
  });
});
