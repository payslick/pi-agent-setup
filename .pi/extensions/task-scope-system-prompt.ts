import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TASK_SCOPE_HEADING = "Task scope discipline (strict opt-in):";
const TASK_SCOPE_SYSTEM_PROMPT = `${TASK_SCOPE_HEADING}
- Focus only on the explicit task and its acceptance criteria.
- Edit, investigate, and validate only files and behavior that directly affect the task at hand.
- Do not opportunistically refactor, reformat, rename, update, clean up, or improve unrelated code or documentation.
- Do not spend effort analyzing unrelated improvement opportunities while the requested task is in progress.
- Treat incidental documentation or style improvements, including migration-document cleanup during migration work, as separate opt-in tasks unless they materially affect the requested result.
- Complete the original task first. If a concrete unrelated opportunity is still worth surfacing afterward, ask the user whether they want a separate change or investigation; do not include it by default.`;

export default function taskScopeSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(TASK_SCOPE_HEADING)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${TASK_SCOPE_SYSTEM_PROMPT}` };
  });
}
