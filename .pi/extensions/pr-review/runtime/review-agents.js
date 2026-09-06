import { readFile } from "node:fs/promises";
import path from "node:path";
import { runPiAgentInHerdr } from "../herdr-agent.ts";
import {
  createLaneArtifactWriter,
  getLaneDir,
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
  REVIEW_AGENT_PROMPT_COMMAND,
  reviewAgentToolGuardSource,
} from "./artifacts.js";
import {
  FINDINGS_JSON_SCHEMA,
  parseAgentFindings,
  parsePartialAgentFindings,
  stripAnsi,
  truncateForPrompt,
} from "./findings.js";
import { buildLaneReviewPrompt } from "./lanes.js";
import { readReviewLanePrompt, readSharedReviewLanePrompt } from "../prompt-loader.ts";
import { filterReviewFindings } from "../review-scope.ts";

const REVIEW_AGENT_DISABLE_REPAIR = process.env.PI_REVIEW_DISABLE_REPAIR === "1";
const REVIEW_AGENT_ENABLE_ALL_TOOLS = process.env.PI_REVIEW_AGENT_ENABLE_TOOLS === "1";
const REVIEW_AGENT_MODEL = process.env.PI_REVIEW_AGENT_MODEL;
const REVIEW_AGENT_THINKING = process.env.PI_REVIEW_AGENT_THINKING;
export const DEFAULT_REVIEW_AGENT_TIMEOUT_MS = 2_700_000;
export const DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS = 600_000;
const GET_DATA_REVIEW_AGENT_ALLOWED_TOOLS = [
  "get_data",
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
  "read",
  "read-many-files-lines",
].join(",");
const REVIEW_AGENT_ALLOWED_TOOLS = [
  "get_data",
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
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
  "get_data",
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
  "read",
  "read-many-files-lines",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
].join(",");
const CI_ANALYSIS_REVIEW_AGENT_ALLOWED_TOOLS = [
  "get_data",
  REVIEW_AGENT_PARTIAL_FINDING_TOOL,
  "read",
  "read-many-files-lines",
  "bash",
].join(",");
const CI_ANALYSIS_FULL_REVIEW_AGENT_ALLOWED_TOOLS = `${REVIEW_AGENT_ALLOWED_TOOLS},bash`;

function reviewAgentProtocolWithTools(laneId) {
  return [
    "## Runtime boundaries",
    "Use only the enabled tools. When calling tools, pass arguments as JSON objects, never as stringified JSON.",
    "Use `read` or `read-many-files-lines` for exact known paths and line ranges. Reserve `get_data` for bounded cross-file investigation when the diff and direct reads are insufficient.",
    `Call \`${REVIEW_AGENT_PARTIAL_FINDING_TOOL}\` once when each finding is fully confirmed and intended for the final response. Before requesting more evidence, record every finding that already meets the reporting threshold instead of deferring all progress until final synthesis. Do not record tentative candidates, and include every recorded finding in the final JSON.`,
    laneId === "ci-analysis"
      ? "Bash is restricted to one direct, read-only `gh pr checks`, `gh run list`, or `gh run view` command per call. Set `action` to `read`; other executables and shell operators are forbidden."
      : "Bash is intentionally unavailable.",
    "If you edit files, edit only your lane directory or the shared review directory.",
    "Return JSON only, with this shape:",
    FINDINGS_JSON_SCHEMA,
    "Use an empty findings array if there are no issues.",
    "Do not include markdown fences or prose outside JSON.",
  ].join("\n");
}
const REVIEW_AGENT_PROTOCOL_NO_TOOLS = [
  "## Runtime boundaries",
  "Tools are intentionally disabled. Review only the prompt content and return JSON; do not emit tool calls.",
  "Return JSON only, with this shape:",
  FINDINGS_JSON_SCHEMA,
  "Use an empty findings array if there are no issues.",
  "Do not include markdown fences or prose outside JSON.",
].join("\n");
const REPAIR_AGENT_SYSTEM_PROMPT = [
  "You normalize a PR review agent response into the required JSON protocol.",
  REVIEW_AGENT_PROTOCOL_NO_TOOLS,
].join("\n\n");

export function reviewAgentToolPolicy(laneId, enableAllTools = REVIEW_AGENT_ENABLE_ALL_TOOLS) {
  if (laneId === "ci-analysis") {
    return {
      toolsEnabled: true,
      allowedTools: enableAllTools
        ? CI_ANALYSIS_FULL_REVIEW_AGENT_ALLOWED_TOOLS
        : CI_ANALYSIS_REVIEW_AGENT_ALLOWED_TOOLS,
    };
  }
  if (enableAllTools) return { toolsEnabled: true, allowedTools: REVIEW_AGENT_ALLOWED_TOOLS };
  if (laneId === "dedupe")
    return { toolsEnabled: true, allowedTools: DEDUPE_REVIEW_AGENT_ALLOWED_TOOLS };
  return { toolsEnabled: true, allowedTools: GET_DATA_REVIEW_AGENT_ALLOWED_TOOLS };
}

export function buildReviewLaneSystemPrompt(laneId, toolsEnabled) {
  return [
    readSharedReviewLanePrompt(),
    readReviewLanePrompt(laneId),
    toolsEnabled ? reviewAgentProtocolWithTools(laneId) : REVIEW_AGENT_PROTOCOL_NO_TOOLS,
  ].join("\n\n");
}

export function selectedReviewAgentDefaults(pi, ctx) {
  return {
    model: REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    thinking: REVIEW_AGENT_THINKING || pi.getThinkingLevel(),
  };
}

export function reviewAgentTimeout(environment = process.env) {
  const configured = Number(environment.PI_REVIEW_AGENT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_REVIEW_AGENT_TIMEOUT_MS;
}

export function reviewAgentInactivityTimeout(environment = process.env) {
  const configured = Number(environment.PI_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_REVIEW_AGENT_INACTIVITY_TIMEOUT_MS;
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
  const laneDir = getLaneDir(ctx, laneId);
  const partialFindingsFile = path.join(laneDir, "partial-findings.jsonl");
  const partialFindingsPath = path.join(ctx.cwd, partialFindingsFile);
  const prompt = [
    `# CI failure analysis for PR #${prMetadata.ref.number}`,
    "",
    `Record confirmed findings with \`${REVIEW_AGENT_PARTIAL_FINDING_TOOL}\`; live partial findings are appended to ${partialFindingsFile}.`,
    "Use shared CI artifacts first, especially:",
    `- ${sharedArtifacts.sharedDir}/ci-status.json`,
    ...(ciStatus.failedLogFiles ?? []).map((file) => `- ${file}`),
  ].join("\n");
  const artifacts = await createLaneArtifactWriter(ctx, laneId);
  const toolPolicy = reviewAgentToolPolicy(laneId);
  const systemPrompt = buildReviewLaneSystemPrompt(laneId, toolPolicy.toolsEnabled);
  await artifacts.write("prompt.md", prompt);
  await artifacts.write("partial-findings.jsonl", "");
  await artifacts.write("system-prompt.md", systemPrompt);
  await artifacts.write("ci-status.json", `${JSON.stringify(ciStatus, null, 2)}\n`);
  await artifacts.write(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(laneDir, sharedArtifacts.sharedDir, {
      allowCiAnalysisGhBash: true,
      promptFile: path.join(laneDir, "prompt.md"),
      partialFindingsFile,
    }),
  );
  const agentArguments = buildReviewAgentArguments(ctx, {
    laneId,
    prompt,
    ...selectedReviewAgentDefaults(pi, ctx),
    ...toolPolicy,
    systemPrompt,
  });
  try {
    const result = await runPiAgentInHerdr(pi, ctx, {
      label: `PR-${laneId}`,
      prompt: `/${REVIEW_AGENT_PROMPT_COMMAND}`,
      piArgs: agentArguments,
      timeout: reviewAgentTimeout(),
      inactivityTimeout: reviewAgentInactivityTimeout(),
    });
    await artifacts.write("stdout.txt", result.stdout);
    await artifacts.write("stderr.txt", result.stderr);
    if (result.code !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || `ci analysis exited ${result.code}`;
      await artifacts.write("error.txt", `${error}\n`);
      const partialFindings = await readPartialReviewFindings(partialFindingsPath, laneId);
      return laneAgentErrorResult(
        laneId,
        error,
        artifacts,
        result.stdout || result.stderr,
        partialFindings,
      );
    }
    const findings = parseAgentFindings(result.stdout, laneId);
    await artifacts.write("findings.json", `${JSON.stringify({ findings }, null, 2)}\n`);
    return laneAgentSuccessResult(laneId, findings, artifacts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await artifacts.write("error.txt", `${errorMessage}\n`);
    const partialFindings = await readPartialReviewFindings(partialFindingsPath, laneId);
    return laneAgentErrorResult(laneId, errorMessage, artifacts, undefined, partialFindings);
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

function laneAgentErrorResult(laneId, error, artifacts, rawOutput, findings = []) {
  return {
    laneId,
    findings,
    partialFindingCount: findings.length,
    error,
    rawOutput,
    artifactDir: artifacts.artifactDir,
    artifactFiles: artifacts.artifactFiles,
  };
}

async function prepareLaneAgentRun(pi, ctx, prMetadata, packet, sharedArtifacts) {
  const laneDir = getLaneDir(ctx, packet.laneId);
  const partialFindingsFile = path.join(laneDir, "partial-findings.jsonl");
  const prompt = buildLaneReviewPrompt(prMetadata, packet, {
    sharedDir: sharedArtifacts.sharedDir,
    laneDir,
    sharedFiles: sharedArtifacts.files,
    partialFindingsFile,
  });
  const artifacts = await createLaneArtifactWriter(ctx, packet.laneId);
  await artifacts.write("prompt.md", prompt);
  await artifacts.write("partial-findings.jsonl", "");
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
    reviewAgentToolGuardSource(laneDir, sharedArtifacts.sharedDir, {
      promptFile: path.join(laneDir, "prompt.md"),
      partialFindingsFile,
    }),
  );
  const toolPolicy = reviewAgentToolPolicy(packet.laneId);
  const systemPrompt = buildReviewLaneSystemPrompt(packet.laneId, toolPolicy.toolsEnabled);
  await artifacts.write("system-prompt.md", systemPrompt);
  const agentArguments = buildReviewAgentArguments(ctx, {
    laneId: packet.laneId,
    prompt,
    ...selectedReviewAgentDefaults(pi, ctx),
    ...toolPolicy,
    systemPrompt,
  });
  return { prompt, artifacts, agentArguments };
}

function reviewableFindings(findings) {
  return filterReviewFindings(findings);
}

export async function readPartialReviewFindings(partialFindingsPath, laneId) {
  try {
    return reviewableFindings(
      parsePartialAgentFindings(await readFile(partialFindingsPath, "utf8"), laneId),
    );
  } catch {
    return [];
  }
}

function partialFindingOutput(findings) {
  const records = findings.flatMap((finding) => {
    const path = finding.location?.filePath;
    if (!path) return [];
    return [
      {
        severity: finding.severity,
        type: finding.type,
        path,
        line: finding.location?.line ?? finding.location?.startLine ?? 1,
        startLine: finding.location?.startLine,
        endLine: finding.location?.endLine,
        functionName: finding.functionName,
        title: finding.title,
        body: finding.body,
        confidence: finding.confidence,
        replacement: finding.replacement,
        example: finding.example,
      },
    ];
  });
  return records.length ? `${records.map((finding) => JSON.stringify(finding)).join("\n")}\n` : "";
}

async function writeFinalFindings(
  artifacts,
  findings,
  partialFindingsPath,
  repaired = false,
) {
  await artifacts.write(
    "findings.json",
    `${JSON.stringify({ findings, ...(repaired ? { repaired: true } : {}) }, null, 2)}\n`,
  );
  const output = partialFindingOutput(findings);
  if (!output) return;
  if (typeof artifacts.append === "function") {
    await artifacts.append("partial-findings.jsonl", output);
    return;
  }
  const existingOutput = await readFile(partialFindingsPath, "utf8").catch(() => "");
  await artifacts.write("partial-findings.jsonl", `${existingOutput}${output}`);
}

async function persistFinalFindings(
  artifacts,
  findings,
  partialFindingsPath,
  repaired = false,
) {
  try {
    await writeFinalFindings(artifacts, findings, partialFindingsPath, repaired);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await artifacts.write("artifact-error.txt", `${message}\n`).catch(() => undefined);
  }
}

async function processLaneAgentOutput(
  pi,
  ctx,
  packet,
  result,
  artifacts,
  partialFindingsPath,
  onProgress,
) {
  if (result.code !== 0) {
    const error =
      result.stderr.trim() || result.stdout.trim() || `review agent exited ${result.code}`;
    await artifacts.write("error.txt", `${error}\n`);
    const partialFindings = await readPartialReviewFindings(
      partialFindingsPath,
      packet.laneId,
    );
    onProgress?.("error", { findingCount: partialFindings.length });
    return laneAgentErrorResult(
      packet.laneId,
      error,
      artifacts,
      truncateForPrompt(result.stdout || result.stderr, 20_000),
      partialFindings,
    );
  }
  let findings;
  try {
    findings = reviewableFindings(parseAgentFindings(result.stdout, packet.laneId));
  } catch (parseError) {
    const parseErrorMessage = parseError instanceof Error ? parseError.message : String(parseError);
    await artifacts.write("parse-error.txt", `${parseErrorMessage}\n`);
    const repaired = await repairAgentFindings(pi, ctx, packet, result.stdout, artifacts.write);
    if (!repaired) {
      const partialFindings = await readPartialReviewFindings(
        partialFindingsPath,
        packet.laneId,
      );
      onProgress?.("error", { findingCount: partialFindings.length });
      return laneAgentErrorResult(
        packet.laneId,
        parseErrorMessage,
        artifacts,
        truncateForPrompt(result.stdout, 20_000),
        partialFindings,
      );
    }
    findings = reviewableFindings(repaired);
    await persistFinalFindings(artifacts, findings, partialFindingsPath, true);
    onProgress?.("done", { findingCount: findings.length });
    return laneAgentSuccessResult(packet.laneId, findings, artifacts);
  }
  await persistFinalFindings(artifacts, findings, partialFindingsPath);
  onProgress?.("done", { findingCount: findings.length });
  return laneAgentSuccessResult(packet.laneId, findings, artifacts);
}

export async function runLaneAgent(pi, ctx, prMetadata, packet, sharedArtifacts, onProgress) {
  const partialFindingsPath = path.join(
    ctx.cwd,
    getLaneDir(ctx, packet.laneId),
    "partial-findings.jsonl",
  );
  onProgress?.("preparing", { partialFindingsPath });
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
      prompt: `/${REVIEW_AGENT_PROMPT_COMMAND}`,
      piArgs: agentArguments,
      timeout: reviewAgentTimeout(),
      inactivityTimeout: reviewAgentInactivityTimeout(),
      onProgress,
    });
    await artifacts.write("stdout.txt", result.stdout);
    await artifacts.write("stderr.txt", result.stderr);
    return processLaneAgentOutput(
      pi,
      ctx,
      packet,
      result,
      artifacts,
      partialFindingsPath,
      onProgress,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await artifacts.write("error.txt", `${errorMessage}\n`);
    const partialFindings = await readPartialReviewFindings(
      partialFindingsPath,
      packet.laneId,
    );
    onProgress?.("error", { findingCount: partialFindings.length });
    return laneAgentErrorResult(
      packet.laneId,
      errorMessage,
      artifacts,
      undefined,
      partialFindings,
    );
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
      systemPrompt: REPAIR_AGENT_SYSTEM_PROMPT,
    }),
    "--no-extensions",
  ];
  try {
    const result = await runPiAgentInHerdr(pi, ctx, {
      label: `PR-${packet.laneId}-repair`,
      prompt,
      piArgs: agentArguments,
      timeout: reviewAgentTimeout(),
      inactivityTimeout: reviewAgentInactivityTimeout(),
    });
    await writeArtifact?.("repair-stdout.txt", result.stdout);
    await writeArtifact?.("repair-stderr.txt", result.stderr);
    return result.code === 0 ? parseAgentFindings(result.stdout, packet.laneId) : undefined;
  } catch {
    return undefined;
  }
}
