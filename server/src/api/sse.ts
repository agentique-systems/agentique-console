import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConsoleEvent } from "@agentique-console/shared";

const HEARTBEAT_MS = 15_000;

/**
 * Streams spine events as Server-Sent Events. Persisted events carry
 * `id: <global seq>` (enabling Last-Event-ID reconnection); transient
 * frames stream without an id and are never replayed.
 */
export async function writeSse(
  request: FastifyRequest,
  reply: FastifyReply,
  source: AsyncIterable<ConsoleEvent>,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.write(": connected\n\n");

  const heartbeat = setInterval(() => raw.write(": hb\n\n"), HEARTBEAT_MS);
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  const onClose = (): void => {
    closed = true;
    void iterator.return?.();
  };
  request.raw.on("close", onClose);

  try {
    while (!closed) {
      const next = await iterator.next();
      if (next.done === true) break;
      const event = next.value;
      let frame = "";
      if (event.seq !== undefined) frame += `id: ${event.seq}\n`;
      frame += `event: console\ndata: ${JSON.stringify(event)}\n\n`;
      raw.write(frame);
    }
  } finally {
    clearInterval(heartbeat);
    request.raw.off("close", onClose);
    await iterator.return?.().then(
      () => undefined,
      () => undefined,
    );
    raw.end();
  }
}
