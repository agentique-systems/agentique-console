import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type PersistenceDb = BetterSQLite3Database<typeof schema>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export interface Connection {
  sqlite: Database.Database;
  db: PersistenceDb;
}

/**
 * Opens a raw connection without changing anything about the file: no
 * journal-mode switch (WAL is persistent in the file header) and no
 * migration. `database.ts` decides whether the file may be used at all and
 * then calls `prepareConnection`.
 */
export function connect(file: string): Connection {
  const sqlite = new Database(file);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

/** Pragmas every accepted connection runs with. */
export function prepareConnection(connection: Connection): void {
  connection.sqlite.pragma("journal_mode = WAL");
  connection.sqlite.pragma("foreign_keys = ON");
}

/** Applies every pending migration from the journal. Foreign keys stay enabled. */
export function runMigrations(connection: Connection): void {
  migrate(connection.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export { schema };
