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
