/**
 * The user-session transcript's stream spec over the shared kit
 * (`@/live/stream-kit`), with conversation semantics:
 *  - items are the raw persisted transcript events themselves; the render-side
 *    fold (user-fold.ts) is pure over the array, so pairing (tool results,
 *    question answers, plan resolutions) can join later events into earlier
 *    items without incremental state
 *  - dedupe on eventId (hydration returns raw envelopes, so live and hydrate
 *    share identity)
 *  - one streaming overlay PER SPEAKER ("orchestrator" today), retired by that
 *    speaker's persisted user_session.message; turn.settled retires ALL
 *    overlays (the one-chat-lane rule's cleanup backstop).
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

export type UserStream = Stream<ConsoleEvent, null>;

/** The persisted event types the transcript renders (via user-fold.ts). */
export const USER_TRANSCRIPT_TYPES: ReadonlySet<ConsoleEventType> = new Set([
  "user_session.message",
  "user_session.turn.started",
  "user_session.turn.settled",
  "user_session.tool.call",
  "user_session.tool.result",
  "user_session.question.asked",
  "user_session.question.answered",
  "user_session.plan.proposed",
  "user_session.plan.resolved",
  "user_session.runtime",
  "user_session.context.rotated",
  "usage.recorded",
]);

export const userStreamKit = createStreamKit<
  ConsoleEvent,
  null,
  readonly ConsoleEvent[]
>({
  emptyState: () => null,
  cloneState: () => null,
  keyOf: (event) => eventId(event),
  fold: (event) => (USER_TRANSCRIPT_TYPES.has(event.type) ? event : undefined),
  // Hydration payload is raw events: seed by the same filter + dedupe.
  seed: (serverEvents) => {
    const seen = new Set<string>();
    const items: ConsoleEvent[] = [];
    for (const event of serverEvents) {
      const id = eventId(event);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      if (USER_TRANSCRIPT_TYPES.has(event.type)) items.push(event);
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
    if (event.type === "user_session.message") {
      return { action: "drop", key: event.payload.message.speaker.name };
    }
    // A settled turn streams nothing more — whatever overlay text never got a
    // persisted row (abort, error) must not stick around as a ghost.
    if (event.type === "user_session.turn.settled") {
      return { action: "drop-all" };
    }
    return undefined;
  },
});
