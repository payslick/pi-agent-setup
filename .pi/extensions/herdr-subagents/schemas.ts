import { StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";

export const MAX_SUBAGENTS_PER_CALL = 15;
export const DEFAULT_READ_LINES = 120;
export const DEFAULT_SUBAGENT_MODEL =
  process.env.PI_SUBAGENT_DEFAULT_MODEL ?? "openai-codex/gpt-5.6-sol";
export const IMPLEMENTATION_PROFILE_NAMES = [
  "frontend-implementer",
  "backend-implementer",
  "database-implementer",
  "builder-implementer",
  "unit-test-implementer",
  "e2e-test-implementer",
] as const;

export const SUBAGENT_PROFILE_NAMES = [
  ...IMPLEMENTATION_PROFILE_NAMES,
  "test-reviewer",
] as const;

const thinkingSchema = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  {
    description: "Thinking level for the subagent. Defaults to the spawning agent's level.",
  },
);

const expectedFailingTestSchema = Type.Object({
  path: Type.String({ description: "Repository-relative contract test file." }),
  title: Type.String({ description: "Exact active test title expected to fail in the red phase." }),
  expectedReason: Type.String({ description: "Why the test is expected to fail before implementation." }),
  outputPattern: Type.String({
    description: "Exact output text that proves the test failed for the declared reason.",
  }),
});

const frozenTestStructureSchema = Type.Object({
  path: Type.String({ description: "Repository-relative test file whose structure is main-owned." }),
  orderedTitles: Type.Array(Type.String(), {
    minItems: 1,
    description: "Suite, test, and step titles in required source order.",
  }),
  requiredText: Type.Optional(
    Type.Array(Type.String(), {
      description: "Known navigation, API calls, or behavioral contract text that must remain.",
    }),
  ),
});

const workPacketSchema = Type.Object({
  taskId: Type.Optional(
    Type.String({ description: "Stable logical task identifier reused across restart attempts." }),
  ),
  objective: Type.String({ description: "Bounded implementation or review objective." }),
  writableFiles: Type.Array(Type.String(), {
    description: "Exclusive file ownership for this worker. Empty for read-only work.",
  }),
  contractFiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Architect-owned contracts and active tests that the worker may read but not modify.",
    }),
  ),
  acceptanceCriteria: Type.Array(Type.String(), {
    minItems: 1,
    description: "Observable conditions required for completion.",
  }),
  nonGoals: Type.Optional(Type.Array(Type.String(), { description: "Explicitly excluded work." })),
  validationPhase: Type.Optional(
    StringEnum(["red", "green"] as const, {
      description: "Red expects declared contract failures; green requires the assigned tests to pass.",
    }),
  ),
  expectedFailingTests: Type.Optional(Type.Array(expectedFailingTestSchema)),
  frozenTestStructure: Type.Optional(Type.Array(frozenTestStructureSchema)),
});

const subagentSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Optional human-readable subagent name." })),
  profile: Type.Optional(
    StringEnum(SUBAGENT_PROFILE_NAMES, {
      description: "Reusable domain role with tools, skills, and system instructions.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Additional task context sent after the structured work packet. Omit to start idle when no packet is provided.",
    }),
  ),
  workPacket: Type.Optional(workPacketSchema),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Subagent system instructions. By default these are appended to Pi's normal system prompt so tools still work.",
    }),
  ),
  replaceSystemPrompt: Type.Optional(
    Type.Boolean({
      description: "Use --system-prompt instead of --append-system-prompt. Default false.",
      default: false,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Provider-qualified model for --model. Defaults to the spawning agent's model.",
    }),
  ),
  provider: Type.Optional(Type.String({ description: "Provider name for --provider, if needed." })),
  thinking: Type.Optional(thinkingSchema),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional tool allowlist passed to --tools, e.g. [read, grep, find, ls].",
    }),
  ),
  excludeTools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tools disabled after profile and explicit tool resolution.",
    }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description: "Exact skill files to load after disabling automatic skill discovery.",
    }),
  ),
  noTools: Type.Optional(
    Type.Boolean({ description: "Pass --no-tools to the subagent.", default: false }),
  ),
  noBuiltinTools: Type.Optional(
    Type.Boolean({ description: "Pass --no-builtin-tools to the subagent.", default: false }),
  ),
  inheritContext: Type.Optional(
    Type.Boolean({
      description: "Load AGENTS.md/CLAUDE.md context files. Default true.",
      default: true,
    }),
  ),
  noExtensions: Type.Optional(
    Type.Boolean({
      description: "Pass --no-extensions to the subagent. Default false.",
      default: false,
    }),
  ),
  noSkills: Type.Optional(
    Type.Boolean({
      description: "Pass --no-skills to the subagent. Default false.",
      default: false,
    }),
  ),
  noPromptTemplates: Type.Optional(
    Type.Boolean({
      description: "Pass --no-prompt-templates to the subagent. Default false.",
      default: false,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the subagent. Relative paths resolve from the current project; absolute worktree paths are allowed.",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description: "Focus the new Herdr tab after spawning. Default false.",
      default: false,
    }),
  ),
});

export const spawnSubagentsSchema = Type.Object({
  agents: Type.Array(subagentSpecSchema, {
    minItems: 1,
    maxItems: MAX_SUBAGENTS_PER_CALL,
    description: "Subagents to start in separate tabs of the current Herdr workspace.",
  }),
});

export type SpawnSubagentsInput = Static<typeof spawnSubagentsSchema>;
export type SubagentSpec = Static<typeof subagentSpecSchema>;
export type SubagentWorkPacket = Static<typeof workPacketSchema>;
export type ExpectedFailingTest = Static<typeof expectedFailingTestSchema>;
export type FrozenTestStructure = Static<typeof frozenTestStructureSchema>;

export const manageSubagentsSchema = Type.Object({
  action: StringEnum(["list", "read", "prompt", "focus", "abort", "close", "restart"] as const, {
    description: "List, inspect, prompt, focus, abort, close, or restart Herdr-managed subagents.",
  }),
  id: Type.Optional(
    Type.String({ description: "Subagent id, name, Herdr tab id, or Herdr pane id." }),
  ),
  lines: Type.Optional(
    Type.Number({ description: `Number of recent lines to read. Default ${DEFAULT_READ_LINES}.` }),
  ),
  message: Type.Optional(Type.String({ description: "Message required for action=prompt." })),
});

export type ManageSubagentsInput = Static<typeof manageSubagentsSchema>;

export const askMainAgentSchema = Type.Object({
  addressedTo: StringEnum(["main_agent", "user", "unsure"] as const, {
    description:
      "Who should answer. Use main_agent for implementation/coordination questions; user for product/intent decisions; unsure when unclear.",
    default: "unsure",
  }),
  question: Type.String({ description: "The question that needs an answer." }),
  context: Type.Optional(Type.String({ description: "Relevant context for the question." })),
  whatDone: Type.Optional(
    Type.String({ description: "Short summary of what the subagent has done so far." }),
  ),
  options: Type.Optional(Type.Array(Type.String(), { description: "Optional answer choices." })),
  artifactPath: Type.Optional(
    Type.String({ description: "Durable checkpoint, handoff, or module-request path for the main agent." }),
  ),
});

export type AskMainAgentInput = Static<typeof askMainAgentSchema>;

const moduleImplementationRequestSchema = Type.Object({
  taskId: Type.String({ description: "Stable logical task identifier for the requested module." }),
  objective: Type.String(),
  reason: Type.String({ description: "Why this responsibility should be an independent module." }),
  profile: StringEnum(
    ["frontend-implementer", "backend-implementer", "database-implementer", "builder-implementer"] as const,
  ),
  writableFiles: Type.Array(Type.String(), { minItems: 1 }),
  contractFiles: Type.Array(Type.String(), { minItems: 1 }),
  acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
  nonGoals: Type.Optional(Type.Array(Type.String())),
});

export const submitCheckpointSchema = Type.Object({
  summary: Type.String(),
  completed: Type.Array(Type.String()),
  remaining: Type.Array(Type.String()),
  changedFiles: Type.Array(Type.String()),
  validation: Type.Array(Type.String()),
  blocker: Type.Optional(Type.String()),
});

export const submitHandoffSchema = Type.Object({
  status: StringEnum(["success", "blocked", "needs-main", "error", "aborted"] as const),
  summary: Type.String(),
  changedFiles: Type.Array(Type.String()),
  validation: Type.Array(Type.String()),
  deviations: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  followUp: Type.Array(Type.String()),
  moduleRequests: Type.Optional(Type.Array(moduleImplementationRequestSchema)),
});

export type SubmitCheckpointInput = Static<typeof submitCheckpointSchema>;
export type SubmitHandoffInput = Static<typeof submitHandoffSchema>;
