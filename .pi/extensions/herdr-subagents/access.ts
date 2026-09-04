import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertProjectPath, resolveAccessPath } from "../access-mode/path-policy";
import {
  ACCESS_MODE_ENV,
  ACCESS_PROJECT_ROOT_ENV,
  canAccessHostPaths,
  canExecute,
  getAccessMode,
  type AccessMode,
} from "../access-mode/state";
import { DEFAULT_SUBAGENT_MODEL, type SubagentSpec } from "./schemas";

const ACCESS_MODE_EXTENSION_PATH = fileURLToPath(
  new URL("../access-mode/index.ts", import.meta.url),
);

export function assertSubagentExecuteAccess(mode: AccessMode = getAccessMode()): void {
  if (!canExecute(mode))
    throw new Error(
      `Access mode ${mode} blocks subagents; spawning requires execute mode (3 or 4).`,
    );
}

export async function resolveSubagentCwd(
  contextCwd: string,
  requested: string | undefined,
  mode: AccessMode,
  projectRoot: string,
): Promise<string> {
  const cwd = requested ? resolveAccessPath(contextCwd, requested) : contextCwd;
  await assertProjectPath(projectRoot, cwd, mode);
  return cwd;
}

export function subagentAccessEnvironment(
  mode: AccessMode,
  projectRoot: string,
): Record<string, string> {
  return {
    [ACCESS_MODE_ENV]: String(mode),
    [ACCESS_PROJECT_ROOT_ENV]: projectRoot,
  };
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveProjectPath(root: string, requested: string, mode: AccessMode): string {
  const resolved = path.resolve(root, requested);
  if (canAccessHostPaths(mode)) return resolved;
  const relative = path.relative(canonicalPath(root), canonicalPath(resolved));
  const insideRoot =
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (!insideRoot) throw new Error(`Subagent skill must stay inside ${root}: ${requested}`);
  return resolved;
}

function appendSkillArgs(
  args: string[],
  spec: SubagentSpec,
  projectRoot: string,
  mode: AccessMode,
): void {
  if (spec.skills !== undefined) {
    args.push("--no-skills");
    for (const skill of spec.skills)
      args.push("--skill", resolveProjectPath(projectRoot, skill, mode));
    return;
  }
  if (spec.noSkills) args.push("--no-skills");
}

export function piArgsForSpec(
  spec: SubagentSpec,
  projectRoot: string,
  systemPromptArgument = spec.systemPrompt?.replace(/\s+/g, " ").trim(),
  mode: AccessMode = getAccessMode(),
): string[] {
  const args: string[] = [];
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model || !spec.provider) args.push("--model", spec.model ?? DEFAULT_SUBAGENT_MODEL);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.noTools) args.push("--no-tools");
  if (!spec.noTools && spec.noBuiltinTools) args.push("--no-builtin-tools");
  if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
  if (spec.excludeTools?.length) args.push("--exclude-tools", spec.excludeTools.join(","));
  if (spec.inheritContext === false) args.push("--no-context-files");
  if (spec.noExtensions) {
    args.push("--no-extensions");
    if (!canAccessHostPaths(mode)) args.push("--extension", ACCESS_MODE_EXTENSION_PATH);
  }
  appendSkillArgs(args, spec, projectRoot, mode);
  if (spec.noPromptTemplates) args.push("--no-prompt-templates");
  if (systemPromptArgument) {
    args.push(
      spec.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt",
      systemPromptArgument,
    );
  }
  return args;
}
