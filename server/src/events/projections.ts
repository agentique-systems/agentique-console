/**
 * Read-model folds over the events table. The table's owner is the EventBus
 * (append-only); everything here derives state from the journal and writes
 * nothing.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema.ts";

export type UnsettledTurn =
  | { kind: "user"; turnId: string; userSessionId: string }
  | {
      kind: "agent";
      turnId: string;
      userSessionId: string;
      agentSessionId: string;
      agent: string;
    };

/**
 * Processes the journal shows as started with no matching exit, across every
 * session, oldest first — the boot-time leak scan. Carries the recorded argv
 * so the caller can guard against pid reuse before killing anything.
 */
export function listOrphanedProcesses(db: Db): { processId: string; pid: number | null; command: string; args: string[]; userSessionId: string; agentSessionId: string; agent: string }[] {
  const rows = db.select({ type: events.type, userSessionId: events.userSessionId, agentSessionId: events.agentSessionId, payload: events.payload })
    .from(events)
    .where(inArray(events.type, ["agent_session.process.started", "agent_session.process.exited"]))
    .orderBy(asc(events.seq)).all();
  const open = new Map<string, { processId: string; pid: number | null; command: string; args: string[]; userSessionId: string; agentSessionId: string; agent: string }>();
  for (const row of rows) {
    const payload = row.payload as { processId?: string; pid?: number; command?: string; args?: string[]; agent?: string };
    const processId = payload.processId;
    if (processId === undefined) continue;
    if (row.type === "agent_session.process.exited") { open.delete(processId); continue; }
    open.set(processId, {
      processId, pid: payload.pid ?? null,
      command: payload.command ?? "", args: payload.args ?? [],
      userSessionId: row.userSessionId ?? "", agentSessionId: row.agentSessionId ?? "",
      agent: payload.agent ?? "",
    });
  }
  return [...open.values()];
}

export function listProcessEvents(db: Db, userSessionId: string): { type: string; processId: string }[] {
  return db.select({ type: events.type, payload: events.payload }).from(events)
    .where(and(
      eq(events.userSessionId, userSessionId),
      inArray(events.type, ["agent_session.process.started", "agent_session.process.exited"]),
    ))
    .orderBy(asc(events.seq))
    .all()
    .map((row) => ({ type: row.type, processId: String((row.payload as { processId?: string }).processId ?? "") }))
    .filter((row) => row.processId !== "");
}

/** A durable event of `type` exists for this agent session. */
export function hasEvent(db: Db, type: string, agentSessionId: string): boolean {
  return db.select({ seq: events.seq }).from(events)
    .where(and(eq(events.type, type), eq(events.agentSessionId, agentSessionId)))
    .limit(1).get() !== undefined;
}

/**
 * Turns that started but never settled — every one is a turn that died with
 * a previous process. Derived from the spine rather than a status column, so
 * it stays true no matter how the process ended, and recovery writing the
 * missing settle is what stops a turn being recovered twice.
 */
export function findUnsettledTurns(db: Db): UnsettledTurn[] {
  return db
    .all<{
      type: string;
      turnId: string | null;
      userSessionId: string | null;
      agentSessionId: string | null;
      agent: string | null;
    }>(sql`
      select
        type,
        json_extract(payload, '$.turnId') as turnId,
        user_session_id as userSessionId,
        agent_session_id as agentSessionId,
        json_extract(payload, '$.agent') as agent
      from events
      where type in ('user_session.turn.started', 'agent_session.turn.started')
        and json_extract(payload, '$.turnId') not in (
          select json_extract(payload, '$.turnId') from events
          where type in ('user_session.turn.settled', 'agent_session.turn.settled')
        )
      order by seq
    `)
    .flatMap((row): UnsettledTurn[] => {
      if (row.turnId === null) return [];
      if (row.type === "agent_session.turn.started") {
        if (row.agentSessionId === null || row.agent === null) return [];
        return [
          {
            kind: "agent" as const,
            turnId: row.turnId,
            userSessionId: row.userSessionId ?? "",
            agentSessionId: row.agentSessionId,
            agent: row.agent,
          },
        ];
      }
      if (row.userSessionId === null) return [];
      return [
        {
          kind: "user" as const,
          turnId: row.turnId,
          userSessionId: row.userSessionId,
        },
      ];
    });
}
