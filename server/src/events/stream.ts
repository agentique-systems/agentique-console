/**
 * The one event stream (execution-model §13): every subscriber replays the
 * journal from a sequence number, in bounded pages, and is then carried live
 * by the transactor's commit notifications — reading the journal after its
 * own cursor each time, so only committed Events are ever delivered, a
 * rolled-back transaction delivers nothing, the replay-to-live handoff
 * cannot lose an Event (the cursor is the only position), and a repeated
 * notification cannot deliver an Event twice. Filters scope a subscription
 * to a Workspace, Conversation, or Run.
 *
 * Transient provider output rides the same stream as `output` frames
 * identified by Attempt, Invocation, and Run: never journaled, never
 * replayed, dropped when a subscriber cannot keep up.
 *
 * Every subscriber has one bounded outbound buffer; a subscriber that stays
 * behind it is closed (a client reconnects from its last sequence number).
 * `close` releases everything a subscription holds.
 */
import type { AttemptId, Event, EventStreamFrame, InvocationId, RunId } from "@agentique-console/core";
import { EVENT_REPLAY_PAGE } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { EventQuery } from "../persistence/journal.ts";
import type { InvocationStore } from "../persistence/stores/invocations.ts";
import type { TransientOutput } from "../provider/adapter.ts";

export interface EventFilter {
  workspaceId?: string;
  conversationId?: string;
  runId?: string;
}

export interface EventSubscriber {
  /** Receives one frame; returns false when the subscriber cannot take more (the subscription closes). */
  deliver(frame: EventStreamFrame): boolean;
  /** Called once when the subscription ends (closed by the client, by backpressure, or by the stream). */
  closed(reason: "client" | "backpressure" | "stream"): void;
}

export interface Subscription {
  readonly id: number;
  readonly filter: EventFilter;
  /** The last sequence delivered. */
  readonly cursor: number;
  close(): void;
}

export interface EventStreamOptions {
  replayPage?: number;
  /** Frames a subscriber may have queued for delivery before it is closed for backpressure. */
  maxPendingFrames?: number;
  /** Attempts whose Run is remembered for transient output routing. */
  outputRouteCache?: number;
}

interface Entry {
  id: number;
  filter: EventFilter;
  subscriber: EventSubscriber;
  cursor: number;
  open: boolean;
  draining: boolean;
  again: boolean;
  pending: number;
}

function scoped(filter: EventFilter, event: Event): boolean {
  if (filter.runId !== undefined && event.scope.runId !== filter.runId) return false;
  if (filter.conversationId !== undefined && event.scope.conversationId !== filter.conversationId) return false;
  if (filter.workspaceId !== undefined && event.scope.workspaceId !== filter.workspaceId) return false;
  return true;
}

export class EventStream {
  readonly #entries = new Map<number, Entry>();
  readonly #routes = new Map<AttemptId, { runId: RunId; invocationId: InvocationId; conversationId: string | null; workspaceId: string | null }>();
  readonly #unsubscribe: () => void;
  #nextId = 1;
  private readonly replayPage: number;
  private readonly maxPendingFrames: number;
  private readonly outputRouteCache: number;

  constructor(
    private readonly ctx: Pick<PersistenceContext, "journal" | "tx">,
    private readonly invocations: Pick<InvocationStore, "getAttempt" | "get">,
    private readonly runs: { get(runId: RunId): { conversationId: string; workspaceId: string } },
    options: EventStreamOptions = {},
  ) {
    this.replayPage = options.replayPage ?? EVENT_REPLAY_PAGE;
    this.maxPendingFrames = options.maxPendingFrames ?? 1_000;
    this.outputRouteCache = options.outputRouteCache ?? 256;
    this.#unsubscribe = ctx.tx.onCommit(() => this.committed());
  }

  get subscriptions(): number {
    return this.#entries.size;
  }

  /** The last committed sequence. */
  lastSeq(): number {
    return this.ctx.journal.lastSeq();
  }

  /** Subscribes from `afterSeq`: a `connected` frame, the replay in pages, a `caught_up` frame, then live delivery. */
  subscribe(filter: EventFilter, afterSeq: number, subscriber: EventSubscriber): Subscription {
    const entry: Entry = { id: this.#nextId++, filter, subscriber, cursor: Math.max(0, afterSeq), open: true, draining: false, again: false, pending: 0 };
    this.#entries.set(entry.id, entry);
    const subscription: Subscription = {
      id: entry.id,
      filter,
      get cursor() {
        return entry.cursor;
      },
      close: () => this.end(entry, "client"),
    };
    this.send(entry, { kind: "connected", lastSeq: this.ctx.journal.lastSeq() });
    void this.replay(entry);
    return subscription;
  }

  /** Routes one transient output chunk to every live subscriber in scope; never journaled, never replayed. */
  publishOutput(output: TransientOutput): void {
    const route = this.routeOf(output.attemptId);
    if (route === null) return;
    const event = { scope: { runId: route.runId, conversationId: route.conversationId, workspaceId: route.workspaceId } } as Event;
    for (const entry of this.#entries.values()) {
      if (!entry.open || !scoped(entry.filter, event)) continue;
      // Output is best effort: a subscriber still replaying or behind gets no transient frames.
      if (entry.draining || entry.pending > 0) continue;
      this.send(entry, { kind: "output", attemptId: output.attemptId, runId: route.runId, invocationId: route.invocationId, chunk: { kind: output.kind, text: output.text } });
    }
  }

  /** Closes every subscription and detaches from the transactor. */
  close(): void {
    for (const entry of [...this.#entries.values()]) this.end(entry, "stream");
    this.#unsubscribe();
  }

  private routeOf(attemptId: AttemptId) {
    const cached = this.#routes.get(attemptId);
    if (cached) return cached;
    try {
      const attempt = this.invocations.getAttempt(attemptId);
      const run = this.runs.get(attempt.runId);
      const route = { runId: attempt.runId, invocationId: attempt.invocationId, conversationId: run.conversationId, workspaceId: run.workspaceId };
      if (this.#routes.size >= this.outputRouteCache) this.#routes.delete(this.#routes.keys().next().value!);
      this.#routes.set(attemptId, route);
      return route;
    } catch {
      return null;
    }
  }

  private committed(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.open) continue;
      if (entry.draining) {
        entry.again = true;
        continue;
      }
      void this.replay(entry);
    }
  }

  /** Reads the journal after the cursor in pages until nothing newer exists; a commit that arrives meanwhile schedules one more read. */
  private async replay(entry: Entry): Promise<void> {
    if (entry.draining) {
      entry.again = true;
      return;
    }
    entry.draining = true;
    try {
      let announcedCaughtUp = false;
      for (;;) {
        entry.again = false;
        for (;;) {
          if (!entry.open) return;
          const page = this.ctx.journal.read(this.query(entry));
          for (const event of page) {
            if (!entry.open) return;
            entry.cursor = event.seq;
            this.send(entry, { kind: "event", event });
          }
          // A filtered page may be empty while newer unscoped Events exist: the cursor still advances to the latest committed sequence.
          if (page.length < this.replayPage) {
            entry.cursor = Math.max(entry.cursor, this.ctx.journal.lastSeq());
            break;
          }
          await Promise.resolve();
        }
        if (!announcedCaughtUp && entry.open) {
          announcedCaughtUp = true;
          this.send(entry, { kind: "caught_up", seq: entry.cursor });
        }
        if (!entry.again) return;
      }
    } finally {
      entry.draining = false;
    }
  }

  private query(entry: Entry): EventQuery {
    const query: EventQuery = { afterSeq: entry.cursor, limit: this.replayPage };
    if (entry.filter.runId !== undefined) query.runId = entry.filter.runId;
    if (entry.filter.conversationId !== undefined) query.conversationId = entry.filter.conversationId;
    if (entry.filter.workspaceId !== undefined) query.workspaceId = entry.filter.workspaceId;
    return query;
  }

  private send(entry: Entry, frame: EventStreamFrame): void {
    if (!entry.open) return;
    entry.pending += 1;
    let accepted: boolean;
    try {
      accepted = entry.subscriber.deliver(frame);
    } catch {
      accepted = false;
    } finally {
      entry.pending -= 1;
    }
    if (!accepted) this.end(entry, "backpressure");
    else if (entry.pending > this.maxPendingFrames) this.end(entry, "backpressure");
  }

  private end(entry: Entry, reason: "client" | "backpressure" | "stream"): void {
    if (!entry.open) return;
    entry.open = false;
    this.#entries.delete(entry.id);
    try {
      entry.subscriber.closed(reason);
    } catch {
      // The subscriber is gone either way.
    }
  }
}
