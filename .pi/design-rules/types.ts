export interface Violation {
  ruleId: string;
  file: string;
  line: number;
  message: string;
  /** Optional fix suggestion to present to the editing agent */
  fix?: string;
}

export interface StaticRule {
  kind: "static";
  id: string;
  title: string;
  severity: "error" | "warning";
  category: string;
  /** Runs synchronously against file content. Return empty array if no violations. */
  check: (fileContent: string, filePath: string) => Violation[];
}

export interface ModelRule {
  kind: "model";
  id: string;
  title: string;
  antipattern: string;
  suggestion: string;
  severity: "error" | "warning";
  category: string;
  /** Regex pre-filter. Only invoke the model if this matches the file content. Omit to always check. */
  pattern?: RegExp;
  example?: {
    bad: string;
    good: string;
  };
}

export type DesignRule = StaticRule | ModelRule;

export function isStaticRule(rule: DesignRule): rule is StaticRule {
  return rule.kind === "static";
}

export function isModelRule(rule: DesignRule): rule is ModelRule {
  return rule.kind === "model";
}
