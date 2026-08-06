import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "./client.ts";

describe("database migrations", () => {
  it("adds dependency dispatch columns to an existing mailbox table", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-db-test-"));
    const filename = path.join(directory, "console.db");
    try {
      const old = new Database(filename);
      old.exec(`
        CREATE TABLE mailbox_deliveries (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          user_session_id TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          dedupe_key TEXT,
          delivered_at TEXT,
          acknowledged_at TEXT,
          created_at TEXT NOT NULL
        )
      `);
      old.close();

      const opened = openDb(filename);
      const columns = opened.sqlite
        .prepare("pragma table_info(mailbox_deliveries)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual(expect.arrayContaining(["gate_task_id", "dispatch_state"]));
      opened.sqlite.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
