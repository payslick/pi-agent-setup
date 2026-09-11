import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const REVIEW_AGENT_PROMPT_COMMAND = "run-pr-review-lane";
export const REVIEW_AGENT_PARTIAL_FINDING_TOOL = "report_pr_review_finding";

export function getReviewSessionDir(ctx) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionId = sessionFile ? path.basename(sessionFile, ".jsonl") : "default";
  return { sessionId, baseDir: path.join("tmp", sessionId) };
}

function getSharedDir(ctx) {
  return path.join(getReviewSessionDir(ctx).baseDir, "shared");
}

export function getLaneDir(ctx, laneId) {
  const safeLaneId = String(laneId)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return path.join(getReviewSessionDir(ctx).baseDir, safeLaneId || "lane");
}

export async function writeSharedArtifact(ctx, fileName, content, sharedArtifacts) {
  const sharedDir = sharedArtifacts?.sharedDir ?? getSharedDir(ctx);
  const absoluteSharedDir = path.join(ctx.cwd, sharedDir);
  await mkdir(absoluteSharedDir, { recursive: true });
  const filePath = path.join(absoluteSharedDir, fileName);
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

export async function writeSharedReviewArtifacts(ctx, prData, lanes) {
  const { sessionId, baseDir } = getReviewSessionDir(ctx);
  const sharedDir = getSharedDir(ctx);
  const absoluteSharedDir = path.join(ctx.cwd, sharedDir);
  await mkdir(absoluteSharedDir, { recursive: true });
  const writtenFiles = [];
  const writeSharedFile = async (fileName, content) => {
    const filePath = path.join(absoluteSharedDir, fileName);
    await writeFile(filePath, content, "utf8");
    writtenFiles.push(relativePath(ctx.cwd, filePath));
  };
  await writeSharedFile("pr-metadata.json", `${JSON.stringify(prData.metadata, null, 2)}\n`);
  await writeSharedFile(
    "commits.json",
    `${JSON.stringify(prData.metadata.commits ?? [], null, 2)}\n`,
  );
  await writeSharedFile("files.json", `${JSON.stringify(prData.files, null, 2)}\n`);
  await writeSharedFile("hunks.json", `${JSON.stringify(prData.hunks, null, 2)}\n`);
  await writeSharedFile(
    "patch.diff",
    prData.patch.endsWith("\n") ? prData.patch : `${prData.patch}\n`,
  );
  await writeSharedFile(
    "lanes.json",
    `${JSON.stringify(
      lanes.map((lane) => ({
        laneId: lane.laneId,
        title: lane.title,
        focus: lane.focus,
        files: lane.files.map((file) => file.path),
        hunkCount: lane.hunks.length,
      })),
      null,
      2,
    )}\n`,
  );
  await writeSharedFile("README.md", sharedReviewReadme(sessionId, sharedDir));
  await writeSharedFile(
    "review-agent-tool-guard.ts",
    reviewAgentToolGuardSource(sharedDir, sharedDir),
  );
  return { sessionId, baseDir, sharedDir, files: writtenFiles, fullPatch: prData.patch };
}

function sharedReviewReadme(sessionId, sharedDir) {
  return [
    `# PR review shared data for Pi session ${sessionId}`,
    "",
    "This directory contains data shared by all PR review lane agents.",
    "Agents should read these files before re-fetching or rediscovering PR metadata.",
    "",
    "## Files",
    "- `pr-metadata.json` — normalized PR metadata.",
    "- `commits.json` — complete commit history from the base to the PR head.",
    "- `files.json` — changed file list from GitHub/local diff.",
    "- `hunks.json` — parsed diff hunks with line numbers.",
    "- `patch.diff` — full patch text.",
    "- `lanes.json` — lane routing summary.",
    "- `review-agent-tool-guard.ts` — tool-call guard loaded into lane-agent Pi processes.",
    "",
    "## Tool/edit rules",
    "- Every lane agent may use read-many-files-lines for bounded, read-only investigation.",
    "- Additional read, web, and project_index tools may be enabled for lane agents.",
    "- Bash is unavailable except to ci-analysis, where a guard permits only direct, read-only gh pr checks, gh run list, and gh run view calls.",
    `- Lane agents may edit only their own lane directory under \`tmp/${sessionId}/<lane>\` or this shared directory: \`${sharedDir}\`.`,
    "",
  ].join("\n");
}

export function isAllowedCiAnalysisBashCall(input) {
  if (!input || input.action !== "read" || typeof input.command !== "string") return false;
  const command = input.command.trim();
  if (!/^gh\s+(?:pr\s+checks|run\s+(?:list|view))(?:\s|$)/.test(command)) return false;
  return !/[\r\n;&|<>`$(){}]/.test(command);
}

export function reviewAgentToolGuardSource(laneDir, sharedDir, options = {}) {
  const allowCiAnalysisGhBash = options.allowCiAnalysisGhBash === true;
  const allowUnlocatedFindings = options.allowUnlocatedFindings === true;
  const requiredFindingFields = allowUnlocatedFindings
    ? ["severity", "type", "title", "body"]
    : ["severity", "type", "path", "line", "title", "body"];
  const promptFile = typeof options.promptFile === "string" ? options.promptFile : undefined;
  const partialFindingsFile =
    typeof options.partialFindingsFile === "string" ? options.partialFindingsFile : undefined;
  return [
    'import { appendFile, readFile } from "node:fs/promises";',
    'import path from "node:path";',
    "",
    `const allowCiAnalysisGhBash = ${JSON.stringify(allowCiAnalysisGhBash)};`,
    `const isAllowedCiAnalysisBashCall = ${isAllowedCiAnalysisBashCall.toString()};`,
    "",
    "export default function reviewAgentToolGuard(pi) {",
    ...(promptFile
      ? [
          `  pi.registerCommand(${JSON.stringify(REVIEW_AGENT_PROMPT_COMMAND)}, {`,
          '    description: "Run the generated PR review lane prompt",',
          "    handler: async (_args, ctx) => {",
          `      const prompt = await readFile(path.resolve(ctx.cwd, ${JSON.stringify(promptFile)}), "utf8");`,
          "      await pi.sendUserMessage(prompt);",
          "    },",
          "  });",
          "",
        ]
      : []),
    ...(partialFindingsFile
      ? [
          `  pi.registerTool({`,
          `    name: ${JSON.stringify(REVIEW_AGENT_PARTIAL_FINDING_TOOL)},`,
          '    label: "Record review finding",',
          '    description: "Append one confirmed, final-quality finding to the lane partial-results artifact.",',
          '    promptSnippet: "Record a confirmed PR review finding immediately for live progress.",',
          '    promptGuidelines: ["Before requesting more evidence, record every finding that already meets the reporting threshold. Do not defer confirmed findings until the final response."],',
          '    parameters: { type: "object", additionalProperties: false,',
          `      required: ${JSON.stringify(requiredFindingFields)},`,
          "      properties: {",
          '        severity: { type: "string" },',
          '        type: { type: "string" },',
          '        path: { type: "string" },',
          '        line: { type: "integer", minimum: 1 },',
          '        startLine: { type: "integer", minimum: 1 },',
          '        endLine: { type: "integer", minimum: 1 },',
          '        functionName: { type: "string" },',
          '        title: { type: "string" },',
          '        body: { type: "string" },',
          '        confidence: { type: "number" },',
          '        replacement: { type: "string" },',
          '        example: { type: "object", additionalProperties: false, required: ["code"],',
          '          properties: { language: { type: "string" }, code: { type: "string" } } },',
          "      },",
          "    },",
          "    execute: async (_toolCallId, finding, _signal, _onUpdate, ctx) => {",
          '      if (typeof finding.path === "string" && /^(?:\\.\\/)?drizzle(?:\\/|$)/i.test(finding.path.trim())) {',
          '        return { content: [{ type: "text", text: "Files under drizzle/ are outside review scope." }], isError: true };',
          "      }",
          `      const outputPath = path.resolve(ctx.cwd, ${JSON.stringify(partialFindingsFile)});`,
          '      await appendFile(outputPath, `${JSON.stringify(finding)}\\n`, "utf8");',
          '      return { content: [{ type: "text", text: "Confirmed finding recorded for live progress." }] };',
          "    },",
          "  });",
          "",
        ]
      : []),
    '  pi.on("tool_call", (event, ctx) => {',
    "    const input = event.input || {};",
    '    if (event.toolName === "bash") {',
    "      if (!allowCiAnalysisGhBash) {",
    '        return { block: true, reason: "Bash is unavailable to this PR review lane." };',
    "      }",
    "      if (!isAllowedCiAnalysisBashCall(input)) {",
    '        return { block: true, reason: "CI-analysis Bash permits only one direct, read-only gh pr checks, gh run list, or gh run view command without shell operators." };',
    "      }",
    "      return;",
    "    }",
    '    if (!["edit", "write", "multi-edit"].includes(event.toolName)) return;',
    '    const rawPaths = event.toolName === "multi-edit"',
    "      ? (Array.isArray(input.files) ? input.files.map((file) => file && file.path) : [])",
    "      : [input.path];",
    `    const laneDir = ${JSON.stringify(laneDir)};`,
    `    const sharedDir = ${JSON.stringify(sharedDir)};`,
    "    const allowedRoots = [laneDir, sharedDir].map((item) => path.resolve(ctx.cwd, item));",
    "    for (const rawPath of rawPaths) {",
    '      if (typeof rawPath !== "string" || rawPath.length === 0) {',
    '        return { block: true, reason: "Review lane agents may edit only their lane directory or shared review directory." };',
    "      }",
    "      const absolutePath = path.resolve(ctx.cwd, rawPath);",
    "      const allowed = allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(root + path.sep));",
    "      if (!allowed) {",
    "        return { block: true, reason: `Review lane agents may edit only files under ${laneDir} or ${sharedDir}. Blocked: ${rawPath}` };",
    "      }",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n");
}

function laneAgentArtifactDir(ctx, laneId) {
  const relative = getLaneDir(ctx, laneId);
  return { absolute: path.join(ctx.cwd, relative), relative };
}

async function writeLaneAgentArtifact(ctx, laneId, fileName, content, append = false) {
  const artifactDir = laneAgentArtifactDir(ctx, laneId);
  await mkdir(artifactDir.absolute, { recursive: true });
  const filePath = path.join(artifactDir.absolute, fileName.replace(/[^a-z0-9._-]+/gi, "-"));
  await (append ? appendFile : writeFile)(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

export async function createLaneArtifactWriter(ctx, laneId) {
  const artifactFiles = [];
  return {
    artifactFiles,
    artifactDir: laneAgentArtifactDir(ctx, laneId).relative,
    write: async (fileName, content) => {
      const artifactPath = await writeLaneAgentArtifact(ctx, laneId, fileName, content);
      if (!artifactFiles.includes(artifactPath)) artifactFiles.push(artifactPath);
    },
    append: async (fileName, content) => {
      const artifactPath = await writeLaneAgentArtifact(ctx, laneId, fileName, content, true);
      if (!artifactFiles.includes(artifactPath)) artifactFiles.push(artifactPath);
    },
  };
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
