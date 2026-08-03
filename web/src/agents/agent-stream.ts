/**
 * The agent-session transcript's stream spec over the shared kit
 * (`@/live/stream-kit`) — the user lane's sibling with multi-seat semantics:
 *  - items are the raw persisted transcript events; the render-side fold
 *    (agent-fold.ts) is pure over the array, so tool pairing can join later
 *    events into earlier items without incremental state
 *  - dedupe on eventId (hydration returns raw envelopes, so live and hydrate
 *    share identity)
 *  - one streaming overlay PER SPEAKER (any seat, or the orchestrator),
 *    retired by that speaker's persisted agent_session.message; turn.settled
 *    retires ALL overlays. The settle arrives BEFORE the closing persisted
 *    message by design — retire-all then append is correct and can't
 *    double-render, because the message row only exists once persisted.
 */
import {
  eventId,
  type ConsoleEvent,
  type ConsoleEventType,
} from "@agentique-console/shared";

import {
  createStreamKit,
  type Retirement,
  type Stream,
  type TransientChunk,
} from "@/live/stream-kit";

export type AgentStream = Stream<ConsoleEvent, null>;

/** The persisted event types the transcript renders (via agent-fold.ts). */
export const AGENT_TRANSCRIPT_TYPES: ReadonlySet<ConsoleEventType> = new Set([
  "agent_session.message",
  "agent_session.routed",
  "agent_session.turn.started",
  "agent_session.turn.settled",
  "agent_session.tool.call",
  "agent_session.tool.result",
  "agent_session.phase",
]);

export const agentStreamKit = createStreamKit<
  ConsoleEvent,
  null,
  readonly ConsoleEvent[]
>({
  emptyState: () => null,
  cloneState: () => null,
  keyOf: (event) => eventId(event),
  fold: (event) => (AGENT_TRANSCRIPT_TYPES.has(event.type) ? event : undefined),
  // Hydration payload is raw events: seed by the same filter + dedupe.
  seed: (serverEvents) => {
    const seen = new Set<string>();
    const items: ConsoleEvent[] = [];
    for (const event of serverEvents) {
      const id = eventId(event);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      if (AGENT_TRANSCRIPT_TYPES.has(event.type)) items.push(event);
    }
    return { items, seen, state: null };
  },
  transientOf: (event): TransientChunk | undefined => {
    if (event.type === "stream.delta") {
      return {
        key: event.payload.speaker,
        field: "message",
        text: event.payload.text,
      };
    }
    if (event.type === "stream.reasoning") {
      return {
        key: event.payload.speaker,
        field: "reasoning",
        text: event.payload.text,
      };
    }
    return undefined;
  },
  retirement: (event): Retirement | undefined => {
    // The speaker's persisted message IS the chat row the overlay previewed.
    if (event.type === "agent_session.message") {
      return { action: "drop", key: event.payload.message.speaker.name };
    }
    // A settled turn streams nothing more — whatever overlay text never got a
    // persisted row (abort, error) must not stick around as a ghost.
    if (event.type === "agent_session.turn.settled") {
      return { action: "drop-all" };
    }
    return undefined;
  },
});
