import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 1 });
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
    expect(inspectDatabase(empty)).toEqual({ kind: "open", schemaInfo: EXPECTED_SCHEMA_INFO });
    empty.exec("INSERT INTO schema_info VALUES (2, 'agentique-console', 'orchestration-core', 1)");
    expect(inspectDatabase(empty).kind).toBe("refuse");
    empty.close();
  });
});
