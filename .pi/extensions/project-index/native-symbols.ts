import path from "node:path";
import {
  API,
  DiagnosticCategory,
  ModifierFlags,
  SymbolFlags,
  type Project,
  type Snapshot,
  type Symbol as NativeSymbol,
} from "@typescript/native-preview/async";
import type { Identifier, Node, SourceFile } from "@typescript/native-preview/ast";
import {
  isCallExpression,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isTypeNode,
} from "@typescript/native-preview/ast/is";

export type NativeSymbolOperation =
  | "definitions"
  | "references"
  | "callingFunctions"
  | "usingFunctions";
export type NativeSymbolScope = "source" | "test" | "all";

export interface NativeSymbolFile {
  absolutePath: string;
  relativeToCwd: string;
  relativeToRoot: string;
  kind: "source" | "test" | "docs" | "other";
  text?: string;
}

export interface NativeSymbolRequest {
  root: string;
  rootLabel: string;
  symbol: string;
  operation: NativeSymbolOperation;
  scope: NativeSymbolScope;
  maxResults: number;
  files: readonly NativeSymbolFile[];
  truncationReasons: readonly string[];
  signal?: AbortSignal;
}

interface Occurrence {
  file: NativeSymbolFile;
  sourceFile: SourceFile;
  project: Project;
  node: Identifier;
  symbol?: NativeSymbol;
  canonical?: NativeSymbol;
}

interface SymbolLocation {
  path: string;
  line: number;
  column: number;
  label: string;
}

export interface NativeSymbolAnalysis {
  text: string;
  details: {
    root: string;
    mode: "symbol";
    symbol: string;
    operation: NativeSymbolOperation;
    scope: NativeSymbolScope;
    count: number;
    complete: boolean;
    reasons: string[];
  };
}

const scriptExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const activeApis = new Set<API>();

function normalized(filePath: string): string {
  const value = path.normalize(filePath);
  return process.platform === "win32" || process.platform === "darwin"
    ? value.toLowerCase()
    : value;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Native symbol analysis aborted.");
}

function identifiersIn(sourceFile: SourceFile): Identifier[] {
  const identifiers: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) identifiers.push(node);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return identifiers;
}

function position(text: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset);
  const line = before.split("\n").length;
  const newline = before.lastIndexOf("\n");
  return { line, column: safeOffset - newline };
}

function withinScope(file: NativeSymbolFile, scope: NativeSymbolScope): boolean {
  if (scope === "all") return file.kind === "source" || file.kind === "test";
  return file.kind === scope;
}

function isImportOrExportNode(node: Node): boolean {
  return (
    isImportDeclaration(node) ||
    isImportEqualsDeclaration(node) ||
    isImportClause(node) ||
    isImportSpecifier(node) ||
    isExportDeclaration(node) ||
    isExportSpecifier(node)
  );
}

function isDefinitionIdentifier(node: Identifier): boolean {
  const parent = node.parent as Node & { name?: Node };
  return parent.name === node && !isImportOrExportNode(parent);
}

function isRuntimeReference(node: Identifier): boolean {
  if (isDefinitionIdentifier(node)) return false;
  let current: Node | undefined = node;
  while (current && current.kind !== current.getSourceFile().kind) {
    if (isImportOrExportNode(current) || isTypeNode(current)) return false;
    current = current.parent;
  }
  return true;
}

function enclosingFunction(node: Node): Node | undefined {
  let current: Node | undefined = node.parent;
  while (current && current.kind !== current.getSourceFile().kind) {
    if (isFunctionLikeDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isDirectCall(node: Identifier): boolean {
  let expression: Node = node;
  let parent: Node | undefined = node.parent;
  while (parent && parent.kind !== parent.getSourceFile().kind) {
    if (isCallExpression(parent)) return parent.expression === expression;
    if (isFunctionLikeDeclaration(parent)) return false;
    const shaped = parent as Node & { expression?: Node };
    if (shaped.expression !== expression) return false;
    expression = parent;
    parent = parent.parent;
  }
  return false;
}

function functionNameNode(node: Node): Identifier | undefined {
  const ownName = (node as Node & { name?: Node }).name;
  if (ownName && isIdentifier(ownName)) return ownName;
  const parentName = (node.parent as Node & { name?: Node }).name;
  return parentName && isIdentifier(parentName) ? parentName : undefined;
}

function functionName(node: Node): string {
  return functionNameNode(node)?.text ?? "anonymous";
}

function declarationIsExported(node: Node): boolean {
  let current: Node | undefined = node;
  while (current && current.kind !== current.getSourceFile().kind) {
    if (current !== node && isFunctionLikeDeclaration(current)) return false;
    const modifierFlags = (current as Node & { modifierFlags?: number }).modifierFlags ?? 0;
    if (modifierFlags & ModifierFlags.Export) return true;
    current = current.parent;
  }
  return false;
}

function declarationIsModuleLevel(node: Node): boolean {
  let current: Node | undefined = node.parent;
  while (current && current.kind !== current.getSourceFile().kind) {
    if (isFunctionLikeDeclaration(current)) return false;
    current = current.parent;
  }
  return true;
}

async function canonicalSymbols(
  project: Project,
  identifiers: readonly Identifier[],
  symbols: readonly (NativeSymbol | undefined)[],
): Promise<(NativeSymbol | undefined)[]> {
  const aliases = identifiers.map((identifier, index) =>
    symbols[index] && symbols[index]!.flags & SymbolFlags.Alias ? identifier : undefined,
  );
  const aliasNodes = aliases.filter((node): node is Identifier => Boolean(node));
  const aliasTypes = aliasNodes.length ? await project.checker.getTypeAtLocation(aliasNodes) : [];
  const targets = await Promise.all(aliasTypes.map((type) => type?.getSymbol()));
  let aliasIndex = 0;
  const resolvedAliases = symbols.map((symbol, index) => {
    if (!aliases[index]) return symbol;
    const target = targets[aliasIndex];
    aliasIndex += 1;
    return target ?? symbol;
  });
  return Promise.all(
    resolvedAliases.map((symbol) => symbol?.getExportSymbol().catch(() => symbol)),
  );
}

async function openProjects(
  api: API,
  configFiles: readonly NativeSymbolFile[],
): Promise<Snapshot | undefined> {
  let snapshot: Snapshot | undefined;
  for (const config of configFiles) {
    const next = await api.updateSnapshot({
      openProject: config.absolutePath,
      fileChanges: { invalidateAll: true },
    });
    if (snapshot && snapshot !== next) await snapshot.dispose();
    snapshot = next;
  }
  return snapshot;
}

function recordDiagnosticCompleteness(
  diagnostics: readonly { category: DiagnosticCategory }[] | undefined,
  reasons: Set<string>,
): void {
  if (!diagnostics) {
    reasons.add("parse-diagnostics-unavailable");
    return;
  }
  if (diagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)) {
    reasons.add("parse-error");
  }
}

async function collectOccurrences(
  projects: readonly Project[],
  files: readonly NativeSymbolFile[],
  reasons: Set<string>,
  signal?: AbortSignal,
): Promise<Occurrence[]> {
  const occurrences: Occurrence[] = [];
  const loaded = new Set<string>();
  const seen = new Set<string>();
  const projectByRootFile = new Map<string, Project>();
  for (const project of projects) {
    for (const rootFile of project.rootFiles) projectByRootFile.set(normalized(rootFile), project);
    const diagnostics = await project.program.getSyntacticDiagnostics().catch(() => undefined);
    recordDiagnosticCompleteness(diagnostics, reasons);
  }
  for (const file of files) {
    abortIfRequested(signal);
    const project = projectByRootFile.get(normalized(file.absolutePath));
    if (!project) continue;
    const sourceFile = await project.program
      .getSourceFile(file.absolutePath)
      .catch(() => undefined);
    if (!sourceFile) {
      reasons.add("source-file-unavailable");
      continue;
    }
    loaded.add(normalized(file.absolutePath));
    const identifiers = identifiersIn(sourceFile);
    const symbols = identifiers.length
      ? await project.checker.getSymbolAtLocation(identifiers)
      : [];
    const canonical = await canonicalSymbols(project, identifiers, symbols);
    for (let index = 0; index < identifiers.length; index += 1) {
      const node = identifiers[index]!;
      const key = `${normalized(file.absolutePath)}:${node.pos}:${node.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      occurrences.push({
        file,
        sourceFile,
        project,
        node,
        symbol: symbols[index],
        canonical: canonical[index],
      });
    }
  }
  for (const file of files) {
    if (!loaded.has(normalized(file.absolutePath))) reasons.add("uncovered-source-file");
  }
  return occurrences;
}

function candidatePriority(candidate: Occurrence): number {
  if (!isDefinitionIdentifier(candidate.node)) return 0;
  if (declarationIsExported(candidate.node.parent)) return 2;
  return declarationIsModuleLevel(candidate.node.parent) ? 1 : 0;
}

function selectTarget(candidates: readonly Occurrence[]): {
  symbol?: NativeSymbol;
  ambiguous: boolean;
} {
  const symbols = new Map<string, { symbol: NativeSymbol; priority: number }>();
  for (const candidate of candidates) {
    const symbol = candidate.canonical;
    if (!symbol?.declarations.length) continue;
    const priority = Math.max(symbols.get(symbol.id)?.priority ?? 0, candidatePriority(candidate));
    symbols.set(symbol.id, { symbol, priority });
  }
  if (!symbols.size) return { ambiguous: false };
  const described = [...symbols.values()];
  const highestPriority = Math.max(...described.map((item) => item.priority));
  const selected = described.filter((item) => item.priority === highestPriority);
  return selected.length === 1
    ? { symbol: selected[0]!.symbol, ambiguous: false }
    : { ambiguous: true };
}

function targetOccurrences(occurrences: readonly Occurrence[], target: NativeSymbol): Occurrence[] {
  return occurrences.filter((occurrence) => occurrence.canonical?.id === target.id);
}

async function definitionLocations(
  target: NativeSymbol,
  filesByPath: ReadonlyMap<string, NativeSymbolFile>,
  scope: NativeSymbolScope,
): Promise<SymbolLocation[]> {
  const locations: SymbolLocation[] = [];
  for (const declaration of target.declarations) {
    const file = filesByPath.get(normalized(declaration.path));
    if (!file || !withinScope(file, scope)) continue;
    const location = position(file.text ?? "", declaration.pos);
    locations.push({ path: file.relativeToCwd, ...location, label: "definition" });
  }
  return locations;
}

function referenceLocations(
  occurrences: readonly Occurrence[],
  scope: NativeSymbolScope,
): SymbolLocation[] {
  return occurrences
    .filter(
      (occurrence) =>
        withinScope(occurrence.file, scope) && !isDefinitionIdentifier(occurrence.node),
    )
    .map((occurrence) => ({
      path: occurrence.file.relativeToCwd,
      ...position(occurrence.sourceFile.text, occurrence.node.pos),
      label: "reference",
    }));
}

function functionLocations(
  occurrences: readonly Occurrence[],
  scope: NativeSymbolScope,
  directCallsOnly: boolean,
): SymbolLocation[] {
  const grouped = new Map<string, SymbolLocation>();
  for (const occurrence of occurrences) {
    if (!withinScope(occurrence.file, scope) || !isRuntimeReference(occurrence.node)) continue;
    if (directCallsOnly && !isDirectCall(occurrence.node)) continue;
    const fn = enclosingFunction(occurrence.node);
    if (!fn) {
      if (directCallsOnly) continue;
      const key = `${normalized(occurrence.file.absolutePath)}:module`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          path: occurrence.file.relativeToCwd,
          ...position(occurrence.sourceFile.text, occurrence.node.pos),
          label: "module scope",
        });
      }
      continue;
    }
    const key = `${normalized(occurrence.file.absolutePath)}:${fn.pos}:${fn.end}`;
    if (!grouped.has(key)) {
      const locationNode = functionNameNode(fn) ?? fn;
      grouped.set(key, {
        path: occurrence.file.relativeToCwd,
        ...position(occurrence.sourceFile.text, locationNode.pos),
        label: `function ${functionName(fn)}`,
      });
    }
  }
  return [...grouped.values()];
}

function uniqueSorted(locations: readonly SymbolLocation[]): SymbolLocation[] {
  const unique = new Map<string, SymbolLocation>();
  for (const location of locations) {
    unique.set(`${location.path}:${location.line}:${location.column}:${location.label}`, location);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column,
  );
}

function formatAnalysis(
  request: NativeSymbolRequest,
  locations: readonly SymbolLocation[],
  reasons: ReadonlySet<string>,
): NativeSymbolAnalysis {
  const selected = locations.slice(0, request.maxResults);
  const allReasons = new Set(reasons);
  if (locations.length > selected.length) allReasons.add("result-limit");
  const complete = allReasons.size === 0;
  const lines = [
    `symbol: ${request.symbol}`,
    "mode: symbol",
    `operation: ${request.operation}`,
    `scope: ${request.scope}`,
    `count: ${selected.length}`,
    `complete: ${complete}`,
    ...(allReasons.size ? [`reasons: ${[...allReasons].sort().join(", ")}`] : []),
    "",
    "results:",
    ...(selected.length
      ? selected.map(
          (location) =>
            `- ${location.path}:${location.line}:${location.column} — ${location.label}`,
        )
      : ["- none"]),
  ];
  return {
    text: lines.join("\n"),
    details: {
      root: request.rootLabel,
      mode: "symbol",
      symbol: request.symbol,
      operation: request.operation,
      scope: request.scope,
      count: selected.length,
      complete,
      reasons: [...allReasons].sort(),
    },
  };
}

export async function analyzeNativeSymbol(
  request: NativeSymbolRequest,
): Promise<NativeSymbolAnalysis> {
  const reasons = new Set(request.truncationReasons);
  const relevantFiles = request.files.filter(
    (file) =>
      (file.kind === "source" || file.kind === "test") &&
      scriptExtensions.has(path.extname(file.absolutePath).toLowerCase()),
  );
  const configs = request.files
    .filter((file) => /^(?:ts|js)config(?:\.[^/]*)?\.json$/i.test(path.basename(file.absolutePath)))
    .sort(
      (left, right) =>
        left.relativeToRoot.split("/").length - right.relativeToRoot.split("/").length ||
        left.relativeToRoot.localeCompare(right.relativeToRoot),
    );
  if (!configs.length) {
    reasons.add("missing-tsconfig");
    return formatAnalysis(request, [], reasons);
  }
  const api = new API({ cwd: request.root });
  activeApis.add(api);
  let snapshot: Snapshot | undefined;
  try {
    snapshot = await openProjects(api, configs);
    const projects = snapshot?.getProjects() ?? [];
    if (!projects.length) {
      reasons.add("project-unavailable");
      return formatAnalysis(request, [], reasons);
    }
    const occurrences = await collectOccurrences(projects, relevantFiles, reasons, request.signal);
    const named = occurrences.filter((occurrence) => occurrence.node.text === request.symbol);
    const target = selectTarget(named);
    if (target.ambiguous) {
      reasons.add("ambiguous-target");
      return formatAnalysis(request, [], reasons);
    }
    if (!target.symbol) return formatAnalysis(request, [], reasons);
    const matching = targetOccurrences(occurrences, target.symbol);
    const filesByPath = new Map(
      request.files.map((file) => [normalized(file.absolutePath), file] as const),
    );
    const locations =
      request.operation === "definitions"
        ? await definitionLocations(target.symbol, filesByPath, request.scope)
        : request.operation === "references"
          ? referenceLocations(matching, request.scope)
          : functionLocations(matching, request.scope, request.operation === "callingFunctions");
    return formatAnalysis(request, uniqueSorted(locations), reasons);
  } catch (error) {
    if (request.signal?.aborted) throw error;
    reasons.add("native-analysis-error");
    return formatAnalysis(request, [], reasons);
  } finally {
    await snapshot?.dispose().catch(() => undefined);
    await api.close().catch(() => undefined);
    activeApis.delete(api);
  }
}

export async function closeNativeSymbolAnalyzers(): Promise<void> {
  await Promise.all([...activeApis].map((api) => api.close().catch(() => undefined)));
  activeApis.clear();
}
