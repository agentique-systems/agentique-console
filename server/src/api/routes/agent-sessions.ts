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

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/activity",
    async (request) => ctx.app.host.activity(request.params.id),
  );

  // The per-agent stop the roguelike run lacked: the operator watched a
  // 14-minute wedged tool call with no lever short of killing the process.
  app.post<{ Params: { id: string; agent: string }; Body: { reason?: string } | null }>(
    "/api/agent-sessions/:id/agents/:agent/interrupt",
    async (request, reply) => {
      ctx.app.host.interruptAgent(
        request.params.id,
        request.params.agent,
        `operator: ${request.body?.reason?.trim() || "stopped from the console"}`,
      );
      reply.code(204);
    },
  );
}
