import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { toWireUserSession } from "../../db/repo.ts";
import { InvalidInputError, NotFoundError } from "../../errors.ts";

export function registerViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/session-tree", async (request) => {
    ctx.app.workspaces.get(request.params.id);
    return ctx.app.repo.listUserSessions(request.params.id).map((session) => ({
      session: toWireUserSession(session),
      agentSessions: ctx.app.repo.listAgentSessions(session.id).map((row) => ctx.app.host.wireSession(row)),
    }));
  });

  app.get<{ Params: { id: string }; Querystring: { userSessionId?: string; agentSessionId?: string } }>(
    "/api/workspaces/:id/tasks",
    async (request) => {
      ctx.app.workspaces.get(request.params.id);
      return {
        tasks: ctx.app.tasks.listForWorkspace(request.params.id, request.query),
        dependencies: ctx.app.tasks.listDependencies(request.params.id),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string; limit?: string } }>(
    "/api/user-sessions/:id/timeline",
    async (request) => {
      const beforeSeq = request.query.beforeSeq === undefined ? undefined : Number(request.query.beforeSeq);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if ((beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw new InvalidInputError("timeline cursor and limit must be positive integers");
      return ctx.app.timeline.page(request.params.id, beforeSeq, limit);
    },
  );

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/agent-profiles", async (request) => {
    ctx.app.workspaces.get(request.params.id); return ctx.app.profiles.summaries(request.params.id);
  });
  app.get<{ Params: { id: string; profileId: string } }>("/api/workspaces/:id/agent-profiles/:profileId", async (request) => {
    ctx.app.workspaces.get(request.params.id); const detail = ctx.app.profiles.detail(request.params.id, request.params.profileId);
    if (!detail) throw new NotFoundError(`no profile ${request.params.profileId}`); return detail;
  });
  app.post<{ Params: { id: string; profileId: string }; Body: { revision?: string } }>("/api/workspaces/:id/agent-profiles/:profileId/trust", async (request) => {
    if (!request.body?.revision) throw new InvalidInputError("revision is required"); ctx.app.profiles.trust(request.params.id, request.params.profileId, request.body.revision); return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/manager-sessions", async (request) => ctx.app.manager.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { profileId?: string; sourceProfileId?: string } }>("/api/workspaces/:id/manager-sessions", async (request, reply) =>
    reply.status(201).send(ctx.app.manager.create(request.params.id, request.body ?? {})));
  app.get<{ Params: { id: string } }>("/api/manager-sessions/:id", async (request) => ({ session: ctx.app.manager.get(request.params.id), proposal: ctx.app.manager.proposal(request.params.id) }));
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/manager-sessions/:id/messages", async (request, reply) => {
    if (!request.body?.text?.trim()) throw new InvalidInputError("text is required"); return reply.status(202).send(ctx.app.manager.postMessage(request.params.id, request.body.text));
  });
}
