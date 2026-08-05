import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";

export function registerHandoffRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string }; Querystring: { section?: "core" | "extension"; cursor?: string; maxBytes?: string } }>(
    "/api/handoffs/:id",
    async (request) => ctx.handoffs.read(
      request.params.id,
      request.query.section ?? "core",
      request.query.cursor,
      request.query.maxBytes === undefined ? undefined : Number(request.query.maxBytes),
    ),
  );

  app.post<{ Params: { id: string }; Body: { reporter: string; claim: string; evidence: string } }>(
    "/api/handoffs/:id/discrepancies",
    async (request, reply) => {
      ctx.handoffs.reportDiscrepancy(request.params.id, request.body.reporter, request.body.claim, request.body.evidence);
      return reply.status(202).send({ recorded: true });
    },
  );
}
