/**
 * Replay proof for the 0023_hot_read_models migration: a PRE-PROJECTION
 * database — built by executing migrations 0000..0022 exactly as an earlier
 * server did, journal stamped to match — carries historical status changes
 * through `openDb` (which applies 0023). The backfill must point every node at
 * its max-`ord` journal row (the shared invalidation clock, NOT wall time —
 * the fixture plants a stale row with a LATER timestamp to prove it), leave
 * never-claimed nodes NULL, key strictly per project, and come out clean under
 * the store's own journal-derivation verifier.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "./client.ts";
import { RequirementStore } from "./stores/requirement-store.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-projmig-"));
  dirs.push(dir);
  return path.join(dir, "console.db");
}

const T = "2026-08-01T10:00:00.000Z";

/** Executes 0000..0022 and stamps their journal rows, so `openDb` applies 0023 onward. */
function buildPreProjectionDb(file: string): Database.Database {
  const sqlite = new Database(file);
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const prior = migrations.slice(0, 23);
  expect(prior).toHaveLength(23);
  for (const migration of prior) for (const statement of migration.sql) sqlite.exec(statement);
  sqlite.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const stamp = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  for (const migration of prior) stamp.run(migration.hash, migration.folderMillis);
  return sqlite;
}

function insertFixture(sqlite: Database.Database): void {
  sqlite.prepare("INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("ws-1", "w", "/tmp/projmig-replay-ws", T, T);
  const project = sqlite.prepare("INSERT INTO projects (id, workspace_id, title, intent_document, created_at) VALUES (?,?,?,?,?)");
  project.run("proj-a", "ws-1", null, null, T);
  project.run("proj-b", "ws-1", null, null, T);
  const session = sqlite.prepare("INSERT INTO user_sessions (id, workspace_id, project_id, mode, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
  session.run("us-a", "ws-1", "proj-a", "execute", "open", T, T);
  session.run("us-b", "ws-1", "proj-b", "execute", "open", T, T);

  const node = sqlite.prepare(
    "INSERT INTO requirement_nodes (id, project_id, parent_id, ord, statement, composition, verify_expectation, status, origin, introduced_in_revision, retired_in_revision, refined_by_agent_session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // proj-a: a parent, a claimed leaf, a never-claimed leaf, a retired node.
  node.run("r1", "proj-a", null, 0, "Root", "all", null, "open", "committed", 1, null, null, T, T);
  node.run("r2", "proj-a", "r1", 0, "Claimed leaf", "all", null, "satisfied", "committed", 1, null, null, T, T);
  node.run("r3", "proj-a", "r1", 1, "Untouched leaf", "all", null, "open", "committed", 1, null, null, T, T);
  node.run("r4", "proj-a", "r1", 2, "Retired", "all", null, "retired", "committed", 1, 2, null, T, T);
  // proj-b reuses the id "r2" — the backfill must key per project.
  node.run("r2", "proj-b", null, 0, "Other project's r2", "all", null, "violated", "committed", 1, null, null, T, T);

  const change = sqlite.prepare(
    "INSERT INTO requirement_status_changes (id, project_id, user_session_id, requirement_id, from_status, to_status, evidence, verified_by, actor, agent_session_id, at_revision, ord, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // r2's history: satisfied → open → satisfied. The FIRST row carries the
  // LATEST wall-clock timestamp — a createdAt-based backfill would pick it;
  // the clock (`ord`) says the last row governs.
  change.run("c1", "proj-a", "us-a", "r2", "open", "satisfied", '[{"kind":"command","ref":"old run"}]', "self", "worker", null, 1, 1, null, "2026-08-03T10:00:00.000Z");
  change.run("c2", "proj-a", "us-a", "r2", "satisfied", "open", "[]", "self", "worker", null, 1, 2, null, "2026-08-01T11:00:00.000Z");
  change.run("c3", "proj-a", "us-a", "r2", "open", "satisfied", '[{"kind":"command","ref":"new run"}]', "independent", "checker", null, 1, 3, null, "2026-08-01T12:00:00.000Z");
  // r4 was retired mechanically (console transition).
  change.run("c4", "proj-a", "us-a", "r4", "open", "retired", "[]", "console", "console", null, 2, 4, "retired by rev 2", T);
  // proj-b's own clock, overlapping ord values with proj-a.
  change.run("c5", "proj-b", "us-b", "r2", "open", "violated", '[{"kind":"file","ref":"src/x.ts"}]', "self", "worker", null, 1, 1, null, T);
}

describe("0023 backfill", () => {
  it("points every node at its max-ord journal row, per project, and verifies clean", () => {
    const file = tmpDbFile();
    const pre = buildPreProjectionDb(file);
    insertFixture(pre);
    // The pre-projection schema must not know the pointer columns yet.
    const columns = pre.prepare("pragma table_info(requirement_nodes)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "latest_change_id")).toBe(false);
    pre.close();

    const { db, sqlite } = openDb(file);
    const store = new RequirementStore(db, sqlite);

    // The claimed leaf follows the CLOCK, not the planted newer timestamp.
    const r2 = store.getNode("proj-a", "r2")!;
    expect(r2.latestChangeId).toBe("c3");
    expect(r2.latestChangeOrd).toBe(3);
    // Never claimed → NULL pointer; retired → its console retirement row.
    expect(store.getNode("proj-a", "r3")!.latestChangeId).toBeNull();
    expect(store.getNode("proj-a", "r1")!.latestChangeId).toBeNull();
    expect(store.getNode("proj-a", "r4")!.latestChangeId).toBe("c4");
    // Same id in another project resolves to that project's journal.
    expect(store.getNode("proj-b", "r2")!.latestChangeId).toBe("c5");

    // The migrated projection is exactly what the journal derives.
    expect(store.verifyCurrentState("proj-a")).toEqual([]);
    expect(store.verifyCurrentState("proj-b")).toEqual([]);
    const latest = store.latestChanges("proj-a");
    expect(latest.get("r2")?.verifiedBy).toBe("independent");
    expect([...latest.keys()].sort()).toEqual(["r2", "r4"]);

    // Old data stays readable and the write path resumes the same clock.
    const { change } = store.applyStatusChange({
      projectId: "proj-a", userSessionId: "us-a", requirementId: "r3", toStatus: "satisfied",
      evidence: [{ kind: "command", ref: "post-migration" }], verifiedBy: "self", actor: "worker", atRevision: 2,
    });
    expect(change.ord).toBe(5);
    expect(store.getNode("proj-a", "r3")!.latestChangeId).toBe(change.id);
    expect(store.verifyCurrentState("proj-a")).toEqual([]);
    sqlite.close();
  });
});
