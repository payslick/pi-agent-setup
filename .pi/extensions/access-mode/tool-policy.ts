import type { AccessMode } from "./state";
import { getAccessMode } from "./state";

export type ToolCapability = "read" | "write" | "execute" | "unrestricted";

export const DIRECT_READ_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read-many-files-lines",
  "project_index_status",
  "project_index_search",
  "project_index_impact",
  "web_search",
  "web_extract",
  "web_research",
  "web_research_status",
  "debug_ui_server_logs",
  "ask_main_agent",
  "bash",
]);

export const WRITE_TOOL_NAMES = new Set(["edit", "write", "multi-edit", "project_index_refresh"]);

export const EXECUTE_TOOL_NAMES = new Set([
  "debug_ui_start",
  "debug_ui_run",
  "debug_ui_close",
  "take_screenshot",
  "spawn_subagents",
  "manage_subagents",
]);

export function toolCapability(toolName: string): ToolCapability {
  if (DIRECT_READ_TOOL_NAMES.has(toolName)) return "read";
  if (WRITE_TOOL_NAMES.has(toolName)) return "write";
  if (EXECUTE_TOOL_NAMES.has(toolName)) return "execute";
  if (toolName === "get_data") return "read";
  return "unrestricted";
}

export function isBashActionAllowed(action: unknown, mode: AccessMode = getAccessMode()): boolean {
  return action === "read" || (action === "write" && mode >= 2);
}

export function isToolAllowed(toolName: string, mode: AccessMode = getAccessMode()): boolean {
  if (mode === 4) return true;
  if (toolName === "get_data") return mode >= 2;

  switch (toolCapability(toolName)) {
    case "read":
      return true;
    case "write":
      return mode >= 2;
    case "execute":
      return mode >= 3;
    case "unrestricted":
      return false;
  }
}

export function filterToolsForAccessMode(
  toolNames: readonly string[],
  mode: AccessMode = getAccessMode(),
): string[] {
  return toolNames.filter((toolName) => isToolAllowed(toolName, mode));
}
