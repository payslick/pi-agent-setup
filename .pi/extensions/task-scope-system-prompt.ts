import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TASK_SCOPE_SYSTEM_PROMPT = `Task scope discipline:
- Only edit files that are directly relevant to the current user request.
- Do not opportunistically refactor, reformat, rename, update, or clean up unrelated code.
- If you notice unrelated problems, mention them separately instead of changing them unless the user asks.`;

export default function taskScopeSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes("Task scope discipline:")) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${TASK_SCOPE_SYSTEM_PROMPT}` };
  });
}
