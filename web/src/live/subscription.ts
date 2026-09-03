/**
 * The one event subscription of the web application (execution-model §13):
 * a Server-Sent Events connection to `GET /api/events`, resumed from the
 * last sequence it saw so a reconnect replays what it missed and nothing
 * twice. Every journaled Event refreshes the canonical projections in its
 * scope (a point read through the API); transient output frames feed the
 * live output store and are never treated as state. Reconnecting starts no
 * work and repeats no mutation: the subscription only reads.
 *
 * The connection is a plain `fetch` over a readable stream rather than the
 * browser's `EventSource`, so the same code runs in the test DOM and can
 * carry the `afterSeq` cursor explicitly.
 */
import type { QueryClient } from "@tanstack/react-query";
import { apiPath, type Event, type EventStreamFrame } from "@agentique-console/core";
import { apiUrl } from "@/api/client";
import { isImmutableHistory, keys } from "@/api/keys";
import { useConnectionStore } from "@/stores/connection";
import { useOutputStore } from "@/stores/output";

export interface Subscription {
  start(): void;
  stop(): void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/** The query prefixes an Event's scope touches. */
export function invalidationsOf(event: Event): (readonly unknown[])[] {
  const out: (readonly unknown[])[] = [];
  const { workspaceId, conversationId, runId } = event.scope;
  if (event.type.startsWith("workspace.")) out.push(keys.workspaces);
  if (workspaceId !== null) {
    out.push(keys.workspace(workspaceId));
    if (event.type.startsWith("agent_definition")) out.push(keys.workspaceAgents(workspaceId));
  }
  if (conversationId !== null) out.push(keys.conversation(conversationId));
  if (runId !== null) {
    out.push(keys.run(runId));
    if (workspaceId !== null) out.push(keys.workspaceRuns(workspaceId));
  }
  if (event.scope.planNodeId !== null) out.push(keys.planNode(event.scope.planNodeId));
  if (event.scope.invocationId !== null) out.push(keys.invocation(event.scope.invocationId));
  if (event.scope.attemptId !== null) out.push(keys.attempt(event.scope.attemptId));
  if (event.type.startsWith("capacity_lease")) out.push(keys.capacity);
  return out;
}

/** Parses SSE frames out of a byte stream; the parser keeps partial lines across chunks. */
export function createSseParser(onFrame: (event: string, data: string, id: string | null) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = "message";
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
      if (data.length > 0) onFrame(event, data.join("\n"), id);
    }
  };
}

export function createSubscription(client: QueryClient, options: { fetchImpl?: typeof fetch } = {}): Subscription {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let stopped = true;
  let controller: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const connection = () => useConnectionStore.getState();
  // Invalidations coalesce per animation frame: one burst of Events refreshes each projection once.
  const pending = new Map<string, readonly unknown[]>();
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    const batch = [...pending.values()];
    pending.clear();
    for (const queryKey of batch) void client.invalidateQueries({ queryKey });
  };
  const invalidate = (queryKey: readonly unknown[]) => {
    pending.set(JSON.stringify(queryKey), queryKey);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 50);
    }
  };

  const handle = (frame: EventStreamFrame): void => {
    switch (frame.kind) {
      case "connected":
        connection().setStatus("open");
        return;
      case "caught_up":
        connection().noteSeq(frame.seq);
        // A reconnect may have missed Events outside the replayed scope; every mounted projection refreshes once — except the
        // immutable message history, which no Event can change.
        void client.invalidateQueries({ predicate: (query) => !isImmutableHistory(query.queryKey) });
        return;
      case "event":
        connection().noteSeq(frame.event.seq);
        for (const queryKey of invalidationsOf(frame.event)) invalidate(queryKey);
        return;
      case "output":
        useOutputStore.getState().append(frame);
        return;
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();
    connection().setStatus("connecting");
    try {
      const afterSeq = connection().lastSeq;
      const response = await fetchImpl(apiUrl(apiPath("events", {}, { afterSeq })), { signal: controller.signal, headers: { accept: "text/event-stream" } });
      if (!response.ok || response.body === null) throw new Error(`event stream ${response.status}`);
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser((event, data) => {
        if (event === "message") return;
        try {
          handle(JSON.parse(data) as EventStreamFrame);
        } catch {
          // A malformed frame is dropped; the cursor stays where it was.
        }
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
    } catch {
      // fall through to the reconnect
    }
    if (stopped) return;
    connection().setStatus("closed");
    connection().noteReconnect();
    useOutputStore.getState().clear();
    attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5));
    timer = setTimeout(() => void connect(), delay);
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      void connect();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      connection().setStatus("closed");
    },
  };
}
