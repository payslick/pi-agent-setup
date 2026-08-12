import { readFileSync } from "node:fs";
import { DEFAULT_SUBAGENT_MODEL, type SubagentSpec, type SubagentWorkPacket } from "./schemas";

export interface SubagentProfile {
  model: string;
  thinking: NonNullable<SubagentSpec["thinking"]>;
  tools: string[];
  excludeTools: string[];
  skills: string[];
  noPromptTemplates: boolean;
  systemPrompt: string;
}

type SubagentProfileName = NonNullable<SubagentSpec["profile"]>;

const MODEL = DEFAULT_SUBAGENT_MODEL;
const THINKING = "high";
const IMPLEMENTATION_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_search",
  "project_index_impact",
  "bash",
  "edit",
  "multi-edit",
  "write",
  "ask_main_agent",
];
const FRONTEND_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_search",
  "project_index_impact",
  "bash",
  "edit",
  "multi-edit",
  "write",
  "debug_ui_start",
  "debug_ui_run",
  "debug_ui_close",
  "debug_ui_server_logs",
  "take_screenshot",
  "ask_main_agent",
];
const REVIEW_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_search",
  "project_index_impact",
  "bash",
  "ask_main_agent",
];
const EXCLUDED_COORDINATION_TOOLS = ["spawn_subagents", "subagent_panes"];

const readProfilePrompt = (filename: string) =>
  readFileSync(new URL(`../../agents/${filename}`, import.meta.url), "utf8").trim();

const FRONTEND_PROMPT = readProfilePrompt("frontend-implementer.md");
const BACKEND_PROMPT = readProfilePrompt("backend-implementer.md");
const UNIT_TEST_PROMPT = readProfilePrompt("unit-test-implementer.md");
const E2E_TEST_PROMPT = readProfilePrompt("e2e-test-implementer.md");
const REVIEW_PROMPT = readProfilePrompt("test-reviewer.md");

export const SUBAGENT_PROFILES = {
  "frontend-implementer": {
    model: MODEL,
    thinking: THINKING,
    tools: FRONTEND_TOOLS,
    excludeTools: EXCLUDED_COORDINATION_TOOLS,
    skills: [
      ".pi/skills/code-index/SKILL.md",
      ".pi/skills/debug-ui/SKILL.md",
      ".pi/skills/testing/SKILL.md",
    ],
    noPromptTemplates: true,
    systemPrompt: FRONTEND_PROMPT,
  },
  "backend-implementer": {
    model: MODEL,
    thinking: THINKING,
    tools: IMPLEMENTATION_TOOLS,
    excludeTools: EXCLUDED_COORDINATION_TOOLS,
    skills: [".pi/skills/code-index/SKILL.md", ".pi/skills/testing/SKILL.md"],
    noPromptTemplates: true,
    systemPrompt: BACKEND_PROMPT,
  },
  "unit-test-implementer": {
    model: MODEL,
    thinking: THINKING,
    tools: IMPLEMENTATION_TOOLS,
    excludeTools: EXCLUDED_COORDINATION_TOOLS,
    skills: [".pi/skills/code-index/SKILL.md", ".pi/skills/testing/SKILL.md"],
    noPromptTemplates: true,
    systemPrompt: UNIT_TEST_PROMPT,
  },
  "e2e-test-implementer": {
    model: MODEL,
    thinking: THINKING,
    tools: FRONTEND_TOOLS,
    excludeTools: EXCLUDED_COORDINATION_TOOLS,
    skills: [
      ".pi/skills/code-index/SKILL.md",
      ".pi/skills/testing/SKILL.md",
      ".pi/skills/debug-ui/SKILL.md",
      ".pi/skills/playwright-guide/SKILL.md",
    ],
    noPromptTemplates: true,
    systemPrompt: E2E_TEST_PROMPT,
  },
  "test-reviewer": {
    model: MODEL,
    thinking: THINKING,
    tools: REVIEW_TOOLS,
    excludeTools: EXCLUDED_COORDINATION_TOOLS,
    skills: [
      ".pi/skills/code-index/SKILL.md",
      ".pi/skills/testing/SKILL.md",
      ".pi/skills/review/SKILL.md",
    ],
    noPromptTemplates: true,
    systemPrompt: REVIEW_PROMPT,
  },
} satisfies Record<SubagentProfileName, SubagentProfile>;

const formatList = (values: string[] | undefined, empty: string) =>
  values?.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;

const joinPromptParts = (...parts: Array<string | undefined>) =>
  parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

const mergeUnique = (...groups: Array<string[] | undefined>) => [
  ...new Set(groups.flatMap((group) => group ?? [])),
];

const definedSpecValues = (spec: SubagentSpec): SubagentSpec =>
  Object.fromEntries(
    Object.entries(spec).filter(([, value]) => value !== undefined),
  ) as SubagentSpec;

export const formatWorkPacket = (packet: SubagentWorkPacket): string =>
  [
    "Work packet",
    `Objective:\n${packet.objective}`,
    `Writable files:\n${formatList(packet.writableFiles, "none; this is read-only work")}`,
    `Contract files (main-owned, read-only):\n${formatList(packet.contractFiles, "none")}`,
    `Acceptance criteria:\n${formatList(packet.acceptanceCriteria, "none")}`,
    `Non-goals:\n${formatList(packet.nonGoals, "none")}`,
  ].join("\n\n");

export const resolveSubagentSpec = (spec: SubagentSpec): SubagentSpec => {
  const profile = spec.profile ? SUBAGENT_PROFILES[spec.profile] : undefined;
  const explicit = definedSpecValues(spec);
  const prompt = joinPromptParts(spec.workPacket && formatWorkPacket(spec.workPacket), spec.prompt);
  const systemPrompt = joinPromptParts(profile?.systemPrompt, spec.systemPrompt);
  const excludeTools = mergeUnique(profile?.excludeTools, spec.excludeTools);
  const model =
    spec.provider && spec.model === undefined ? undefined : (spec.model ?? profile?.model);

  return {
    ...profile,
    ...explicit,
    model,
    excludeTools: excludeTools.length ? excludeTools : undefined,
    prompt: prompt || undefined,
    systemPrompt: systemPrompt || undefined,
  };
};
