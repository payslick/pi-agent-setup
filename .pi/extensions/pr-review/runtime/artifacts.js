import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  return { sessionId, baseDir, sharedDir, files: writtenFiles };
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
    "- `files.json` — changed file list from GitHub/local diff.",
    "- `hunks.json` — parsed diff hunks with line numbers.",
    "- `patch.diff` — full patch text.",
    "- `lanes.json` — lane routing summary.",
    "- `review-agent-tool-guard.ts` — tool-call guard loaded into lane-agent Pi processes.",
    "",
    "## Tool/edit rules",
    "- Bash is intentionally unavailable to lane agents.",
    "- Lane agents may use read/read-many-files-lines, web tools, and project_index tools.",
    `- Lane agents may edit only their own lane directory under \`tmp/${sessionId}/<lane>\` or this shared directory: \`${sharedDir}\`.`,
    "",
  ].join("\n");
}

export function reviewAgentToolGuardSource(laneDir, sharedDir) {
  return [
    'import path from "node:path";',
    "",
    "export default function reviewAgentToolGuard(pi) {",
    '  pi.on("tool_call", (event, ctx) => {',
    '    if (!["edit", "write", "multi-edit"].includes(event.toolName)) return;',
    "    const input = event.input || {};",
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

async function writeLaneAgentArtifact(ctx, laneId, fileName, content) {
  const artifactDir = laneAgentArtifactDir(ctx, laneId);
  await mkdir(artifactDir.absolute, { recursive: true });
  const filePath = path.join(artifactDir.absolute, fileName.replace(/[^a-z0-9._-]+/gi, "-"));
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

export async function createLaneArtifactWriter(ctx, laneId) {
  const artifactFiles = [];
  return {
    artifactFiles,
    artifactDir: laneAgentArtifactDir(ctx, laneId).relative,
    write: async (fileName, content) => {
      const artifactPath = await writeLaneAgentArtifact(ctx, laneId, fileName, content);
      artifactFiles.push(artifactPath);
    },
  };
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
