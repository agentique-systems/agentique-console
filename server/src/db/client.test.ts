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
    expect(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 3 });
    // The two indexes that used to live only in the legacy additive migration.
    expect(sqlite.prepare("PRAGMA index_list(interactions)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "interactions_session_status" }),
        expect.objectContaining({ name: "interactions_agent_open" }),
      ]),
    );
    sqlite.close();
  });

  it("adopts a pre-journal database at the baseline shape, then migrates it forward", () => {
    const file = tmpDbFile();
    // A real pre-journal database has the BASELINE shape — later migrations
    // only exist alongside the journal.
    const legacy = new Database(file);
    legacy.exec(fs.readFileSync(new URL("./migrations/0000_baseline.sql", import.meta.url), "utf8"));
    legacy.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run("ws-1", "w", "/tmp/ws-1", "{}", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO user_sessions (id, workspace_id, mode, created_at, updated_at) VALUES (?,?,?,?,?)").run("us-1", "ws-1", "execute", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO agent_sessions (id, user_session_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run("as-1", "us-1", "t", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO participants (agent_session_id, name, role, instructions, ord, created_at) VALUES (?,?,?,?,?,?)").run("as-1", "scout", "agent", "x", 1, "2026-01-01");
    legacy.prepare("INSERT INTO handoff_records (id, user_session_id, sender, recipient, trigger, root_handoff_id, core, extension, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("h-1", "us-1", "console", "scout", "update", "h-1", "{}", JSON.stringify({ kind: "generic", data: { consoleSynthesized: true } }), 10, "2026-01-01");
    legacy.prepare("INSERT INTO handoff_records (id, user_session_id, sender, recipient, trigger, root_handoff_id, core, extension, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("h-2", "us-1", "scout", "main", "update", "h-2", "{}", JSON.stringify({ kind: "generic", data: {} }), 10, "2026-01-01");
    legacy.close();

    const second = openDb(file);
    expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 3 });
    expect(second.sqlite.prepare("SELECT id FROM workspaces").get()).toMatchObject({ id: "ws-1" });
    // Post-baseline backfills reached the adopted rows.
    expect(second.sqlite.prepare("SELECT pattern_role FROM participants WHERE name = 'scout'").get()).toMatchObject({ pattern_role: "specialist" });
    expect(second.sqlite.prepare("SELECT id, synthetic FROM handoff_records ORDER BY id").all()).toEqual([
      { id: "h-1", synthetic: 1 },
      { id: "h-2", synthetic: 0 },
    ]);
    second.sqlite.close();

    const third = openDb(file);
    expect(third.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 3 });
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
