import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("database migration", () => {
  it("backfills stable task ids before creating their unique index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-db-")); dirs.push(dir); const file = path.join(dir, "console.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE tasks (sdk_session_id TEXT NOT NULL, sdk_task_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_session_id TEXT NOT NULL, agent_session_id TEXT, participant TEXT, subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', active_form TEXT, status TEXT NOT NULL DEFAULT 'pending', owner TEXT, blocks TEXT NOT NULL DEFAULT '[]', blocked_by TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (sdk_session_id, sdk_task_id));`);
    legacy.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("sdk-1", "7", "ws-1", "us-1", null, null, "Legacy", "", null, "pending", null, "[]", "[]", "{}", "2026-01-01", "2026-01-01");
    legacy.close();
    const { sqlite } = openDb(file);
    const row = sqlite.prepare("SELECT id FROM tasks").get() as { id: string };
    expect(row.id).toMatch(/^task_/);
    expect(sqlite.prepare("PRAGMA index_list(tasks)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "tasks_console_id", unique: 1 })]));
    sqlite.close();
  });

  /**
   * `openDb` execs the DDL block BEFORE `migrateAdditiveColumns`. On an
   * existing database `CREATE TABLE IF NOT EXISTS` is a no-op, but
   * `CREATE INDEX IF NOT EXISTS` is not — so an index in the DDL that names a
   * column only the migration adds fails the entire boot with
   * "no such column". Caught by opening a copy of a real live database; the
   * fixture below is that database's `interactions` table.
   */
  it("opens a legacy interactions table and backfills its new columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-db-")); dirs.push(dir); const file = path.join(dir, "console.db");
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT, mode TEXT NOT NULL CHECK (mode IN ('execute','plan_execute')), phase TEXT NOT NULL DEFAULT 'planning', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE interactions (id TEXT PRIMARY KEY, user_session_id TEXT NOT NULL REFERENCES user_sessions(id), kind TEXT NOT NULL CHECK (kind IN ('question','plan_approval')), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','rejected','dismissed','stale')), payload TEXT NOT NULL, response TEXT, tool_use_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
    `);
    legacy.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run("ws-1", "w", "/tmp/ws-1", "{}", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO user_sessions VALUES (?,?,?,?,?,?,?,?)").run("us-1", "ws-1", "t", "execute", "executing", "open", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO interactions VALUES (?,?,?,?,?,?,?,?,?)").run("int-1", "us-1", "question", "answered", "{}", null, null, "2026-01-01", "2026-01-01");
    legacy.close();

    const { sqlite } = openDb(file);
    const columns = new Set((sqlite.prepare("PRAGMA table_info(interactions)").all() as { name: string }[]).map((row) => row.name));
    for (const added of ["agent_session_id", "participant", "urgency", "source", "detached", "flushed_at", "allow_free_text"]) {
      expect(columns.has(added)).toBe(true);
    }
    // Existing rows land on the defaults that describe what they actually were:
    // a main-lane blocking question raised by an agent.
    const row = sqlite.prepare("SELECT urgency, source, detached, participant FROM interactions").get() as Record<string, unknown>;
    expect(row).toMatchObject({ urgency: "blocking", source: "agent", detached: 0, participant: null });
    expect(sqlite.prepare("PRAGMA index_list(interactions)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "interactions_agent_open" })]));
    sqlite.close();
  });
});
