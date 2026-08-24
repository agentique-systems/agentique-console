/**
 * Replay proof for the 0017_drop_spec_revisions migration: a PRE-DROP database
 * — built by executing migrations 0000..0016 exactly as an earlier server did,
 * journal stamped to match — carries legacy spec revisions through `openDb`
 * (which applies only 0017). Every spec document must be archived to
 * event_artifacts; each OPEN pre-graph run must come out governed by an
 * approved intent revision with its approval lineage intact; runs that already
 * have a requirement graph, and archived runs, must be left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../events/bus.ts";
import { RequirementService } from "../orchestrator/requirements.ts";
import { openDb } from "./client.ts";
import { createStores } from "./stores/index.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-specdrop-"));
  dirs.push(dir);
  return path.join(dir, "console.db");
}

const T = "2026-08-01T10:00:00.000Z";
const T2 = "2026-08-02T10:00:00.000Z";

/** Executes 0000..0016 and stamps their journal rows, so `openDb` applies 0017 onward. */
function buildPreDropDb(file: string): Database.Database {
  const sqlite = new Database(file);
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  // Everything BEFORE 0017 — sliced by position, not "all but the last", so
  // later migrations (0018…) do not silently join the pre-drop universe.
  const prior = migrations.slice(0, 17);
  expect(prior).toHaveLength(17);
  for (const migration of prior) for (const statement of migration.sql) sqlite.exec(statement);
  sqlite.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const stamp = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  for (const migration of prior) stamp.run(migration.hash, migration.folderMillis);
  return sqlite;
}

const LEGACY_DOC = "# Game spec (v2)\n\nDeterministic dungeons; combat feels responsive.";

/**
 * Three projects at drop time: `proj-legacy` (open, spec-governed, no graph —
 * MUST convert), `proj-graph` (open, already graph-governed, a stale approved
 * spec left behind — must NOT convert), `proj-closed` (archived, spec-governed
 * — archived to artifacts only).
 */
function insertFixture(sqlite: Database.Database): void {
  sqlite.prepare("INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("ws-1", "w", "/tmp/specdrop-replay-ws", T, T);
  const project = sqlite.prepare("INSERT INTO projects (id, workspace_id, title, intent_document, created_at) VALUES (?,?,?,?,?)");
  project.run("proj-legacy", "ws-1", null, null, T);
  project.run("proj-graph", "ws-1", null, "existing intent", T);
  project.run("proj-closed", "ws-1", null, null, T);
  const session = sqlite.prepare("INSERT INTO user_sessions (id, workspace_id, project_id, mode, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
  session.run("us-legacy", "ws-1", "proj-legacy", "execute", "open", T, T);
  session.run("us-graph", "ws-1", "proj-graph", "execute", "open", T, T);
  session.run("us-closed", "ws-1", "proj-closed", "execute", "archived", T, T);

  const spec = sqlite.prepare(
    "INSERT INTO spec_revisions (id, user_session_id, revision, document, change_note, status, origin, interaction_id, created_at, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  // The pre-graph run's history: superseded v1, governing v2, an unresolved draft.
  spec.run("spec-1", "us-legacy", 1, "# Game spec (v1)", "initial", "superseded", "main", null, T, T);
  spec.run("spec-2", "us-legacy", 2, LEGACY_DOC, "sharpen combat", "approved", "operator_edited", "int-1", T2, T2);
  spec.run("spec-3", "us-legacy", 3, "# Game spec (v3, never approved)", null, "draft", "main", null, T2, null);
  // A stale spec on an already-migrated (graph-governed) run.
  spec.run("spec-4", "us-graph", 1, "# Old spec on a graph run", null, "approved", "main", null, T, T);
  // An archived pre-graph run.
  spec.run("spec-5", "us-closed", 1, "# Spec of a closed run", null, "approved", "main", null, T, T);

  sqlite.prepare(
    "INSERT INTO requirement_revisions (id, project_id, user_session_id, revision, kind, base_revision, document, graph, status, created_at, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("reqrev-existing", "proj-graph", "us-graph", 1, "full", 0, "## Requirements\n- r1: Works\n",
      JSON.stringify({ title: null, preamble: [], nodes: [{ id: "r1", statement: "Works", composition: "all", verifyExpectation: null, children: [] }] }),
      "approved", T, T);
}

describe("0017_drop_spec_revisions replay over a pre-drop database", () => {
  it("archives every document, converts exactly the open pre-graph run, and drops the table", () => {
    const file = tmpDbFile();
    const legacy = buildPreDropDb(file);
    insertFixture(legacy);
    legacy.close();

    const { db, sqlite } = openDb(file); // journal says 0000..0016 ran — this applies ONLY 0017
    expect(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 20 });
    const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    expect(tables.has("spec_revisions")).toBe(false);

    // Every document — approved, superseded, draft, archived-run — is archived verbatim.
    const artifacts = sqlite.prepare("SELECT id, user_session_id, media_type, content FROM event_artifacts ORDER BY id").all() as
      { id: string; user_session_id: string; media_type: string; content: string }[];
    expect(artifacts.map((row) => row.id)).toEqual(
      ["artifact_spec-1", "artifact_spec-2", "artifact_spec-3", "artifact_spec-4", "artifact_spec-5"]);
    expect(artifacts[1]).toMatchObject({ user_session_id: "us-legacy", media_type: "text/markdown", content: LEGACY_DOC });

    // The open pre-graph run converts: ONE approved intent revision carrying
    // the governing document and its approval lineage.
    const converted = sqlite.prepare("SELECT * FROM requirement_revisions WHERE project_id = 'proj-legacy'").all() as Record<string, unknown>[];
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      id: "reqrev_spec-2", revision: 1, kind: "intent", scope_id: null, base_revision: 0,
      document: LEGACY_DOC, status: "approved", origin: "operator_edited", interaction_id: "int-1",
      created_at: T2, approved_at: T2, change_note: "migrated from the legacy specification (spec rev 2)",
    });
    const graph = JSON.parse(converted[0]!.graph as string) as { title: null; preamble: { heading: string; body: string }[]; nodes: unknown[] };
    expect(graph).toEqual({ title: null, preamble: [{ heading: "", body: LEGACY_DOC }], nodes: [] });
    expect(sqlite.prepare("SELECT intent_document FROM projects WHERE id = 'proj-legacy'").get())
      .toMatchObject({ intent_document: LEGACY_DOC });

    // The graph-governed run is untouched; the archived run gets no revision.
    expect(sqlite.prepare("SELECT count(*) AS n FROM requirement_revisions WHERE project_id = 'proj-graph'").get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare("SELECT intent_document FROM projects WHERE id = 'proj-graph'").get()).toMatchObject({ intent_document: "existing intent" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM requirement_revisions WHERE project_id = 'proj-closed'").get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare("SELECT intent_document FROM projects WHERE id = 'proj-closed'").get()).toMatchObject({ intent_document: null });

    // The service read path over the migrated row: the run IS governed.
    const stores = createStores(db, sqlite);
    const bus = new EventBus(db, stores.artifacts);
    const service = new RequirementService(stores.requirements, stores.projects, stores.assumptions, bus, () => "proj-legacy");
    expect(service.governingRevision("us-legacy")).toBe(1);
    expect(service.intentDocument("us-legacy")).toBe(LEGACY_DOC);
    expect(service.pointer("us-legacy")).toBe("requirements rev 1 — 0/0 satisfied, 0 open");
    expect(service.digest("us-legacy")).toContain("Deterministic dungeons");
    sqlite.close();
  });
});
