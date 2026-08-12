import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODE_STYLE_HEADING = "# Code Style Guide";
const CODE_STYLE_SYSTEM_PROMPT = readFileSync(
  new URL("../skills/feature/code-style.md", import.meta.url),
  "utf8",
).trim();

export default function codeStyleSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(CODE_STYLE_HEADING)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${CODE_STYLE_SYSTEM_PROMPT}` };
  });
}
