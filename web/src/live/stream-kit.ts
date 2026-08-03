/**
 * The one live-stream machine. Every transcript surface folds the SAME wire —
 * transcript routes serve raw ConsoleEvent envelopes — through per-surface
 * specs (their items differ; the machinery does not):
 *
 *  1. watch() creates a 'buffering' stream; every spine event lands in `buffer`
 *     (hydration is gated on the spine being OPEN, so no event can fall between
 *     live start and the server snapshot)
 *  2. hydrate() seeds from the server payload, then replays the buffer — events
 *     the snapshot already contained dedupe on the spec's identity key
 *     (`eventId` on both lanes); raced events append in arrival order, which IS
 *     global seq order.
 *
 * Transient deltas accumulate one overlay per spec-chosen key (v2: the
 * speaker) and are retired by the spec's retirement rule (the speaker's
 * persisted message, or the turn settling).
 */
import { create, type UseBoundStore, type StoreApi } from "zustand";

import type { ConsoleEvent } from "@agentique-console/shared";

import { watched } from "@/live/watched";

export interface DeltaOverlay {
  readonly message: string;
  readonly reasoning: string;
}

/** One transient frame's contribution to an overlay, as the spec reads it. */
export interface TransientChunk {
  readonly key: string;
  readonly field: "message" | "reasoning";
  readonly text: string;
}

export type Retirement =
  | { readonly action: "drop"; readonly key: string }
  | { readonly action: "drop-all" };

export interface Stream<Item, State> {
  readonly phase: "buffering" | "hydrated";
  readonly items: readonly Item[];
  readonly seen: ReadonlySet<string>;
  /** Fold-owned working state (speaker maps, …); null when the fold is stateless. */
  readonly state: State;
  readonly deltas: ReadonlyMap<string, DeltaOverlay>;
  readonly buffer: readonly ConsoleEvent[];
}

export interface StreamSpec<Item, State, Seed> {
  /** Fresh fold state. */
  emptyState(): State;
  /** A copy safe to mutate during one fold step. */
  cloneState(state: State): State;
  /** Identity of a persisted event, for dedupe between hydration and the live spine. */
  keyOf(event: ConsoleEvent): string | null;
  /** Folds one persisted event into an item (or nothing), updating `state` in place. */
  fold(event: ConsoleEvent, state: State): Item | undefined;
  /** Seeds items/seen/state from the hydration payload. */
  seed(payload: Seed): {
    readonly items: readonly Item[];
    readonly seen: ReadonlySet<string>;
    readonly state: State;
  };
  /** Which overlay a transient frame feeds, when it feeds one. */
  transientOf(event: ConsoleEvent): TransientChunk | undefined;
  /** Which overlay(s) a persisted event retires, when it does. */
  retirement(event: ConsoleEvent): Retirement | undefined;
}

export interface StreamKit<Item, State, Seed> {
  empty(): Stream<Item, State>;
  append(
    stream: Stream<Item, State>,
    event: ConsoleEvent,
  ): Stream<Item, State>;
  hydrate(stream: Stream<Item, State>, payload: Seed): Stream<Item, State>;
  /** Back to buffering (keeping a stale view) — reconnect re-hydrates over it. */
  beginRehydrate(stream: Stream<Item, State>): Stream<Item, State>;
}

export function createStreamKit<Item, State, Seed>(
  spec: StreamSpec<Item, State, Seed>,
): StreamKit<Item, State, Seed> {
  type S = Stream<Item, State>;

  const empty = (): S => ({
    phase: "buffering",
    items: [],
    seen: new Set(),
    state: spec.emptyState(),
    deltas: new Map(),
    buffer: [],
  });

  const applyTransient = (stream: S, event: ConsoleEvent): S => {
    const chunk = spec.transientOf(event);
    if (chunk === undefined || chunk.text === "") return stream;

    const current = stream.deltas.get(chunk.key) ?? {
      message: "",
      reasoning: "",
    };
    const next: DeltaOverlay = {
      ...current,
      [chunk.field]: current[chunk.field] + chunk.text,
    };
    const deltas = new Map(stream.deltas);
    deltas.set(chunk.key, next);
    return { ...stream, deltas };
  };

  const applyRetirement = (
    deltas: ReadonlyMap<string, DeltaOverlay>,
    retirement: Retirement | undefined,
  ): ReadonlyMap<string, DeltaOverlay> => {
    if (retirement === undefined) return deltas;
    if (retirement.action === "drop-all") {
      return deltas.size === 0 ? deltas : new Map();
    }
    if (!deltas.has(retirement.key)) return deltas;
    const next = new Map(deltas);
    next.delete(retirement.key);
    return next;
  };

  const applyEvent = (stream: S, event: ConsoleEvent): S => {
    // Transient frames never carry a seq; treat both signals as transient so a
    // malformed frame can't be mistaken for a persisted row.
    if (event.transient === true || event.seq === undefined) {
      return applyTransient(stream, event);
    }
    const key = spec.keyOf(event);
    if (key === null || stream.seen.has(key)) return stream;

    const state = spec.cloneState(stream.state);
    const item = spec.fold(event, state);

    const seen = new Set(stream.seen);
    seen.add(key);
    const deltas = applyRetirement(stream.deltas, spec.retirement(event));

    return {
      ...stream,
      items: item === undefined ? stream.items : [...stream.items, item],
      seen,
      state,
      deltas,
    };
  };

  return {
    empty,
    append: (stream, event) =>
      stream.phase === "buffering"
        ? { ...stream, buffer: [...stream.buffer, event] }
        : applyEvent(stream, event),
    hydrate: (stream, payload) => {
      let next: S = { ...empty(), phase: "hydrated", ...spec.seed(payload) };
      for (const event of stream.buffer) next = applyEvent(next, event);
      return next;
    },
    beginRehydrate: (stream) => ({ ...stream, phase: "buffering", buffer: [] }),
  };
}

const DROP_UNWATCHED_MS = 60_000;

export interface StreamStoreState<Item, State, Seed> {
  readonly streams: Readonly<Record<string, Stream<Item, State>>>;
  /** Drops every stream — used when the workspace scope changes. */
  clearAll(): void;
  watch(id: string): void;
  unwatch(id: string): void;
  appendEvent(id: string, event: ConsoleEvent): void;
  hydrateStream(id: string, payload: Seed): void;
  onReconnect(): void;
}

/**
 * The zustand wrapper every transcript store shares: watch/unwatch with a
 * linger timer (a quickly-reopened stream keeps its items), spine append,
 * hydrate, and the reconnect re-buffering handshake.
 */
export function createStreamStore<Item, State, Seed>(
  kit: StreamKit<Item, State, Seed>,
): UseBoundStore<StoreApi<StreamStoreState<Item, State, Seed>>> {
  const dropTimers = new Map<string, ReturnType<typeof setTimeout>>();

  return create<StreamStoreState<Item, State, Seed>>((set, get) => ({
    streams: {},
    clearAll: () => set({ streams: {} }),

    watch: (id) => {
      const timer = dropTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        dropTimers.delete(id);
      }
      watched.add(id);
      if (get().streams[id] === undefined) {
        set((state) => ({ streams: { ...state.streams, [id]: kit.empty() } }));
      }
    },

    unwatch: (id) => {
      watched.remove(id);
      const timer = setTimeout(() => {
        dropTimers.delete(id);
        set((state) => {
          const streams = { ...state.streams };
          delete streams[id];
          return { streams };
        });
      }, DROP_UNWATCHED_MS);
      dropTimers.set(id, timer);
    },

    appendEvent: (id, event) => {
      const stream = get().streams[id];
      // Without a mounted view we don't accumulate; the next watch re-hydrates
      // from the server. Drop here.
      if (stream === undefined) return;
      set((state) => ({
        streams: { ...state.streams, [id]: kit.append(stream, event) },
      }));
    },

    hydrateStream: (id, payload) => {
      const stream = get().streams[id] ?? kit.empty();
      set((state) => ({
        streams: { ...state.streams, [id]: kit.hydrate(stream, payload) },
      }));
    },

    onReconnect: () => {
      // Watched streams go back to buffering (stale view stays up); the
      // spine's invalidate-all makes their queries refetch, and the fresh
      // hydration replays whatever buffered meanwhile.
      set((state) => {
        const streams: Record<string, Stream<Item, State>> = {};
        for (const [id, stream] of Object.entries(state.streams)) {
          streams[id] = watched.has(id) ? kit.beginRehydrate(stream) : stream;
        }
        return { streams };
      });
    },
  }));
}
