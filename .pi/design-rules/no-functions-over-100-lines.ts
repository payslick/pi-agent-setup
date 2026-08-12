import type { StaticRule, Violation } from "./types";

export const noFunctionsOver100: StaticRule = {
  kind: "static",
  id: "no-functions-over-100-lines",
  title: "Functions must not exceed 100 lines",
  severity: "warning",
  category: "code-quality",
  check(fileContent, filePath): Violation[] {
    const violations: Violation[] = [];
    const lines = fileContent.split("\n");
    let inFunction: { start: number; name: string } | null = null;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      if (inFunction) {
        // Track brace depth within the function
        const openCount = (trimmed.match(/\{/g) ?? []).length;
        const closeCount = (trimmed.match(/\}/g) ?? []).length;
        depth += openCount - closeCount;

        if (depth <= 0) {
          const length = i + 1 - inFunction.start + 1;
          if (length > 100) {
            violations.push({
              ruleId: "no-functions-over-100-lines",
              file: filePath,
              line: inFunction.start,
              message: `function '${inFunction.name}' is ${length} lines (max 100)`,
            });
          }
          inFunction = null;
          depth = 0;
        }
        continue;
      }

      // Detect function start
      const isFunctionStart =
        /\b(function\s+\w+|=>\s*\{|:\s*function\s*\(|\b(method|get|set)\b)/.test(line) &&
        line.includes("{");

      if (isFunctionStart) {
        const name =
          line
            .match(/function\s+(\w+)|(\w+)\s*[:=].*=>|(\w+)\s*\([^)]*\)\s*\{/)
            ?.slice(1)
            .find(Boolean) ?? "unknown";
        // Count braces on this opening line
        const openCount = (trimmed.match(/\{/g) ?? []).length;
        const closeCount = (trimmed.match(/\}/g) ?? []).length;
        inFunction = { start: i + 1, name };
        depth = openCount - closeCount;

        // Single-line function body
        if (depth <= 0) {
          inFunction = null;
          depth = 0;
        }
      }
    }

    return violations;
  },
};
