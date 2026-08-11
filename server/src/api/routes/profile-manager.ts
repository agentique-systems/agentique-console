import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { InvalidInputError } from "../../errors.ts";

export function registerProfileManagerRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/profile-manager-sessions",
    async (request) => ctx.app.manager.list(request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { profileId?: string; sourceProfileId?: string } }>(
    "/api/workspaces/:id/profile-manager-sessions",
    async (request, reply) =>
      reply
        .status(201)
        .send(ctx.app.manager.create(request.params.id, request.body ?? {})),
  );

  app.get<{ Params: { id: string } }>(
    "/api/profile-manager-sessions/:id",
    async (request) => ctx.app.manager.detail(request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/profile-manager-sessions/:id/messages",
    async (request, reply) => {
      if (!request.body?.text?.trim()) throw new InvalidInputError("text is required");
      return reply
        .status(202)
        .send(ctx.app.manager.postMessage(request.params.id, request.body.text));
    },
  );
}
