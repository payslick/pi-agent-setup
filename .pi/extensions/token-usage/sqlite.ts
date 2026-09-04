import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface TokenUsageRecord {
  sessionId: string;
  occurredAt: number;
  provider: string;
  model: string;
  messageIdentity: string;
  subagentId: string | null;
  subagentName: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsageGroup {
  provider: string;
  model: string;
  subagentId: string | null;
  subagentName: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type SQLiteValue = null | number | bigint | string | NodeJS.ArrayBufferView;

interface SQLiteStatement {
  all(...parameters: SQLiteValue[]): Record<string, SQLiteValue>[];
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

const require = createRequire(import.meta.url);

function databaseConstructor(): SQLiteConstructor {
  if (process.versions.bun) {
    return (require("bun:sqlite") as { Database: SQLiteConstructor }).Database;
  }

  return (require("node:sqlite") as { DatabaseSync: SQLiteConstructor }).DatabaseSync;
}

function openDatabase(databasePath: string): SQLiteDatabase {
  const Database = databaseConstructor();
  if (process.versions.bun) {
    return new Database(databasePath, { create: true, readonly: false, strict: true });
  }

  return new Database(databasePath, { readOnly: false, timeout: 5_000 });
}

function tokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function integer(value: SQLiteValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function nullableString(value: SQLiteValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sharedProjectRoot(cwd: string, subagentOutbox: string | null): string {
  if (!subagentOutbox) return cwd;

  const herdrDirectory = path.dirname(path.resolve(subagentOutbox));
  const tmpDirectory = path.dirname(herdrDirectory);
  const piDirectory = path.dirname(tmpDirectory);
  const matchesHerdrLayout =
    path.basename(herdrDirectory) === "herdr-subagents" &&
    path.basename(tmpDirectory) === "tmp" &&
    path.basename(piDirectory) === ".pi";
  return matchesHerdrLayout ? path.dirname(piDirectory) : cwd;
}

export function tokenUsageDatabasePath(cwd: string, subagentOutbox: string | null = null): string {
  return path.resolve(sharedProjectRoot(cwd, subagentOutbox), ".pi", "tmp", "token-usage.db");
}

export function eventKey(record: TokenUsageRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        record.sessionId,
        record.occurredAt,
        record.provider,
        record.model,
        record.messageIdentity,
        record.subagentId,
        record.subagentName,
        tokenCount(record.input),
        tokenCount(record.output),
        tokenCount(record.cacheRead),
        tokenCount(record.cacheWrite),
      ]),
    )
    .digest("hex");
}

export class TokenUsageStore {
  private readonly insertStatement: SQLiteStatement;
  private readonly totalsStatement: SQLiteStatement;
  private closed = false;

  constructor(private readonly database: SQLiteDatabase) {
    this.insertStatement = database.prepare(`
      INSERT OR IGNORE INTO token_usage (
        event_key,
        session_id,
        occurred_at,
        provider,
        model,
        subagent_id,
        subagent_name,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.totalsStatement = database.prepare(`
      SELECT
        provider,
        model,
        subagent_id,
        subagent_name,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens
      FROM token_usage
      WHERE occurred_at >= ? AND occurred_at <= ?
      GROUP BY provider, model, subagent_id, subagent_name
      ORDER BY provider, model, subagent_id IS NOT NULL, subagent_name, subagent_id
    `);
  }

  record(record: TokenUsageRecord): void {
    if (this.closed) return;

    this.insertStatement.run(
      eventKey(record),
      record.sessionId,
      Math.trunc(record.occurredAt),
      record.provider,
      record.model,
      record.subagentId,
      record.subagentName,
      tokenCount(record.input),
      tokenCount(record.output),
      tokenCount(record.cacheRead),
      tokenCount(record.cacheWrite),
    );
  }

  totalsSince(since: number, until = Date.now()): TokenUsageGroup[] {
    if (this.closed) return [];

    return this.totalsStatement.all(Math.trunc(since), Math.trunc(until)).map((row) => ({
      provider: String(row.provider ?? "unknown"),
      model: String(row.model ?? "unknown"),
      subagentId: nullableString(row.subagent_id),
      subagentName: nullableString(row.subagent_name),
      input: integer(row.input_tokens),
      output: integer(row.output_tokens),
      cacheRead: integer(row.cache_read_tokens),
      cacheWrite: integer(row.cache_write_tokens),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

export function openTokenUsageStore(
  cwd: string,
  subagentOutbox: string | null = null,
): TokenUsageStore {
  const databasePath = tokenUsageDatabasePath(cwd, subagentOutbox);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = openDatabase(databasePath);

  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        subagent_id TEXT,
        subagent_name TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS token_usage_occurred_at_idx
        ON token_usage (occurred_at);
    `);
    return new TokenUsageStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
