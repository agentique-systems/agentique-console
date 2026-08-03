import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/tasks",
    async (request) => ctx.tasks.listForUserSession(request.params.id),
  );
}
