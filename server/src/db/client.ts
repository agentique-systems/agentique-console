import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DDL } from "./ddl.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof openDb>["db"];

export function openDb(dbFile: string) {
  if (dbFile !== ":memory:") {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  }
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  migrateAdditiveColumns(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function migrateAdditiveColumns(sqlite: Database.Database): void {
  const userColumns = new Set(sqlite.prepare("pragma table_info(user_sessions)").all().map((row) => (row as { name: string }).name));
  for (const [name, ddl] of [["sdk_generation", "INTEGER NOT NULL DEFAULT 0"], ["sdk_turn_count", "INTEGER NOT NULL DEFAULT 0"], ["context_tokens", "INTEGER NOT NULL DEFAULT 0"], ["memory", "TEXT NOT NULL DEFAULT ''"], ["latest_handoff_id", "TEXT"], ["purpose", "TEXT NOT NULL DEFAULT 'work'"], ["subject_key", "TEXT"], ["cumulative_cost_usd", "REAL NOT NULL DEFAULT 0"], ["cumulative_api_duration_ms", "INTEGER NOT NULL DEFAULT 0"], ["run_state", "TEXT NOT NULL DEFAULT 'active' CHECK (run_state IN ('active','awaiting_signoff','completed'))"], ["run_base_commit", "TEXT"], ["model", "TEXT"]] as const) {
    if (!userColumns.has(name)) sqlite.exec(`ALTER TABLE user_sessions ADD COLUMN ${name} ${ddl}`);
  }
  const agentSessionColumns = new Set(sqlite.prepare("pragma table_info(agent_sessions)").all().map((row) => (row as { name: string }).name));
  for (const [name, ddl] of [
    // No CHECK on pattern — the catalog grows, and a CHECK cannot widen.
    ["pattern", "TEXT NOT NULL DEFAULT 'hub_and_spoke'"],
    ["topology", "TEXT NOT NULL DEFAULT '{}'"],
    ["parent_agent_session_id", "TEXT"],
    ["parent_controller_seat", "TEXT"],
    ["depth", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!agentSessionColumns.has(name)) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${ddl}`);
  }
  const columns = new Set(
    sqlite
      .prepare("pragma table_info(participants)")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const additions: [string, string][] = [
    ["profile_id", "TEXT NOT NULL DEFAULT 'explorer'"],
    ["profile_snapshot", "TEXT NOT NULL DEFAULT '{}'"],
    ["ownership", "TEXT NOT NULL DEFAULT '[]'"],
    ["sdk_session_id", "TEXT"],
    ["generation", "INTEGER NOT NULL DEFAULT 0"],
    ["turn_count", "INTEGER NOT NULL DEFAULT 0"],
    ["context_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["latest_handoff_id", "TEXT"],
    ["worktree_path", "TEXT"],
    ["worktree_base_commit", "TEXT"],
    ["worktree_branch", "TEXT"],
    ["last_active_at", "TEXT"],
    ["cumulative_cost_usd", "REAL NOT NULL DEFAULT 0"],
    ["cumulative_api_duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["last_decision_at", "TEXT"],
    ["pattern_role", "TEXT"],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE participants ADD COLUMN ${name} ${ddl}`);
  }
  // Bare, no CHECKs — the `transport` precedent below. An existing table's
  // CHECK cannot be widened, so the service treats these as typed by drizzle
  // and validated at the boundary rather than by the database.
  const interactionColumns = new Set(sqlite.prepare("pragma table_info(interactions)").all().map((row) => (row as { name: string }).name));
  for (const [name, ddl] of [
    ["agent_session_id", "TEXT"],
    ["participant", "TEXT"],
    ["urgency", "TEXT NOT NULL DEFAULT 'blocking'"],
    ["source", "TEXT NOT NULL DEFAULT 'agent'"],
    ["recommendation", "TEXT"],
    ["dedupe_key", "TEXT"],
    ["allow_free_text", "INTEGER NOT NULL DEFAULT 0"],
    ["detached", "INTEGER NOT NULL DEFAULT 0"],
    ["flushed_at", "TEXT"],
  ] as const) {
    if (!interactionColumns.has(name)) sqlite.exec(`ALTER TABLE interactions ADD COLUMN ${name} ${ddl}`);
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS interactions_session_status ON interactions(user_session_id, status)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS interactions_agent_open ON interactions(agent_session_id, status, urgency)");
  const cronColumns = new Set(sqlite.prepare("pragma table_info(crons)").all().map((row) => (row as { name: string }).name));
  if (!cronColumns.has("due_at")) sqlite.exec("ALTER TABLE crons ADD COLUMN due_at TEXT");
  const usageColumns = new Set(sqlite.prepare("pragma table_info(usage_samples)").all().map((row) => (row as { name: string }).name));
  for (const name of ["uncached_input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (!usageColumns.has(name)) sqlite.exec(`ALTER TABLE usage_samples ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }
  const usageOptional: [string, string][] = [["model", "TEXT"], ["effort", "TEXT"], ["trigger", "TEXT"], ["duration_ms", "INTEGER"], ["api_duration_ms", "INTEGER"], ["sdk_duration_ms", "INTEGER"], ["status", "TEXT"], ["stop_reason", "TEXT"]];
  for (const [name, ddl] of usageOptional) if (!usageColumns.has(name)) sqlite.exec(`ALTER TABLE usage_samples ADD COLUMN ${name} ${ddl}`);

  const taskColumns = new Set(sqlite.prepare("pragma table_info(tasks)").all().map((row) => (row as { name: string }).name));
  if (!taskColumns.has("id")) sqlite.exec("ALTER TABLE tasks ADD COLUMN id TEXT");
  const missing = sqlite.prepare("SELECT sdk_session_id, sdk_task_id FROM tasks WHERE id IS NULL OR id = ''").all() as { sdk_session_id: string; sdk_task_id: string }[];
  const updateTaskId = sqlite.prepare("UPDATE tasks SET id = ? WHERE sdk_session_id = ? AND sdk_task_id = ?");
  for (const row of missing) updateTaskId.run(`task_${Buffer.from(`${row.sdk_session_id}\0${row.sdk_task_id}`).toString("base64url")}`, row.sdk_session_id, row.sdk_task_id);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_console_id ON tasks(id)");

  // Legacy cleanup for subsystems removed in the 2026-08-10 simplification.
  // agent_sessions.mode was NOT NULL without a default, so inserts on an old
  // database would fail once the code stopped writing it — the DROPs are the
  // migration, not cosmetics. Best-effort: a statement that cannot apply
  // (already gone, or DROP COLUMN unsupported) must never block boot.
  for (const statement of [
    "DROP TABLE IF EXISTS sdk_session_entries",
    "DROP TABLE IF EXISTS contract_parties",
    "DROP TABLE IF EXISTS contracts",
    "DROP TABLE IF EXISTS attempt_groups",
    "ALTER TABLE agent_sessions DROP COLUMN mode",
    "ALTER TABLE agent_sessions DROP COLUMN phase",
  ]) {
    try { sqlite.exec(statement); } catch { /* already applied, or unsupported */ }
  }
}
