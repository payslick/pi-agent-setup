import { constants, type Dirent } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAccessPath } from "../access-mode/path-policy";
import { canAccessHostPaths, getAccessProjectRoot } from "../access-mode/state";
import {
  closeNativeSymbolAnalyzers,
  type NativeSymbolOperation,
  type NativeSymbolScope,
} from "./native-symbols";
import { nativeSymbolTimeoutMs, runNativeSymbolAnalysis } from "./native-symbol-runner";
import {
  impactSchema,
  type ImpactInput,
  refreshSchema,
  type RefreshInput,
  searchSchema,
  type SearchInput,
  statusSchema,
  type StatusInput,
} from "./tool-schemas";
import {
  closeProjectIndexCaches,
  type FileKind,
  type IndexedFile,
  indexedFileChange,
  projectIndexCache,
  sameIndexedFileMetadata,
  shouldUpsertIndexedFile,
  SQLITE_CACHE_PATH,
} from "./sqlite-cache";
const DEFAULT_MAX_FILES = 12;
const DEFAULT_IMPACT_RESULTS = 30;
const STATUS_KEY = "project-index";
function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
const limits = {
  visitedEntries: positiveIntegerEnv("PI_PROJECT_INDEX_MAX_VISITED_ENTRIES", 50_000, 1_000_000),
  acceptedFiles: positiveIntegerEnv("PI_PROJECT_INDEX_MAX_SCAN_FILES", 12_000, 100_000),
  fileBytes: positiveIntegerEnv("PI_PROJECT_INDEX_MAX_READ_BYTES", 300_000, 5_000_000),
  totalBytes: positiveIntegerEnv(
    "PI_PROJECT_INDEX_MAX_TOTAL_READ_BYTES",
    64 * 1024 * 1024,
    512 * 1024 * 1024,
  ),
  readConcurrency: positiveIntegerEnv("PI_PROJECT_INDEX_READ_CONCURRENCY", 8, 32),
} as const;
type ImpactCategory = "API" | "Pages" | "Tests" | "Docs" | "Other";
interface SearchHit extends IndexedFile {
  score: number;
  startLine: number;
  endLine: number;
  evidence: string[];
}
interface ScanStats {
  visitedEntries: number;
  acceptedBytes: number;
  reusedFiles: number;
  rereadFiles: number;
  readErrors: number;
  addedFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  forced: boolean;
  truncationReasons: string[];
}
interface ScanResult {
  cwd: string;
  root: string;
  rootLabel: string;
  files: IndexedFile[];
  reconciledAt: string;
  stats: ScanStats;
}
interface ListedFiles {
  files: IndexedFile[];
  visitedEntries: number;
  acceptedBytes: number;
  truncationReasons: string[];
}
type Dependency = { specifier: string; line: number };
type ReverseEdge = Dependency & { importer: IndexedFile };
type ImpactHit = ReverseEdge & { distance: number };
const excludedDirs = new Set(
  ".git .next .turbo .cache coverage dist build node_modules".split(" "),
);
const sourceExtensionList =
  ".bash .c .cc .cjs .cpp .css .cs .cts .cxx .go .gql .graphql .h .hh .hpp .html .java .js .jsx .kt .kts .less .mjs .mts .php .prisma .py .rb .rs .sass .scss .sh .sql .svelte .ts .tsx .vue .zsh".split(
    " ",
  );
const sourceExtensions = new Set(sourceExtensionList);
const textExtensions = new Set([
  ...sourceExtensionList,
  ...".csv .json .jsonc .md .mdx .svg .toml .txt .xml .yaml .yml".split(" "),
]);
const moduleExtensions = [...sourceExtensionList, ".json", ".jsonc"];
const visibleDotEntries = new Set(".dockerignore .env.example .github .gitignore .pi".split(" "));
const extensionlessTextFiles = new Set(
  ".dockerignore .env.example .gitignore dockerfile license makefile readme".split(" "),
);
const stopWords = new Set(
  "a an and are as be by for from has how in is it of on or pr the to use what when where with".split(
    " ",
  ),
);
const dependencyPatterns = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?["']([^"'`]+)["']/g,
  /\bimport\s*\(\s*["']([^"'`]+)["']/g,
  /\brequire(?:\.resolve)?\s*\(\s*["']([^"'`]+)["']/g,
  /\b(?:jest|vi)\s*\.\s*(?:doMock|mock|requireActual|setMock|unmock|unstable_mockModule)\s*\(\s*["']([^"'`]+)["']/g,
  /\bmock\s*\.\s*module\s*\(\s*["']([^"'`]+)["']/g,
];
const impactCategoryOrder: readonly ImpactCategory[] = ["API", "Pages", "Tests", "Docs", "Other"];
let lastScan: ScanResult | undefined;
function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Project index operation aborted.");
}
function slashPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new Error(`${label} does not exist: ${candidate}`);
  }
  const metadata = await stat(canonical).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`${label} is not a directory: ${candidate}`);
  try {
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`${label} is not readable: ${candidate}`);
  }
  return canonical;
}
async function resolveProjectRoot(
  cwd: string,
  requestedRoot?: string,
): Promise<{ cwd: string; root: string }> {
  const canonicalCwd = await canonicalDirectory(cwd, "Current working directory");
  const projectRoot = getAccessProjectRoot(cwd);
  const canonicalProjectRoot = await canonicalDirectory(projectRoot, "Access project root");
  if (requestedRoot?.trim()) {
    const candidate = resolveAccessPath(cwd, requestedRoot.trim());
    const root = await canonicalDirectory(candidate, "Requested root");
    if (!canAccessHostPaths() && !isInside(canonicalProjectRoot, root)) {
      throw new Error(`Requested root is outside the project: ${requestedRoot}`);
    }
    return { cwd: canonicalCwd, root };
  }
  try {
    const root = await canonicalDirectory(path.join(cwd, "app", "wt", "main"), "Default root");
    if (isInside(canonicalCwd, root)) return { cwd: canonicalCwd, root };
  } catch {}
  return { cwd: canonicalCwd, root: canonicalCwd };
}
function rootLabel(cwd: string, root: string): string {
  return slashPath(path.relative(cwd, root)) || ".";
}
function isProbablyTextFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (textExtensions.has(extension)) return true;
  return extensionlessTextFiles.has(path.basename(filePath).toLowerCase());
}
function classifyFile(relativePath: string): FileKind {
  const normalized = relativePath.toLowerCase();
  const parts = normalized.split("/");
  const base = parts.at(-1) ?? normalized;
  if (
    parts.some((part) => part === "test" || part === "tests" || part === "__tests__") ||
    /(?:^|[._-])(test|spec|e2e)\.[cm]?[jt]sx?$/.test(base) ||
    /(?:^test_.*|.*_test)\.py$/.test(base)
  ) {
    return "test";
  }
  if (
    parts.some((part) => part === "doc" || part === "docs" || part === "prd") ||
    base.startsWith("readme") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  ) {
    return "docs";
  }
  return sourceExtensions.has(path.extname(normalized)) ? "source" : "other";
}
async function listFiles(root: string, cwd: string, signal?: AbortSignal): Promise<ListedFiles> {
  const files: IndexedFile[] = [];
  const truncationReasons = new Set<string>();
  let visitedEntries = 0;
  let acceptedBytes = 0;
  let stopped = false;
  async function visit(directory: string): Promise<void> {
    abortIfRequested(signal);
    if (stopped) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      truncationReasons.add("unreadable-entry");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      abortIfRequested(signal);
      if (visitedEntries >= limits.visitedEntries) {
        truncationReasons.add("visited-entry-limit");
        stopped = true;
        return;
      }
      visitedEntries += 1;
      if (files.length >= limits.acceptedFiles) {
        truncationReasons.add("accepted-file-limit");
        stopped = true;
        return;
      }
      if (entry.name.startsWith(".") && !visibleDotEntries.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativeToRoot = slashPath(path.relative(root, absolutePath));
      const parts = relativeToRoot.split("/");
      if (parts.some((part) => excludedDirs.has(part.toLowerCase()))) continue;
      if (relativeToRoot.startsWith(".pi/tmp/") || relativeToRoot.startsWith(".pi/index/"))
        continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        if (stopped) return;
        continue;
      }
      if (!entry.isFile() || !isProbablyTextFile(absolutePath)) continue;
      let metadata;
      try {
        metadata = await stat(absolutePath);
      } catch {
        truncationReasons.add("unreadable-entry");
        continue;
      }
      if (metadata.size > limits.fileBytes) {
        truncationReasons.add("per-file-byte-limit");
        continue;
      }
      if (acceptedBytes + metadata.size > limits.totalBytes) {
        truncationReasons.add("aggregate-byte-limit");
        continue;
      }
      acceptedBytes += metadata.size;
      files.push({
        absolutePath,
        relativeToRoot,
        relativeToCwd: slashPath(path.relative(cwd, absolutePath)),
        kind: classifyFile(relativeToRoot),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        lineCount: 0,
      });
    }
  }
  await visit(root);
  return {
    files,
    visitedEntries,
    acceptedBytes,
    truncationReasons: [...truncationReasons].sort(),
  };
}
async function readIndexedFile(file: IndexedFile, signal?: AbortSignal): Promise<IndexedFile> {
  abortIfRequested(signal);
  let handle;
  try {
    handle = await open(file.absolutePath, "r");
    const before = await handle.stat();
    if (
      before.size !== file.size ||
      before.mtimeMs !== file.mtimeMs ||
      before.ctimeMs !== file.ctimeMs
    ) {
      return file;
    }
    const buffer = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < file.size) {
      abortIfRequested(signal);
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        Math.min(64 * 1024, file.size - offset),
        offset,
      );
      if (!bytesRead) return file;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== file.size ||
      after.mtimeMs !== file.mtimeMs ||
      after.ctimeMs !== file.ctimeMs
    ) {
      return file;
    }
    const text = buffer.toString("utf8");
    return { ...file, text, lineCount: text.split(/\r?\n/).length };
  } catch {
    abortIfRequested(signal);
    return file;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
async function mapConcurrent<T, U>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<U>,
  signal?: AbortSignal,
): Promise<U[]> {
  const results = items.map(() => undefined as U);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      abortIfRequested(signal);
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
async function scan(
  cwd: string,
  requestedRoot?: string,
  force = false,
  signal?: AbortSignal,
): Promise<ScanResult> {
  abortIfRequested(signal);
  const resolved = await resolveProjectRoot(cwd, requestedRoot);
  const cache = projectIndexCache(resolved.cwd);
  const previous =
    lastScan?.cwd === resolved.cwd && lastScan.root === resolved.root
      ? lastScan
      : { files: cache.load(resolved.cwd, resolved.root) };
  const listed = await listFiles(resolved.root, resolved.cwd, signal);
  const previousByPath = new Map(
    previous?.files.map((file) => [file.absolutePath, file] as const) ?? [],
  );
  const currentPaths = new Set(listed.files.map((file) => file.absolutePath));
  let reusedFiles = 0;
  let rereadFiles = 0;
  let addedFiles = 0;
  let modifiedFiles = 0;
  const files = await mapConcurrent(
    listed.files,
    limits.readConcurrency,
    async (file) => {
      const oldFile = previousByPath.get(file.absolutePath);
      const change = indexedFileChange(file, oldFile);
      if (change === "added") addedFiles += 1;
      if (change === "modified") modifiedFiles += 1;
      if (!force && oldFile?.text !== undefined && sameIndexedFileMetadata(file, oldFile)) {
        reusedFiles += 1;
        return { ...file, text: oldFile.text, lineCount: oldFile.lineCount };
      }
      rereadFiles += 1;
      return readIndexedFile(file, signal);
    },
    signal,
  );
  const deletedPaths = previous.files
    .filter((file) => !currentPaths.has(file.absolutePath))
    .map((file) => file.absolutePath);
  const readErrors = files.filter((file) => file.text === undefined).length;
  const truncationReasons = new Set(listed.truncationReasons);
  if (readErrors) truncationReasons.add("read-error");
  const result: ScanResult = {
    ...resolved,
    rootLabel: rootLabel(resolved.cwd, resolved.root),
    files,
    reconciledAt: new Date().toISOString(),
    stats: {
      visitedEntries: listed.visitedEntries,
      acceptedBytes: listed.acceptedBytes,
      reusedFiles,
      rereadFiles,
      readErrors,
      addedFiles,
      modifiedFiles,
      deletedFiles: deletedPaths.length,
      forced: force,
      truncationReasons: [...truncationReasons].sort(),
    },
  };
  const upserts = files.filter((file) =>
    shouldUpsertIndexedFile(file, previousByPath.get(file.absolutePath), force),
  );
  const persisted = cache.reconcile(resolved.cwd, resolved.root, upserts, deletedPaths);
  lastScan = persisted ? result : undefined;
  return result;
}
function scanSummary(scanResult: ScanResult) {
  const { stats } = scanResult;
  return {
    root: scanResult.rootLabel,
    reconciledAt: scanResult.reconciledAt,
    files: scanResult.files.length,
    acceptedBytes: stats.acceptedBytes,
    visitedEntries: stats.visitedEntries,
    truncated: stats.truncationReasons.length > 0,
    truncationReasons: stats.truncationReasons,
    changes: {
      added: stats.addedFiles,
      modified: stats.modifiedFiles,
      deleted: stats.deletedFiles,
    },
    reads: {
      forced: stats.forced,
      reread: stats.rereadFiles,
      reused: stats.reusedFiles,
      errors: stats.readErrors,
    },
    limits,
    diskCache: SQLITE_CACHE_PATH,
  };
}
function shouldShowIndexStatus(ctx: ExtensionContext): boolean {
  return ctx.hasUI && !process.env.PI_SUBAGENT_ID;
}
function updateIndexStatus(ctx: ExtensionContext, scanResult?: ScanResult): void {
  if (!shouldShowIndexStatus(ctx)) return;
  if (!scanResult) {
    ctx.ui.setStatus(STATUS_KEY, "index:scanning");
    return;
  }
  const suffix = scanResult.stats.truncationReasons.length ? "+" : "";
  ctx.ui.setStatus(STATUS_KEY, `index:ready ${scanResult.files.length}${suffix}`);
}
function setIndexErrorStatus(ctx: ExtensionContext): void {
  if (shouldShowIndexStatus(ctx)) ctx.ui.setStatus(STATUS_KEY, "index:error");
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
  let count = 0;
  let cursor = 0;
  while (token && cursor < haystack.length) {
    const index = haystack.indexOf(token, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + token.length;
    if (count >= 30) break;
  }
  return count;
}
function rangeForHit(
  file: IndexedFile,
  tokens: readonly string[],
  phrase: string,
): { startLine: number; endLine: number } {
  const lines = (file.text ?? "").split(/\r?\n/);
  const lowerPhrase = phrase.toLowerCase().trim();
  const matchingLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.toLowerCase();
    if (
      (lowerPhrase && line.includes(lowerPhrase)) ||
      tokens.some((token) => line.includes(token))
    ) {
      matchingLines.push(index + 1);
    }
  }
  if (!matchingLines.length) return { startLine: 1, endLine: Math.min(lines.length || 1, 220) };
  const first = Math.max(1, Math.min(...matchingLines) - 12);
  const last = Math.min(lines.length || 1, Math.max(...matchingLines) + 80);
  return { startLine: first, endLine: Math.min(last, first + 219) };
}
function scoreFile(
  file: IndexedFile,
  query: string,
  tokens: readonly string[],
): SearchHit | undefined {
  const lowerText = (file.text ?? "").toLowerCase();
  const lowerPath = file.relativeToRoot.toLowerCase();
  const phrase = query.toLowerCase().trim();
  const phraseInPath = Boolean(phrase && lowerPath.includes(phrase));
  const phraseInContent = Boolean(phrase && lowerText.includes(phrase));
  const pathTokens = tokens.filter((token) => lowerPath.includes(token));
  const contentTokens = tokens.filter((token) => lowerText.includes(token));
  const matchedTokenCount = new Set([...pathTokens, ...contentTokens]).size;
  const hasTokenEvidence = matchedTokenCount > tokens.length / 2;
  if (!phraseInPath && !phraseInContent && !hasTokenEvidence) return undefined;
  let score = phraseInContent ? 80 : 0;
  if (phraseInPath) score += 60;
  score += pathTokens.length * 18;
  for (const token of contentTokens) {
    score += Math.min(30, countTokenOccurrences(lowerText, token)) * 2;
  }
  if (file.kind === "source") score += 3;
  if (file.kind === "test") score -= 1;
  if (file.kind === "docs") score += 1;
  const evidence = [
    ...(phraseInPath ? ["phrase:path"] : []),
    ...(phraseInContent ? ["phrase:content"] : []),
    ...(pathTokens.length ? [`tokens:path=${pathTokens.join(",")}`] : []),
    ...(contentTokens.length ? [`tokens:content=${contentTokens.join(",")}`] : []),
  ];
  return {
    ...file,
    ...rangeForHit(file, tokens, query),
    score,
    evidence,
  };
}
function confidence(hits: readonly SearchHit[]): string {
  if (!hits.length) return "none";
  if (hits[0]!.score >= 60) return "high";
  if (hits[0]!.score >= 20) return "medium";
  return "low";
}
function formatSpec(hit: Pick<SearchHit, "relativeToCwd" | "startLine" | "endLine">): string {
  return `${hit.relativeToCwd}:${hit.startLine}:${hit.endLine}`;
}
function formatSourceSearchOutput(
  input: SearchInput,
  scanResult: ScanResult,
  allHits: readonly SearchHit[],
  selected: readonly SearchHit[],
): string {
  const query = input.query ?? "";
  const primary = selected.filter((hit) => hit.kind !== "test" && hit.kind !== "docs");
  const tests = selected.filter((hit) => hit.kind === "test");
  const docs = selected.filter((hit) => hit.kind === "docs");
  const lines = [
    `query: ${query}`,
    `root: ${scanResult.rootLabel}`,
    `confidence: ${confidence(allHits)}`,
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
    `- indexed-files=${scanResult.files.length}`,
    `- matching-files=${allHits.length}; reported=${selected.length}`,
    `- tokens=${tokenize(query).join(",") || "none"}`,
    "- Read the listed ranges with read-many-files-lines before answering or editing.",
  );
  return lines.join("\n");
}
function formatDebugSearchOutput(
  input: SearchInput,
  scanResult: ScanResult,
  allHits: readonly SearchHit[],
  selected: readonly SearchHit[],
): string {
  const lines = [
    `query: ${input.query ?? ""}`,
    "mode: debug",
    `root: ${scanResult.rootLabel}`,
    `confidence: ${confidence(allHits)}`,
    `matching-files: ${allHits.length}`,
    `reported: ${selected.length}`,
    "",
    "ranking:",
  ];
  if (!selected.length) lines.push("- none (no phrase or token evidence)");
  selected.forEach((hit, index) => {
    lines.push(
      `${index + 1}. ${formatSpec(hit)}`,
      `   score=${hit.score}; kind=${hit.kind}; evidence=${hit.evidence.join("; ")}`,
    );
  });
  lines.push(
    "",
    "ranking-notes:",
    "- Exact phrase evidence outranks token evidence; path evidence receives an additional boost.",
    "- Ties are ordered by project-relative path.",
  );
  return lines.join("\n");
}
function dependenciesIn(text: string): Dependency[] {
  const matches: Array<{ specifier: string; index: number }> = [];
  const seen = new Set<string>();
  for (const pattern of dependencyPatterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || match.index === undefined) continue;
      const key = `${match.index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ specifier, index: match.index });
    }
  }
  matches.sort((a, b) => a.index - b.index || a.specifier.localeCompare(b.specifier));
  let cursor = 0;
  let line = 1;
  return matches.map((match) => {
    while (true) {
      const newline = text.indexOf("\n", cursor);
      if (newline < 0 || newline >= match.index) break;
      line += 1;
      cursor = newline + 1;
    }
    return { specifier: match.specifier, line };
  });
}
function moduleCandidates(base: string): string[] {
  const candidates = [base];
  for (const extension of moduleExtensions) candidates.push(`${base}${extension}`);
  for (const extension of moduleExtensions) candidates.push(path.join(base, `index${extension}`));
  const extension = path.extname(base).toLowerCase();
  if ([".cjs", ".js", ".jsx", ".mjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}
function dependencyBases(importer: IndexedFile, specifier: string, root: string): string[] {
  const suffixIndex = specifier.search(/[?#]/);
  const clean = suffixIndex > 0 ? specifier.slice(0, suffixIndex) : specifier;
  if (!clean || clean.startsWith("node:")) return [];
  if (clean.startsWith(".")) return [path.resolve(path.dirname(importer.absolutePath), clean)];
  if (clean.startsWith("@/") || clean.startsWith("~/")) {
    const relative = clean.slice(2);
    return [path.resolve(root, relative), path.resolve(root, "src", relative)];
  }
  if (clean.startsWith("/")) return [path.resolve(root, clean.slice(1))];
  return [path.resolve(root, clean), path.resolve(root, "src", clean)];
}
function resolveDependency(
  importer: IndexedFile,
  specifier: string,
  root: string,
  filesByAbsolutePath: ReadonlyMap<string, IndexedFile>,
): IndexedFile | undefined {
  for (const base of dependencyBases(importer, specifier, root)) {
    for (const candidate of moduleCandidates(base)) {
      const target = filesByAbsolutePath.get(candidate);
      if (target) return target;
    }
  }
  return undefined;
}
function buildReverseGraph(scanResult: ScanResult): Map<string, ReverseEdge[]> {
  const filesByAbsolutePath = new Map(
    scanResult.files.map((file) => [path.normalize(file.absolutePath), file] as const),
  );
  const reverse = new Map<string, ReverseEdge[]>();
  const seenEdges = new Set<string>();
  for (const importer of scanResult.files) {
    if (importer.text === undefined) continue;
    for (const dependency of dependenciesIn(importer.text)) {
      const target = resolveDependency(
        importer,
        dependency.specifier,
        scanResult.root,
        filesByAbsolutePath,
      );
      if (!target || target.absolutePath === importer.absolutePath) continue;
      const edgeKey = `${target.absolutePath}\0${importer.absolutePath}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      const edges = reverse.get(target.absolutePath) ?? [];
      edges.push({ importer, ...dependency });
      reverse.set(target.absolutePath, edges);
    }
  }
  for (const edges of reverse.values()) {
    edges.sort((a, b) => a.importer.relativeToCwd.localeCompare(b.importer.relativeToCwd));
  }
  return reverse;
}
function resolveChangedFile(input: string, scanResult: ScanResult): IndexedFile | undefined {
  const normalizedInput = slashPath(input.trim()).replace(/^\.\//, "");
  const exact = scanResult.files.find(
    (file) =>
      file.relativeToCwd === normalizedInput ||
      file.relativeToRoot === normalizedInput ||
      slashPath(file.absolutePath) === normalizedInput,
  );
  if (exact) return exact;
  const filesByAbsolutePath = new Map(
    scanResult.files.map((file) => [path.normalize(file.absolutePath), file] as const),
  );
  const bases =
    path.isAbsolute(input) || input.startsWith("~")
      ? [resolveAccessPath(scanResult.cwd, input)]
      : [resolveAccessPath(scanResult.cwd, input), resolveAccessPath(scanResult.root, input)];
  for (const base of bases) {
    for (const candidate of moduleCandidates(base)) {
      const file = filesByAbsolutePath.get(candidate);
      if (file) return file;
    }
  }
  return undefined;
}
function impactCategory(file: IndexedFile): ImpactCategory {
  const normalized = file.relativeToRoot.toLowerCase();
  const parts = normalized.split("/");
  if (file.kind === "test") return "Tests";
  if (file.kind === "docs") return "Docs";
  if (parts.includes("api") || normalized.includes("trpc") || normalized.includes("router")) {
    return "API";
  }
  if (parts.includes("pages") || parts.includes("app") || /(?:^|\/)page\.[^.]+$/.test(normalized))
    return "Pages";
  return "Other";
}
function collectImpactHits(
  changed: IndexedFile,
  reverse: ReadonlyMap<string, ReverseEdge[]>,
): ImpactHit[] {
  const hits: ImpactHit[] = [];
  const seen = new Set([changed.absolutePath]);
  const queue: Array<{ file: IndexedFile; distance: number }> = [{ file: changed, distance: 0 }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const edge of reverse.get(current.file.absolutePath) ?? []) {
      if (seen.has(edge.importer.absolutePath)) continue;
      seen.add(edge.importer.absolutePath);
      const distance = current.distance + 1;
      hits.push({ ...edge, distance });
      queue.push({ file: edge.importer, distance });
    }
  }
  return hits.sort(
    (a, b) =>
      a.distance - b.distance ||
      impactCategoryOrder.indexOf(impactCategory(a.importer)) -
        impactCategoryOrder.indexOf(impactCategory(b.importer)) ||
      a.importer.relativeToCwd.localeCompare(b.importer.relativeToCwd),
  );
}
function formatImpactSpec(hit: ImpactHit): string {
  const start = Math.max(1, hit.line - 2);
  const end = Math.min(hit.importer.lineCount || hit.line, hit.line + 2);
  return `${hit.importer.relativeToCwd}:${start}:${Math.max(start, end)}`;
}
function appendImpactSection(lines: string[], title: string, hits: readonly ImpactHit[]): void {
  lines.push(`${title} (${hits.length}):`);
  if (!hits.length) {
    lines.push("- none", "");
    return;
  }
  for (const category of impactCategoryOrder) {
    const categoryHits = hits.filter((hit) => impactCategory(hit.importer) === category);
    if (!categoryHits.length) continue;
    lines.push(`${category}:`);
    for (const hit of categoryHits) {
      const relation = hit.distance === 1 ? "direct" : `${hit.distance} hops`;
      lines.push(`- ${formatImpactSpec(hit)} — ${relation} via ${hit.specifier}`);
    }
  }
  lines.push("");
}
function formatImpactOutput(
  input: ImpactInput,
  scanResult: ScanResult,
  changed: IndexedFile | undefined,
  allHits: readonly ImpactHit[],
  selected: readonly ImpactHit[],
): string {
  if (!changed) {
    return [
      `changed: ${input.file}`,
      `root: ${scanResult.rootLabel}`,
      "resolved: false",
      "",
      "Changed file is not present in the bounded project index; no impact results were inferred.",
    ].join("\n");
  }
  const direct = selected.filter((hit) => hit.distance === 1);
  const transitive = selected.filter((hit) => hit.distance > 1);
  const lines = [
    `changed: ${changed.relativeToCwd}`,
    `root: ${scanResult.rootLabel}`,
    "resolved: true",
    `importers: ${allHits.length}; reported: ${selected.length}`,
    "",
  ];
  appendImpactSection(lines, "direct importers", direct);
  appendImpactSection(lines, "transitive importers", transitive);
  if (!allHits.length) lines.push("No reverse dependencies found; no lexical fallback was used.");
  return lines.join("\n").trimEnd();
}
function statusText(scanResult: ScanResult): string {
  const summary = scanSummary(scanResult);
  return [
    "status: ready",
    "mode: SQLite-persisted incremental filesystem index",
    `root: ${summary.root}`,
    `files: ${summary.files}`,
    `visitedEntries: ${summary.visitedEntries}`,
    `acceptedBytes: ${summary.acceptedBytes}`,
    `changes: added=${summary.changes.added}, modified=${summary.changes.modified}, deleted=${summary.changes.deleted}`,
    `reads: reread=${summary.reads.reread}, reused=${summary.reads.reused}, errors=${summary.reads.errors}`,
    `truncated: ${summary.truncated}${summary.truncated ? ` (${summary.truncationReasons.join(", ")})` : ""}`,
    `reconciledAt: ${summary.reconciledAt}`,
    `diskCache: ${summary.diskCache}`,
  ].join("\n");
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
    lastScan = undefined;
    closeProjectIndexCaches();
    void closeNativeSymbolAnalyzers();
  });
  registerSummaryTools(pi);
  registerAnalysisTools(pi);
}
function registerSummaryTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_index_status",
    label: "Project Index Status",
    description: "Reconcile the filesystem and report local persisted project-index status.",
    promptSnippet: "Reconcile the filesystem and report local project-index status.",
    parameters: statusSchema,
    async execute(_toolCallId, params: StatusInput, signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root, false, signal);
      updateIndexStatus(ctx, scanResult);
      return {
        content: [{ type: "text" as const, text: statusText(scanResult) }],
        details: scanSummary(scanResult),
      };
    },
  });
  pi.registerTool({
    name: "project_index_refresh",
    label: "Refresh Project Index",
    description: "Reconcile the persisted project index, optionally rereading every accepted file.",
    promptSnippet: "Refresh the persisted project index for a root.",
    parameters: refreshSchema,
    async execute(_toolCallId, params: RefreshInput, signal, _onUpdate, ctx) {
      const force = params.force ?? false;
      const scanResult = await scan(ctx.cwd, params.root, force, signal);
      updateIndexStatus(ctx, scanResult);
      const summary = scanSummary(scanResult);
      const text = [
        "refreshed: true",
        `force: ${force}`,
        `root: ${summary.root}`,
        `files: ${summary.files}`,
        `reads: reread=${summary.reads.reread}, reused=${summary.reads.reused}, errors=${summary.reads.errors}`,
        `truncated: ${summary.truncated}${summary.truncated ? ` (${summary.truncationReasons.join(", ")})` : ""}`,
        `diskCache: ${summary.diskCache}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: summary };
    },
  });
}
function registerAnalysisTools(pi: ExtensionAPI): void {
  registerSearchTool(pi);
  registerImpactTool(pi);
}
function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_index_search",
    label: "Search Project Index",
    description:
      "Find evidence-backed source ranges or exact TypeScript 7 native symbol definitions, references, callers, and users.",
    promptSnippet:
      "Find evidence-backed project files or exact structural symbol results, not domain answers.",
    promptGuidelines: [
      "Use project_index_search before broad manual grep when locating app/wt/main implementation sources.",
      "Use mode=symbol for exact definition, reference, caller, user, and count questions.",
      "Treat symbol counts as exact only when complete=true.",
      "Treat source results as candidates; read returned specs before answering.",
    ],
    parameters: searchSchema,
    async execute(_toolCallId, params: SearchInput, signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root, false, signal);
      if (params.mode !== "symbol") updateIndexStatus(ctx, scanResult);
      if (params.mode === "symbol") {
        const symbol = params.symbol?.trim();
        if (!symbol) throw new Error("Symbol mode requires a non-empty symbol.");
        const operation = (params.operation ?? "usingFunctions") as NativeSymbolOperation;
        const scope = (params.scope ?? "all") as NativeSymbolScope;
        const analysis = await runNativeSymbolAnalysis({
          root: scanResult.root,
          rootLabel: scanResult.rootLabel,
          symbol,
          operation,
          scope,
          maxResults: params.maxResults ?? 100,
          files: scanResult.files,
          truncationReasons: scanResult.stats.truncationReasons,
          signal,
          timeoutMs: nativeSymbolTimeoutMs(),
          onStart: () =>
            shouldShowIndexStatus(ctx) && ctx.ui.setStatus(STATUS_KEY, `index:analyzing ${symbol}`),
          onFinish: () => updateIndexStatus(ctx, scanResult),
        });
        return {
          content: [{ type: "text" as const, text: analysis.text }],
          details: analysis.details,
        };
      }
      const query = params.query?.trim();
      if (!query) throw new Error("Source and debug search require a non-empty query.");
      const tokens = tokenize(query);
      const hits = scanResult.files
        .filter((file) => params.includeTests !== false || file.kind !== "test")
        .filter((file) => params.includeDocs !== false || file.kind !== "docs")
        .flatMap((file) => scoreFile(file, query, tokens) ?? [])
        .sort((a, b) => b.score - a.score || a.relativeToCwd.localeCompare(b.relativeToCwd));
      const selected = hits.slice(0, params.maxFiles ?? DEFAULT_MAX_FILES);
      const text =
        params.mode === "debug"
          ? formatDebugSearchOutput(params, scanResult, hits, selected)
          : formatSourceSearchOutput(params, scanResult, hits, selected);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          root: scanResult.rootLabel,
          mode: params.mode ?? "sources",
          matchingFiles: hits.length,
          reportedFiles: selected.length,
        },
      };
    },
  });
}
function registerImpactTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_index_impact",
    label: "Project Index Impact",
    description:
      "Find direct and transitive pages, API modules, and tests affected by a changed indexed file using a reverse import graph.",
    promptSnippet:
      "Find direct and transitive importers of a changed source file using the project reverse import graph.",
    promptGuidelines: [
      "Use project_index_impact when the user asks which pages, tRPC procedures, or tests are affected by changing a file.",
    ],
    parameters: impactSchema,
    async execute(_toolCallId, params: ImpactInput, signal, _onUpdate, ctx) {
      const scanResult = await scan(ctx.cwd, params.root, false, signal);
      updateIndexStatus(ctx, scanResult);
      abortIfRequested(signal);
      const changed = resolveChangedFile(params.file, scanResult);
      const hits = changed ? collectImpactHits(changed, buildReverseGraph(scanResult)) : [];
      const eligible = hits.filter(
        (hit) => params.includeTests !== false || hit.importer.kind !== "test",
      );
      const selected = eligible.slice(0, params.maxResults ?? DEFAULT_IMPACT_RESULTS);
      return {
        content: [
          {
            type: "text" as const,
            text: formatImpactOutput(params, scanResult, changed, eligible, selected),
          },
        ],
        details: {
          root: scanResult.rootLabel,
          resolved: Boolean(changed),
          directImporters: eligible.filter((hit) => hit.distance === 1).length,
          transitiveImporters: eligible.filter((hit) => hit.distance > 1).length,
          reportedFiles: selected.length,
        },
      };
    },
  });
}
