import type { StaticRule, Violation } from "./types";

const jsxIifePatterns = [/{\s*\(\s*\(\s*\)\s*=>/, /{\s*\(\s*function\b/];

function isJsxFile(filePath: string): boolean {
  return /\.[jt]sx$/.test(filePath);
}

function hasJsxIife(line: string): boolean {
  return jsxIifePatterns.some((pattern) => pattern.test(line));
}

export const noJsxIife: StaticRule = {
  kind: "static",
  id: "no-jsx-iife",
  title: "Do not use IIFEs inside JSX render expressions",
  severity: "error",
  category: "code-quality",
  check: (fileContent: string, filePath: string): Violation[] => {
    if (!isJsxFile(filePath)) return [];

    return fileContent.split("\n").flatMap((line, index) =>
      hasJsxIife(line)
        ? [
            {
              ruleId: "no-jsx-iife",
              file: filePath,
              line: index + 1,
              message:
                "Do not use an IIFE inside JSX. Extract the render logic to a named helper function or component.",
              fix: "Create a named helper function/component and render its result instead of `{(() => ...)()}`.",
            },
          ]
        : [],
    );
  },
};
