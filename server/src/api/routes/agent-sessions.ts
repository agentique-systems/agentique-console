import type { FastifyInstance } from "fastify";
import type { ConsoleEvent } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import { notFound } from "../errors.ts";
import { toWireMessage } from "../../db/repo.ts";

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/agent-sessions",
    async (request) =>
      ctx.repo
        .listAgentSessions(request.params.id)
        .map((row) => ctx.host.wireSession(row)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id",
    async (request) => {
      const row = ctx.repo.getAgentSession(request.params.id);
      if (!row) throw notFound(`no agent session ${request.params.id}`);
      return {
        session: ctx.host.wireSession(row),
        messages: ctx.repo
          .listMessages("agent", row.id)
          .map(toWireMessage),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/transcript",
    async (request) => {
      const row = ctx.repo.getAgentSession(request.params.id);
      if (!row) throw notFound(`no agent session ${request.params.id}`);
      const events: ConsoleEvent[] = [];
      for await (const event of ctx.bus.readWithSeq({
        agentSessionId: row.id,
      })) {
        events.push(event);
      }
      return events;
    },
  );
}
