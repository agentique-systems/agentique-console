/**
 * The event spine. Persisted events get a global `seq` from the events table
 * (SQLite AUTOINCREMENT; appends are synchronous, so seq order = call order =
 * hub delivery order). `readWithSeq({follow: true})` achieves gap-free,
 * duplicate-free replay-then-tail: subscribe to the in-process hub FIRST (its
 * queue buffers live events), replay committed rows, then drain the queue
 * skipping anything at or below the replay watermark.
 */
import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { ConsoleEvent } from "@agentique-console/shared";
import { AsyncQueue } from "../async-queue.ts";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema.ts";
import { nowIso } from "../ids.ts";
import type { ArtifactStore } from "./artifact-store.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What emitters provide; the bus stamps ts, seq, and transient. */
export type EventInput = DistributiveOmit<
  ConsoleEvent,
  "seq" | "ts" | "transient"
>;

export interface EventSelector {
  fromSeq?: number;
  userSessionId?: string;
  agentSessionId?: string;
  follow?: boolean;
}

interface Subscriber {
  selector: EventSelector;
  queue: AsyncQueue<ConsoleEvent>;
}

function matches(event: ConsoleEvent, selector: EventSelector): boolean {
  if (
    selector.userSessionId !== undefined &&
    event.userSessionId !== selector.userSessionId
  ) {
    return false;
  }
  if (
    selector.agentSessionId !== undefined &&
    event.agentSessionId !== selector.agentSessionId
  ) {
    return false;
  }
  return true;
}

/** Inline JSON cap before a payload spills to the artifact store. One owner; sdk/mapping.ts imports it. */
export const INLINE_JSON_CAP_BYTES = 16_384;

export class EventBus {
  readonly #db: Db;
  readonly #artifacts: ArtifactStore;
  readonly #subscribers = new Set<Subscriber>();

  constructor(db: Db, artifacts: ArtifactStore) {
    this.#db = db;
    this.#artifacts = artifacts;
  }

  headSeq(): number {
    const row = this.#db
      .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
      .from(events)
      .get();
    return row?.seq ?? 0;
  }

  /**
   * Project-objective assessment clock. This is intentionally a narrow list,
   * not a universal materiality engine: progress/meaning/frontier transitions
   * count; turns, tool telemetry, usage, retries, runtime notices and the
   * assessment's own state.updated event do not.
   */
  objectiveMaterialHeadSeq(userSessionIds: readonly string[]): number {
    if (userSessionIds.length === 0) return 0;
    const materialTypes = [
      "user_session.requirements.updated", "requirement.status.changed", "requirement.decomposed",
      "assumption.recorded", "assumption.resolved", "requirement.link.changed",
      "change_impact.recorded", "change_impact.reconciled",
      "decision_issue.created", "decision_issue.resolved", "decision_issue.merged",
      "workstream.link.created", "workstream.link.released", "workstream.link.broken",
      "agent_session.created", "agent_session.status.changed", "agent_session.result.returned",
      "agent_session.worktree.merged", "agent_session.worktree.landing_invalidated", "agent_session.worktree.landing_restored",
      "task.created", "task.updated", "task.dependency.created", "task.dependency.deleted",
      "operator.decision.recorded", "run.completion.proposed", "run.signoff.resolved", "run.reopened",
    ];
    const material = or(
      inArray(events.type, materialTypes),
      and(eq(events.type, "user_session.message.appended"), sql`json_extract(${events.payload}, '$.message.speaker.kind') = 'operator'`),
      and(eq(events.type, "user_session.state.updated"), sql`json_extract(${events.payload}, '$.trigger') = 'completion'`),
    );
    const row = this.#db.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events)
      .where(and(inArray(events.userSessionId, [...userSessionIds]), material)).get();
    return row?.seq ?? 0;
  }

  /** Keep event rows bounded without losing the authoritative payload. */
  captureSized(value: unknown, scope: { workspaceId?: string; userSessionId?: string; agentSessionId?: string } = {}): { value: unknown; bytes: number } {
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? "null"; } catch { serialized = JSON.stringify({ unserializable: true }); }
    const bytes = Buffer.byteLength(serialized);
    if (serialized.length <= INLINE_JSON_CAP_BYTES) return { value, bytes };
    const artifact = this.#artifacts.store(serialized, "application/json", scope);
    return { value: { truncated: true, preview: serialized.slice(0, INLINE_JSON_CAP_BYTES), ...artifact }, bytes };
  }

  /** Persist and publish. Returns the stamped event (with seq). */
  append(input: EventInput): ConsoleEvent {
    const ts = nowIso();
    const rows = this.#db
      .insert(events)
      .values({
        type: input.type,
        workspaceId: input.workspaceId ?? null,
        userSessionId: input.userSessionId ?? null,
        agentSessionId: input.agentSessionId ?? null,
        payload: input.payload,
        createdAt: ts,
      })
      .returning({ seq: events.seq })
      .all();
    const seq = rows[0]?.seq;
    const event = { ...input, ts, seq } as ConsoleEvent;
    this.#publish(event);
    return event;
  }

  /** Publish without persisting (stream deltas, agent state). */
  broadcast(input: EventInput): void {
    const event = { ...input, ts: nowIso(), transient: true } as ConsoleEvent;
    this.#publish(event);
  }

  readWithSeq(selector: EventSelector): AsyncIterable<ConsoleEvent> {
    if (selector.follow !== true) {
      const rows = this.#replay(selector);
      return {
        async *[Symbol.asyncIterator]() {
          yield* rows;
        },
      };
    }
    const subscribers = this.#subscribers;
    const replay = (sel: EventSelector): ConsoleEvent[] => this.#replay(sel);
    // Subscribe EAGERLY, before the consumer's first next(): the queue buffers
    // everything published from now on, so transient frames can't slip through
    // the gap between creating the iterable and starting to consume it.
    // Persisted rows that land in both replay and queue are deduped by watermark.
    const queue = new AsyncQueue<ConsoleEvent>();
    const subscriber: Subscriber = { selector, queue };
    subscribers.add(subscriber);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<ConsoleEvent> {
        try {
          let watermark = 0;
          for (const event of replay(selector)) {
            if (event.seq !== undefined && event.seq > watermark) {
              watermark = event.seq;
            }
            yield event;
          }
          for await (const event of queue) {
            if (event.seq !== undefined && event.seq <= watermark) continue;
            yield event;
          }
        } finally {
          subscribers.delete(subscriber);
          queue.close();
        }
      },
    };
  }

  pageForUserSession(userSessionId: string, beforeSeq: number | undefined, limit: number): { events: ConsoleEvent[]; nextBeforeSeq: number | null } {
    const conditions: SQL[] = [eq(events.userSessionId, userSessionId)];
    if (beforeSeq !== undefined) conditions.push(lt(events.seq, beforeSeq));
    const rows = this.#db.select().from(events).where(and(...conditions)).orderBy(desc(events.seq)).limit(limit + 1).all();
    const page = rows.slice(0, limit).reverse().map((row) => ({ type: row.type, seq: row.seq, ts: row.createdAt,
      ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
      ...(row.userSessionId === null ? {} : { userSessionId: row.userSessionId }),
      ...(row.agentSessionId === null ? {} : { agentSessionId: row.agentSessionId }), payload: row.payload } as ConsoleEvent));
    return { events: page, nextBeforeSeq: rows.length > limit ? (page[0]?.seq ?? null) : null };
  }

  #replay(selector: EventSelector): ConsoleEvent[] {
    const conditions: SQL[] = [];
    if (selector.fromSeq !== undefined) {
      conditions.push(gte(events.seq, selector.fromSeq));
    }
    if (selector.userSessionId !== undefined) {
      conditions.push(eq(events.userSessionId, selector.userSessionId));
    }
    if (selector.agentSessionId !== undefined) {
      conditions.push(eq(events.agentSessionId, selector.agentSessionId));
    }
    const query = this.#db.select().from(events).orderBy(asc(events.seq)).$dynamic();
    const rows =
      conditions.length > 0
        ? query.where(and(...conditions)).all()
        : query.all();
    return rows.map(
      (row) =>
        ({
          type: row.type,
          seq: row.seq,
          ts: row.createdAt,
          ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
          ...(row.userSessionId === null
            ? {}
            : { userSessionId: row.userSessionId }),
          ...(row.agentSessionId === null
            ? {}
            : { agentSessionId: row.agentSessionId }),
          payload: row.payload,
        }) as ConsoleEvent,
    );
  }

  #publish(event: ConsoleEvent): void {
    for (const subscriber of this.#subscribers) {
      if (matches(event, subscriber.selector)) subscriber.queue.push(event);
    }
  }

  /** Closes every open follow stream (shutdown). */
  closeSubscriptions(): void {
    for (const subscriber of this.#subscribers) subscriber.queue.close();
    this.#subscribers.clear();
  }
}
