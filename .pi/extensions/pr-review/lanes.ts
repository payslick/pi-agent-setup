import type { DiffHunk, PRFile, PRMetadata, ReviewLaneId, ReviewLanePacket } from "./types";
import { designRulesPrompt } from "../../design-rules/index";
import { readReviewLanePrompt } from "./prompt-loader";
import { filterReviewFiles, filterReviewHunks } from "./review-scope";

interface LaneDefinition {
  laneId: ReviewLaneId;
  title: string;
  score: (input: RouteReviewLanesInput) => number;
}

export interface RouteReviewLanesInput {
  pr: PRMetadata;
  files: readonly PRFile[];
  hunks: readonly DiffHunk[];
}

const HUNK_LIMIT = 80;
const HUNK_LINE_LIMIT = 220;

const laneDefinitions: LaneDefinition[] = [
  {
    laneId: "correctness",
    title: "Correctness",
    score: () => 100,
  },
  {
    laneId: "relevance",
    title: "Relevance",
    score: () => 96,
  },
  {
    laneId: "security-api",
    title: "Security/API safety",
    score: ({ files }) =>
      files.some((file) => /server|api|route|controller|auth|schema|validation|db/i.test(file.path))
        ? 85
        : 20,
  },
  {
    laneId: "tests",
    title: "Tests",
    score: ({ files }) => (files.some((file) => /\.(test|spec|e2e)\./i.test(file.path)) ? 35 : 75),
  },
  {
    laneId: "docs",
    title: "Docs",
    score: ({ files }) => (files.some((file) => /docs|readme|\.mdx?$/i.test(file.path)) ? 90 : 35),
  },
  {
    laneId: "architecture",
    title: "Architecture",
    score: ({ files }) => (files.length >= 5 ? 65 : 25),
  },
  {
    laneId: "code-quality",
    title: "Code quality",
    score: () => 55,
  },
  {
    laneId: "dedupe",
    title: "Dedupe / reuse",
    score: ({ files }) => (files.some((file) => isDedupeCandidatePath(file.path)) ? 58 : 0),
  },
  {
    laneId: "data",
    title: "Data & types",
    score: ({ files }) =>
      files.some((file) =>
        /(^|\/)(db|drizzle|data)(\/|$)|schema|schemas|types?|validation|form/i.test(file.path),
      )
        ? 92
        : 70,
  },
  {
    laneId: "performance",
    title: "Performance",
    score: ({ files, hunks }) =>
      files.some((file) => /query|db|sql|table|list|render|cache|import|export/i.test(file.path)) ||
      hunks.length > 12
        ? 45
        : 0,
  },
  {
    laneId: "ux",
    title: "UX/accessibility",
    score: ({ files }) =>
      files.some((file) => /components|pages|app|ui|\.tsx$/i.test(file.path)) ? 50 : 0,
  },
  {
    laneId: "dependencies",
    title: "Dependencies",
    score: ({ files }) =>
      files.some((file) =>
        /package\.json|bun\.lock|pnpm-lock|yarn\.lock|package-lock|tsconfig|config/i.test(
          file.path,
        ),
      )
        ? 60
        : 0,
  },
];

export function routeReviewLanes(
  input: RouteReviewLanesInput,
  requestedLaneIds?: readonly string[],
): ReviewLanePacket[] {
  const reviewInput = {
    ...input,
    files: filterReviewFiles(input.files),
    hunks: filterReviewHunks(input.hunks),
  };
  if (!reviewInput.files.length && !reviewInput.hunks.length) return [];
  const requested = requestedLaneIds?.length ? new Set(requestedLaneIds) : undefined;
  return laneDefinitions
    .map((definition) => ({
      definition,
      score: scoreLane(definition, reviewInput, requested),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ definition }) => buildLanePacket(reviewInput, definition));
}

function scoreLane(
  definition: LaneDefinition,
  input: RouteReviewLanesInput,
  requested: Set<string> | undefined,
): number {
  if (!requested) return definition.score(input);
  if (requested.has(definition.laneId)) return 100;
  return 0;
}

function buildLanePacket(
  input: RouteReviewLanesInput,
  definition: LaneDefinition,
): ReviewLanePacket {
  const scopedFiles = scopeFilesForLane(definition.laneId, input.files);
  const files = scopedFiles.length ? scopedFiles : [...input.files];
  const filePaths = new Set(files.map((file) => file.path));
  const scopedHunks = input.hunks.filter((hunk) => filePaths.has(hunk.filePath));
  return {
    laneId: definition.laneId,
    title: definition.title,
    focus: readReviewLanePrompt(definition.laneId),
    files,
    hunks: scopedHunks.length ? scopedHunks : [...input.hunks],
  };
}

function scopeFilesForLane(laneId: ReviewLaneId, files: readonly PRFile[]): PRFile[] {
  const matcher = laneFileMatcher(laneId);
  return matcher ? files.filter((file) => matcher(file.path)) : [...files];
}

function laneFileMatcher(laneId: ReviewLaneId): ((filePath: string) => boolean) | undefined {
  switch (laneId) {
    case "docs":
      return (filePath) => /(^|\/)(docs|documentation)(\/|$)|readme|\.mdx?$/i.test(filePath);
    case "security-api":
      return (filePath) =>
        /server|api|route|controller|auth|permission|middleware|schema|validation|db|drizzle|trpc|env/i.test(
          filePath,
        );
    case "data":
      return (filePath) =>
        /(^|\/)(db|drizzle|data)(\/|$)|schema|schemas|types?|validation|form|migration/i.test(
          filePath,
        );
    case "ux":
      return (filePath) =>
        /(^|\/)(app|pages|components|ui)(\/|$)|\.tsx$|\.css$|\.scss$/i.test(filePath);
    case "dependencies":
      return (filePath) =>
        /package\.json|bun\.lock|pnpm-lock|yarn\.lock|package-lock|tsconfig|config/i.test(filePath);
    case "performance":
      return (filePath) =>
        /query|db|sql|table|list|render|cache|import|export|\.tsx$/i.test(filePath);
    case "dedupe":
      return isDedupeCandidatePath;
    default:
      return undefined;
  }
}

function isDedupeCandidatePath(filePath: string): boolean {
  if (
    /(^|\/)(docs|documentation)(\/|$)|readme|\.mdx?$|lock$|package-lock|pnpm-lock|yarn\.lock|bun\.lock/i.test(
      filePath,
    )
  )
    return false;
  return /(^|\/)(src|app|pages|components|server|api|lib|utils|hooks|tests?|features|packages)(\/|$)|\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(
    filePath,
  );
}

export interface LaneReviewPromptArtifacts {
  sharedDir: string;
  laneDir: string;
  sharedFiles: readonly string[];
  partialFindingsFile?: string;
}

export function buildLaneReviewPrompt(
  pr: PRMetadata,
  packet: ReviewLanePacket,
  artifacts?: LaneReviewPromptArtifacts,
): string {
  return [
    `# PR review lane: ${packet.title}`,
    "",
    `PR: ${pr.title}`,
    `URL: ${pr.url || "local diff"}`,
    "",
    "## PR description",
    pr.body.trim() || "(empty)",
    "",
    `Base: ${pr.base.ref} (${pr.base.sha || "unknown"})`,
    `Head: ${pr.head.ref} (${pr.head.sha || "unknown"})`,
    "",
    designRulesPrompt(),
    "- Return only concrete, actionable findings backed by the diff below.",
    "- Do not ask for broad rewrites; keep suggestions scoped to the changed code.",
    "- Avoid duplicate findings; if one root cause affects multiple lines, report the best representative line.",
    "",
    "## GitHub comment style",
    "- Prefer an exact `replacement`, then an illustrative `example`, then prose alone.",
    "- Use `replacement` only for complete, mechanically applicable code. Return raw code without Markdown fences and set `startLine` and `endLine` for multi-line replacements.",
    "- Use `example` only when an exact replacement is unsafe. Put raw code in `example.code`; default `example.language` to `ts`.",
    "- Keep `title` within 72 characters. Keep rendered prose within 400 characters and two short sentences. Use correct punctuation.",
    "- Use concise Markdown to emphasize the issue. Do not add greetings, summaries, repeated conclusions, or long headings.",
    `- Use the project's terminology. Link obscure terms to exact docs or source with a full GitHub blob URL at head ${pr.head.sha || "SHA"}.`,
    "- Do not repeat the title in the body. Do not return both `replacement` and `example`.",
    "",
    "## Shared review data",
    ...(artifacts
      ? [
          `Shared directory: ${artifacts.sharedDir}`,
          `Lane directory: ${artifacts.laneDir}`,
          "Artifact paths are references, not a reading checklist. Do not read them unless a specific truncated hunk requires omitted context:",
          ...artifacts.sharedFiles.map((file) => `- ${file}`),
          `Lane packet: ${artifacts.laneDir}/packet.json`,
          `Lane hunks: ${artifacts.laneDir}/hunks.json`,
          ...(artifacts.partialFindingsFile
            ? [
                `Live partial findings: ${artifacts.partialFindingsFile}`,
                "Record each fully confirmed finding with `report_pr_review_finding` as soon as it is ready; this append-only file drives live progress and does not replace the final JSON response.",
              ]
            : []),
        ]
      : ["No shared artifact directory was provided."]),
    "",
    "## Tool boundaries",
    "- Use `read` or `read-many-files-lines` for exact known paths and line ranges. Reserve `get_data` for bounded cross-file investigation when the diff and direct reads are insufficient.",
    "- Additional web and project-index tools may be enabled by the caller; use only tools listed for this agent.",
    "- Do not use Bash unless the system prompt explicitly grants the CI-analysis lane its restricted GitHub CLI policy.",
    artifacts
      ? `- If edit tools are enabled, edit only files under ${artifacts.laneDir} or ${artifacts.sharedDir}.`
      : "- If edit tools are enabled, edit only your review artifact directory or shared review directory.",
    "",
    "## Changed files",
    ...packet.files.map((file) => `- ${file.path} (${file.status})`),
    "",
    "## Diff hunks",
    artifacts
      ? `Diff hunks are also stored in ${artifacts.laneDir}/hunks.json. The shared patch is at ${artifacts.sharedDir}/patch.diff if tools are enabled.`
      : "Inline diff hunks follow.",
    formatHunks(packet.hunks),
    "",
    "Return JSON only with this shape:",
    '{"findings":[{"severity":"blocker|high|medium|low|nit","type":"bug|security|performance|maintainability|test|documentation|style|question","path":"file","line":123,"startLine":120,"endLine":123,"functionName":"name","title":"short point","body":"at most two short sentences","confidence":0.8,"replacement":"exact raw replacement code","example":{"language":"ts","code":"illustrative raw code"}}]}',
  ].join("\n");
}

function diffLinePrefix(kind: DiffHunk["lines"][number]["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "delete") return "-";
  return " ";
}

function formatHunks(hunks: readonly DiffHunk[]): string {
  if (!hunks.length) return "No hunks available.";
  const displayedHunks = hunks.slice(0, HUNK_LIMIT);
  const warnings = truncationWarnings(hunks);
  const body = displayedHunks
    .map((hunk) => {
      const lines = hunk.lines
        .slice(0, HUNK_LINE_LIMIT)
        .map((line) => {
          if (line.kind === "hunk") return line.content;
          const prefix = diffLinePrefix(line.kind);
          const number = line.kind === "delete" ? line.oldLineNumber : line.newLineNumber;
          return `${prefix}${number ?? ""}: ${line.content}`;
        })
        .join("\n");
      const omittedLineCount = Math.max(0, hunk.lines.length - HUNK_LINE_LIMIT);
      const truncationNote = omittedLineCount
        ? `\n# Diff context truncated: ${omittedLineCount} additional line(s) from this hunk were omitted.`
        : "";
      return `### ${hunk.filePath}\n${lines}${truncationNote}`;
    })
    .join("\n\n");
  return warnings.length ? `${warnings.join("\n")}\n\n${body}` : body;
}

function truncationWarnings(hunks: readonly DiffHunk[]): string[] {
  const warnings: string[] = [];
  if (hunks.length > HUNK_LIMIT)
    warnings.push(`# Diff context truncated: showing ${HUNK_LIMIT}/${hunks.length} hunks.`);
  const truncatedHunks = hunks.filter((hunk) => hunk.lines.length > HUNK_LINE_LIMIT).length;
  if (truncatedHunks > 0)
    warnings.push(
      `# Diff context truncated: ${truncatedHunks} hunk(s) exceed ${HUNK_LINE_LIMIT} displayed lines each.`,
    );
  return warnings;
}
