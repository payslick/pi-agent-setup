import type { StaticRule, Violation } from "./types";

export const noFilesOver1000: StaticRule = {
  kind: "static",
  id: "no-files-over-1000-lines",
  title: "Files must not exceed 1000 lines",
  severity: "error",
  category: "code-quality",
  check(fileContent, filePath): Violation[] {
    const count = fileContent.split("\n").length;
    return count > 1000
      ? [
          {
            ruleId: "no-files-over-1000-lines",
            file: filePath,
            line: 1,
            message: `file is ${count} lines (max 1000)`,
          },
        ]
      : [];
  },
};
