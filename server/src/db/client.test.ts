import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-db-"));
  dirs.push(dir);
  return path.join(dir, "console.db");
}

describe("database migrations", () => {
  it("applies the baseline to a fresh database and records the journal", () => {
    const { sqlite } = openDb(tmpDbFile());
    const tables = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const table of ["workspaces", "user_sessions", "agent_sessions", "participants", "messages", "interactions", "tasks", "task_dependencies", "events", "mailbox_deliveries", "handoff_records", "pattern_state"]) {
      expect(tables.has(table)).toBe(true);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 1 });
    // The two indexes that used to live only in the legacy additive migration.
    expect(sqlite.prepare("PRAGMA index_list(interactions)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "interactions_session_status" }),
        expect.objectContaining({ name: "interactions_agent_open" }),
      ]),
    );
    sqlite.close();
  });

  it("adopts a pre-journal database at the baseline shape by stamping, and is idempotent", () => {
    const file = tmpDbFile();
    const first = openDb(file);
    first.sqlite.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run("ws-1", "w", "/tmp/ws-1", "{}", "2026-01-01", "2026-01-01");
    // Simulate a database created before the journal existed: current shape, no journal.
    first.sqlite.exec("DROP TABLE __drizzle_migrations");
    first.sqlite.close();

    const second = openDb(file);
    expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 1 });
    expect(second.sqlite.prepare("SELECT id FROM workspaces").get()).toMatchObject({ id: "ws-1" });
    second.sqlite.close();

    const third = openDb(file);
    expect(third.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 1 });
    third.sqlite.close();
  });

  it("refuses a database that predates the baseline shape", () => {
    const file = tmpDbFile();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE user_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT,
        mode TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'planning', status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    legacy.close();
    expect(() => openDb(file)).toThrow(/lacks user_sessions\.run_state.*delete the file/s);
  });

  it("refuses a database the legacy cleanup never ran on", () => {
    const file = tmpDbFile();
    const current = openDb(file);
    current.sqlite.exec("DROP TABLE __drizzle_migrations");
    current.sqlite.exec("ALTER TABLE agent_sessions ADD COLUMN mode TEXT");
    current.sqlite.close();
    expect(() => openDb(file)).toThrow(/still carries agent_sessions\.mode.*delete the file/s);
  });
});
