import { describe, expect, it } from "vitest";
import type { ConsoleEvent } from "@agentique-console/shared";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { EventBus, type EventInput } from "./bus.ts";

function makeBus(): EventBus {
  const { db } = openDb(":memory:");
  return new EventBus(db, new ArtifactStore(db));
}

function msgInput(sessionId: string, text: string): EventInput {
  return {
    type: "user_session.message",
    userSessionId: sessionId,
    payload: {
      userSessionId: sessionId,
      message: {
        seq: 1,
        speaker: { kind: "operator", name: "operator" },
        kind: "message",
        text,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

async function collect(
  source: AsyncIterable<ConsoleEvent>,
  count: number,
): Promise<ConsoleEvent[]> {
  const out: ConsoleEvent[] = [];
  for await (const event of source) {
    out.push(event);
    if (out.length >= count) break;
  }
  return out;
}

describe("EventBus", () => {
  it("stores oversized payloads as retrievable durable artifacts", () => {
    const { db } = openDb(":memory:");
    const artifacts = new ArtifactStore(db);
    const bus = new EventBus(db, artifacts);
    const captured = bus.captureSized({ output: "x".repeat(20_000) });
    const value = captured.value as { artifactId: string; truncated: boolean };
    expect(value.truncated).toBe(true);
    expect(captured.bytes).toBeGreaterThan(20_000);
    expect(JSON.parse(artifacts.get(value.artifactId)?.content ?? "{}").output).toHaveLength(20_000);
  });
  it("stamps increasing seq on append and reports headSeq", () => {
    const bus = makeBus();
    expect(bus.headSeq()).toBe(0);
    const a = bus.append(msgInput("us_1", "one"));
    const b = bus.append(msgInput("us_1", "two"));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(bus.headSeq()).toBe(2);
  });

  it("replays persisted events without follow", async () => {
    const bus = makeBus();
    bus.append(msgInput("us_1", "one"));
    bus.append(msgInput("us_2", "other"));
    bus.append(msgInput("us_1", "two"));
    const events = await collect(
      bus.readWithSeq({ userSessionId: "us_1" }),
      2,
    );
    expect(events.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("replay-then-tail delivers no gaps and no duplicates", async () => {
    const bus = makeBus();
    bus.append(msgInput("us_1", "before-1"));
    bus.append(msgInput("us_1", "before-2"));

    const stream = bus.readWithSeq({ fromSeq: 1, follow: true });
    const iterator = stream[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value.seq).toBe(1);
    expect(second.value.seq).toBe(2);

    // Appended mid-stream: must arrive exactly once via the tail.
    bus.append(msgInput("us_1", "live-1"));
    const third = await iterator.next();
    expect(third.value.seq).toBe(3);

    await iterator.return?.();
  });

  it("respects fromSeq cursor", async () => {
    const bus = makeBus();
    bus.append(msgInput("us_1", "one"));
    bus.append(msgInput("us_1", "two"));
    bus.append(msgInput("us_1", "three"));
    const events = await collect(bus.readWithSeq({ fromSeq: 3 }), 1);
    expect(events.map((e) => e.seq)).toEqual([3]);
  });

  it("broadcast delivers transient frames to followers without persisting", async () => {
    const bus = makeBus();
    const stream = bus.readWithSeq({ fromSeq: 1, follow: true });
    const iterator = stream[Symbol.asyncIterator]();

    bus.broadcast({
      type: "stream.delta",
      userSessionId: "us_1",
      payload: {
        scope: { kind: "user", sessionId: "us_1" },
        speaker: "orchestrator",
        turnId: "turn_1",
        text: "hel",
      },
    });

    const frame = await iterator.next();
    expect(frame.value.type).toBe("stream.delta");
    expect(frame.value.seq).toBeUndefined();
    expect(frame.value.transient).toBe(true);
    expect(bus.headSeq()).toBe(0);
    await iterator.return?.();
  });

  it("filters follow streams by selector", async () => {
    const bus = makeBus();
    const stream = bus.readWithSeq({
      fromSeq: 1,
      follow: true,
      userSessionId: "us_2",
    });
    const iterator = stream[Symbol.asyncIterator]();
    bus.append(msgInput("us_1", "not for us"));
    bus.append(msgInput("us_2", "for us"));
    const got = await iterator.next();
    expect(got.value.seq).toBe(2);
    await iterator.return?.();
  });
});
