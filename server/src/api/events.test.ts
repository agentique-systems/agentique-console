/**
 * `GET /api/events` over a real listener (execution-model §13): the
 * server-sent stream carries only committed Events with their journal
 * sequence as the SSE id; a client that reconnects with `Last-Event-ID`
 * receives exactly the Events it missed, in order, then `caught_up`, then
 * the live ones — no gap, no duplicate; a scoped subscription never
 * receives another Workspace's Event; a disconnect releases the
 * subscription at once; opening and closing subscriptions never writes
 * anything; and a stopping console refuses new subscriptions.
 *
 * Invariants 3 and 21 (committed-only, sequence-ordered projection).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Event, EventStreamFrame } from "@agentique-console/core";
import { openTestApp, removeAppDirectory, type TestApp } from "./test-support.ts";

interface Frame {
  id: number | null;
  frame: EventStreamFrame;
}

/** Reads SSE frames from a fetch response until `count` frames of the accepted kinds arrived (comments are skipped). */
async function readFrames(response: Response, accept: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!accept(frames)) {
    if (Date.now() > deadline) throw new Error(`timed out after ${frames.length} frames: ${JSON.stringify(frames).slice(0, 1_000)}`);
    const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), Math.max(1, deadline - Date.now())))]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (block.startsWith(":")) continue;
      let id: number | null = null;
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = Number(line.slice(4));
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (data !== "") frames.push({ id, frame: JSON.parse(data) as EventStreamFrame });
    }
  }
  reader.cancel().catch(() => undefined);
  return frames;
}

const events = (frames: Frame[]) => frames.filter((f): f is Frame & { frame: { kind: "event"; event: Event } } => f.frame.kind === "event");

describe("GET /api/events", () => {
  let t: TestApp;
  let url: string;

  beforeAll(async () => {
    t = await openTestApp();
    url = await t.app.server.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await t.close();
    removeAppDirectory(t.dir);
  });

  const open = (query: string, headers: Record<string, string> = {}) => {
    const controller = new AbortController();
    const response = fetch(`${url}/api/events${query}`, { headers, signal: controller.signal });
    return { controller, response };
  };

  it("announces the connection with the journal's last sequence, then delivers each committed Event once with its sequence as the SSE id", async () => {
    const before = t.app.events.lastSeq();
    const { controller, response } = open("");
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const created = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: `${t.dir}\\one`, create: true } });
    expect(created.status).toBe(201);
    const frames = await readFrames(res, (f) => events(f).some((e) => e.frame.event.scope.workspaceId === created.body.workspace.id));
    expect(frames[0]!.frame).toEqual({ kind: "connected", lastSeq: before });
    // A fresh subscription is live at once: it reports caught_up at the same sequence, then the live Events.
    expect(frames[1]!.frame).toEqual({ kind: "caught_up", seq: before });
    const live = events(frames);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((e) => e.id === e.frame.event.seq)).toBe(true);
    expect(live.map((e) => e.frame.event.seq)).toEqual([...new Set(live.map((e) => e.frame.event.seq))]);
    expect(live[0]!.frame.event.seq).toBe(before + 1);
    controller.abort();
  });

  it("replays exactly the missed Events after Last-Event-ID, in order, then caught_up, then live — no gap and no duplicate — and a scoped stream never carries another Workspace's Event", async () => {
    const one = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: `${t.dir}\\two`, create: true } });
    const other = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: `${t.dir}\\three`, create: true } });
    const seen = t.app.events.lastSeq();
    // Commits the client misses while disconnected: one in scope, one out of scope.
    await t.call("createConversation", { body: { workspaceId: one.body.workspace.id, title: "missed" } });
    await t.call("createConversation", { body: { workspaceId: other.body.workspace.id, title: "other" } });
    const after = t.app.events.lastSeq();
    expect(after).toBeGreaterThan(seen);
    const { controller, response } = open(`?workspaceId=${one.body.workspace.id}`, { "last-event-id": String(seen) });
    const res = await response;
    // A live commit after the reconnect, in scope.
    const framesPromise = readFrames(res, (f) => f.some((x) => x.frame.kind === "caught_up") && events(f).some((e) => e.frame.event.seq > after));
    await t.call("createConversation", { body: { workspaceId: one.body.workspace.id, title: "live" } });
    const frames = await framesPromise;
    const replayed = events(frames).filter((e) => e.frame.event.seq <= after);
    const caughtUp = frames.findIndex((f) => f.frame.kind === "caught_up");
    // Every replayed Event precedes caught_up; every live one follows it; the sequence never repeats or goes backwards.
    expect(replayed.every((e) => frames.indexOf(e) < caughtUp)).toBe(true);
    expect(events(frames).filter((e) => e.frame.event.seq > after).every((e) => frames.indexOf(e) > caughtUp)).toBe(true);
    const seqs = events(frames).map((e) => e.frame.event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.every((s) => s > seen)).toBe(true);
    // Only the scoped Workspace's Events: the other Workspace's commit is absent from the replay.
    expect(events(frames).every((e) => e.frame.event.scope.workspaceId === one.body.workspace.id)).toBe(true);
    expect(replayed.length).toBeGreaterThan(0);
    controller.abort();
  });

  it("releases the subscription when the client disconnects, and connecting or reconnecting never writes anything", async () => {
    const seqBefore = t.app.events.lastSeq();
    // The earlier tests' aborted clients are released asynchronously; start from a settled count.
    const settle = async (expected: number) => {
      const deadline = Date.now() + 5_000;
      while (t.app.events.subscriptions !== expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      return t.app.events.subscriptions;
    };
    expect(await settle(0)).toBe(0);
    const subscriptionsBefore = 0;
    const { controller, response } = open("");
    const res = await response;
    await readFrames(res, (f) => f.length >= 1);
    expect(t.app.events.subscriptions).toBe(subscriptionsBefore + 1);
    controller.abort();
    expect(await settle(subscriptionsBefore)).toBe(subscriptionsBefore);
    // A reconnect from an old sequence replays rows; nothing is written by it.
    const again = open("", { "last-event-id": "0" });
    const res2 = await again.response;
    const frames = await readFrames(res2, (f) => f.some((x) => x.frame.kind === "caught_up"));
    expect(frames.at(-1)!.frame).toEqual({ kind: "caught_up", seq: seqBefore });
    again.controller.abort();
    expect(t.app.events.lastSeq()).toBe(seqBefore);
  });

  it("rejects a malformed query and refuses a new subscription while the console is stopping", async () => {
    const bad = await fetch(`${url}/api/events?afterSeq=-1`);
    expect(bad.status).toBe(400);
    t.app.admission.set("stopping");
    try {
      const refused = await fetch(`${url}/api/events`);
      expect(refused.status).toBe(503);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    } finally {
      t.app.admission.set("ready");
    }
  });
});
