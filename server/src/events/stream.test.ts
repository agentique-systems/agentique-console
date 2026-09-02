/**
 * The one event stream (execution-model §13): only committed Events are
 * delivered; a rolled-back transaction delivers nothing; a subscriber that
 * connects mid-stream replays from its sequence and is handed to live
 * delivery without a lost or duplicated Event; filters keep scope; replay
 * pages, outbound buffers, and transient output are bounded; a closed
 * subscription releases its resources; and transient output rides the
 * stream by Attempt without ever being journaled.
 */
import { describe, expect, it } from "vitest";
import type { AttemptId, EventStreamFrame, RunId } from "@agentique-console/core";
import { openHarness, seedInvocation, seedManifest, seedRun } from "../persistence/test-support.ts";
import { EventStream, type EventSubscriber } from "./stream.ts";

function collector(options: { accept?: (frame: EventStreamFrame) => boolean } = {}) {
  const frames: EventStreamFrame[] = [];
  let closedReason: string | null = null;
  const subscriber: EventSubscriber = {
    deliver: (frame) => {
      frames.push(frame);
      return options.accept?.(frame) ?? true;
    },
    closed: (reason) => {
      closedReason = reason;
    },
  };
  return { frames, subscriber, closed: () => closedReason, events: () => frames.filter((f): f is Extract<EventStreamFrame, { kind: "event" }> => f.kind === "event").map((f) => f.event.seq) };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("EventStream", () => {
  it("replays from a sequence in bounded pages, announces caught_up, then delivers live committed Events exactly once each", async () => {
    const h = openHarness();
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 3 });
    try {
      const seeded = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      expect(before).toBeGreaterThan(3);
      const c = collector();
      stream.subscribe({}, 0, c.subscriber);
      await settle();
      const all = h.ctx.journal.read({ limit: 1_000 }).map((e) => e.seq);
      expect(c.frames[0]).toEqual({ kind: "connected", lastSeq: before });
      expect(c.events()).toEqual(all);
      expect(c.frames.some((f) => f.kind === "caught_up" && f.seq === before)).toBe(true);
      // Live: one committed transaction with several Events delivers each once, in sequence order.
      h.stores.conversations.postMessage({ conversationId: seeded.conversation.id, author: "operator", content: "hello", runId: null, invocationId: null });
      h.stores.conversations.update(seeded.conversation.id, { title: "renamed" });
      await settle();
      const after = h.ctx.journal.lastSeq();
      expect(c.events()).toEqual(h.ctx.journal.read({ limit: 1_000 }).map((e) => e.seq));
      expect(new Set(c.events()).size).toBe(c.events().length);
      expect(after).toBeGreaterThan(before);
      // A subscriber from the middle receives only what follows its sequence.
      const late = collector();
      stream.subscribe({}, before, late.subscriber);
      await settle();
      expect(late.events()).toEqual(all.length === 0 ? [] : h.ctx.journal.read({ afterSeq: before, limit: 1_000 }).map((e) => e.seq));
    } finally {
      stream.close();
      h.close();
    }
  });

  it("delivers nothing for a rolled-back transaction, and loses nothing when a commit lands during the replay", async () => {
    const h = openHarness();
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 2 });
    try {
      const seeded = seedRun(h);
      const c = collector();
      stream.subscribe({}, 0, c.subscriber);
      // A commit that lands while the subscriber is still paging: the cursor picks it up in the same replay; nothing is lost or repeated.
      h.stores.conversations.update(seeded.conversation.id, { title: "during replay" });
      await settle();
      const before = h.ctx.journal.lastSeq();
      expect(c.events()).toEqual(h.ctx.journal.read({ limit: 1_000 }).map((e) => e.seq));
      // A rolled-back transaction: its Events never existed; no frame is delivered.
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.conversations.update(seeded.conversation.id, { title: "rolled back" });
          throw new Error("abort");
        }),
      ).toThrow("abort");
      await settle();
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(c.events().at(-1)).toBe(before);
      expect(c.frames.filter((f) => f.kind === "event").length).toBe(before);
    } finally {
      stream.close();
      h.close();
    }
  });

  it("filters by Workspace, Conversation, and Run; a scoped subscriber never receives another scope's Event", async () => {
    const h = openHarness();
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs);
    try {
      const a = seedRun(h);
      const b = seedRun(h);
      const byRun = collector();
      const byConversation = collector();
      const byWorkspace = collector();
      stream.subscribe({ runId: a.run.id }, 0, byRun.subscriber);
      stream.subscribe({ conversationId: b.conversation.id }, 0, byConversation.subscriber);
      stream.subscribe({ workspaceId: a.workspace.id }, 0, byWorkspace.subscriber);
      await settle();
      h.stores.conversations.postMessage({ conversationId: a.conversation.id, author: "operator", content: "for a", runId: a.run.id, invocationId: null });
      h.stores.conversations.postMessage({ conversationId: b.conversation.id, author: "operator", content: "for b", runId: null, invocationId: null });
      await settle();
      const events = h.ctx.journal.read({ limit: 1_000 });
      const scopeOf = (seq: number) => events.find((e) => e.seq === seq)!.scope;
      expect(byRun.events().length).toBeGreaterThan(0);
      for (const seq of byRun.events()) expect(scopeOf(seq).runId).toBe(a.run.id);
      for (const seq of byConversation.events()) expect(scopeOf(seq).conversationId).toBe(b.conversation.id);
      for (const seq of byWorkspace.events()) expect(scopeOf(seq).workspaceId).toBe(a.workspace.id);
      expect(byWorkspace.events()).toEqual(events.filter((e) => e.scope.workspaceId === a.workspace.id).map((e) => e.seq));
    } finally {
      stream.close();
      h.close();
    }
  });

  it("closes a subscriber that refuses a frame or falls behind the bounded buffer, and releases a closed subscription", async () => {
    const h = openHarness();
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 100, maxPendingFrames: 5 });
    try {
      seedRun(h);
      const refusing = collector({ accept: (frame) => frame.kind !== "event" });
      stream.subscribe({}, 0, refusing.subscriber);
      await settle();
      expect(refusing.closed()).toBe("backpressure");
      expect(refusing.events()).toHaveLength(1);
      const fine = collector();
      const subscription = stream.subscribe({}, 0, fine.subscriber);
      await settle();
      expect(stream.subscriptions).toBe(1);
      subscription.close();
      expect(fine.closed()).toBe("client");
      expect(stream.subscriptions).toBe(0);
      // Nothing reaches a closed subscription.
      const count = fine.frames.length;
      h.stores.workspaces.create({ name: "later", rootPath: "/tmp/later", kind: "git" });
      await settle();
      expect(fine.frames.length).toBe(count);
    } finally {
      stream.close();
      h.close();
    }
  });

  it("routes transient output by Attempt to live subscribers in scope, never journals it, and drops it for a subscriber still replaying", async () => {
    const h = openHarness();
    const stream = new EventStream(h.ctx, h.stores.invocations, h.stores.runs);
    try {
      const seeded = seedRun(h);
      const invocation = seedInvocation(h, seeded, { allocation: { costUsd: 1, tokens: 1_000, attempts: 1 } });
      seedManifest(h, seeded, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const inScope = collector();
      const outOfScope = collector();
      stream.subscribe({ runId: seeded.run.id }, h.ctx.journal.lastSeq(), inScope.subscriber);
      stream.subscribe({ runId: "run_000000000000000000000000" as RunId }, h.ctx.journal.lastSeq(), outOfScope.subscriber);
      await settle();
      const seq = h.ctx.journal.lastSeq();
      stream.publishOutput({ attemptId: attempt.id, kind: "text", text: "thinking" });
      stream.publishOutput({ attemptId: "att_000000000000000000000000" as AttemptId, kind: "text", text: "unknown attempt" });
      expect(inScope.frames.filter((f) => f.kind === "output")).toEqual([{ kind: "output", attemptId: attempt.id, runId: seeded.run.id, invocationId: invocation.id, chunk: { kind: "text", text: "thinking" } }]);
      expect(outOfScope.frames.filter((f) => f.kind === "output")).toEqual([]);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // A subscriber still replaying (one Event per page, so the replay yields between pages) receives no transient frame.
      const paged = new EventStream(h.ctx, h.stores.invocations, h.stores.runs, { replayPage: 1 });
      try {
        const replaying = collector();
        paged.subscribe({ runId: seeded.run.id }, 0, replaying.subscriber);
        paged.publishOutput({ attemptId: attempt.id, kind: "tool_call", text: "Read" });
        await settle();
        expect(replaying.frames.filter((f) => f.kind === "output")).toEqual([]);
        expect(replaying.frames.some((f) => f.kind === "caught_up")).toBe(true);
      } finally {
        paged.close();
      }
    } finally {
      stream.close();
      h.close();
    }
  });
});
