import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { applicableModelRules, designRules, runStaticChecks } from "../design-rules/index";
import type { ModelRule, Violation } from "../design-rules/types";

const EXTENSION_ERROR_PREFIX = "Design-rule check extension failed";
const MULTI_EDIT_TOOL_NAME = "multi-edit";
const MODEL_TIMEOUT_MS = Number(process.env.PI_DESIGN_RULE_MODEL_TIMEOUT_MS ?? 60_000);
const DELAY_BEFORE_MODEL_MS = 2_000;
const IGNORED_PATH_PREFIXES = [".pi/tmp/upstream/"];

const DESIGN_RULE_MODEL = process.env.PI_DESIGN_RULE_MODEL;
const DESIGN_RULE_SYSTEM_PROMPT = [
  "You are a design-rule checker. You receive a file and a list of rules.",
  "For each rule, check if the file violates the rule.",
  "Return JSON only with this shape:",
  '{ "violations": [ { "ruleId": "rule-id", "file": "path", "line": 1, "message": "description", "fix": "optional suggested fix" } ] }',
  "Use the exact ruleId from the provided rules, not an invented one.",
  'If no rules are violated, return { "violations": [] }.',
  "Do not include markdown fences or prose outside JSON.",
].join("\n");

function isFileMutationToolName(toolName: string): boolean {
  return toolName === "edit" || toolName === "write" || toolName === MULTI_EDIT_TOOL_NAME;
}

function resolveAffectedFile(root: string, filePath: string): string | null {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
}

function isIgnoredPath(root: string, filePath: string): boolean {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  return IGNORED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function changedFilesFromMultiEdit(event: ToolResultEvent): string[] {
  if (event.toolName !== MULTI_EDIT_TOOL_NAME || event.isError) return [];
  const details = event.details;
  if (!details || typeof details !== "object") return [];
  const changedFiles = (details as { changedFiles?: unknown }).changedFiles;
  return Array.isArray(changedFiles)
    ? changedFiles.filter((file): file is string => typeof file === "string")
    : [];
}

function affectedPathsFromEvent(event: ToolResultEvent): string[] {
  if (event.isError) return [];
  if (isEditToolResult(event) || isWriteToolResult(event)) {
    const filePath = event.input.path;
    return typeof filePath === "string" ? [filePath] : [];
  }
  return changedFilesFromMultiEdit(event);
}

function modelRulePrompt(rules: ModelRule[]): string {
  const lines = [
    "## Design rules to check",
    "For each rule, determine if the file below contains a violation. Only flag genuine violations — not every instance of a pattern is a violation.",
    "",
  ];

  for (const rule of rules) {
    lines.push(`### ${rule.id} (severity: ${rule.severity})`);
    lines.push(`Title: ${rule.title}`);
    lines.push(`Antipattern: ${rule.antipattern}`);
    lines.push(`Instead: ${rule.suggestion}`);
    if (rule.example) {
      lines.push("Bad example:", "```", rule.example.bad, "```");
      lines.push("Good example:", "```", rule.example.good, "```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatViolationOutput(
  root: string,
  relativeFile: string,
  violations: Violation[],
): string {
  const lines = [
    `Design rule violations in ${relativeFile}:`,
    "",
    ...violations.map(
      (v) => `- [${v.ruleId}] line ${v.line}: ${v.message}${v.fix ? `\n  Fix: ${v.fix}` : ""}`,
    ),
    "",
  ];

  const hasErrors = violations.some((v) => {
    const rule = designRules.find((r) => r.id === v.ruleId);
    return rule?.severity === "error";
  });

  if (hasErrors) lines.push("These violations must be resolved before proceeding.");
  else lines.push("Please fix these warnings in the next edit.");

  return lines.join("\n");
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [text.trim()];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (text[i] !== "}" || depth === 0) continue;
    depth--;
    if (depth === 0 && start !== -1 && text.slice(start, i + 1).includes('"violations"')) {
      candidates.push(text.slice(start, i + 1).trim());
    }
  }

  return [...new Set(candidates)];
}

function parseModelViolations(
  stdout: string,
  relativeFile: string,
  checkedRules: ModelRule[],
): Violation[] {
  const ruleIds = new Set(checkedRules.map((r) => r.id));
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  for (const candidate of collectJsonCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "violations" in (parsed as Record<string, unknown>)
      ) {
        const raw = (parsed as { violations: unknown }).violations;
        if (!Array.isArray(raw)) continue;
        return raw
          .filter(
            (v): v is Violation =>
              v !== null &&
              typeof v === "object" &&
              typeof (v as Violation).ruleId === "string" &&
              ruleIds.has((v as Violation).ruleId),
          )
          .map((v) => ({
            ruleId: v.ruleId,
            file: relativeFile,
            line: typeof v.line === "number" ? v.line : 1,
            message: typeof v.message === "string" ? v.message : `violates ${v.ruleId}`,
            fix: typeof v.fix === "string" ? v.fix : undefined,
          }));
      }
    } catch {
      // try next candidate
    }
  }

  return [];
}

async function runModelRuleCheck(
  pi: ExtensionAPI,
  root: string,
  file: string,
  rules: ModelRule[],
): Promise<Violation[]> {
  const relativeFile = path.relative(root, file);
  const fileContent = await readFile(file, "utf8");
  const maxChars = 20_000;
  const truncated =
    fileContent.length > maxChars
      ? fileContent.slice(0, maxChars) + `\n\n[File truncated at ${maxChars} chars]`
      : fileContent;

  const prompt = [
    `File: ${relativeFile}`,
    "",
    modelRulePrompt(rules),
    "",
    "## File to check",
    "```",
    truncated,
    "```",
  ].join("\n");

  const model = DESIGN_RULE_MODEL || undefined;
  const args = [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    DESIGN_RULE_SYSTEM_PROMPT,
    prompt,
  ];

  try {
    const result = await pi.exec(process.env.PI_DESIGN_RULE_PI_BIN || "pi", args, {
      cwd: root,
      timeout: MODEL_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      console.error(
        `${EXTENSION_ERROR_PREFIX}: model exited ${result.code}: ${result.stderr || result.stdout}`,
      );
      return [];
    }

    return parseModelViolations(result.stdout, relativeFile, rules);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${EXTENSION_ERROR_PREFIX}: ${message}`);
    return [];
  }
}

async function runDesignChecksForFile(
  pi: ExtensionAPI,
  root: string,
  file: string,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const relativeFile = path.relative(root, file);

  try {
    const fileContent = await readFile(file, "utf8");

    // 1. Static checks (instant, no model)
    violations.push(...runStaticChecks(fileContent, relativeFile));

    // 2. Model rule checks (grep pre-filter → model)
    const matchingRules = applicableModelRules(fileContent);
    if (matchingRules.length > 0) {
      // Short delay to let the editing agent finish its turn before invoking the model
      await new Promise((resolve) => setTimeout(resolve, DELAY_BEFORE_MODEL_MS));
      const modelViolations = await runModelRuleCheck(pi, root, file, matchingRules);
      violations.push(...modelViolations);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.sendMessage({
      customType: "design-rule-checks",
      content: `${EXTENSION_ERROR_PREFIX} for ${relativeFile}: ${message}`,
      display: true,
    });
  }

  return violations;
}

export default function designRuleCheckExtension(pi: ExtensionAPI): void {
  if (!designRules.length) return;

  pi.on("tool_result", async (event, ctx) => {
    if (!isFileMutationToolName(event.toolName)) return;

    const affectedPaths = affectedPathsFromEvent(event);
    if (affectedPaths.length === 0) return;

    for (const filePath of affectedPaths) {
      const affectedFile = resolveAffectedFile(ctx.cwd, filePath);
      if (affectedFile === null || isIgnoredPath(ctx.cwd, affectedFile)) continue;

      const ext = path.extname(affectedFile);
      if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") continue;

      const violations = await runDesignChecksForFile(pi, ctx.cwd, affectedFile);

      if (violations.length > 0) {
        pi.sendMessage(
          {
            customType: "design-rule-checks",
            content: formatViolationOutput(
              ctx.cwd,
              path.relative(ctx.cwd, affectedFile),
              violations,
            ),
            display: true,
            details: { file: path.relative(ctx.cwd, affectedFile), violations },
          },
          { triggerTurn: true },
        );
      }
    }
  });
}
