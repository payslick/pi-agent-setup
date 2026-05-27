import type { DesignRule, ModelRule, StaticRule, Violation } from "./types";

import { noFilesOver1000 } from "./no-files-over-1000-lines";
import { noFunctionsOver100 } from "./no-functions-over-100-lines";
import { noIfElseIfChain } from "./no-if-else-if-chain";
import { noJsxIife } from "./no-jsx-iife";

/** All design rules in the order they were registered. */
export const designRules: readonly DesignRule[] = [
  noJsxIife,
  noIfElseIfChain,
  noFunctionsOver100,
  noFilesOver1000,
];

export const staticRules: readonly StaticRule[] = designRules.filter(
  (rule): rule is StaticRule => rule.kind === "static",
);

export const modelRules: readonly ModelRule[] = designRules.filter(
  (rule): rule is ModelRule => rule.kind === "model",
);

/** Find all static rules whose patterns (if any) match the file content. */
export function applicableModelRules(fileContent: string): ModelRule[] {
  return modelRules.filter((rule) => !rule.pattern || rule.pattern.test(fileContent));
}

/** Run all static checks against file content. Always fast, no model needed. */
export function runStaticChecks(fileContent: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  for (const rule of staticRules) {
    violations.push(...rule.check(fileContent, filePath));
  }
  return violations;
}

/** Build the design-rules prompt section for inclusion in lane review prompts. */
export function designRulesPrompt(): string {
  if (!designRules.length) return "";

  const lines = [
    "",
    "## Design rules to enforce",
    "These are project-level rules the review should flag violations of:",
    "",
  ];

  for (const rule of designRules) {
    if (rule.kind === "static") {
      lines.push(`- **[${rule.severity}] ${rule.id}**: ${rule.title}`);
    } else {
      lines.push(`- **[${rule.severity}] ${rule.id}**: ${rule.title}`);
      lines.push(`  Antipattern: ${rule.antipattern}`);
      lines.push(`  Instead: ${rule.suggestion}`);
    }
  }

  return lines.join("\n");
}
