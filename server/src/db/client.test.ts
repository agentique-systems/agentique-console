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
    for (const table of ["workspaces", "user_sessions", "agent_sessions", "agents", "messages", "interactions", "tasks", "task_dependencies", "events", "mailbox_deliveries", "handoff_records", "pattern_state"]) {
      expect(tables.has(table)).toBe(true);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 6 });
    // Indexes the baseline must create.
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
    expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 6 });
    expect(second.sqlite.prepare("SELECT id FROM workspaces").get()).toMatchObject({ id: "ws-1" });
    // Post-baseline backfills reached the adopted rows (pattern_role became
    // the single `agents.role` column in 0003).
    expect(second.sqlite.prepare("SELECT role FROM agents WHERE name = 'scout'").get()).toMatchObject({ role: "specialist" });
    expect(second.sqlite.prepare("SELECT id, synthetic FROM handoff_records ORDER BY id").all()).toEqual([
      { id: "h-1", synthetic: 1 },
      { id: "h-2", synthetic: 0 },
    ]);
    second.sqlite.close();

    const third = openDb(file);
    expect(third.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toMatchObject({ n: 6 });
    third.sqlite.close();
  });

  it("0003_glossary rewrites event history onto the renamed universe", () => {
    const file = tmpDbFile();
    const legacy = new Database(file);
    legacy.exec(fs.readFileSync(new URL("./migrations/0000_baseline.sql", import.meta.url), "utf8"));
    legacy.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run("ws-1", "w", "/tmp/ws-g", "{}", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO user_sessions (id, workspace_id, mode, created_at, updated_at) VALUES (?,?,?,?,?)").run("us-1", "ws-1", "execute", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO agent_sessions (id, user_session_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run("as-1", "us-1", "t", "2026-01-01", "2026-01-01");
    legacy.prepare("INSERT INTO participants (agent_session_id, name, role, instructions, ord, created_at) VALUES (?,?,?,?,?,?)").run("as-1", "orchestrator", "orchestrator", "x", 0, "2026-01-01");
    const insert = legacy.prepare("INSERT INTO events (type, user_session_id, agent_session_id, payload, created_at) VALUES (?,?,?,?,?)");
    // One pre-rename row of each renamed durable type, with the payload shapes
    // the old emitters wrote.
    const rows: [string, string | null, string][] = [
      ["user_session.message", null, JSON.stringify({ sessionId: "us-1", message: { seq: 1 } })],
      ["agent_session.message", "as-1", JSON.stringify({ agentSessionId: "as-1", message: { seq: 1 } })],
      ["user_session.tool.call", null, JSON.stringify({ sessionId: "us-1", callId: "c1", name: "Read", input: {} })],
      ["user_session.tool.result", null, JSON.stringify({ sessionId: "us-1", callId: "c1", output: { entrySeat: "orchestrator" } })],
      ["agent_session.tool.call", "as-1", JSON.stringify({ sessionId: "as-1", participant: "orchestrator", callId: "c2", name: "Grep", input: {} })],
      ["agent_session.tool.result", "as-1", JSON.stringify({ sessionId: "as-1", participant: "orchestrator", callId: "c2", output: {} })],
      ["user_session.runtime", null, JSON.stringify({ sessionId: "us-1", detail: "d" })],
      ["agent_session.runtime", "as-1", JSON.stringify({ agentSessionId: "as-1", participant: "orchestrator", detail: "d" })],
      ["agent_session.status", "as-1", JSON.stringify({ agentSessionId: "as-1", status: "working" })],
      ["agent_session.mailbox", "as-1", JSON.stringify({ agentSessionId: "as-1", deliveryId: "d1", messageSeq: 1, sender: "orchestrator", recipient: "scout", category: "assignment", status: "queued" })],
      ["agent_session.watchdog", "as-1", JSON.stringify({ agentSessionId: "as-1", participant: "scout", turnId: "t1", kind: "repeat_tool_calls", count: 5, detail: "d" })],
      ["agent_session.unreported", "as-1", JSON.stringify({ agentSessionId: "as-1", seatReports: 2, hadCoordinatorReport: false })],
      ["governance.tool.denied", null, JSON.stringify({ sessionId: "us-1", toolName: "Bash", kind: "coordination_only", reason: "r" })],
      ["handoff.discrepancy", "as-1", JSON.stringify({ handoffId: "h1", reporter: "scout", claim: "c", evidence: "e" })],
      ["task_dependency.created", null, JSON.stringify({ dependency: { blockerTaskId: "a", blockedTaskId: "b", source: "console", createdAt: "2026-01-01" } })],
      ["task_dependency.deleted", null, JSON.stringify({ dependency: { blockerTaskId: "a", blockedTaskId: "b", source: "console", createdAt: "2026-01-01" } })],
      ["flow.delegation", "as-1", JSON.stringify({ userSessionId: "us-1", agentSessionId: "as-1", kind: "created", preview: "p" })],
      ["flow.result", "as-1", JSON.stringify({ userSessionId: "us-1", agentSessionId: "as-1", digestPreview: "p" })],
      ["agent.state", "as-1", JSON.stringify({ scope: { kind: "agent", sessionId: "as-1" }, participant: "orchestrator", state: "idle" })],
      ["agent_session.created", "as-1", JSON.stringify({ session: { id: "as-1" }, participants: ["scout"] })],
      ["agent_session.child.spawned", "as-1", JSON.stringify({ agentSessionId: "as-1", childAgentSessionId: "as-2", pattern: "hub_and_spoke", byParticipant: "orchestrator", title: "t" })],
      ["agent_session.worktree.created", "as-1", JSON.stringify({ agentSessionId: "as-1", seat: "scout", branch: "b", baseCommit: "c" })],
      ["usage.recorded", "as-1", JSON.stringify({ userSessionId: "us-1", agentSessionId: "as-1", participant: "orchestrator", generation: 0, turnId: "t1", inputTokens: 1, outputTokens: 1 })],
    ];
    for (const [type, agentSessionId, payload] of rows) insert.run(type, "us-1", agentSessionId, payload, "2026-01-01");
    legacy.close();

    const { sqlite } = openDb(file);
    // Every renamed old type is gone; everything left is in the new universe.
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
    const types = (sqlite.prepare("SELECT DISTINCT type FROM events").all() as { type: string }[]).map((r) => r.type);
    for (const type of types) expect(NEW_UNION.has(type), `events.type "${type}" is outside the new union`).toBe(true);
    // Sampled payload rewrites: 'orchestrator' → 'coordinator', keys renamed,
    // bare sessionId disambiguated.
    const mailbox = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.delivery.updated'").get() as { payload: string };
    expect(JSON.parse(mailbox.payload).sender).toBe("coordinator");
    const runtime = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.runtime.noted'").get() as { payload: string };
    expect(JSON.parse(runtime.payload)).toMatchObject({ agent: "coordinator" });
    expect(JSON.parse(runtime.payload).participant).toBeUndefined();
    const userTool = sqlite.prepare("SELECT payload FROM events WHERE type = 'user_session.tool.called'").get() as { payload: string };
    expect(JSON.parse(userTool.payload)).toMatchObject({ userSessionId: "us-1" });
    expect(JSON.parse(userTool.payload).sessionId).toBeUndefined();
    const userToolResult = sqlite.prepare("SELECT payload FROM events WHERE type = 'user_session.tool.completed'").get() as { payload: string };
    expect(JSON.parse(userToolResult.payload).output.entrySeat).toBe("coordinator");
    const agentTool = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.tool.called'").get() as { payload: string };
    expect(JSON.parse(agentTool.payload)).toMatchObject({ agentSessionId: "as-1", agent: "coordinator" });
    const created = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.created'").get() as { payload: string };
    expect(JSON.parse(created.payload).agents).toEqual(["scout"]);
    const spawned = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.child.spawned'").get() as { payload: string };
    expect(JSON.parse(spawned.payload).byAgent).toBe("coordinator");
    const worktree = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.worktree.created'").get() as { payload: string };
    expect(JSON.parse(worktree.payload).agent).toBe("scout");
    const closeout = sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.closeout.forced'").get() as { payload: string };
    expect(JSON.parse(closeout.payload).agentReports).toBe(2);
    // The renamed participant row itself, and its speaker rows.
    expect(sqlite.prepare("SELECT name, role FROM agents WHERE agent_session_id = 'as-1'").get()).toMatchObject({ name: "coordinator", role: "coordinator" });
    sqlite.close();
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
