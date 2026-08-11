import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/agent-sessions",
    async (request) => ctx.app.host.wireSessionsForUserSession(request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id",
    async (request) => ctx.app.host.detail(request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/transcript",
    async (request) => ctx.app.host.transcript(request.params.id),
  );
}
