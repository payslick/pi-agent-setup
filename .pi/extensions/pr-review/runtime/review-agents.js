import path from "node:path";
import { runPiAgentInHerdr } from "../herdr-agent.ts";
import { createLaneArtifactWriter, getLaneDir, reviewAgentToolGuardSource } from "./artifacts.js";
import {
  FINDINGS_JSON_SCHEMA,
  parseAgentFindings,
  stripAnsi,
  truncateForPrompt,
} from "./findings.js";
import { buildLaneReviewPrompt } from "./lanes.js";

const REVIEW_AGENT_DISABLE_REPAIR = process.env.PI_REVIEW_DISABLE_REPAIR === "1";
const REVIEW_AGENT_ENABLE_TOOLS = process.env.PI_REVIEW_AGENT_ENABLE_TOOLS === "1";
const REVIEW_AGENT_MODEL = process.env.PI_REVIEW_AGENT_MODEL;
const REVIEW_AGENT_THINKING = process.env.PI_REVIEW_AGENT_THINKING;
const REVIEW_AGENT_ALLOWED_TOOLS = [
  "read",
  "read-many-files-lines",
  "web_search",
  "web_extract",
  "web_research",
  "web_research_status",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
  "project_index_impact",
  "edit",
].join(",");
const DEDUPE_REVIEW_AGENT_ALLOWED_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
].join(",");
const REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS = [
  "You are a focused PR review lane agent.",
  "Use only the enabled tools. Bash is intentionally unavailable. When calling tools, pass arguments as JSON objects, never as stringified JSON.",
  "If you edit files, edit only your lane directory or the shared review directory.",
  "Return JSON only, with this shape:",
  FINDINGS_JSON_SCHEMA,
  "Use an empty findings array if there are no issues.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");
const REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS = [
  "You are a focused PR review lane agent.",
  "Tools are intentionally disabled. Review only the prompt content and return JSON; do not emit tool calls.",
  "If you edit files, edit only your lane directory or the shared review directory.",
  "Return JSON only, with this shape:",
  FINDINGS_JSON_SCHEMA,
  "Use an empty findings array if there are no issues.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");
const REVIEW_AGENT_SYSTEM_PROMPT = REVIEW_AGENT_ENABLE_TOOLS
  ? REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS
  : REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS;

export function selectedReviewAgentDefaults(pi, ctx) {
  return {
    model: REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    thinking: REVIEW_AGENT_THINKING || pi.getThinkingLevel(),
  };
}

export function buildReviewAgentArguments(ctx, input) {
  return [
    ...(input.model ? ["--model", input.model] : []),
    "--thinking",
    input.thinking,
    ...(input.toolsEnabled
      ? [
          "--tools",
          input.allowedTools,
          "--extension",
          path.join(ctx.cwd, getLaneDir(ctx, input.laneId), "review-agent-tool-guard.ts"),
        ]
      : ["--no-tools"]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt",
    input.systemPrompt,
  ];
}

export async function runCiAnalysisLaneAgent(pi, ctx, prMetadata, ciStatus, sharedArtifacts) {
  const laneId = "ci-analysis";
  const prompt = [
    `# CI failure analysis for PR #${prMetadata.ref.number}`,
    "",
    "Analyze failing CI checks and suggest concrete fixes.",
    "Use shared CI artifacts first, especially:",
    `- ${sharedArtifacts.sharedDir}/ci-status.json`,
    ...(ciStatus.failedLogFiles ?? []).map((file) => `- ${file}`),
    "",
    "Return JSON findings only. Each finding should point to the likely file/line when possible.",
  ].join("\n");
  const artifacts = await createLaneArtifactWriter(ctx, laneId);
  await artifacts.write("prompt.md", prompt);
  await artifacts.write("ci-status.json", `${JSON.stringify(ciStatus, null, 2)}\n`);
  await artifacts.write(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(getLaneDir(ctx, laneId), sharedArtifacts.sharedDir),
  );
  const agentArguments = buildReviewAgentArguments(ctx, {
    laneId,
    prompt,
    ...selectedReviewAgentDefaults(pi, ctx),
    toolsEnabled: REVIEW_AGENT_ENABLE_TOOLS,
    allowedTools: REVIEW_AGENT_ALLOWED_TOOLS,
    systemPrompt: REVIEW_AGENT_SYSTEM_PROMPT,
  });
  try {
    const result = await runPiAgentInHerdr(pi, ctx, {
      label: `PR-${laneId}`,
      prompt,
      piArgs: agentArguments,
    });
    await artifacts.write("stdout.txt", result.stdout);
    await artifacts.write("stderr.txt", result.stderr);
    if (result.code !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || `ci analysis exited ${result.code}`;
      await artifacts.write("error.txt", `${error}\n`);
      return laneAgentErrorResult(laneId, error, artifacts, result.stdout || result.stderr);
    }
    const findings = parseAgentFindings(result.stdout, laneId);
    await artifacts.write("findings.json", `${JSON.stringify({ findings }, null, 2)}\n`);
    return laneAgentSuccessResult(laneId, findings, artifacts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await artifacts.write("error.txt", `${errorMessage}\n`);
    return laneAgentErrorResult(laneId, errorMessage, artifacts);
  }
}

function laneAgentSuccessResult(laneId, findings, artifacts) {
  return {
    laneId,
    findings,
    artifactDir: artifacts.artifactDir,
    artifactFiles: artifacts.artifactFiles,
  };
}

function laneAgentErrorResult(laneId, error, artifacts, rawOutput) {
  return {
    laneId,
    findings: [],
    error,
    rawOutput,
    artifactDir: artifacts.artifactDir,
    artifactFiles: artifacts.artifactFiles,
  };
}

async function prepareLaneAgentRun(pi, ctx, prMetadata, packet, sharedArtifacts) {
  const prompt = buildLaneReviewPrompt(prMetadata, packet, {
    sharedDir: sharedArtifacts.sharedDir,
    laneDir: getLaneDir(ctx, packet.laneId),
    sharedFiles: sharedArtifacts.files,
  });
  const artifacts = await createLaneArtifactWriter(ctx, packet.laneId);
  await artifacts.write("prompt.md", prompt);
  await artifacts.write(
    "metadata.json",
    `${JSON.stringify(
      {
        laneId: packet.laneId,
        title: packet.title,
        focus: packet.focus,
        pr: {
          title: prMetadata.title,
          url: prMetadata.url,
          head: prMetadata.head,
          base: prMetadata.base,
        },
        files: packet.files.map((file) => file.path),
        hunkCount: packet.hunks.length,
        sharedDir: sharedArtifacts.sharedDir,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await artifacts.write("packet.json", `${JSON.stringify(packet, null, 2)}\n`);
  await artifacts.write("hunks.json", `${JSON.stringify(packet.hunks, null, 2)}\n`);
  await artifacts.write(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(getLaneDir(ctx, packet.laneId), sharedArtifacts.sharedDir),
  );
  const toolsEnabled = REVIEW_AGENT_ENABLE_TOOLS || packet.laneId === "dedupe";
  const allowedTools =
    packet.laneId === "dedupe" && !REVIEW_AGENT_ENABLE_TOOLS
      ? DEDUPE_REVIEW_AGENT_ALLOWED_TOOLS
      : REVIEW_AGENT_ALLOWED_TOOLS;
  const agentArguments = buildReviewAgentArguments(ctx, {
    laneId: packet.laneId,
    prompt,
    ...selectedReviewAgentDefaults(pi, ctx),
    toolsEnabled,
    allowedTools,
    systemPrompt: toolsEnabled
      ? REVIEW_AGENT_SYSTEM_PROMPT_WITH_TOOLS
      : REVIEW_AGENT_SYSTEM_PROMPT_NO_TOOLS,
  });
  return { prompt, artifacts, agentArguments };
}

async function processLaneAgentOutput(pi, ctx, packet, result, artifacts, onProgress) {
  if (result.code !== 0) {
    const error =
      result.stderr.trim() || result.stdout.trim() || `review agent exited ${result.code}`;
    await artifacts.write("error.txt", `${error}\n`);
    onProgress?.("error");
    return laneAgentErrorResult(
      packet.laneId,
      error,
      artifacts,
      truncateForPrompt(result.stdout || result.stderr, 20_000),
    );
  }
  try {
    const findings = parseAgentFindings(result.stdout, packet.laneId);
    await artifacts.write("findings.json", `${JSON.stringify({ findings }, null, 2)}\n`);
    onProgress?.("done");
    return laneAgentSuccessResult(packet.laneId, findings, artifacts);
  } catch (parseError) {
    const parseErrorMessage = parseError instanceof Error ? parseError.message : String(parseError);
    await artifacts.write("parse-error.txt", `${parseErrorMessage}\n`);
    const repaired = await repairAgentFindings(pi, ctx, packet, result.stdout, artifacts.write);
    if (repaired) {
      await artifacts.write(
        "findings.json",
        `${JSON.stringify({ findings: repaired, repaired: true }, null, 2)}\n`,
      );
      onProgress?.("done");
      return laneAgentSuccessResult(packet.laneId, repaired, artifacts);
    }
    onProgress?.("error");
    return laneAgentErrorResult(
      packet.laneId,
      parseErrorMessage,
      artifacts,
      truncateForPrompt(result.stdout, 20_000),
    );
  }
}

export async function runLaneAgent(pi, ctx, prMetadata, packet, sharedArtifacts, onProgress) {
  onProgress?.("running");
  const { prompt, artifacts, agentArguments } = await prepareLaneAgentRun(
    pi,
    ctx,
    prMetadata,
    packet,
    sharedArtifacts,
  );
  try {
    const result = await runPiAgentInHerdr(pi, ctx, {
      label: `PR-${packet.laneId}`,
      prompt,
      piArgs: agentArguments,
    });
    await artifacts.write("stdout.txt", result.stdout);
    await artifacts.write("stderr.txt", result.stderr);
    return processLaneAgentOutput(pi, ctx, packet, result, artifacts, onProgress);
  } catch (error) {
    onProgress?.("error");
    const errorMessage = error instanceof Error ? error.message : String(error);
    await artifacts.write("error.txt", `${errorMessage}\n`);
    return laneAgentErrorResult(packet.laneId, errorMessage, artifacts);
  }
}

async function repairAgentFindings(pi, ctx, packet, stdout, writeArtifact) {
  if (REVIEW_AGENT_DISABLE_REPAIR || !stdout.trim()) return undefined;
  const prompt = [
    "Convert this PR review lane agent output into the required JSON shape.",
    'Return JSON only. If there are no concrete findings, return {"findings":[]}.',
    "Do not invent findings that are not present in the output.",
    `Lane: ${packet.laneId}`,
    "Required shape:",
    FINDINGS_JSON_SCHEMA,
    "Agent output:",
    "```",
    truncateForPrompt(stripAnsi(stdout), 20_000),
    "```",
  ].join("\n");
  const agentArguments = [
    ...buildReviewAgentArguments(ctx, {
      laneId: packet.laneId,
      ...selectedReviewAgentDefaults(pi, ctx),
      toolsEnabled: false,
      allowedTools: "",
      systemPrompt: REVIEW_AGENT_SYSTEM_PROMPT,
    }),
    "--no-extensions",
  ];
  try {
    const result = await runPiAgentInHerdr(pi, ctx, {
      label: `PR-${packet.laneId}-repair`,
      prompt,
      piArgs: agentArguments,
    });
    await writeArtifact?.("repair-stdout.txt", result.stdout);
    await writeArtifact?.("repair-stderr.txt", result.stderr);
    return result.code === 0 ? parseAgentFindings(result.stdout, packet.laneId) : undefined;
  } catch {
    return undefined;
  }
}
