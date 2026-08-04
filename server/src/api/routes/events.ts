import type { FastifyInstance } from "fastify";
import type { StatsResponse } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import { writeSse } from "../sse.ts";
import { notFound } from "../errors.ts";

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/stats", async (): Promise<StatsResponse> => {
    return { lastEventSeq: ctx.bus.headSeq() };
  });

  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (request, reply) => {
    const artifact = ctx.bus.getArtifact(request.params.id);
    if (!artifact) throw notFound(`no artifact ${request.params.id}`);
    if (artifact.mediaType.endsWith(";base64")) {
      reply.header("content-type", artifact.mediaType.slice(0, -7));
      return reply.send(Buffer.from(artifact.content, "base64"));
    }
    reply.header("content-type", artifact.mediaType);
    return artifact.mediaType === "application/json" ? JSON.parse(artifact.content) : artifact.content;
  });

  app.get<{ Querystring: { fromSeq?: string } }>(
    "/api/events",
    async (request, reply) => {
      // Last-Event-ID (browser auto-reconnect) wins over the query cursor;
      // the header carries the last id RECEIVED, so resume one past it.
      const header = request.headers["last-event-id"];
      const headerSeq =
        typeof header === "string" && header !== "" ? Number(header) + 1 : undefined;
      const querySeq =
        request.query.fromSeq !== undefined
          ? Number(request.query.fromSeq)
          : undefined;
      const fromSeq = headerSeq ?? querySeq ?? ctx.bus.headSeq() + 1;
      await writeSse(
        request,
        reply,
        ctx.bus.readWithSeq({ fromSeq, follow: true }),
      );
    },
  );
}
