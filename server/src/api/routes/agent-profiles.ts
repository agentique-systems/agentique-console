import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { InvalidInputError, NotFoundError } from "../../errors.ts";

export function registerAgentProfileRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/agent-profiles",
    async (request) => ctx.app.profiles.summaries(request.params.id),
  );

  app.get<{ Params: { id: string; profileId: string } }>(
    "/api/workspaces/:id/agent-profiles/:profileId",
    async (request) => {
      const detail = ctx.app.profiles.detail(
        request.params.id,
        request.params.profileId,
      );
      if (!detail) throw new NotFoundError(`no profile ${request.params.profileId}`);
      return detail;
    },
  );

  app.post<{ Params: { id: string; profileId: string }; Body: { revision?: string } }>(
    "/api/workspaces/:id/agent-profiles/:profileId/trust",
    async (request) => {
      if (!request.body?.revision) throw new InvalidInputError("revision is required");
      ctx.app.profiles.trust(
        request.params.id,
        request.params.profileId,
        request.body.revision,
      );
      return { ok: true };
    },
  );
}
