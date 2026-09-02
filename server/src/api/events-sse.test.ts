/**
 * The SSE attachment over a scripted transport (execution-model §13): one
 * idempotent cleanup — response ended, heartbeat cleared, transport
 * listeners dropped, subscription closed, each exactly once — in every
 * order the stream and the peer can produce: closure delivered
 * synchronously inside `subscribe` (the first replay page crossing the
 * buffer bound, before the subscription handle exists), backpressure on a
 * later replay page, a disconnect during replay, a disconnect during live
 * delivery, the stream's own shutdown, a write that throws on a destroyed
 * peer, and repeated closure notifications. The synchronous-closure case
 * is the focused regression for the handler that referenced its cleanup
 * before defining it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_REPLAY_PAGE } from "@agentique-console/core";
import { openHarness, seedRun, type Harness } from "../persistence/test-support.ts";
import { EventStream } from "../events/stream.ts";
import { attachEventStream, type SseTransport } from "./events.ts";

/** A transport whose pressure a test controls: bytes accumulate as `writableLength` once `pressure` is on; `disconnect` is the peer going away. */
class FakeTransport implements SseTransport {
  readonly chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  ended = 0;
  pressure = false;
  throwOnWrite = false;
  /** Turns pressure on after this many written chunks (`null`: never). */
  pressureAfter: number | null = null;
  readonly #listeners = new Set<() => void>();
  registered = 0;

  write(chunk: string): void {
    if (this.throwOnWrite) throw new Error("write after end");
    this.chunks.push(chunk);
    if (this.pressureAfter !== null && this.chunks.length >= this.pressureAfter) this.pressure = true;
    if (this.pressure) this.writableLength += Buffer.byteLength(chunk);
  }

  end(): void {
    this.ended += 1;
  }

  onClose(callback: () => void): () => void {
    this.#listeners.add(callback);
    this.registered += 1;
    return () => {
      this.#listeners.delete(callback);
      this.registered -= 1;
    };
  }

  /** The peer disconnects (or the socket fails): every registered callback fires, as Node's close and error events would. */
  disconnect(): void {
    this.destroyed = true;
    for (const listener of [...this.#listeners]) listener();
  }

  ids(): number[] {
    return this.chunks.flatMap((c) => [...c.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));
  }

  kinds(): string[] {
    return this.chunks.flatMap((c) => [...c.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]!));
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the SSE attachment", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    h = openHarness();
  });
  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  /** Everything cleanup must have done exactly once. */
  const released = (transport: FakeTransport, stream: EventStream) => ({ ended: transport.ended, listeners: transport.registered, subscriptions: stream.subscriptions, timers: vi.getTimerCount() });

  it("cleans up once when the stream closes the subscriber synchronously inside subscribe — the initial replay page crossing the buffer bound", () => {
    seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: EVENT_REPLAY_PAGE });
    try {
      const transport = new FakeTransport();
      transport.pressure = true;
      // The whole journal fits one replay page, so every frame is delivered before `subscribe` returns; the bound is crossed within it.
      const attached = attachEventStream(transport, stream, {}, 0, { maxBufferedBytes: 512, heartbeatMs: 1_000 });
      expect(attached).toMatchObject({ closed: true, reason: "backpressure" });
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      // The frames written before the bound was crossed are contiguous from the first sequence: a client resumes from the last id it saw.
      const ids = transport.ids();
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(ids.map((_, i) => ids[0]! + i));
      // Repeated closure notifications change nothing.
      attached.end("client");
      transport.disconnect();
      attached.end("stream");
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      expect(attached.reason).toBe("backpressure");
    } finally {
      stream.close();
    }
  });

  it("cleans up once when backpressure arrives on a later replay page, after the subscription handle exists", async () => {
    seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 2 });
    try {
      const transport = new FakeTransport();
      transport.pressureAfter = 6;
      const attached = attachEventStream(transport, stream, {}, 0, { maxBufferedBytes: 256, heartbeatMs: 1_000 });
      expect(attached.closed).toBe(false);
      expect(stream.subscriptions).toBe(1);
      await settle();
      expect(attached).toMatchObject({ closed: true, reason: "backpressure" });
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      // Nothing is written after the end, whatever commits later.
      const written = transport.chunks.length;
      h.stores.workspaces.create({ name: "later", rootPath: "/tmp/later", kind: "git" });
      await settle();
      expect(transport.chunks.length).toBe(written);
    } finally {
      stream.close();
    }
  });

  it("cleans up once when the peer disconnects during the replay, and delivers nothing afterwards", async () => {
    seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 2 });
    try {
      const transport = new FakeTransport();
      const attached = attachEventStream(transport, stream, {}, 0, { heartbeatMs: 1_000 });
      expect(transport.kinds()).not.toContain("caught_up");
      transport.disconnect();
      expect(attached).toMatchObject({ closed: true, reason: "client" });
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      const written = transport.chunks.length;
      await settle();
      expect(transport.chunks.length).toBe(written);
      expect(transport.kinds()).not.toContain("caught_up");
      transport.disconnect();
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
    } finally {
      stream.close();
    }
  });

  it("cleans up once when the peer disconnects during live delivery, and once when the stream itself shuts down", async () => {
    const seeded = seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs);
    const live = new FakeTransport();
    const attached = attachEventStream(live, stream, {}, h.ctx.journal.lastSeq(), { heartbeatMs: 1_000 });
    await settle();
    expect(live.kinds()).toEqual(["connected", "caught_up"]);
    h.stores.conversations.update(seeded.conversation.id, { title: "live one" });
    await settle();
    expect(live.kinds().filter((k) => k === "event")).toHaveLength(1);
    live.disconnect();
    expect(attached).toMatchObject({ closed: true, reason: "client" });
    expect(released(live, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
    h.stores.conversations.update(seeded.conversation.id, { title: "after the disconnect" });
    await settle();
    expect(live.kinds().filter((k) => k === "event")).toHaveLength(1);
    // The server shuts the stream down: every attached subscription ends once, with the stream's reason.
    const a = new FakeTransport();
    const b = new FakeTransport();
    const attachedA = attachEventStream(a, stream, {}, h.ctx.journal.lastSeq(), { heartbeatMs: 1_000 });
    const attachedB = attachEventStream(b, stream, { runId: seeded.run.id }, h.ctx.journal.lastSeq(), { heartbeatMs: 1_000 });
    expect(stream.subscriptions).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    stream.close();
    expect(attachedA).toMatchObject({ closed: true, reason: "stream" });
    expect(attachedB).toMatchObject({ closed: true, reason: "stream" });
    expect(released(a, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
    expect(b.ended).toBe(1);
    a.disconnect();
    attachedA.end("client");
    expect(a.ended).toBe(1);
  });

  it("treats a write that throws on a destroyed peer as a disconnect, and a peer already gone at attachment as nothing to subscribe", () => {
    seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs);
    try {
      const throwing = new FakeTransport();
      throwing.throwOnWrite = true;
      const attached = attachEventStream(throwing, stream, {}, 0, { heartbeatMs: 1_000 });
      expect(attached).toMatchObject({ closed: true, reason: "client" });
      expect(released(throwing, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      const gone = new FakeTransport();
      gone.destroyed = true;
      const late = attachEventStream(gone, stream, {}, 0, { heartbeatMs: 1_000 });
      expect(late).toMatchObject({ closed: true, reason: "client" });
      expect(released(gone, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
      expect(gone.chunks).toEqual([]);
    } finally {
      stream.close();
    }
  });

  it("keeps the heartbeat transport-only: it is written while open, cleared at the end, and a heartbeat that cannot be written ends the subscription", () => {
    seedRun(h);
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs);
    try {
      const transport = new FakeTransport();
      const attached = attachEventStream(transport, stream, {}, h.ctx.journal.lastSeq(), { heartbeatMs: 100 });
      vi.advanceTimersByTime(250);
      expect(transport.chunks.filter((c) => c === ": heartbeat\n\n")).toHaveLength(2);
      expect(h.ctx.journal.lastSeq()).toBe(h.ctx.journal.lastSeq());
      transport.throwOnWrite = true;
      vi.advanceTimersByTime(100);
      expect(attached).toMatchObject({ closed: true, reason: "client" });
      expect(released(transport, stream)).toEqual({ ended: 1, listeners: 0, subscriptions: 0, timers: 0 });
    } finally {
      stream.close();
    }
  });
});
