import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import {
  canonicalJson,
  eventEnvelopeSchema,
  validateEventPayload,
  type Event,
  type EventInput,
  type EventType,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceDb } from "./client.ts";
import { events } from "./schema.ts";
import type { Transactor } from "./transactions.ts";

export interface EventQuery {
  runId?: string;
  conversationId?: string;
  workspaceId?: string;
  type?: EventType;
  afterSeq?: number;
  limit?: number;
}

/**
 * The append-only Event journal. `append` must be called inside the same
 * write transaction as the projection change it records; the Transactor
 * enforces that an append outside a transaction is an error, so no store
 * can journal an Event in a transaction of its own.
 */
export class EventJournal {
  constructor(
    private readonly db: PersistenceDb,
    private readonly tx: Transactor,
    private readonly clock: () => Timestamp,
  ) {}

  append<T extends EventType>(input: EventInput<T>): Event<T> {
    if (!this.tx.inTransaction) {
      throw new Error(`Event ${input.type} must be appended inside the transaction that changes the projection`);
    }
    const payload = validateEventPayload(input.type, input.payload);
    const occurredAt = this.clock();
    const row = this.db
      .insert(events)
      .values({
        type: input.type,
        occurredAt,
        workspaceId: input.scope.workspaceId,
        conversationId: input.scope.conversationId,
        runId: input.scope.runId,
        planNodeId: input.scope.planNodeId,
        invocationId: input.scope.invocationId,
        attemptId: input.scope.attemptId,
        actor: input.actor,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: JSON.parse(canonicalJson(payload)) as unknown,
        correlationId: input.correlationId,
        causationSeq: input.causationSeq,
      })
      .returning({ seq: events.seq })
      .get();
    return { seq: row.seq, occurredAt, ...input, payload } as Event<T>;
  }

  read(query: EventQuery = {}): Event[] {
    const conditions: SQL[] = [];
    if (query.runId) conditions.push(eq(events.runId, query.runId));
    if (query.conversationId) conditions.push(eq(events.conversationId, query.conversationId));
    if (query.workspaceId) conditions.push(eq(events.workspaceId, query.workspaceId));
    if (query.type) conditions.push(eq(events.type, query.type));
    if (query.afterSeq !== undefined) conditions.push(gt(events.seq, query.afterSeq));
    const rows = this.db
      .select()
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(events.seq))
      .limit(query.limit ?? 1000)
      .all();
    return rows.map((row) => {
      const envelope = eventEnvelopeSchema.parse({
        seq: row.seq,
        type: row.type,
        occurredAt: row.occurredAt,
        scope: {
          workspaceId: row.workspaceId,
          conversationId: row.conversationId,
          runId: row.runId,
          planNodeId: row.planNodeId,
          invocationId: row.invocationId,
          attemptId: row.attemptId,
        },
        actor: row.actor,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        payload: row.payload,
        correlationId: row.correlationId,
        causationSeq: row.causationSeq,
      });
      return envelope as unknown as Event;
    });
  }

  lastSeq(): number {
    const row = this.db.select({ seq: events.seq }).from(events).orderBy(asc(events.seq)).all().at(-1);
    return row?.seq ?? 0;
  }
}
