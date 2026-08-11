import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof openDb>["db"];

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export function openDb(dbFile: string) {
  if (dbFile !== ":memory:") {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  }
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  adoptPreJournalDatabase(sqlite, dbFile);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

/**
 * A database created before the migration journal existed is adopted by
 * stamping the baseline as applied — its tables already have the shape the
 * baseline describes. Adoption requires evidence that the legacy boot-time
 * migrations all ran: `user_sessions.run_state` (the last column the legacy
 * additive migration added) must exist, and `agent_sessions.mode` (dropped by
 * the legacy cleanup; NOT NULL without default, so inserts fail while it
 * remains) must not. Anything else predates the baseline and cannot boot.
 */
function adoptPreJournalDatabase(sqlite: Database.Database, dbFile: string): void {
  if (tableExists(sqlite, "__drizzle_migrations")) return;
  if (!tableExists(sqlite, "user_sessions")) return; // fresh: migrate() applies the baseline
  const refuse = (why: string): never => {
    throw new Error(
      `database at ${dbFile} ${why}, so it predates the migration baseline and cannot be adopted; ` +
        `pre-release databases are test artifacts — delete the file and restart`,
    );
  };
  if (!columnExists(sqlite, "user_sessions", "run_state")) refuse("lacks user_sessions.run_state");
  if (tableExists(sqlite, "agent_sessions") && columnExists(sqlite, "agent_sessions", "mode")) {
    refuse("still carries agent_sessions.mode");
  }
  const [baseline] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  if (!baseline) throw new Error(`no migrations found at ${MIGRATIONS_FOLDER}`);
  // Same DDL drizzle's migrator uses, so migrate() recognizes the journal.
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  sqlite
    .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
    .run(baseline.hash, baseline.folderMillis);
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  return (
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`pragma table_info(${JSON.stringify(table)})`).all() as {
    name: string;
  }[];
  return rows.some((row) => row.name === column);
}
