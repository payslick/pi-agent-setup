import { describe, expect, test } from "bun:test";
import { parseAgentJson } from "../pr-review/index";

describe("pr review agent JSON parsing", () => {
  test("extracts JSON from fenced output", () => {
    const parsed = parseAgentJson(
      ["I found one issue:", "```json", '{"findings":[{"title":"Issue"}]}', "```"].join("\n"),
    );

    expect(parsed.findings).toEqual([{ title: "Issue" }]);
  });

  test("extracts final assistant text from pi json-mode output", () => {
    const event = {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "review" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: '{"findings":[]}' }],
        },
      ],
    };

    expect(parseAgentJson(JSON.stringify(event)).findings).toEqual([]);
  });

  test("preserves structured code and multi-line locations", () => {
    const parsed = parseAgentJson(
      JSON.stringify({
        findings: [
          {
            title: "Use the active-settlement predicate",
            body: "This excludes completed settlements.",
            path: "src/settlement.ts",
            startLine: 10,
            endLine: 14,
            replacement: "return activeSettlementWhere(employeeId);",
            example: { language: "ts", code: "const active = rows.filter(isActive);" },
          },
        ],
      }),
    );

    expect(parsed.findings).toEqual([
      {
        title: "Use the active-settlement predicate",
        body: "This excludes completed settlements.",
        path: "src/settlement.ts",
        startLine: 10,
        endLine: 14,
        replacement: "return activeSettlementWhere(employeeId);",
        example: { language: "ts", code: "const active = rows.filter(isActive);" },
      },
    ]);
  });

  test("error includes an output snippet", () => {
    expect(() => parseAgentJson("No issues found.")).toThrow(
      "Review agent did not return parseable JSON. Output starts with:",
    );
  });
});
