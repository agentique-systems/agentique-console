import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { toWireUserSession } from "../../db/repo.ts";
import { badRequest, notFound } from "../errors.ts";

export function registerViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/session-tree", async (request) => {
    ctx.workspaces.get(request.params.id);
    return ctx.repo.listUserSessions(request.params.id).map((session) => ({
      session: toWireUserSession(session),
      agentSessions: ctx.repo.listAgentSessions(session.id).map((row) => ctx.host.wireSession(row)),
    }));
  });

  app.get<{ Params: { id: string }; Querystring: { userSessionId?: string; agentSessionId?: string } }>(
    "/api/workspaces/:id/tasks",
    async (request) => {
      ctx.workspaces.get(request.params.id);
      return {
        tasks: ctx.tasks.listForWorkspace(request.params.id, request.query),
        dependencies: ctx.tasks.listDependencies(request.params.id),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string; limit?: string } }>(
    "/api/user-sessions/:id/timeline",
    async (request) => {
      const beforeSeq = request.query.beforeSeq === undefined ? undefined : Number(request.query.beforeSeq);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if ((beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw badRequest("timeline cursor and limit must be positive integers");
      return ctx.timeline.page(request.params.id, beforeSeq, limit);
    },
  );

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/agent-profiles", async (request) => {
    ctx.workspaces.get(request.params.id); return ctx.profiles.summaries(request.params.id);
  });
  app.get<{ Params: { id: string; profileId: string } }>("/api/workspaces/:id/agent-profiles/:profileId", async (request) => {
    ctx.workspaces.get(request.params.id); const detail = ctx.profiles.detail(request.params.id, request.params.profileId);
    if (!detail) throw notFound(`no profile ${request.params.profileId}`); return detail;
  });
  app.post<{ Params: { id: string; profileId: string }; Body: { revision?: string } }>("/api/workspaces/:id/agent-profiles/:profileId/trust", async (request) => {
    if (!request.body?.revision) throw badRequest("revision is required"); ctx.profiles.trust(request.params.id, request.params.profileId, request.body.revision); return { ok: true };
  });
  app.delete<{ Params: { id: string; profileId: string } }>("/api/workspaces/:id/agent-profiles/:profileId/trust", async (request) => {
    ctx.profiles.untrust(request.params.id, request.params.profileId); return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/manager-sessions", async (request) => ctx.manager.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { profileId?: string; sourceProfileId?: string } }>("/api/workspaces/:id/manager-sessions", async (request, reply) =>
    reply.status(201).send(ctx.manager.create(request.params.id, request.body ?? {})));
  app.get<{ Params: { id: string } }>("/api/manager-sessions/:id", async (request) => ({ session: ctx.manager.get(request.params.id), proposal: ctx.manager.proposal(request.params.id) }));
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/manager-sessions/:id/messages", async (request, reply) => {
    if (!request.body?.text?.trim()) throw badRequest("text is required"); return reply.status(202).send(ctx.manager.postMessage(request.params.id, request.body.text));
  });
  app.get<{ Params: { id: string } }>("/api/manager-sessions/:id/transcript", async (request) => ctx.userSessions.transcript(request.params.id));
}
