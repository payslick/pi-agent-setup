import type { StaticRule, Violation } from "./types";

export const noIfElseIfChain: StaticRule = {
  kind: "static",
  id: "no-if-else-if-chain",
  title: "Avoid if-else-if chains",
  severity: "error",
  category: "code-quality",
  check(fileContent, filePath): Violation[] {
    return fileContent.split("\n").flatMap((line, index) => {
      if (!/\belse\s+if\b/.test(line)) return [];
      return [
        {
          ruleId: "no-if-else-if-chain",
          file: filePath,
          line: index + 1,
          message:
            "Do not use chained if/else conditionals. Extract a named helper with guard-clause returns.",
          fix: "Use a named helper function that returns early for each condition instead of chaining condition branches.",
        },
      ];
    });
  },
};
