import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleEvent, StatsResponse } from "@agentique-console/shared";

import { useConnectionStore } from "@/stores/connection";

import { createSpine } from "./spine";

const STATS: StatsResponse = { lastEventSeq: 41 };

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #listeners = new Map<string, EventListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener) {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  fail(closed: boolean) {
    if (closed) this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  emit(
    event: Partial<ConsoleEvent> & { type: string },
    seq: number | undefined,
  ) {
    const full = {
      ts: "2026-08-03T12:00:00.000Z",
      payload: {},
      ...event,
      ...(seq === undefined ? {} : { seq }),
    } as ConsoleEvent;
    const message = {
      data: JSON.stringify(full),
      lastEventId: seq === undefined ? "" : String(seq),
    } as MessageEvent<string>;
    for (const listener of this.#listeners.get("console") ?? []) {
      (listener as (ev: MessageEvent<string>) => void)(message);
    }
  }
}

describe("spine", () => {
  let queryClient: QueryClient;
  let routed: { type: string; seq: number | undefined }[];
  let statsCalls: number;
  let statsFail: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    queryClient = new QueryClient();
    routed = [];
    statsCalls = 0;
    statsFail = false;
    useConnectionStore.setState({
      status: "connecting",
      lastSeq: 0,
      reconnects: 0,
    });
  });
  afterEach(() => vi.useRealTimers());

  function makeSpine(onReconnect?: () => void) {
    return createSpine({
      queryClient,
      route: (event, seq) => routed.push({ type: event.type, seq }),
      ...(onReconnect === undefined ? {} : { onReconnect }),
      makeEventSource: (url) =>
        new FakeEventSource(url) as unknown as EventSource,
      fetchStats: () => {
        statsCalls += 1;
        return statsFail
          ? Promise.reject(new Error("down"))
          : Promise.resolve(STATS);
      },
      backoffBaseMs: 100,
    });
  }

  it("bootstraps fromSeq off stats.lastEventSeq + 1 (never a bare connect)", async () => {
    const spine = makeSpine();
    spine.start();
    await vi.runOnlyPendingTimersAsync();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events?fromSeq=42");
    spine.stop();
  });

  it("tracks seq from persisted events only and routes transients with undefined seq", async () => {
    const spine = makeSpine();
    spine.start();
    await vi.runOnlyPendingTimersAsync();
    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit({ type: "user_session.message.appended" }, 42);
    source.emit({ type: "stream.delta", transient: true }, undefined);
    expect(useConnectionStore.getState().lastSeq).toBe(42);
    expect(routed).toEqual([
      { type: "user_session.message.appended", seq: 42 },
      { type: "stream.delta", seq: undefined },
    ]);
    spine.stop();
  });

  it("recreates with an explicit fromSeq cursor after CLOSED, invalidates all, and calls onReconnect", async () => {
    const onReconnect = vi.fn();
    const spine = makeSpine(onReconnect);
    const invalidateAll = vi.spyOn(queryClient, "invalidateQueries");
    spine.start();
    await vi.runOnlyPendingTimersAsync();
    const first = FakeEventSource.instances[0]!;
    first.open();
    first.emit({ type: "user_session.message.appended" }, 50);
    first.fail(true); // native retry gave up
    expect(useConnectionStore.getState().status).toBe("closed");
    await vi.advanceTimersByTimeAsync(100); // backoff
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe("/api/events?fromSeq=51");
    FakeEventSource.instances[1]!.open();
    expect(invalidateAll).toHaveBeenCalledWith();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(useConnectionStore.getState().reconnects).toBe(1);
    spine.stop();
  });

  it("re-runs the stats bootstrap when the initial fetch failed (no fromSeq=1 replay)", async () => {
    statsFail = true;
    const spine = makeSpine();
    spine.start();
    await vi.runOnlyPendingTimersAsync();
    expect(FakeEventSource.instances).toHaveLength(0);
    statsFail = false;
    await vi.advanceTimersByTimeAsync(100); // backoff → bootstrap retry
    await vi.runOnlyPendingTimersAsync();
    expect(statsCalls).toBeGreaterThanOrEqual(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events?fromSeq=42");
    spine.stop();
  });

  it("treats non-CLOSED errors as native auto-reconnect in flight", async () => {
    const spine = makeSpine();
    spine.start();
    await vi.runOnlyPendingTimersAsync();
    const source = FakeEventSource.instances[0]!;
    source.open();
    source.fail(false); // readyState CONNECTING — browser is retrying itself
    expect(useConnectionStore.getState().status).toBe("connecting");
    expect(FakeEventSource.instances).toHaveLength(1); // no manual recreate
    spine.stop();
  });
});
