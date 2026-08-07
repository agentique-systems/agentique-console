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
});
