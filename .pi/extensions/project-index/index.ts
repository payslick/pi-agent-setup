import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

const INDEX_DIR = path.join(".pi", "index");
const INDEX_FILE = path.join(INDEX_DIR, "project-index.json");
const DEFAULT_MAX_FILES = 12;
const DEFAULT_IMPACT_RESULTS = 30;
const MAX_SCAN_FILES = Number(process.env.PI_PROJECT_INDEX_MAX_SCAN_FILES ?? 12_000);
const MAX_READ_BYTES = Number(process.env.PI_PROJECT_INDEX_MAX_READ_BYTES ?? 300_000);
const STATUS_KEY = "project-index";

const statusSchema = Type.Object({
  root: Type.Optional(Type.String({ description: "Optional root override." })),
});
const refreshSchema = Type.Object({
  root: Type.Optional(Type.String({ description: "Optional root override." })),
  force: Type.Optional(Type.Boolean({ default: false })),
});
const searchSchema = Type.Object({
  query: Type.String({ description: "Project question/query to locate relevant sources." }),
  root: Type.Optional(Type.String({ description: "Root to query (relative to Pi cwd)." })),
  maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: DEFAULT_MAX_FILES })),
  includeTests: Type.Optional(Type.Boolean({ default: true })),
  includeDocs: Type.Optional(Type.Boolean({ default: true })),
  mode: Type.Optional(
    Type.Union([Type.Literal("sources"), Type.Literal("debug")], { default: "sources" }),
  ),
});
const impactSchema = Type.Object({
  file: Type.String({ description: "Changed file path to analyze for affected pages/API/tests." }),
  root: Type.Optional(Type.String({ description: "Root to query (relative to Pi cwd)." })),
  maxResults: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, default: DEFAULT_IMPACT_RESULTS }),
  ),
  includeTests: Type.Optional(Type.Boolean({ default: true })),
});

type StatusInput = Static<typeof statusSchema>;
type RefreshInput = Static<typeof refreshSchema>;
type SearchInput = Static<typeof searchSchema>;
type ImpactInput = Static<typeof impactSchema>;

interface IndexedFile {
  absolutePath: string;
  relativeToRoot: string;
  relativeToCwd: string;
  kind: "source" | "docs" | "test" | "other";
  size: number;
  lineCount: number;
  text?: string;
}

interface SearchHit extends IndexedFile {
  score: number;
  startLine: number;
  endLine: number;
  label: string;
}

interface ScanResult {
  cwd: string;
  root: string;
  rootLabel: string;
  files: IndexedFile[];
  truncated: boolean;
  scannedAt: string;
}

const excludedDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".prisma",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "has",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "pr",
  "the",
  "to",
  "use",
  "what",
  "when",
  "where",
  "with",
]);

let lastScan: ScanResult | undefined;

function shouldShowIndexStatus(ctx: ExtensionContext): boolean {
  return ctx.hasUI && !process.env.PI_SUBAGENT_ID;
}

function updateIndexStatus(ctx: ExtensionContext, scanResult?: ScanResult): void {
  if (!shouldShowIndexStatus(ctx)) return;
  if (!scanResult) {
    ctx.ui.setStatus(STATUS_KEY, "index:scanning");
    return;
  }
  const files = `${scanResult.files.length}${scanResult.truncated ? "+" : ""}`;
  ctx.ui.setStatus(STATUS_KEY, `index:ready ${files}`);
}

function setIndexErrorStatus(ctx: ExtensionContext): void {
  if (!shouldShowIndexStatus(ctx)) return;
  ctx.ui.setStatus(STATUS_KEY, "index:error");
}

function resolveInside(root: string, target: string): string | null {
  const absolutePath = path.resolve(root, target);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectRoot(cwd: string, requestedRoot?: string): Promise<string> {
  if (requestedRoot?.trim()) {
    const resolved = resolveInside(cwd, requestedRoot.trim());
    if (!resolved)
      throw new Error(`Root is outside the current working directory: ${requestedRoot}`);
    return resolved;
  }

  const wtMain = path.join(cwd, "app", "wt", "main");
  if (await pathExists(wtMain)) return wtMain;
  return cwd;
}

function rootLabel(cwd: string, root: string): string {
  const relative = path.relative(cwd, root).split(path.sep).join("/");
  return relative || ".";
}

function isProbablyTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (textExtensions.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return ["dockerfile", "makefile", "readme", "license", "gitignore", "env.example"].includes(base);
}

function classifyFile(relativePath: string): IndexedFile["kind"] {
  const normalized = relativePath.toLowerCase();
  const base = path.basename(normalized);
  if (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/") ||
    /(?:^|[.-])(test|spec|e2e)\.[cm]?[jt]sx?$/.test(base)
  ) {
    return "test";
  }
  if (
    normalized.includes("/docs/") ||
    normalized.includes("/prd/") ||
    normalized.endsWith("readme.md") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  ) {
    return "docs";
  }
  if (/\.(?:[cm]?[jt]sx?|css|scss|sql|graphql|prisma)$/.test(normalized)) return "source";
  return "other";
}

async function listFiles(
  root: string,
  cwd: string,
): Promise<{ files: IndexedFile[]; truncated: boolean }> {
  const files: IndexedFile[] = [];
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    if (files.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await readdir(directory, { withFileTypes: true })) as Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".pi") continue;
      const absolutePath = path.join(directory, entry.name);
      const relativeToRoot = path.relative(root, absolutePath).split(path.sep).join("/");
      const parts = relativeToRoot.split("/");
      if (parts.some((part) => excludedDirs.has(part))) continue;
      if (relativeToRoot.startsWith(".pi/tmp/") || relativeToRoot.startsWith(".pi/index/"))
        continue;

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isProbablyTextFile(absolutePath)) continue;

      let size = 0;
      try {
        size = (await stat(absolutePath)).size;
      } catch {
        continue;
      }
      if (size > MAX_READ_BYTES) continue;

      const relativeToCwd = path.relative(cwd, absolutePath).split(path.sep).join("/");
      files.push({
        absolutePath,
        relativeToRoot,
        relativeToCwd,
        kind: classifyFile(relativeToRoot),
        size,
        lineCount: 0,
      });
    }
  }

  await visit(root);
  return { files, truncated };
}

async function readIndexedFile(file: IndexedFile): Promise<IndexedFile> {
  try {
    const text = await readFile(file.absolutePath, "utf8");
    return { ...file, text, lineCount: text.split(/\r?\n/).length };
  } catch {
    return file;
  }
}

async function scan(cwd: string, requestedRoot?: string, force = false): Promise<ScanResult> {
  const root = await resolveProjectRoot(cwd, requestedRoot);
  if (!force && lastScan?.cwd === cwd && lastScan.root === root) return lastScan;
  const listed = await listFiles(root, cwd);
  const files = await Promise.all(listed.files.map(readIndexedFile));
  lastScan = {
    cwd,
    root,
    rootLabel: rootLabel(cwd, root),
    files,
    truncated: listed.truncated,
    scannedAt: new Date().toISOString(),
  };
  return lastScan;
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .flatMap((token) => token.split(/[/_-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopWords.has(token));
  return [...new Set(tokens)];
}

function countTokenOccurrences(haystack: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(token, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + token.length;
    if (count > 30) break;
  }
  return count;
}

function matchingLines(
  lines: readonly string[],
  tokens: readonly string[],
  phrase: string,
): number[] {
  const matches: number[] = [];
  const lowerPhrase = phrase.toLowerCase().trim();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.toLowerCase();
    if (
      (lowerPhrase && line.includes(lowerPhrase)) ||
      tokens.some((token) => line.includes(token))
    ) {
      matches.push(index + 1);
    }
  }
  return matches;
}

function rangeForHit(
  file: IndexedFile,
  tokens: readonly string[],
  phrase: string,
): { startLine: number; endLine: number } {
  const lines = (file.text ?? "").split(/\r?\n/);
  const matches = matchingLines(lines, tokens, phrase);
  if (!matches.length) return { startLine: 1, endLine: Math.min(lines.length || 1, 220) };
  const first = Math.max(1, Math.min(...matches) - 12);
  const last = Math.min(lines.length || 1, Math.max(...matches) + 80);
  return { startLine: first, endLine: Math.min(last, first + 219) };
}

function labelForHit(file: IndexedFile, tokens: readonly string[]): string {
  const pathTokens = tokenize(file.relativeToRoot);
  const shared = tokens.filter((token) => pathTokens.includes(token)).slice(0, 4);
  if (shared.length) return `${file.kind} path match: ${shared.join(", ")}`;
  return `${file.kind} content match`;
}

function scoreFile(
  file: IndexedFile,
  query: string,
  tokens: readonly string[],
): SearchHit | undefined {
  const text = file.text ?? "";
  const lowerText = text.toLowerCase();
  const lowerPath = file.relativeToRoot.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  let score = 0;

  if (lowerQuery && lowerText.includes(lowerQuery)) score += 80;
  if (lowerQuery && lowerPath.includes(lowerQuery)) score += 60;
  for (const token of tokens) {
    if (lowerPath.includes(token)) score += 18;
    score += Math.min(30, countTokenOccurrences(lowerText, token)) * 2;
  }
  if (file.kind === "source") score += 3;
  if (file.kind === "test") score -= 1;
  if (file.kind === "docs") score += 1;
  if (score <= 0) return undefined;

  const range = rangeForHit(file, tokens, query);
  return { ...file, ...range, score, label: labelForHit(file, tokens) };
}

function confidence(hits: readonly SearchHit[]): string {
  if (!hits.length) return "none";
  if (hits[0]!.score >= 60) return "high";
  if (hits[0]!.score >= 20) return "medium";
  return "low";
}

function formatSpec(hit: SearchHit): string {
  return `${hit.relativeToCwd}:${hit.startLine}:${hit.endLine}`;
}

function groupHits(
  hits: readonly SearchHit[],
  kind: IndexedFile["kind"],
  limit: number,
): SearchHit[] {
  return hits.filter((hit) => hit.kind === kind).slice(0, limit);
}

function formatSearchOutput(
  input: SearchInput,
  scanResult: ScanResult,
  hits: readonly SearchHit[],
): string {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const primary = hits
    .filter((hit) => hit.kind !== "test" && hit.kind !== "docs")
    .slice(0, maxFiles);
  const tests = input.includeTests === false ? [] : groupHits(hits, "test", maxFiles);
  const docs = input.includeDocs === false ? [] : groupHits(hits, "docs", maxFiles);
  const selected = [...primary, ...docs, ...tests]
    .filter(
      (hit, index, all) =>
        all.findIndex((candidate) => candidate.relativeToCwd === hit.relativeToCwd) === index,
    )
    .slice(0, maxFiles);

  const lines = [
    `query: ${input.query}`,
    `root: ${scanResult.rootLabel}`,
    `confidence: ${confidence(hits)}`,
    "",
    "specs:",
    ...(selected.length ? selected.map((hit) => `- ${formatSpec(hit)}`) : ["- none"]),
    "",
    "groups:",
    `primary (${primary.length}):`,
    ...(primary.length ? primary.map((hit) => `  - ${formatSpec(hit)}`) : ["  - none"]),
  ];
  if (input.includeTests !== false) {
    lines.push(
      `tests (${tests.length}):`,
      ...(tests.length ? tests.map((hit) => `  - ${formatSpec(hit)}`) : ["  - none"]),
    );
  }
  if (input.includeDocs !== false) {
    lines.push(
      `docs (${docs.length}):`,
      ...(docs.length ? docs.map((hit) => `  - ${formatSpec(hit)}`) : ["  - none"]),
    );
  }
  lines.push(
    "",
    "notes:",
    `- candidates=${scanResult.files.length}${scanResult.truncated ? "+" : ""}`,
    `- tokens=${tokenize(input.query).join(",") || "none"}`,
    "- Read the listed ranges with read-many-files-lines before answering or editing.",
  );
  return lines.join("\n");
}

async function writeIndex(scanResult: ScanResult): Promise<void> {
  await mkdir(INDEX_DIR, { recursive: true });
  const payload = {
    version: 1,
    root: scanResult.root,
    rootLabel: scanResult.rootLabel,
    scannedAt: scanResult.scannedAt,
    fileCount: scanResult.files.length,
    truncated: scanResult.truncated,
    files: scanResult.files.map((file) => ({
      path: file.relativeToCwd,
      kind: file.kind,
      size: file.size,
      lineCount: file.lineCount,
    })),
  };
  await writeFile(INDEX_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function changedFileTokens(filePath: string): string[] {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const directory = path.dirname(filePath).split(path.sep).join("/");
  return tokenize(`${filePath} ${stem} ${directory}`).filter((token) => token.length > 2);
}

function impactCategory(file: IndexedFile): "Pages" | "API" | "Tests" | "Docs" | "Other" {
  const normalized = file.relativeToRoot.toLowerCase();
  if (file.kind === "test") return "Tests";
  if (file.kind === "docs") return "Docs";
  if (
    normalized.includes("/pages/") ||
    normalized.includes("/app/") ||
    normalized.endsWith("page.tsx")
  )
    return "Pages";
  if (normalized.includes("/api/") || normalized.includes("trpc") || normalized.includes("router"))
    return "API";
  return "Other";
}

function formatImpactOutput(
  input: ImpactInput,
  scanResult: ScanResult,
  hits: readonly SearchHit[],
): string {
  const maxResults = input.maxResults ?? DEFAULT_IMPACT_RESULTS;
  const filtered = hits
    .filter((hit) => input.includeTests !== false || hit.kind !== "test")
    .slice(0, maxResults);
  const categories = ["Pages", "API", "Tests", "Docs", "Other"] as const;
  const lines = [`changed: ${input.file}`, `root: ${scanResult.rootLabel}`, ""];
  for (const category of categories) {
    const items = filtered.filter((hit) => impactCategory(hit) === category);
    if (!items.length) continue;
    lines.push(`${category}:`, ...items.map((hit) => `- ${formatSpec(hit)} — ${hit.label}`), "");
  }
  if (!filtered.length) lines.push("No likely affected files found.");
  return lines.join("\n").trimEnd();
}

export default function projectIndex(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!shouldShowIndexStatus(ctx)) return;
    updateIndexStatus(ctx);
    void scan(ctx.cwd)
      .then((scanResult) => updateIndexStatus(ctx, scanResult))
      .catch(() => setIndexErrorStatus(ctx));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerTool({
    name: "project_index_status",
    label: "Project Index Status",
    description: "Get local project-index service status.",
    promptSnippet: "Get local project-index service status.",
    parameters: statusSchema,
    async execute(_toolCallId, params: StatusInput, _signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root);
      updateIndexStatus(ctx, scanResult);
      const text = [
        "status: ready",
        "mode: on-demand filesystem index",
        `root: ${scanResult.rootLabel}`,
        `files: ${scanResult.files.length}${scanResult.truncated ? "+" : ""}`,
        `indexedAt: ${scanResult.scannedAt}`,
        `cache: ${INDEX_FILE}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: scanResult };
    },
  });

  pi.registerTool({
    name: "project_index_refresh",
    label: "Refresh Project Index",
    description: "Refresh/rebuild local project index for a root.",
    promptSnippet: "Refresh/rebuild local project index for a root.",
    parameters: refreshSchema,
    async execute(_toolCallId, params: RefreshInput, _signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root, params.force ?? true);
      await writeIndex(scanResult);
      updateIndexStatus(ctx, scanResult);
      const text = [
        "refreshed: true",
        `root: ${scanResult.rootLabel}`,
        `files: ${scanResult.files.length}${scanResult.truncated ? "+" : ""}`,
        `index: ${INDEX_FILE}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: scanResult };
    },
  });

  pi.registerTool({
    name: "project_index_search",
    label: "Search Project Index",
    description:
      "Find likely relevant source files and line ranges for a project question. Returns read-many-files-lines specs and does not answer the domain question.",
    promptSnippet:
      "Find likely relevant source files and line ranges for a project question. Returns read-many-files-lines specs, not domain answers.",
    promptGuidelines: [
      "Use project_index_search before broad manual grep when locating app/wt/main implementation sources.",
      "Treat results as source candidates; read returned specs with read-many-files-lines before answering.",
    ],
    parameters: searchSchema,
    async execute(_toolCallId, params: SearchInput, _signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root);
      updateIndexStatus(ctx, scanResult);
      const tokens = tokenize(params.query);
      const hits = scanResult.files
        .filter((file) => params.includeTests !== false || file.kind !== "test")
        .filter((file) => params.includeDocs !== false || file.kind !== "docs")
        .flatMap((file) => scoreFile(file, params.query, tokens) ?? [])
        .sort((a, b) => b.score - a.score || a.relativeToCwd.localeCompare(b.relativeToCwd));
      return {
        content: [{ type: "text" as const, text: formatSearchOutput(params, scanResult, hits) }],
        details: { root: scanResult.rootLabel, hitCount: hits.length },
      };
    },
  });

  pi.registerTool({
    name: "project_index_impact",
    label: "Project Index Impact",
    description:
      "Find pages, tRPC procedures, and tests likely affected by a changed file using the project dependency map.",
    promptSnippet:
      "Find pages, tRPC procedures, and tests likely affected by a changed source file using the project dependency map.",
    promptGuidelines: [
      "Use project_index_impact when the user asks which pages, tRPC procedures, or tests are affected by changing a file.",
    ],
    parameters: impactSchema,
    async execute(_toolCallId, params: ImpactInput, _signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root);
      updateIndexStatus(ctx, scanResult);
      const tokens = changedFileTokens(params.file);
      const query = tokens.join(" ");
      const hits = scanResult.files
        .filter((file) => file.relativeToCwd !== params.file && file.relativeToRoot !== params.file)
        .flatMap((file) => scoreFile(file, query, tokens) ?? [])
        .sort((a, b) => b.score - a.score || a.relativeToCwd.localeCompare(b.relativeToCwd));
      return {
        content: [{ type: "text" as const, text: formatImpactOutput(params, scanResult, hits) }],
        details: { root: scanResult.rootLabel, hitCount: hits.length },
      };
    },
  });
}
