import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const SQLITE_CACHE_PATH = "tmp/project_index.db";
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const rebuildCodes = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);
type SQLiteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
interface SQLiteStatement {
  all(...parameters: SQLiteValue[]): Record<string, SQLiteValue>[];
  get(...parameters: SQLiteValue[]): Record<string, SQLiteValue> | undefined;
  run(...parameters: SQLiteValue[]): unknown;
}
interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): unknown;
  close(): void;
}
type SQLiteConstructor = new (
  databasePath: string,
  options?: Record<string, unknown>,
) => SQLiteDatabase;
interface SQLiteModule {
  Database?: SQLiteConstructor;
  DatabaseSync?: SQLiteConstructor;
}
const bunRuntime = "Bun" in globalThis;
const require = createRequire(import.meta.url);
const sqliteModule = require(bunRuntime ? "bun:sqlite" : "node:sqlite") as SQLiteModule;
function runtimeDatabaseConstructor(): SQLiteConstructor {
  const constructor = bunRuntime ? sqliteModule.Database : sqliteModule.DatabaseSync;
  if (!constructor) throw new Error("SQLite is unavailable in this runtime.");
  return constructor;
}
const DatabaseConstructor = runtimeDatabaseConstructor();

function openDatabase(databasePath: string): SQLiteDatabase {
  const options = bunRuntime
    ? { create: true, readonly: false, strict: true }
    : { readOnly: false, timeout: BUSY_TIMEOUT_MS };
  return new DatabaseConstructor(databasePath, options);
}

export type FileKind = "source" | "docs" | "test" | "other";
export interface IndexedFile {
  absolutePath: string;
  relativeToRoot: string;
  relativeToCwd: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  lineCount: number;
  text?: string;
}

export function sameIndexedFileMetadata(left: IndexedFile, right: IndexedFile): boolean {
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

export function indexedFileChange(
  file: IndexedFile,
  oldFile?: IndexedFile,
): "added" | "modified" | "none" {
  if (!oldFile) return "added";
  return sameIndexedFileMetadata(file, oldFile) ? "none" : "modified";
}

export function shouldUpsertIndexedFile(
  file: IndexedFile,
  oldFile: IndexedFile | undefined,
  force: boolean,
): boolean {
  return force || indexedFileChange(file, oldFile) !== "none" || oldFile?.text === undefined;
}

interface StoredFile {
  absolute_path: string;
  relative_to_root: string;
  relative_to_cwd: string;
  kind: FileKind;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  line_count: number;
  text: string | null;
}

export interface ProjectIndexCache {
  load(canonicalCwd: string, canonicalRoot: string): IndexedFile[];
  reconcile(
    canonicalCwd: string,
    canonicalRoot: string,
    files: readonly IndexedFile[],
    deletedPaths: readonly string[],
  ): boolean;
  close(): void;
}

const schema = `
  CREATE TABLE IF NOT EXISTS indexed_files (
    canonical_cwd TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    relative_to_root TEXT NOT NULL,
    relative_to_cwd TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    ctime_ms REAL NOT NULL,
    line_count INTEGER NOT NULL,
    text TEXT,
    PRIMARY KEY (canonical_cwd, canonical_root, absolute_path)
  ) WITHOUT ROWID
`;

class SQLiteProjectIndexCache implements ProjectIndexCache {
  private readonly loadFiles: SQLiteStatement;
  private readonly deleteFile: SQLiteStatement;
  private readonly upsertFile: SQLiteStatement;

  constructor(private readonly database: SQLiteDatabase) {
    this.loadFiles = database.prepare(`
      SELECT absolute_path, relative_to_root, relative_to_cwd, kind, size,
             mtime_ms, ctime_ms, line_count, text
      FROM indexed_files
      WHERE canonical_cwd = ? AND canonical_root = ?
      ORDER BY absolute_path
    `);
    this.deleteFile = database.prepare(`
      DELETE FROM indexed_files
      WHERE canonical_cwd = ? AND canonical_root = ? AND absolute_path = ?
    `);
    this.upsertFile = database.prepare(`
      INSERT INTO indexed_files (
        canonical_cwd, canonical_root, absolute_path, relative_to_root, relative_to_cwd,
        kind, size, mtime_ms, ctime_ms, line_count, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (canonical_cwd, canonical_root, absolute_path) DO UPDATE SET
        relative_to_root = excluded.relative_to_root,
        relative_to_cwd = excluded.relative_to_cwd,
        kind = excluded.kind,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        ctime_ms = excluded.ctime_ms,
        line_count = excluded.line_count,
        text = excluded.text
    `);
  }

  load(canonicalCwd: string, canonicalRoot: string): IndexedFile[] {
    try {
      return this.loadFiles.all(canonicalCwd, canonicalRoot).map((value) => {
        const row = value as unknown as StoredFile;
        return {
          absolutePath: row.absolute_path,
          relativeToRoot: row.relative_to_root,
          relativeToCwd: row.relative_to_cwd,
          kind: row.kind,
          size: row.size,
          mtimeMs: row.mtime_ms,
          ctimeMs: row.ctime_ms,
          lineCount: row.line_count,
          ...(row.text === null ? {} : { text: row.text }),
        };
      });
    } catch {
      return [];
    }
  }

  reconcile(
    canonicalCwd: string,
    canonicalRoot: string,
    files: readonly IndexedFile[],
    deletedPaths: readonly string[],
  ): boolean {
    if (!files.length && !deletedPaths.length) return true;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      for (const absolutePath of deletedPaths) {
        this.deleteFile.run(canonicalCwd, canonicalRoot, absolutePath);
      }
      for (const file of files) {
        this.upsertFile.run(
          canonicalCwd,
          canonicalRoot,
          file.absolutePath,
          file.relativeToRoot,
          file.relativeToCwd,
          file.kind,
          file.size,
          file.mtimeMs,
          file.ctimeMs,
          file.lineCount,
          file.text ?? null,
        );
      }
      this.database.exec("COMMIT");
      return true;
    } catch {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  close(): void {
    try {
      this.database.close();
    } catch {}
  }
}

const disabledCache: ProjectIndexCache = {
  load: () => [],
  reconcile: () => false,
  close: () => undefined,
};
const caches = new Map<string, ProjectIndexCache>();

class RebuildCacheError extends Error {}

function sqliteCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function shouldRebuild(error: unknown): boolean {
  return error instanceof RebuildCacheError || rebuildCodes.has(sqliteCode(error) ?? "");
}

function configureSharing(database: SQLiteDatabase): void {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const journalMode = database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
  if (String(journalMode).toLowerCase() !== "wal") throw new Error("WAL mode unavailable");
  database.exec("PRAGMA synchronous = NORMAL");
}

function validateSchema(database: SQLiteDatabase): void {
  try {
    database.prepare(
      "SELECT canonical_cwd, canonical_root, absolute_path FROM indexed_files LIMIT 0",
    );
  } catch (error) {
    const code = sqliteCode(error);
    if (code === "SQLITE_ERROR" || rebuildCodes.has(code ?? "")) {
      throw new RebuildCacheError("incompatible cache schema");
    }
    throw error;
  }
}

function initialize(database: SQLiteDatabase): void {
  configureSharing(database);
  const check = database.prepare("PRAGMA quick_check").get();
  if (!check || Object.values(check)[0] !== "ok") throw new RebuildCacheError("invalid cache");
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new RebuildCacheError("incompatible cache version");
  }
  if (version === 0) {
    try {
      database.exec("BEGIN IMMEDIATE");
      database.exec(schema);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  validateSchema(database);
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {}
  }
}

function closeDatabase(database?: SQLiteDatabase): void {
  try {
    database?.close();
  } catch {}
}

function openCache(databasePath: string): ProjectIndexCache {
  let database: SQLiteDatabase | undefined;
  try {
    database = openDatabase(databasePath);
    initialize(database);
    return new SQLiteProjectIndexCache(database);
  } catch (error) {
    closeDatabase(database);
    if (!shouldRebuild(error)) return disabledCache;
    removeDatabaseFiles(databasePath);
  }
  try {
    database = openDatabase(databasePath);
    initialize(database);
    return new SQLiteProjectIndexCache(database);
  } catch {
    closeDatabase(database);
    return disabledCache;
  }
}

export function projectIndexCache(piCwd: string): ProjectIndexCache {
  const databasePath = path.join(path.resolve(piCwd), SQLITE_CACHE_PATH);
  const existing = caches.get(databasePath);
  if (existing) return existing;
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch {
    return disabledCache;
  }
  const cache = openCache(databasePath);
  if (cache !== disabledCache) caches.set(databasePath, cache);
  return cache;
}

export function closeProjectIndexCaches(): void {
  for (const cache of caches.values()) cache.close();
  caches.clear();
}
