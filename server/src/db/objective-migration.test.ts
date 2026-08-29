import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./client.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-objective-mig-"));
  dirs.push(dir);
  return path.join(dir, "console.db");
}

function buildPreObjectiveDb(file: string): Database.Database {
  const sqlite = new Database(file);
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const prior = migrations.slice(0, 27);
  expect(prior).toHaveLength(27);
  for (const migration of prior) for (const statement of migration.sql) sqlite.exec(statement);
  sqlite.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const stamp = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  for (const migration of prior) stamp.run(migration.hash, migration.folderMillis);
  return sqlite;
}

const T1 = "2026-08-01T10:00:00.000Z";
const T2 = "2026-08-02T10:00:00.000Z";

describe("0027 governing objective backfill", () => {
  it("uses the earliest work-session operator message, then intent, and handles internal projects safely", () => {
    const file = tmpDbFile();
    const pre = buildPreObjectiveDb(file);
    pre.prepare("INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("ws", "w", "/tmp/objective-mig", T1, T1);
    const project = pre.prepare("INSERT INTO projects (id,workspace_id,title,intent_document,created_at) VALUES (?,?,?,?,?)");
    project.run("p-history", "ws", null, "legacy narrowed intent", T1);
    project.run("p-fallback", "ws", null, "fallback intent", T1);
    project.run("p-internal", "ws", null, "internal maintenance objective", T1);
    const session = pre.prepare("INSERT INTO user_sessions (id,workspace_id,project_id,mode,lifecycle,purpose,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
    session.run("us-old", "ws", "p-history", "execute", "archived", "work", T1, T1);
    session.run("us-new", "ws", "p-history", "execute", "archived", "work", T2, T2);
    session.run("us-fallback", "ws", "p-fallback", "execute", "archived", "work", T1, T1);
    session.run("us-internal", "ws", "p-internal", "execute", "archived", "profile_manager", T1, T1);
    const message = pre.prepare("INSERT INTO messages (id,session_kind,session_id,seq,speaker_kind,speaker_name,kind,text,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    message.run("m-old", "user", "us-old", 1, "operator", "operator", "message", "Broad original objective", T1);
    message.run("m-new", "user", "us-new", 1, "operator", "operator", "message", "Later continuation direction", T2);
    message.run("m-internal", "user", "us-internal", 1, "operator", "operator", "message", "Profile-manager instruction", T1);
    pre.prepare("INSERT INTO orchestration_state_revisions (id,user_session_id,revision,trigger,strategy,created_at) VALUES (?,?,?,?,?,?)")
      .run("ost-old", "us-old", 1, "discovery", "keep this", T1);
    pre.close();

    const { sqlite } = openDb(file);
    const rows = sqlite.prepare("SELECT id,objective_document AS objective FROM projects ORDER BY id").all() as { id: string; objective: string | null }[];
    expect(rows).toEqual([
      { id: "p-fallback", objective: "fallback intent" },
      { id: "p-history", objective: "Broad original objective" },
      { id: "p-internal", objective: "internal maintenance objective" },
    ]);
    expect(sqlite.prepare("SELECT strategy,objective_assessment AS assessment FROM orchestration_state_revisions WHERE id='ost-old'").get())
      .toEqual({ strategy: "keep this", assessment: null });
    sqlite.close();
  });
});
