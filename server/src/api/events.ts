/**
 * `GET /api/events` as Server-Sent Events over the one event stream
 * (execution-model §13): journaled Events carry their sequence as the SSE
 * `id` so a client resumes with `afterSeq` (or `Last-Event-ID`); transient
 * output frames carry no id. A subscriber that cannot drain its socket is
 * closed (bounded outbound backlog) and reconnects from its last sequence;
 * a client disconnect releases the subscription at once. A comment line
 * keeps proxies from closing an idle connection — transport only, no
 * semantics.
 *
 * Cleanup is one idempotent `end` over an explicit transport boundary
 * (`SseTransport`): it closes the response, clears the heartbeat, drops the
 * transport listeners, and closes the subscription exactly once, whatever
 * the order — the stream closing the subscriber synchronously inside
 * `subscribe` (the initial replay page crossing the buffer bound), a later
 * replay page, a disconnect during replay or live delivery, the server's
 * shutdown, a write that throws on a destroyed socket, or repeated
 * closure notifications. Nothing here decides anything about Events.
 */
import { eventsQuerySchema, type EventStreamFrame } from "@agentique-console/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import type { EventFilter, EventStream, Subscription } from "../events/stream.ts";
import { ApiError } from "./errors.ts";
import { parse } from "./routes/support.ts";

export const HEARTBEAT_MS = 15_000;
/** Bytes the socket may hold unsent before the subscriber is closed for backpressure. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function frameOf(frame: EventStreamFrame): string {
  const id = frame.kind === "event" ? `id: ${frame.event.seq}\n` : "";
  return `${id}event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** The transport an SSE subscription writes to: the HTTP response in production, a scripted double in the unit tests. */
export interface SseTransport {
  /** Queues one chunk; may throw once the peer is gone. */
  write(chunk: string): void;
  /** Bytes queued and not yet handed to the peer. */
  readonly writableLength: number;
  /** Whether the peer is already gone. */
  readonly destroyed: boolean;
  /** Ends the response (idempotent on the transport's side). */
  end(): void;
  /** Registers the callback for the peer disconnecting or the socket failing; returns the unregister. */
  onClose(callback: () => void): () => void;
}

export interface SseOptions {
  maxBufferedBytes?: number;
  heartbeatMs?: number;
  /** Observes every ended subscription with its reason (tests); production passes none. */
  onEnd?: (reason: SseEndReason) => void;
}

export type SseEndReason = "client" | "backpressure" | "stream" | "handler";

export interface AttachedSse {
  /** Ends the subscription and the response once; later calls change nothing. */
  end(reason: SseEndReason): void;
  readonly closed: boolean;
  /** The reason the first `end` gave, once closed. */
  readonly reason: SseEndReason | null;
}

/**
 * Attaches one subscription to the transport. `end` exists before the stream is asked for anything, so a closure the
 * stream delivers synchronously inside `subscribe` — before the subscription handle exists — still releases everything; the
 * handle is closed right after `subscribe` returns when that happened.
 */
export function attachEventStream(transport: SseTransport, events: Pick<EventStream, "subscribe">, filter: EventFilter, afterSeq: number, options: SseOptions = {}): AttachedSse {
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  let closed = false;
  let reason: SseEndReason | null = null;
  let subscription: Subscription | null = null;
  let unregister: (() => void) | null = null;
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      transport.write(": heartbeat\n\n");
    } catch {
      end("client");
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();
  const end = (why: SseEndReason): void => {
    if (closed) return;
    closed = true;
    reason = why;
    clearInterval(heartbeat);
    unregister?.();
    // Idempotent on the stream's side: an entry the stream already ended is left as it is.
    subscription?.close();
    try {
      transport.end();
    } catch {
      // The peer is gone either way.
    }
    options.onEnd?.(why);
  };
  unregister = transport.onClose(() => end("client"));
  const attached: AttachedSse = {
    end,
    get closed() {
      return closed;
    },
    get reason() {
      return reason;
    },
  };
  if (transport.destroyed) {
    end("client");
    return attached;
  }
  try {
    transport.write(": connected\n\n");
  } catch {
    end("client");
    return attached;
  }
  const handle = events.subscribe(filter, afterSeq, {
    deliver: (frame) => {
      if (closed) return false;
      // Transient output is dropped, never queued, once the socket is behind.
      if (frame.kind === "output" && transport.writableLength > 0) return true;
      try {
        transport.write(frameOf(frame));
      } catch {
        return false;
      }
      return transport.writableLength <= maxBufferedBytes;
    },
    closed: (why) => end(why),
  });
  if (closed) {
    // The stream ended the subscription while `subscribe` was still running (the initial replay crossed the bound, or the peer
    // vanished meanwhile): the handle exists only now, and closing it is a no-op on an already-ended entry.
    handle.close();
  } else {
    subscription = handle;
  }
  return attached;
}

/** The HTTP response as the transport: the request's and the response's close, and the socket's error, all end the subscription. */
export function responseTransport(request: FastifyRequest, reply: FastifyReply): SseTransport {
  const raw = reply.raw;
  return {
    write: (chunk) => {
      raw.write(chunk);
    },
    get writableLength() {
      return raw.writableLength;
    },
    get destroyed() {
      return raw.destroyed || request.raw.destroyed;
    },
    end: () => {
      // An SSE response owns its connection: once the response has flushed, the socket is ended rather than left idling as a
      // keep-alive connection (the response detaches from it at finish, so the socket is taken before the end).
      const socket = raw.socket ?? request.raw.socket;
      raw.end(() => socket?.destroySoon());
    },
    onClose: (callback) => {
      request.raw.on("close", callback);
      raw.on("close", callback);
      raw.on("error", callback);
      return () => {
        request.raw.off("close", callback);
        raw.off("close", callback);
        raw.off("error", callback);
      };
    },
  };
}

export async function handleEvents(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  const query = parse(eventsQuerySchema, request.query, "query");
  const lastEventId = request.headers["last-event-id"];
  const fromHeader = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : null;
  const afterSeq = query.afterSeq ?? fromHeader ?? ctx.app.events.lastSeq();
  if (ctx.app.admission.state === "stopping") throw new ApiError("unavailable", "the console is stopping", { admission: "stopping" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const filter: EventFilter = { ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }), ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }), ...(query.runId === undefined ? {} : { runId: query.runId }) };
  attachEventStream(responseTransport(request, reply), ctx.app.events, filter, afterSeq, ctx.app.eventStreamOptions);
}
