/**
 * Replay proof for the 0003_glossary migration: a mid-run PRE-RENAME database
 * — built by executing migrations 0000..0002 exactly as a pre-rename server
 * did, journal stamped to match — carries an open session, a queued delivery,
 * transcript rows and old-universe events through `openDb` (which applies only
 * 0003) and then through a real `createApp` + `bootApp`. The migration must
 * leave no old table, no old event type, and no data the boot folds cannot
 * read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../app.ts";
import { bootApp, shutdownApp } from "../boot.ts";
import { loadConfig } from "../config.ts";
import { fakeSdk, initMessage, successMessage } from "../sdk/fake.ts";
import { openDb } from "./client.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-glossary-"));
  dirs.push(dir);
  return path.join(dir, "console.db");
}

/**
 * The hub contract snapshot exactly as the pre-rename builder froze it onto
 * agent_sessions.topology: `advance:"router"`, `minSeats`/`maxSeats`, and the
 * "orchestrator" addressing prose the migration rewrites in place.
 */
const PRE_RENAME_TOPOLOGY = JSON.stringify({
  schemaVersion: 1,
  pattern: "hub_and_spoke",
  roles: {
    coordinator: { replicable: false, min: 1, max: 1, grants: ["tasks_write", "forward_message", "child_sessions"], escalateTo: "main" },
    specialist: { replicable: false, min: 1, max: 20, grants: [], escalateTo: "coordinator" },
  },
  edges: [
    { from: "main", to: "coordinator", advance: "router" },
    { from: "coordinator", to: "main", advance: "router" },
    { from: "coordinator", to: "specialist", advance: "router" },
    { from: "specialist", to: "coordinator", advance: "router" },
  ],
  joins: [],
  entry: { role: "coordinator", broadcast: false },
  termination: {},
  completion: { finalFrom: "coordinator", voice: "coordinator" },
  promptPack: {
    coordinator: { addressing: `Address participants by bare name (e.g. "orchestrator"); "main" reaches the Orchestrator. You may address your specialists and main.`, protocol: "protocol" },
    specialist: { addressing: `Address participants by bare name (e.g. "orchestrator"); "main" reaches the Orchestrator. You may address only orchestrator.`, protocol: "protocol" },
  },
  routeSummary: "Specialists address only orchestrator; orchestrator addresses specialists and main.",
  limits: { minSeats: 1, maxSeats: 20 },
  config: {},
});

/** The full post-rename durable+transient type universe (shared/src/events.ts). */
const NEW_UNION = new Set([
  "workspace.created", "workspace.updated", "user_session.created", "user_session.updated",
  "user_session.message.appended", "user_session.turn.started", "user_session.turn.settled",
  "user_session.context.rotated", "user_session.runtime.noted", "user_session.retry.recorded",
  "user_session.tool.called", "user_session.tool.completed", "user_session.question.asked",
  "user_session.question.answered", "user_session.plan.proposed", "user_session.plan.resolved",
  "agent_session.created", "agent_session.termination.tripped", "agent_session.join.completed",
  "agent_session.child.spawned", "agent_session.child.reported", "agent_session.message.appended",
  "agent_session.turn.started", "agent_session.turn.settled", "agent_session.tool.called",
  "agent_session.tool.completed", "agent_session.status.changed", "agent_session.delivery.updated",
  "agent_session.runtime.noted", "agent_session.retry.recorded", "agent_session.context.rotated",
  "agent_session.process.started", "agent_session.process.output", "agent_session.process.exited",
  "task.created", "task.updated", "task.dependency.created", "task.dependency.deleted",
  "agent_profile.changed", "usage.recorded", "handoff.created", "handoff.consumed",
  "handoff.discrepancy.reported", "handoff.checkpoint.failed", "handoff.final.caveats",
  "handoff.final.blocked", "operator.decision.recorded", "run.completion.proposed",
  "run.signoff.resolved", "run.reopened", "agent_session.closeout.forced",
  "agent_session.watchdog.tripped", "tool.denied", "agent_session.worktree.created",
  "agent_session.worktree.merged", "agent_session.worktree.merge_failed",
  "agent_session.worktree.discarded", "agent_session.delegation.sent",
  "agent_session.result.returned", "stream.delta", "stream.reasoning",
  "agent_session.activity.changed",
]);

const T = "2026-08-01T10:00:00.000Z";

/** Executes 0000..0002 and stamps their journal rows — the exact state a
 * pre-rename server left behind, so `openDb` applies ONLY 0003. */
function buildPreRenameDb(file: string): Database.Database {
  const sqlite = new Database(file);
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const preRename = migrations.slice(0, 3);
  expect(preRename.map((m) => m.folderMillis).every((ms, i) => i === 0 || ms > preRename[i - 1]!.folderMillis)).toBe(true);
  for (const name of ["0000_baseline.sql", "0001_synthetic_flag.sql", "0002_pattern_role_backfill.sql"]) {
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_FOLDER, name), "utf8"));
  }
  sqlite.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const stamp = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  for (const migration of preRename) stamp.run(migration.hash, migration.folderMillis);
  return sqlite;
}

/** A run caught mid-flight: open session, seated hub, queued delivery, live history. */
function insertMidRunFixture(sqlite: Database.Database): void {
  sqlite.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)")
    .run("ws-1", "w", "/tmp/glossary-replay-ws", "{}", T, T);
  sqlite.prepare("INSERT INTO user_sessions (id, workspace_id, title, mode, phase, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("us-1", "ws-1", "mid-run", "execute", "executing", "open", T, T);
  sqlite.prepare("INSERT INTO agent_sessions (id, user_session_id, title, status, pattern, topology, parent_agent_session_id, parent_controller_seat, depth, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("as-1", "us-1", "hub", "open", "hub_and_spoke", PRE_RENAME_TOPOLOGY, null, null, 0, T, T);

  const seat = sqlite.prepare("INSERT INTO participants (agent_session_id, name, role, instructions, profile_id, pattern_role, ord, created_at) VALUES (?,?,?,?,?,?,?,?)");
  seat.run("as-1", "orchestrator", "orchestrator", "coordinate", "coordinator", "coordinator", 0, T);
  seat.run("as-1", "scout", "agent", "explore", "explorer", "specialist", 1, T);

  const message = sqlite.prepare("INSERT INTO messages (id, session_kind, session_id, seq, speaker_kind, speaker_name, to_name, kind, text, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  // The reserved coordination seat speaking in the agent transcript — renamed.
  message.run("msg-a1", "agent", "as-1", 1, "orchestrator", "orchestrator", "scout", "message", "start with repo.ts", T);
  // A specialist report whose delivery is still queued.
  message.run("msg-a2", "agent", "as-1", 2, "agent", "scout", "orchestrator", "message", "found it", T);
  // The main-lane voice in the user transcript — must NOT be renamed.
  message.run("msg-u1", "user", "us-1", 1, "orchestrator", "main", null, "message", "working on it", T);

  sqlite.prepare("INSERT INTO mailbox_deliveries (id, message_id, user_session_id, agent_session_id, sender, recipient, category, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("del-1", "msg-a2", "us-1", "as-1", "scout", "orchestrator", "update", "queued", T);
  sqlite.prepare("INSERT INTO handoff_records (id, user_session_id, agent_session_id, sender, recipient, trigger, root_handoff_id, core, extension, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("h-1", "us-1", "as-1", "orchestrator", "main", "milestone", "h-1",
      JSON.stringify({ status: "in_progress", state: { summary: "midway" }, result: { summary: null } }),
      JSON.stringify({ kind: "generic", data: {} }), 120, T);

  const event = sqlite.prepare("INSERT INTO events (type, user_session_id, agent_session_id, payload, created_at) VALUES (?,?,?,?,?)");
  const rows: [string, string | null, unknown][] = [
    ["user_session.message", null, { sessionId: "us-1", message: { seq: 1, speaker: { kind: "orchestrator", name: "main" }, kind: "message", text: "working on it", createdAt: T } }],
    ["agent_session.message", "as-1", { agentSessionId: "as-1", message: { seq: 1, speaker: { kind: "orchestrator", name: "orchestrator" }, to: "scout", kind: "message", text: "start with repo.ts", createdAt: T } }],
    ["agent_session.tool.call", "as-1", { sessionId: "as-1", participant: "orchestrator", turnId: "t1", callId: "c1", name: "Grep", input: {} }],
    ["agent_session.mailbox", "as-1", { agentSessionId: "as-1", deliveryId: "del-1", messageSeq: 2, sender: "scout", recipient: "orchestrator", category: "update", status: "queued" }],
    ["flow.delegation", "as-1", { userSessionId: "us-1", agentSessionId: "as-1", kind: "created", preview: "kick off" }],
    ["agent_session.status", "as-1", { agentSessionId: "as-1", status: "working" }],
    ["task_dependency.created", null, { dependency: { blockerTaskId: "task-a", blockedTaskId: "task-b", source: "console", createdAt: T } }],
    ["agent.state", "as-1", { scope: { kind: "agent", sessionId: "as-1" }, participant: "orchestrator", state: "thinking" }],
  ];
  for (const [type, agentSessionId, payload] of rows) event.run(type, "us-1", agentSessionId, JSON.stringify(payload), T);
}

describe("0003_glossary replay over a mid-run pre-rename database", () => {
  it("migrates the fixture onto the new universe and boots over it", async () => {
    const file = tmpDbFile();
    const legacy = buildPreRenameDb(file);
    insertMidRunFixture(legacy);
    legacy.close();

    const { db, sqlite } = openDb(file); // journal says 0000..0002 ran — this applies ONLY 0003
    expect(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 15 });

    // Table renames: the old names are gone, the new ones exist.
    const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    expect(tables.has("agents")).toBe(true);
    expect(tables.has("provider_entries")).toBe(true);
    expect(tables.has("participants")).toBe(false);
    expect(tables.has("provider_entries_v2")).toBe(false);

    // The reserved seat is renamed and carries the pattern role as its role.
    expect(sqlite.prepare("SELECT name, role FROM agents WHERE agent_session_id = 'as-1' AND ord = 0").get())
      .toMatchObject({ name: "coordinator", role: "coordinator" });
    expect(sqlite.prepare("SELECT name, role FROM agents WHERE agent_session_id = 'as-1' AND ord = 1").get())
      .toMatchObject({ name: "scout", role: "specialist" });

    // status → lifecycle, value preserved.
    expect(sqlite.prepare("SELECT lifecycle FROM user_sessions WHERE id = 'us-1'").get()).toMatchObject({ lifecycle: "open" });
    expect(sqlite.prepare("SELECT lifecycle, parent_controller_agent FROM agent_sessions WHERE id = 'as-1'").get())
      .toMatchObject({ lifecycle: "open", parent_controller_agent: null });

    // Transport rows renamed with the seat.
    expect(sqlite.prepare("SELECT sender, recipient, status FROM mailbox_deliveries WHERE id = 'del-1'").get())
      .toMatchObject({ sender: "scout", recipient: "coordinator", status: "queued" });
    expect(sqlite.prepare("SELECT sender, recipient FROM handoff_records WHERE id = 'h-1'").get())
      .toMatchObject({ sender: "coordinator", recipient: "main" });

    // Agent-transcript speaker NAMES rename; speaker_kind 'orchestrator' is the
    // main-lane VOICE and stays on both rows; the user-lane name is untouched.
    expect(sqlite.prepare("SELECT speaker_kind, speaker_name FROM messages WHERE id = 'msg-a1'").get())
      .toMatchObject({ speaker_kind: "orchestrator", speaker_name: "coordinator" });
    expect(sqlite.prepare("SELECT speaker_kind, speaker_name FROM messages WHERE id = 'msg-u1'").get())
      .toMatchObject({ speaker_kind: "orchestrator", speaker_name: "main" });

    // The frozen topology snapshot moved onto the new advance/limits vocabulary.
    const { topology } = sqlite.prepare("SELECT topology FROM agent_sessions WHERE id = 'as-1'").get() as { topology: string };
    expect(topology).toContain('"advance":"immediate"');
    expect(topology).not.toContain('"advance":"router"');
    expect(topology).toContain('"minAgents":');
    expect(topology).not.toContain('"minSeats":');

    // Every historical event landed inside the new type universe.
    const types = (sqlite.prepare("SELECT DISTINCT type FROM events").all() as { type: string }[]).map((r) => r.type);
    for (const type of types) expect(NEW_UNION.has(type), `events.type "${type}" is outside the new union`).toBe(true);

    // Sampled payload rewrites: scoped ids and the renamed agent keys.
    const payloadOf = (type: string): Record<string, unknown> =>
      JSON.parse((sqlite.prepare("SELECT payload FROM events WHERE type = ?").get(type) as { payload: string }).payload) as Record<string, unknown>;
    const userMessage = payloadOf("user_session.message.appended");
    expect(userMessage).toMatchObject({ userSessionId: "us-1" });
    expect(userMessage.sessionId).toBeUndefined();
    const agentTool = payloadOf("agent_session.tool.called");
    expect(agentTool).toMatchObject({ agentSessionId: "as-1", agent: "coordinator" });
    expect(agentTool.sessionId).toBeUndefined();
    expect(agentTool.participant).toBeUndefined();
    expect(payloadOf("agent_session.delivery.updated")).toMatchObject({ deliveryId: "del-1", recipient: "coordinator", status: "queued" });
    expect(payloadOf("agent_session.delegation.sent")).toMatchObject({ agentSessionId: "as-1", kind: "created" });
    expect(payloadOf("agent_session.status.changed")).toMatchObject({ agentSessionId: "as-1", status: "working" });
    expect(payloadOf("task.dependency.created")).toMatchObject({ dependency: { blockerTaskId: "task-a" } });
    const activity = payloadOf("agent_session.activity.changed");
    expect(activity).toMatchObject({ agent: "coordinator", state: "thinking" });
    expect(activity.participant).toBeUndefined();

    // The boot folds read the migrated history without exploding: the real
    // composition root plus the real boot sequence over this very file.
    const fake = fakeSdk(async function* () {
      yield initMessage("replay");
      yield successMessage(undefined, { session_id: "replay" });
    });
    const app = createApp({
      config: loadConfig({}),
      db,
      sqlite,
      sdk: async () => fake.sdk,
      runtime: { worktrees: null },
    });
    const bootReport = await bootApp(app);
    expect(bootReport.requeuedDeliveries).toBeGreaterThanOrEqual(0);
    // msg-a2 (scout's report) had no journal event — reconciliation emits
    // exactly one appended event from the RENAMED row, proving the fold path.
    expect(bootReport.reconciledCommunications).toBe(1);
    await shutdownApp(app);
    sqlite.close();
  });
});
