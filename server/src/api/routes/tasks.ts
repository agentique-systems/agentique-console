import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/tasks",
    async (request) => ctx.app.tasks.listForUserSession(request.params.id),
  );

  app.get<{
    Params: { id: string };
    Querystring: { userSessionId?: string; agentSessionId?: string };
  }>(
    "/api/workspaces/:id/tasks",
    async (request) => ctx.app.tasks.workspaceView(request.params.id, request.query),
  );
}
