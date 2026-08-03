import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleEvent } from "@agentique-console/shared";

import { userStreamKit, type UserStream } from "@/session/user-stream";

import { createStreamStore } from "./stream-kit";
import { watched } from "./watched";

let seq = 0;
function ev(
  type: string,
  payload: unknown,
  extra: Partial<ConsoleEvent> = {},
): ConsoleEvent {
  seq += 1;
  return {
    seq,
    ts: "2026-08-03T12:00:00.000Z",
    type,
    userSessionId: "us_1",
    payload,
    ...extra,
  } as ConsoleEvent;
}

function operatorMessage(text: string): ConsoleEvent {
  return ev("user_session.message", {
    sessionId: "us_1",
    message: {
      seq: seq + 1,
      speaker: { kind: "operator", name: "operator" },
      kind: "message",
      text,
      createdAt: "2026-08-03T12:00:00.000Z",
    },
  });
}

function orchestratorMessage(text: string): ConsoleEvent {
  return ev("user_session.message", {
    sessionId: "us_1",
    message: {
      seq: seq + 1,
      speaker: { kind: "orchestrator", name: "orchestrator" },
      kind: "message",
      text,
      createdAt: "2026-08-03T12:00:00.000Z",
    },
  });
}

function delta(
  kind: "stream.delta" | "stream.reasoning",
  speaker: string,
  text: string,
): ConsoleEvent {
  return {
    ts: "2026-08-03T12:00:00.000Z",
    type: kind,
    transient: true,
    userSessionId: "us_1",
    payload: {
      scope: { kind: "user", sessionId: "us_1" },
      speaker,
      turnId: "turn_1",
      text,
    },
  } as ConsoleEvent;
}

function textsOf(stream: UserStream): string[] {
  return stream.items.map(
    (event) =>
      (event.payload as { message?: { text?: string } }).message?.text ?? "",
  );
}

describe("user stream kit", () => {
  it("buffers before hydration, then replays with event-id dedupe", () => {
    let stream = userStreamKit.empty();
    const first = operatorMessage("hello");
    stream = userStreamKit.append(stream, first);
    expect(stream.items).toHaveLength(0); // buffering
    expect(stream.buffer).toHaveLength(1);

    // The server snapshot already contains the buffered event — replay
    // dedupes on the event id.
    stream = userStreamKit.hydrate(stream, [first]);
    expect(stream.phase).toBe("hydrated");
    expect(textsOf(stream)).toEqual(["hello"]);
  });

  it("raced events (buffered but not in the snapshot) append after hydration", () => {
    let stream = userStreamKit.empty();
    const snapshotted = operatorMessage("one");
    const raced = operatorMessage("two");
    stream = userStreamKit.append(stream, snapshotted);
    stream = userStreamKit.append(stream, raced);
    stream = userStreamKit.hydrate(stream, [snapshotted]);
    expect(textsOf(stream)).toEqual(["one", "two"]);
  });

  it("accumulates one overlay per speaker key, message and reasoning apart", () => {
    let stream: UserStream = { ...userStreamKit.empty(), phase: "hydrated" };
    stream = userStreamKit.append(stream, delta("stream.delta", "orchestrator", "thinking "));
    stream = userStreamKit.append(stream, delta("stream.delta", "orchestrator", "about it"));
    stream = userStreamKit.append(stream, delta("stream.reasoning", "orchestrator", "hmm"));
    stream = userStreamKit.append(stream, delta("stream.delta", "other", "second lane"));

    expect(stream.deltas.get("orchestrator")?.message).toBe("thinking about it");
    expect(stream.deltas.get("orchestrator")?.reasoning).toBe("hmm");
    expect(stream.deltas.get("other")?.message).toBe("second lane");
  });

  it("the speaker's persisted message retires THAT key's whole overlay", () => {
    let stream: UserStream = { ...userStreamKit.empty(), phase: "hydrated" };
    stream = userStreamKit.append(stream, delta("stream.delta", "orchestrator", "streaming"));
    stream = userStreamKit.append(stream, delta("stream.reasoning", "orchestrator", "hmm"));
    stream = userStreamKit.append(stream, delta("stream.delta", "other", "kept"));

    stream = userStreamKit.append(stream, orchestratorMessage("final answer"));
    expect(stream.deltas.get("orchestrator")).toBeUndefined();
    expect(stream.deltas.get("other")?.message).toBe("kept");
  });

  it("turn.settled retires ALL overlays (abort leaves no ghosts)", () => {
    let stream: UserStream = { ...userStreamKit.empty(), phase: "hydrated" };
    stream = userStreamKit.append(stream, delta("stream.delta", "orchestrator", "half a thou"));
    stream = userStreamKit.append(stream, delta("stream.delta", "other", "also here"));
    stream = userStreamKit.append(
      stream,
      ev("user_session.turn.settled", {
        sessionId: "us_1",
        turnId: "turn_1",
        status: "aborted",
        queuedJobs: 0,
      }),
    );
    expect(stream.deltas.size).toBe(0);
  });

  it("beginRehydrate keeps the stale view while re-buffering", () => {
    let stream = userStreamKit.empty();
    stream = userStreamKit.hydrate(stream, [operatorMessage("kept")]);
    stream = userStreamKit.beginRehydrate(stream);
    expect(stream.phase).toBe("buffering");
    expect(textsOf(stream)).toEqual(["kept"]);

    // Re-hydration replaces wholesale (the snapshot is the truth) and replays
    // the buffer.
    const late = operatorMessage("late");
    stream = userStreamKit.append(stream, late);
    stream = userStreamKit.hydrate(stream, [late]);
    expect(textsOf(stream)).toEqual(["late"]);
  });
});

describe("stream store watch/unwatch linger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watched.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps an unwatched stream for the linger window, then drops it", () => {
    const store = createStreamStore(userStreamKit);
    store.getState().watch("us:us_1");
    expect(watched.has("us:us_1")).toBe(true);
    store.getState().hydrateStream("us:us_1", [operatorMessage("kept")]);

    store.getState().unwatch("us:us_1");
    expect(watched.has("us:us_1")).toBe(false);
    // Still lingering — a quick re-open keeps its items.
    vi.advanceTimersByTime(59_000);
    expect(store.getState().streams["us:us_1"]).toBeDefined();

    vi.advanceTimersByTime(2_000);
    expect(store.getState().streams["us:us_1"]).toBeUndefined();
  });

  it("re-watching within the linger window cancels the drop", () => {
    const store = createStreamStore(userStreamKit);
    store.getState().watch("us:us_1");
    store.getState().hydrateStream("us:us_1", [operatorMessage("kept")]);
    store.getState().unwatch("us:us_1");
    vi.advanceTimersByTime(30_000);
    store.getState().watch("us:us_1");
    vi.advanceTimersByTime(120_000);
    const stream = store.getState().streams["us:us_1"];
    expect(stream).toBeDefined();
    expect(stream?.phase).toBe("hydrated");
  });

  it("drops events for ids it holds no stream for", () => {
    const store = createStreamStore(userStreamKit);
    store.getState().appendEvent("us:us_ghost", operatorMessage("dropped"));
    expect(store.getState().streams["us:us_ghost"]).toBeUndefined();
  });
});
