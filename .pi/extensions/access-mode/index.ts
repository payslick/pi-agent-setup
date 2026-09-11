import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { assertProjectPath, PROJECT_PATH_ERROR, resolveAccessPath } from "./path-policy";
import {
  accessModeLabel,
  accessModeStatus,
  clearAccessProjectRoot,
  getAccessMode,
  getAccessProjectRoot,
  initializeAccessProjectRoot,
  subscribeToAccessMode,
  type AccessMode,
} from "./state";
import {
  filterToolsForAccessMode,
  isBashActionAllowed,
  isToolAllowed,
  toolCapability,
} from "./tool-policy";

export const ACCESS_MODE_STATUS_KEY = "access-mode";
const PROMPT_START = "<!-- pi-access-mode:start -->";
const PROMPT_END = "<!-- pi-access-mode:end -->";

function modeInstructions(mode: AccessMode): string {
  const capabilities = (() => {
    switch (mode) {
      case 1:
        return "Use direct read/search/index/web tools and Bash self-reported as read. get_data, writes, write-action Bash, browser mutation, screenshots, and subagents are blocked.";
      case 2:
        return "Direct reads, get_data, file writes, and Bash self-reported as read or write are allowed. Other process/browser execution and subagents are blocked.";
      case 3:
        return "Known write, execute, read-many-files-lines, search, index, web, and log tools are allowed, but parent read is blocked; use get_data when requested data must be located through searching or reasoning. Structured paths and explicit shell path arguments are project-scoped.";
      case 4:
        return "All registered tools and host filesystem paths are allowed, subject to OS permissions and non-path safety guards.";
    }
  })();
  const pathPolicy =
    mode === 4
      ? "Absolute paths, home paths, parent traversal, and per-command shell directory changes are allowed."
      : "Structured filesystem paths are restricted to the Pi project root. Bash and subprocess guards are policy checks, not an OS sandbox.";
  return `${PROMPT_START}
Access mode ${mode}: ${accessModeLabel(mode)}.
- ${capabilities}
- ${pathPolicy}
- Only the user can change access mode through Pi prefix keys.
${PROMPT_END}`;
}

export function appendAccessModeInstructions(systemPrompt: string, mode = getAccessMode()): string {
  const instructions = modeInstructions(mode);
  const start = systemPrompt.indexOf(PROMPT_START);
  const end = systemPrompt.indexOf(PROMPT_END);
  if (start >= 0 && end >= start)
    return `${systemPrompt.slice(0, start)}${instructions}${systemPrompt.slice(end + PROMPT_END.length)}`;
  return `${systemPrompt}\n\n${instructions}`;
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

export function enforceAccessModeTools(
  pi: ExtensionAPI,
  mode = getAccessMode(),
  configuredTools: readonly string[] = pi.getActiveTools(),
): void {
  const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const allowed = filterToolsForAccessMode(
    configuredTools.filter((toolName) => toolName !== "edit" && availableTools.has(toolName)),
    mode,
  );
  if (!sameTools(pi.getActiveTools(), allowed)) pi.setActiveTools(allowed);
}

function pathInputs(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown>;
  switch (event.toolName) {
    case "read":
    case "edit":
    case "write":
      return typeof input.path === "string" ? [input.path] : [];
    case "grep":
    case "find":
    case "ls":
      return typeof input.path === "string" ? [input.path] : ["."];
    case "project_index_status":
    case "project_index_refresh":
    case "project_index_search":
      return typeof input.root === "string" ? [input.root] : ["."];
    case "project_index_impact":
      return [
        ...(typeof input.root === "string" ? [input.root] : ["."]),
        ...(typeof input.file === "string" ? [input.file] : []),
      ];
    case "multi-edit": {
      const files = Array.isArray(input.files) ? input.files : [];
      return files.flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const filePath = (file as { path?: unknown }).path;
        return typeof filePath === "string" ? [filePath] : [];
      });
    }
    default:
      return [];
  }
}

async function accessModeBlock(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
  const mode = getAccessMode();
  if (
    !isToolAllowed(event.toolName, mode) ||
    (event.toolName === "bash" &&
      !isBashActionAllowed((event.input as { action?: unknown }).action, mode)) ||
    (event.toolName === "debug_ui_server_logs" &&
      mode < 3 &&
      (event.input as { clear?: unknown }).clear === true)
  ) {
    const capability = toolCapability(event.toolName);
    return {
      block: true,
      reason: `Access mode ${mode} (${accessModeLabel(mode)}) blocks ${capability} tool ${event.toolName}. Use Ctrl+S then Tab to change mode.`,
    };
  }

  if (mode === 4) return undefined;
  try {
    const projectRoot = getAccessProjectRoot(ctx.cwd);
    for (const filePath of pathInputs(event))
      await assertProjectPath(projectRoot, resolveAccessPath(ctx.cwd, filePath), mode);
  } catch {
    return {
      block: true,
      reason: `${PROJECT_PATH_ERROR} Mode ${mode} is project-scoped; mode 4 enables host paths.`,
    };
  }
  return undefined;
}

export default function accessModeExtension(pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | undefined;
  let configuredTools: string[] | undefined;

  const apply = (ctx: ExtensionContext) => {
    currentContext = ctx;
    configuredTools ??= pi.getActiveTools();
    initializeAccessProjectRoot(ctx.cwd);
    enforceAccessModeTools(pi, getAccessMode(), configuredTools);
    if (ctx.hasUI) ctx.ui.setStatus(ACCESS_MODE_STATUS_KEY, accessModeStatus());
  };

  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = subscribeToAccessMode(() => {
      if (currentContext) apply(currentContext);
    });
    apply(ctx);
  });
  pi.on("session_tree", (_event, ctx) => apply(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    apply(ctx);
    return { systemPrompt: appendAccessModeInstructions(event.systemPrompt) };
  });
  pi.on("tool_call", accessModeBlock);
  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    currentContext = undefined;
    clearAccessProjectRoot();
    if (configuredTools) pi.setActiveTools(configuredTools);
    if (ctx.hasUI) ctx.ui.setStatus(ACCESS_MODE_STATUS_KEY, undefined);
  });
}
