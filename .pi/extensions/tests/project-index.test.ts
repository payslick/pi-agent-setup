import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import projectIndex from "../project-index/index";

type ProjectIndexToolName =
  | "project_index_search"
  | "project_index_status"
  | "project_index_refresh"
  | "project_index_impact";

const temporaryPaths = new Set<string>();

function registerProjectIndexTools(): Map<string, ToolDefinition> {
  const registeredTools = new Map<string, ToolDefinition>();
  projectIndex({
    on() {},
    registerTool(tool: ToolDefinition) {
      registeredTools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI);
  return registeredTools;
}

const tools = registerProjectIndexTools();

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
  temporaryPaths.clear();
});

async function temporaryDirectory(prefix = "project-index-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.add(directory);
  return directory;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await temporaryDirectory();
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf8");
    }),
  );
  return root;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(filePath).catch(() => undefined)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

function contextFor(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;
}

async function executeTool(
  name: ProjectIndexToolName,
  params: Record<string, unknown>,
  cwd: string,
  registeredTools = tools,
): Promise<AgentToolResult<unknown>> {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Project-index tool was not registered: ${name}`);
  return tool.execute("project-index-test-call", params, undefined, undefined, contextFor(cwd));
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function listedFiles(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/^\s*-\s+([^:\n]+):\d+:\d+(?:\s+—.*)?$/gm)].map((match) => match[1]!),
    ),
  ];
}

async function executeRefresh(
  cwd: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  return executeTool("project_index_refresh", params, cwd);
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(nestedStrings);
  }
  return [];
}

function expectSanitizedDetails(
  result: AgentToolResult<unknown>,
  absoluteCorpusPath: string,
  corpusMarker: string,
): void {
  expect(result.details).toBeDefined();
  const values = nestedStrings(result.details);
  expect(values).not.toContain(absoluteCorpusPath);
  expect(values.some((value) => value.includes(corpusMarker))).toBe(false);
}

type SymbolOperation = "definitions" | "references" | "callingFunctions" | "usingFunctions";
type SymbolScope = "source" | "test" | "all";
type RelativeLocation = { path: string; line: number; column: number };

async function nativeTypeScriptProject(files: Record<string, string>): Promise<string> {
  return fixture({
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "tests/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    ...files,
  });
}

async function executeSymbolSearch(
  cwd: string,
  symbol: string,
  operation: SymbolOperation,
  scope: SymbolScope = "all",
  maxResults = 100,
): Promise<string> {
  return resultText(
    await executeTool(
      "project_index_search",
      { mode: "symbol", symbol, operation, scope, maxResults },
      cwd,
    ),
  );
}

function symbolResultSummary(
  text: string,
  operation: SymbolOperation,
  complete: boolean,
): { count: number; locations: RelativeLocation[] } {
  expect(text).toMatch(new RegExp(`^operation:\\s*${operation}\\s*$`, "m"));
  expect(text).toMatch(new RegExp(`^complete:\\s*${complete}\\s*$`, "m"));
  const countMatch = text.match(/^count:\s*(\d+)\s*$/m);
  expect(countMatch).not.toBeNull();
  if (!countMatch) throw new Error("Expected a symbol result count");

  const locations = [
    ...new Map(
      [...text.matchAll(/(?:^|\s)((?:src|tests)\/[^:\s]+):(\d+):(\d+)/gm)].map((match) => {
        const location = {
          path: match[1]!,
          line: Number(match[2]),
          column: Number(match[3]),
        };
        return [`${location.path}:${location.line}:${location.column}`, location] as const;
      }),
    ).values(),
  ];
  expect(Number(countMatch[1])).toBe(locations.length);
  return { count: Number(countMatch[1]), locations };
}

function expectLocation(
  locations: readonly RelativeLocation[],
  relativePath: string,
  line: number,
): void {
  expect(
    locations.some((location) => location.path === relativePath && location.line === line),
  ).toBe(true);
}

describe("project-index registered search tool", () => {
  test("finds relevant files and line ranges and returns none for an unmatched query", async () => {
    const root = await fixture({
      "src/payroll.ts": [
        "export function reconcilePayroll() {",
        "  const period = 'quarterly';",
        "  // quarterly payroll reconciliation marker",
        "  return period;",
        "}",
      ].join("\n"),
      "src/inventory.ts": "export const inventoryCount = 4;\n",
    });

    const found = resultText(
      await executeTool(
        "project_index_search",
        { query: "quarterly payroll reconciliation", includeDocs: false, includeTests: false },
        root,
      ),
    );
    const range = found.match(/src\/payroll\.ts:(\d+):(\d+)/);
    expect(range).not.toBeNull();
    if (!range) throw new Error("Expected a payroll source range");
    expect(Number(range[1])).toBeLessThanOrEqual(3);
    expect(Number(range[2])).toBeGreaterThanOrEqual(3);

    const unmatched = resultText(
      await executeTool(
        "project_index_search",
        { query: "intergalactic narwhal observatory", includeDocs: false, includeTests: false },
        root,
      ),
    );
    expect(unmatched).toContain("confidence: none");
    expect(unmatched).toMatch(/specs:\n- none(?:\n|$)/);
  });

  test("applies maxFiles as a global cap across source, docs, and test groups", async () => {
    const marker = "global cap heliotrope marker";
    const root = await fixture({
      "src/one.ts": `export const one = "${marker}";\n`,
      "src/two.ts": `export const two = "${marker}";\n`,
      "docs/one.md": marker,
      "docs/two.md": marker,
      "tests/one.test.ts": `test("one", () => "${marker}");\n`,
      "tests/two.test.ts": `test("two", () => "${marker}");\n`,
    });

    const text = resultText(
      await executeTool("project_index_search", { query: marker, maxFiles: 2 }, root),
    );

    expect(listedFiles(text)).toHaveLength(2);
  });

  test("makes debug mode observably distinct from normal source search", async () => {
    const root = await fixture({
      "src/ledger.ts": "export const ledgerDiagnosticMarker = true;\n",
    });
    const params = {
      query: "ledger diagnostic marker",
      includeDocs: false,
      includeTests: false,
    };

    const sources = await executeTool("project_index_search", { ...params, mode: "sources" }, root);
    const debug = await executeTool("project_index_search", { ...params, mode: "debug" }, root);

    expect(debug).not.toEqual(sources);
  });

  test("classifies root-level test and docs directories for include filters", async () => {
    const root = await fixture({
      "tests/helper.ts": "export const boundaryFilterMarker = true;\n",
      "docs/guide.txt": "boundaryFilterMarker\n",
    });

    const excluded = resultText(
      await executeTool(
        "project_index_search",
        { query: "boundaryFilterMarker", includeDocs: false, includeTests: false },
        root,
      ),
    );
    const included = resultText(
      await executeTool("project_index_search", { query: "boundaryFilterMarker" }, root),
    );

    expect(excluded).toMatch(/specs:\n- none(?:\n|$)/);
    expect(included).toContain("tests/helper.ts:");
    expect(included).toContain("docs/guide.txt:");
  });
});

describe("project-index TypeScript native symbol search", () => {
  test("selects one exported definition and follows direct and renamed barrel references without local shadows", async () => {
    const root = await nativeTypeScriptProject({
      "src/target.ts": "export function selectedTarget(value: number) { return value * 2; }\n",
      "src/direct.ts": [
        'import { selectedTarget } from "./target";',
        "export const directResult = selectedTarget(1);",
      ].join("\n"),
      "src/barrel.ts": 'export { selectedTarget as barrelTarget } from "./target";\n',
      "src/aliased.ts": [
        'import { barrelTarget as renamedTarget } from "./barrel";',
        "export const aliasedResult = renamedTarget(2);",
        "export function shadowed() {",
        "  const selectedTarget = (value: number) => value + 1;",
        "  return selectedTarget(3);",
        "}",
      ].join("\n"),
    });

    const definitions = symbolResultSummary(
      await executeSymbolSearch(root, "selectedTarget", "definitions"),
      "definitions",
      true,
    );
    expect(definitions.count).toBe(1);
    expect(definitions.locations).toEqual([
      { path: "src/target.ts", line: 1, column: expect.any(Number) },
    ]);

    const references = symbolResultSummary(
      await executeSymbolSearch(root, "selectedTarget", "references"),
      "references",
      true,
    );
    expectLocation(references.locations, "src/direct.ts", 2);
    expectLocation(references.locations, "src/aliased.ts", 2);
    expect(
      references.locations.some(
        (location) => location.path === "src/aliased.ts" && location.line >= 4,
      ),
    ).toBe(false);
  });

  test("distinguishes and deduplicates callers from all users, including callbacks and module scope", async () => {
    const root = await nativeTypeScriptProject({
      "src/target.ts": "export function trackedTarget(value: number) { return value; }\n",
      "src/usage.ts": [
        'import { trackedTarget } from "./target";',
        "export function callsTarget() {",
        "  trackedTarget(1);",
        "  return trackedTarget(2);",
        "}",
        "export function callbackTarget() {",
        "  return [1, 2].map(trackedTarget);",
        "}",
        "export function storesTarget() {",
        "  return { handler: trackedTarget };",
        "}",
        "export const moduleHandler = trackedTarget;",
      ].join("\n"),
    });

    const callers = symbolResultSummary(
      await executeSymbolSearch(root, "trackedTarget", "callingFunctions"),
      "callingFunctions",
      true,
    );
    expect(callers.count).toBe(1);
    expectLocation(callers.locations, "src/usage.ts", 2);

    const usersText = await executeSymbolSearch(root, "trackedTarget", "usingFunctions");
    const users = symbolResultSummary(usersText, "usingFunctions", true);
    expect(users.count).toBe(4);
    expectLocation(users.locations, "src/usage.ts", 2);
    expectLocation(users.locations, "src/usage.ts", 6);
    expectLocation(users.locations, "src/usage.ts", 9);
    expect(
      usersText.split("\n").some((line) => line.includes("src/usage.ts:") && /module/i.test(line)),
    ).toBe(true);
  });

  test("honors source, test, and all scopes and marks maxResults truncation incomplete", async () => {
    const root = await nativeTypeScriptProject({
      "src/target.ts": "export function scopedTarget() { return 1; }\n",
      "src/source-use.ts": [
        'import { scopedTarget } from "./target";',
        "export const sourceValue = scopedTarget();",
      ].join("\n"),
      "tests/target.test.ts": [
        'import { scopedTarget } from "../src/target";',
        'test("target", () => scopedTarget());',
      ].join("\n"),
    });

    const source = symbolResultSummary(
      await executeSymbolSearch(root, "scopedTarget", "references", "source"),
      "references",
      true,
    );
    expect(source.count).toBeGreaterThan(0);
    expect(source.locations.every((location) => location.path.startsWith("src/"))).toBe(true);
    expectLocation(source.locations, "src/source-use.ts", 2);

    const tests = symbolResultSummary(
      await executeSymbolSearch(root, "scopedTarget", "references", "test"),
      "references",
      true,
    );
    expect(tests.count).toBeGreaterThan(0);
    expect(tests.locations.every((location) => location.path.startsWith("tests/"))).toBe(true);
    expectLocation(tests.locations, "tests/target.test.ts", 2);

    const all = symbolResultSummary(
      await executeSymbolSearch(root, "scopedTarget", "references", "all"),
      "references",
      true,
    );
    expect(all.count).toBe(source.count + tests.count);
    expectLocation(all.locations, "src/source-use.ts", 2);
    expectLocation(all.locations, "tests/target.test.ts", 2);

    const truncated = symbolResultSummary(
      await executeSymbolSearch(root, "scopedTarget", "references", "all", 1),
      "references",
      false,
    );
    expect(truncated.count).toBe(1);
  });

  test("reflects changed and deleted TypeScript source without a reload", async () => {
    const root = await nativeTypeScriptProject({
      "src/live-target.ts": "export function liveTarget() { return 1; }\n",
      "src/live-consumer.ts": [
        'import { liveTarget } from "./live-target";',
        "export const liveValue = liveTarget();",
      ].join("\n"),
    });
    const targetPath = path.join(root, "src/live-target.ts");
    const consumerPath = path.join(root, "src/live-consumer.ts");

    const before = symbolResultSummary(
      await executeSymbolSearch(root, "liveTarget", "references"),
      "references",
      true,
    );
    expectLocation(before.locations, "src/live-consumer.ts", 2);

    await writeFile(
      consumerPath,
      "export const liveValue = 'changed source no longer uses the exported target';\n",
      "utf8",
    );
    const changed = symbolResultSummary(
      await executeSymbolSearch(root, "liveTarget", "references"),
      "references",
      true,
    );
    expect(changed.count).toBe(0);

    await rm(targetPath);
    const deleted = symbolResultSummary(
      await executeSymbolSearch(root, "liveTarget", "definitions"),
      "definitions",
      true,
    );
    expect(deleted.count).toBe(0);
  });
});

describe("project-index SQLite persistence through registered tools", () => {
  test("creates tmp/project_index.db and reuses cached text and metadata after re-registration", async () => {
    const marker = "persistent amaranth cache marker";
    const root = await fixture({
      "src/persistent.ts": `export const persistent = "${marker}";\n`,
    });

    const initialTools = registerProjectIndexTools();
    const initial = resultText(
      await executeTool("project_index_search", { query: marker }, root, initialTools),
    );
    expect(initial).toContain("src/persistent.ts:");

    const databasePath = path.join(root, "tmp", "project_index.db");
    expect((await stat(databasePath)).isFile()).toBe(true);

    const otherRoot = await fixture({
      "src/other.ts": "export const other = 'separate memory scan marker';\n",
    });
    await executeTool("project_index_status", {}, otherRoot);

    const reRegisteredTools = registerProjectIndexTools();
    const restoredStatus = resultText(
      await executeTool("project_index_status", {}, root, reRegisteredTools),
    );
    const restoredSearch = resultText(
      await executeTool("project_index_search", { query: marker }, root, reRegisteredTools),
    );

    expect(restoredStatus).toContain("reads: reread=0, reused=1");
    expect(restoredSearch).toContain("src/persistent.ts:");
  });

  test("persists modification, addition, and deletion reconciliation", async () => {
    const root = await fixture({
      "src/modified.ts": "export const state = 'legacy topaz sqlite marker';\n",
      "src/deleted.ts": "export const removed = 'obsolete indigo sqlite marker';\n",
    });
    await executeTool("project_index_status", {}, root);

    await Promise.all([
      writeFile(
        path.join(root, "src/modified.ts"),
        "export const state = 'current cobalt sqlite marker with changed bytes';\n",
        "utf8",
      ),
      writeFile(
        path.join(root, "src/added.ts"),
        "export const added = 'new verdigris sqlite marker';\n",
        "utf8",
      ),
      rm(path.join(root, "src/deleted.ts")),
    ]);

    const reconciled = await executeRefresh(root, {});
    expect(reconciled.details).toMatchObject({
      changes: { added: 1, modified: 1, deleted: 1 },
    });

    const reRegisteredTools = registerProjectIndexTools();
    const modified = resultText(
      await executeTool(
        "project_index_search",
        { query: "current cobalt sqlite marker" },
        root,
        reRegisteredTools,
      ),
    );
    const added = resultText(
      await executeTool(
        "project_index_search",
        { query: "new verdigris sqlite marker" },
        root,
        reRegisteredTools,
      ),
    );
    const deleted = resultText(
      await executeTool(
        "project_index_search",
        { query: "obsolete indigo sqlite marker" },
        root,
        reRegisteredTools,
      ),
    );
    const stale = resultText(
      await executeTool(
        "project_index_search",
        { query: "legacy topaz sqlite marker" },
        root,
        reRegisteredTools,
      ),
    );

    expect(modified).toContain("src/modified.ts:");
    expect(added).toContain("src/added.ts:");
    expect(deleted).toMatch(/specs:\n- none(?:\n|$)/);
    expect(stale).toMatch(/specs:\n- none(?:\n|$)/);
  });

  test("keeps requested roots and separate working directories isolated", async () => {
    const workspace = await fixture({
      "projects/one/src/state.ts": "export const state = 'root one heliotrope marker';\n",
      "projects/two/src/state.ts": "export const state = 'root two celadon marker';\n",
    });

    const ownFirstRoot = resultText(
      await executeTool(
        "project_index_search",
        { root: "projects/one", query: "root one heliotrope marker" },
        workspace,
      ),
    );
    const ownSecondRoot = resultText(
      await executeTool(
        "project_index_search",
        { root: "projects/two", query: "root two celadon marker" },
        workspace,
      ),
    );
    const wrongRequestedRoot = resultText(
      await executeTool(
        "project_index_search",
        { root: "projects/two", query: "root one heliotrope marker" },
        workspace,
        registerProjectIndexTools(),
      ),
    );
    expect(ownFirstRoot).toContain("projects/one/src/state.ts:");
    expect(ownSecondRoot).toContain("projects/two/src/state.ts:");
    expect(wrongRequestedRoot).toMatch(/specs:\n- none(?:\n|$)/);

    const firstCwd = await fixture({
      "src/shared.ts": "export const shared = 'cwd one fuchsia marker';\n",
    });
    const secondCwd = await fixture({
      "src/shared.ts": "export const shared = 'cwd two ochre marker';\n",
    });
    await executeTool("project_index_status", {}, firstCwd);
    await executeTool("project_index_status", {}, secondCwd);

    const wrongCwd = resultText(
      await executeTool(
        "project_index_search",
        { query: "cwd one fuchsia marker" },
        secondCwd,
        registerProjectIndexTools(),
      ),
    );
    const ownCwd = resultText(
      await executeTool(
        "project_index_search",
        { query: "cwd one fuchsia marker" },
        firstCwd,
        registerProjectIndexTools(),
      ),
    );

    expect(wrongCwd).toMatch(/specs:\n- none(?:\n|$)/);
    expect(ownCwd).toContain("src/shared.ts:");
    expect((await stat(path.join(firstCwd, "tmp/project_index.db"))).isFile()).toBe(true);
    expect((await stat(path.join(secondCwd, "tmp/project_index.db"))).isFile()).toBe(true);
  });

  test("reports only the relative SQLite path in status and refresh output", async () => {
    const root = await fixture({
      "src/private.ts": "export const privateValue = 'private sqlite path marker';\n",
    });
    const status = await executeTool("project_index_status", {}, root);
    const refresh = await executeRefresh(root, { force: true });

    for (const result of [status, refresh]) {
      const text = resultText(result);
      expect(text).toContain("tmp/project_index.db");
      expect(text).not.toContain(root);
      expect(text).not.toContain(path.join(root, "tmp", "project_index.db"));
      for (const value of nestedStrings(result.details)) {
        expect(value).not.toContain(root);
        expect(value).not.toContain(path.join(root, "tmp", "project_index.db"));
      }
    }
  });

  test("shares its WAL database with a concurrent Pi writer", async () => {
    const root = await fixture({
      "src/shared.ts": "export const shared = 'initial shared sqlite marker';\n",
    });
    await executeTool("project_index_status", {}, root);
    const databasePath = path.join(root, "tmp", "project_index.db");
    const inspector = new Database(databasePath, { readonly: true, strict: true });
    const journalMode = inspector
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()?.journal_mode;
    inspector.close();
    expect(journalMode?.toLowerCase()).toBe("wal");

    await writeFile(
      path.join(root, "src/shared.ts"),
      "export const shared = 'updated shared sqlite marker with more bytes';\n",
      "utf8",
    );
    const readyPath = path.join(root, "tmp", "writer-ready");
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          'import { writeFileSync } from "node:fs";',
          'import { Database } from "bun:sqlite";',
          "const database = new Database(process.env.DB_PATH, { strict: true });",
          "database.run('PRAGMA busy_timeout = 5000');",
          "database.run('BEGIN IMMEDIATE');",
          "writeFileSync(process.env.READY_PATH, 'ready');",
          "await Bun.sleep(350);",
          "database.run('COMMIT');",
          "database.close();",
        ].join(""),
      ],
      {
        env: { ...process.env, DB_PATH: databasePath, READY_PATH: readyPath },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await waitForFile(readyPath);

    const updated = resultText(
      await executeTool("project_index_search", { query: "updated shared sqlite marker" }, root),
    );
    expect(updated).toContain("src/shared.ts:");
    expect(await writer.exited).toBe(0);

    const persisted = new Database(databasePath, { readonly: true, strict: true });
    const row = persisted
      .query<{ text: string | null }, [string]>(
        "SELECT text FROM indexed_files WHERE relative_to_root = ?",
      )
      .get("src/shared.ts");
    persisted.close();
    expect(row?.text).toContain("updated shared sqlite marker");
  });
});

describe("project-index freshness through registered tools", () => {
  test("reflects modified file contents without force", async () => {
    const root = await fixture({
      "src/state.ts": "export const state = 'legacy saffron marker';\n",
    });
    const statePath = path.join(root, "src/state.ts");

    await executeTool("project_index_search", { query: "legacy saffron marker" }, root);
    await writeFile(statePath, "export const state = 'modified cobalt marker with new bytes';\n");

    const modified = resultText(
      await executeTool("project_index_search", { query: "modified cobalt marker" }, root),
    );
    const removedContent = resultText(
      await executeTool("project_index_search", { query: "legacy saffron" }, root),
    );
    expect(modified).toContain("src/state.ts:");
    expect(removedContent).toMatch(/specs:\n- none(?:\n|$)/);
  });

  test("discovers added files without force", async () => {
    const root = await fixture({ "src/state.ts": "export const state = true;\n" });
    await executeTool("project_index_status", {}, root);

    await writeFile(
      path.join(root, "src/added.ts"),
      "export const added = 'new verdigris marker';\n",
      "utf8",
    );
    const added = resultText(
      await executeTool("project_index_search", { query: "new verdigris marker" }, root),
    );

    expect(added).toContain("src/added.ts:");
  });

  test("drops deleted files without force", async () => {
    const root = await fixture({
      "src/deleted.ts": "export const removed = 'obsolete cerulean marker';\n",
    });
    const deletedPath = path.join(root, "src/deleted.ts");
    await executeTool("project_index_search", { query: "obsolete cerulean marker" }, root);

    await rm(deletedPath);
    const deleted = resultText(
      await executeTool("project_index_search", { query: "obsolete cerulean marker" }, root),
    );

    expect(deleted).toMatch(/specs:\n- none(?:\n|$)/);
  });

  test("accepts an explicit force refresh", async () => {
    const root = await fixture({ "src/state.ts": "export const state = true;\n" });

    const refreshed = await executeRefresh(root, { force: true });

    expect(resultText(refreshed)).toContain("refreshed: true");
  });
});

describe("project-index registered impact tool", () => {
  test("finds direct and transitive relative importers, excludes unrelated files, and honors includeTests", async () => {
    const root = await fixture({
      "src/domain/value.ts": "export const domainValue = 42;\n",
      "src/services/calculate.ts": [
        'import { domainValue } from "../domain/value";',
        "export const calculate = () => domainValue * 2;",
      ].join("\n"),
      "src/pages/dashboard.ts": [
        'import { calculate } from "../services/calculate";',
        "export const dashboardTotal = calculate();",
      ].join("\n"),
      "src/health/ping.ts": "export const ping = () => 'ok';\n",
      "app/api/report/route.ts": [
        'import { domainValue } from "../../../src/domain/value";',
        "export const report = domainValue;",
      ].join("\n"),
      "tests/dashboard.test.ts": [
        'import { dashboardTotal } from "../src/pages/dashboard";',
        'test("dashboard", () => expect(dashboardTotal).toBe(84));',
      ].join("\n"),
    });

    const withTests = resultText(
      await executeTool(
        "project_index_impact",
        { file: "src/domain/value.ts", includeTests: true },
        root,
      ),
    );
    expect(withTests).toContain("src/services/calculate.ts:");
    expect(withTests).toContain("src/pages/dashboard.ts:");
    expect(withTests).toContain("tests/dashboard.test.ts:");
    expect(withTests).toMatch(/API:\n- app\/api\/report\/route\.ts:/);
    expect(withTests).not.toContain("src/health/ping.ts:");

    const withoutTests = resultText(
      await executeTool(
        "project_index_impact",
        { file: "src/domain/value.ts", includeTests: false },
        root,
      ),
    );
    expect(withoutTests).toContain("src/services/calculate.ts:");
    expect(withoutTests).toContain("src/pages/dashboard.ts:");
    expect(withoutTests).not.toContain("tests/dashboard.test.ts:");
    expect(withoutTests).not.toContain("src/health/ping.ts:");
  });
});

describe("project-index roots and public details", () => {
  test("rejects a nonexistent requested root", async () => {
    const root = await fixture({ "src/index.ts": "export const index = true;\n" });

    await expect(
      executeTool("project_index_status", { root: "missing-project-root" }, root),
    ).rejects.toThrow();
  });

  test("rejects a requested root that escapes through a directory symlink where supported", async () => {
    const root = await fixture({ "src/index.ts": "export const index = true;\n" });
    const outside = await temporaryDirectory("project-index-outside-");
    await writeFile(path.join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
    const link = path.join(root, "linked-outside");

    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw error;
    }

    await expect(
      executeTool("project_index_search", { root: "linked-outside", query: "outside" }, root),
    ).rejects.toThrow();
  });

  test("keeps indexed text and absolute corpus records out of status and refresh details", async () => {
    const marker = "private-corpus-text-a19f3b";
    const root = await fixture({
      "src/private.ts": `export const privateMarker = "${marker}";\n`,
    });
    const corpusPath = path.join(root, "src/private.ts");

    const status = await executeTool("project_index_status", {}, root);
    const refresh = await executeRefresh(root, { force: true });

    expectSanitizedDetails(status, corpusPath, marker);
    expectSanitizedDetails(refresh, corpusPath, marker);
  });
});
