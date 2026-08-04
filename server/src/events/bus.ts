/**
 * The event spine. Persisted events get a global `seq` from the events table
 * (SQLite AUTOINCREMENT; appends are synchronous, so seq order = call order =
 * hub delivery order). `readWithSeq({follow: true})` achieves gap-free,
 * duplicate-free replay-then-tail: subscribe to the in-process hub FIRST (its
 * queue buffers live events), replay committed rows, then drain the queue
 * skipping anything at or below the replay watermark.
 */
import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import type { ConsoleEvent } from "@agentique-console/shared";
import { AsyncQueue } from "../async-queue.ts";
import type { Db } from "../db/client.ts";
import { eventArtifacts, events } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";

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

export class EventBus {
  readonly #db: Db;
  readonly #subscribers = new Set<Subscriber>();

  constructor(db: Db) {
    this.#db = db;
  }

  headSeq(): number {
    const row = this.#db
      .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
      .from(events)
      .get();
    return row?.seq ?? 0;
  }

  /** Keep event rows bounded without losing the authoritative payload. */
  capture(value: unknown, scope: { workspaceId?: string; userSessionId?: string; agentSessionId?: string } = {}): unknown {
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? "null"; } catch { serialized = JSON.stringify({ unserializable: true }); }
    if (serialized.length <= 16_384) return value;
    const artifact = this.storeArtifact(serialized, "application/json", scope);
    return { truncated: true, preview: serialized.slice(0, 16_384), ...artifact };
  }

  storeArtifact(content: string, mediaType: string, scope: { workspaceId?: string; userSessionId?: string; agentSessionId?: string } = {}): { artifactId: string; bytes: number } {
    const artifactId = newId("artifact");
    const bytes = mediaType.endsWith(";base64") ? Buffer.from(content, "base64").byteLength : Buffer.byteLength(content);
    this.#db.insert(eventArtifacts).values({ id: artifactId, eventSeq: null, workspaceId: scope.workspaceId ?? null,
      userSessionId: scope.userSessionId ?? null, agentSessionId: scope.agentSessionId ?? null,
      mediaType, bytes, content, createdAt: nowIso() }).run();
    return { artifactId, bytes };
  }

  getArtifact(id: string): { id: string; mediaType: string; bytes: number; content: string; createdAt: string } | undefined {
    return this.#db.select({ id: eventArtifacts.id, mediaType: eventArtifacts.mediaType, bytes: eventArtifacts.bytes, content: eventArtifacts.content, createdAt: eventArtifacts.createdAt })
      .from(eventArtifacts).where(eq(eventArtifacts.id, id)).get();
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
