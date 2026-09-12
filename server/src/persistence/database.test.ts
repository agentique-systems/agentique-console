import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MIGRATIONS_FOLDER } from "./client.ts";
import Database from "better-sqlite3";
import { EXPECTED_SCHEMA_INFO } from "@agentique-console/core";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabase, openDatabase, ResetRequiredError } from "./database.ts";
import { TABLE_NAMES } from "./schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-persistence-"));
  dirs.push(dir);
  return dir;
}

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

function writeLegacyDatabase(file: string): void {
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE workspaces (id text primary key, name text not null, root_path text not null, metadata text not null default '{}', created_at text not null, updated_at text not null);
    CREATE TABLE user_sessions (id text primary key, workspace_id text not null, run_state text not null);
    CREATE TABLE agent_sessions (id text primary key, user_session_id text not null);
    CREATE TABLE tasks (id text primary key, status text not null);
    CREATE TABLE events (id text primary key, type text not null);
    CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('deadbeef', 1786471412736);
    INSERT INTO user_sessions VALUES ('us_1', 'ws_1', 'idle');
  `);
  sqlite.close();
}

describe("openDatabase", () => {
  it("migrates version 1 forward without rewriting legacy runs, manifests or events, and pins execution", () => {
    const file = path.join(tempDir(), "version-one.db");
    const legacy = new Database(file);
    legacy.pragma("foreign_keys = OFF");
    const baseline = fs.readFileSync(path.join(MIGRATIONS_FOLDER, "0000_orchestration_core.sql"), "utf8");
    legacy.exec(baseline);
    legacy.exec("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
    legacy.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(createHash("sha256").update(baseline).digest("hex"), 1788299335694);
    legacy.exec(`
      INSERT INTO runs (id, conversation_id, workspace_id, kind, status, target, max_cost_usd, max_tokens, max_attempts, final_reserve_cost_usd, final_reserve_tokens, final_reserve_attempts, verification_policy, created_at, updated_at)
      VALUES ('run_old', 'conv_old', 'ws_old', 'other', 'created', '{}', 10, 10000, 5, 0, 0, 0, '{"maxNodeGateCycles":1,"maxRunCompletionCycles":1,"runCompletionAcceptanceCriterionIds":[],"evaluatorAgentDefinitionRevisionId":null}', '2026-01-01', '2026-01-01');
      INSERT INTO context_manifests VALUES ('ctx_old', 'inv_old', 'run_old', '{"modelPolicy":{"model":"claude-old"}}', '${"a".repeat(64)}', 1, '2026-01-01');
      INSERT INTO events (type, occurred_at, run_id, actor, subject_type, subject_id, payload) VALUES ('old.event', '2026-01-01', 'run_old', '{}', 'run', 'run_old', '{"original":true}');
    `);
    const runBefore = legacy.prepare("SELECT * FROM runs").get();
    const manifestBefore = legacy.prepare("SELECT * FROM context_manifests").get();
    const eventBefore = legacy.prepare("SELECT * FROM events").get();
    legacy.close();
    const current = openDatabase(file);
    try {
      expect(current.schemaInfo.version).toBe(2);
      expect(current.sqlite.prepare("SELECT * FROM runs").get()).toEqual({ ...runBefore as object, execution: null });
      expect(current.sqlite.prepare("SELECT * FROM context_manifests").get()).toEqual(manifestBefore);
      expect(current.sqlite.prepare("SELECT * FROM events").get()).toEqual(eventBefore);
      expect(() => current.sqlite.prepare("UPDATE runs SET execution = ? WHERE id = 'run_old'").run('{"provider":"codex","model":"gpt-5.6-terra"}')).toThrow(/immutable/);
      expect(current.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 2 });
    } finally { current.close(); }
  });

  it("initializes a missing file, creating parent directories, and writes schema_info", () => {
    const file = path.join(tempDir(), "nested", "console.db");
    const db = openDatabase(file);
    try {
      expect(db.disposition).toBe("initialized");
      expect(db.schemaInfo).toEqual(EXPECTED_SCHEMA_INFO);
      expect(tableNames(db.sqlite)).toEqual([...TABLE_NAMES, "__drizzle_migrations"].sort());
    } finally {
      db.close();
    }
  });

  it("initializes an empty database file (no user tables)", () => {
    const file = path.join(tempDir(), "empty.db");
    new Database(file).close();
    expect(fs.statSync(file).size).toBe(0);
    const db = openDatabase(file);
    try {
      expect(db.disposition).toBe("initialized");
    } finally {
      db.close();
    }
  });

  it("reopens a matching database and keeps its contents", () => {
    const file = path.join(tempDir(), "console.db");
    const first = openDatabase(file);
    first.sqlite.prepare("INSERT INTO workspaces (id, name, root_path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("ws_000000000000000000000000", "w", "/w", "git", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    first.close();
    const second = openDatabase(file);
    try {
      expect(second.disposition).toBe("opened");
      expect(second.schemaInfo).toEqual(EXPECTED_SCHEMA_INFO);
      expect(second.sqlite.prepare("SELECT count(*) AS n FROM workspaces").get()).toEqual({ n: 1 });
      expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 2 });
    } finally {
      second.close();
    }
  });

  it("refuses a legacy database without touching it, even though it has a migration journal", () => {
    const file = path.join(tempDir(), "legacy.db");
    writeLegacyDatabase(file);
    const before = fs.readFileSync(file);
    expect(() => openDatabase(file)).toThrow(ResetRequiredError);
    try {
      openDatabase(file);
    } catch (error) {
      expect((error as Error).message).toBe(
        `reset-required: ${file} was created by a previous, unsupported schema.\nDelete the file or point CONSOLE_DATA_DIR at an empty directory.`,
      );
    }
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    const sqlite = new Database(file, { readonly: true });
    expect(tableNames(sqlite)).not.toContain("schema_info");
    expect(sqlite.prepare("SELECT run_state FROM user_sessions").get()).toEqual({ run_state: "idle" });
    sqlite.close();
    // The refused handle was closed: the file can be deleted (Windows would refuse otherwise).
    fs.rmSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses an unrelated SQLite database", () => {
    const file = path.join(tempDir(), "notes.db");
    const sqlite = new Database(file);
    sqlite.exec("CREATE TABLE notes (id integer primary key, body text); INSERT INTO notes (body) VALUES ('hi');");
    sqlite.close();
    expect(() => openDatabase(file)).toThrow(/reset-required/);
    const check = new Database(file, { readonly: true });
    expect(tableNames(check)).toEqual(["notes"]);
    check.close();
  });

  it("refuses a database whose schema_info names another application or a newer version", () => {
    for (const row of [
      ["other-app", "orchestration-core", 1],
      ["agentique-console", "something-else", 1],
      ["agentique-console", "orchestration-core", EXPECTED_SCHEMA_INFO.version + 1],
    ] as const) {
      const file = path.join(tempDir(), "info.db");
      const sqlite = new Database(file);
      sqlite.exec("CREATE TABLE schema_info (id integer primary key, application text not null, schema text not null, version integer not null)");
      sqlite.prepare("INSERT INTO schema_info VALUES (1, ?, ?, ?)").run(row[0], row[1], row[2]);
      sqlite.close();
      expect(() => openDatabase(file)).toThrow(ResetRequiredError);
    }
  });

  it(":memory: always initializes", () => {
    const db = openDatabase(":memory:");
    try {
      expect(db.disposition).toBe("initialized");
      expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("inspectDatabase", () => {
  it("classifies without reading legacy rows", () => {
    const empty = new Database(":memory:");
    expect(inspectDatabase(empty)).toEqual({ kind: "initialize" });
    empty.exec("CREATE TABLE user_sessions (id text)");
    expect(inspectDatabase(empty)).toEqual({ kind: "refuse", reason: "no schema_info table" });
    empty.exec("CREATE TABLE schema_info (id integer primary key, application text, schema text, version integer)");
    expect(inspectDatabase(empty).kind).toBe("refuse");
    empty.exec("INSERT INTO schema_info VALUES (1, 'agentique-console', 'orchestration-core', 1)");
    expect(inspectDatabase(empty)).toEqual({ kind: "open", schemaInfo: { ...EXPECTED_SCHEMA_INFO, version: 1 } });
    empty.exec("INSERT INTO schema_info VALUES (2, 'agentique-console', 'orchestration-core', 1)");
    expect(inspectDatabase(empty).kind).toBe("refuse");
    empty.close();
  });
});
