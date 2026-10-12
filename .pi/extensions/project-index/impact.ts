import path from "node:path";
import type { IndexedFile } from "./sqlite-cache";

type Dependency = { specifier: string; line: number };
export type ReverseEdge = Dependency & { importer: IndexedFile };

const dependencyPatterns = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?["']([^"'`]+)["']/g,
  /\bimport\s*\(\s*["']([^"'`]+)["']/g,
  /\brequire(?:\.resolve)?\s*\(\s*["']([^"'`]+)["']/g,
  /\b(?:jest|vi)\s*\.\s*(?:doMock|mock|requireActual|setMock|unmock|unstable_mockModule)\s*\(\s*["']([^"'`]+)["']/g,
  /\bmock\s*\.\s*module\s*\(\s*["']([^"'`]+)["']/g,
];

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

export function moduleCandidates(base: string, extensions: readonly string[]): string[] {
  const candidates = [base];
  for (const extension of extensions) candidates.push(`${base}${extension}`);
  for (const extension of extensions) candidates.push(path.join(base, `index${extension}`));
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
  extensions: readonly string[],
): IndexedFile | undefined {
  for (const base of dependencyBases(importer, specifier, root)) {
    for (const candidate of moduleCandidates(base, extensions)) {
      const target = filesByAbsolutePath.get(candidate);
      if (target) return target;
    }
  }
  return undefined;
}

export function buildReverseGraph(
  scanResult: { files: IndexedFile[]; root: string },
  extensions: readonly string[],
): Map<string, ReverseEdge[]> {
  const filesByAbsolutePath = new Map(
    scanResult.files.map((file) => [path.normalize(file.absolutePath), file] as const),
  );
  const reverse = new Map<string, ReverseEdge[]>();
  const seenEdges = new Set<string>();
  for (const importer of scanResult.files) {
    if (importer.text === undefined) continue;
    for (const dependency of dependenciesIn(importer.text)) {
      const target = resolveDependency(
        importer, dependency.specifier, scanResult.root, filesByAbsolutePath, extensions,
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
