import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DDL } from "./ddl.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof openDb>["db"];

export function openDb(dbFile: string) {
  if (dbFile !== ":memory:") {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  }
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  migrateAdditiveColumns(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function migrateAdditiveColumns(sqlite: Database.Database): void {
  const userColumns = new Set(sqlite.prepare("pragma table_info(user_sessions)").all().map((row) => (row as { name: string }).name));
  for (const [name, ddl] of [["sdk_generation", "INTEGER NOT NULL DEFAULT 0"], ["sdk_turn_count", "INTEGER NOT NULL DEFAULT 0"], ["context_tokens", "INTEGER NOT NULL DEFAULT 0"], ["memory", "TEXT NOT NULL DEFAULT ''"], ["latest_handoff_id", "TEXT"]] as const) {
    if (!userColumns.has(name)) sqlite.exec(`ALTER TABLE user_sessions ADD COLUMN ${name} ${ddl}`);
  }
  const columns = new Set(
    sqlite
      .prepare("pragma table_info(participants)")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const additions: [string, string][] = [
    ["profile_id", "TEXT NOT NULL DEFAULT 'explorer'"],
    ["profile_snapshot", "TEXT NOT NULL DEFAULT '{}'"],
    ["ownership", "TEXT NOT NULL DEFAULT '[]'"],
    ["sdk_session_id", "TEXT"],
    ["generation", "INTEGER NOT NULL DEFAULT 0"],
    ["turn_count", "INTEGER NOT NULL DEFAULT 0"],
    ["context_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["memory", "TEXT NOT NULL DEFAULT ''"],
    ["latest_handoff_id", "TEXT"],
    ["checkpoint_ready", "INTEGER NOT NULL DEFAULT 1"],
    ["pending_turn_seq", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE participants ADD COLUMN ${name} ${ddl}`);
  }
  const usageColumns = new Set(sqlite.prepare("pragma table_info(usage_samples)").all().map((row) => (row as { name: string }).name));
  for (const name of ["uncached_input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (!usageColumns.has(name)) sqlite.exec(`ALTER TABLE usage_samples ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }
}
