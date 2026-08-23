/**
 * Checker-library units over synthetic journals — cases the scenario traces
 * cannot cheaply produce. Review regression: respondedToEvidence must not
 * count a random seat's routine report_requirement as a plan response (the
 * scoping the doctrine comment promises), while main's own status change or
 * one on the marker's session still counts.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { respondedToEvidence } from "./checks.ts";
import { Trace, type Ev } from "./trace.ts";

function journal(rows: { type: string; agentSessionId?: string | null; payload?: Record<string, unknown> }[]): Trace {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT, workspace_id TEXT, user_session_id TEXT, agent_session_id TEXT, payload TEXT, created_at TEXT)");
  const insert = db.prepare(
    "INSERT INTO events (type, workspace_id, user_session_id, agent_session_id, payload, created_at) VALUES (?, 'ws', 'us', ?, ?, ?)");
  rows.forEach((row, index) => insert.run(
    row.type, row.agentSessionId ?? null, JSON.stringify(row.payload ?? {}),
    `2026-08-22T00:00:${String(index).padStart(2, "0")}Z`));
  return Trace.fromSqlite(db);
}

describe("respondedToEvidence scoping", () => {
  const marker = (event: Ev) => event.type === "handoff.created";

  it("an unrelated seat's routine report_requirement is NOT a plan response", () => {
    const trace = journal([
      { type: "handoff.created", agentSessionId: "as_marker" },
      { type: "requirement.status.changed", agentSessionId: "as_other",
        payload: { requirementId: "r5", to: "satisfied", verifiedBy: "self", actor: "builder", agentSessionId: "as_other" } },
    ]);
    expect(respondedToEvidence(marker).run(trace).pass).toBe(false);
  });

  it("main's own status change, or one on the marker's session, IS a response", () => {
    const byMain = journal([
      { type: "handoff.created", agentSessionId: "as_marker" },
      { type: "requirement.status.changed", payload: { requirementId: "r2", to: "violated", actor: "main" } },
    ]);
    expect(respondedToEvidence(marker).run(byMain).pass).toBe(true);

    const onMarkerSession = journal([
      { type: "handoff.created", agentSessionId: "as_marker" },
      { type: "requirement.status.changed", agentSessionId: "as_marker",
        payload: { requirementId: "r2", to: "open", actor: "builder", agentSessionId: "as_marker" } },
    ]);
    expect(respondedToEvidence(marker).run(onMarkerSession).pass).toBe(true);
  });
});
