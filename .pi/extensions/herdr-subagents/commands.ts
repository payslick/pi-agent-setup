import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManageSubagentsInput, SpawnSubagentsInput, SubagentSpec } from "./schemas";

export function parseSpawnArgs(args: string): SpawnSubagentsInput | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
    return { agents: [{ prompt: trimmed }] };
  const parsed = JSON.parse(trimmed) as SpawnSubagentsInput | SubagentSpec[] | SubagentSpec;
  if (Array.isArray(parsed)) return { agents: parsed };
  if ("agents" in parsed) return parsed;
  return { agents: [parsed] };
}

export async function promptForSubagent(
  ctx: ExtensionContext,
): Promise<SpawnSubagentsInput | null> {
  if (!ctx.hasUI) return null;
  const prompt = await ctx.ui.editor("Subagent task (optional; blank starts idle)", "");
  const focus = await ctx.ui.confirm("Focus new Herdr tab?", "No keeps the current tab focused.");
  return { agents: [{ prompt: prompt?.trim() || undefined, focus }] };
}

export function parseManageCommand(args: string): ManageSubagentsInput {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const [action, id, third, ...rest] = trimmed.split(/\s+/);
  if (action === "prompt")
    return { action, id, message: [third, ...rest].filter(Boolean).join(" ") };
  if (!["list", "read", "focus", "abort", "close", "restart"].includes(action))
    throw new Error(
      "Usage: /agents [list|read <id> [lines]|prompt <id> <message>|focus <id>|abort <id>|close <id>|restart <id>]",
    );
  return {
    action: action as ManageSubagentsInput["action"],
    id,
    lines: third ? Number(third) : undefined,
  };
}
