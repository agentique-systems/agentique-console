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
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
