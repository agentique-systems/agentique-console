import type { FastifyInstance } from "fastify";
import type { StatsResponse } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import { writeSse } from "../sse.ts";

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/stats", async (): Promise<StatsResponse> => {
    return { lastEventSeq: ctx.bus.headSeq() };
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
