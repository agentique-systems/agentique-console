/**
 * `GET /api/events` as Server-Sent Events over the one event stream
 * (execution-model §13): journaled Events carry their sequence as the SSE
 * `id` so a client resumes with `afterSeq` (or `Last-Event-ID`); transient
 * output frames carry no id. A subscriber that cannot drain its socket is
 * closed (bounded outbound backlog) and reconnects from its last sequence;
 * a client disconnect releases the subscription at once. A comment line
 * keeps proxies from closing an idle connection — transport only, no
 * semantics.
 */
import { eventsQuerySchema, type EventStreamFrame } from "@agentique-console/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { ApiError } from "./errors.ts";
import { parse } from "./routes/support.ts";

const HEARTBEAT_MS = 15_000;
/** Bytes the socket may hold unsent before the subscriber is closed for backpressure. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function frameOf(frame: EventStreamFrame): string {
  const id = frame.kind === "event" ? `id: ${frame.event.seq}\n` : "";
  return `${id}event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export async function handleEvents(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  const query = parse(eventsQuerySchema, request.query, "query");
  const lastEventId = request.headers["last-event-id"];
  const fromHeader = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : null;
  const afterSeq = query.afterSeq ?? fromHeader ?? ctx.app.events.lastSeq();
  if (ctx.app.admission.state === "stopping") throw new ApiError("unavailable", "the console is stopping", { admission: "stopping" });
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.write(": connected\n\n");
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const filter = { ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }), ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }), ...(query.runId === undefined ? {} : { runId: query.runId }) };
  const subscription = ctx.app.events.subscribe(filter, afterSeq, {
    deliver: (frame) => {
      if (closed) return false;
      // Transient output is dropped, never queued, once the socket is behind.
      if (frame.kind === "output" && raw.writableLength > 0) return true;
      raw.write(frameOf(frame));
      return raw.writableLength <= MAX_BUFFERED_BYTES;
    },
    closed: () => {
      end();
    },
  });
  const end = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    request.raw.off("close", onClose);
    subscription.close();
    raw.end();
  };
  const onClose = (): void => end();
  request.raw.on("close", onClose);
  if (request.raw.destroyed) end();
}
