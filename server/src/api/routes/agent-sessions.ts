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
      ctx.app.repo
        .listAgentSessions(request.params.id)
        .map((row) => ctx.app.host.wireSession(row)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id",
    async (request) => {
      const row = ctx.app.repo.getAgentSession(request.params.id);
      if (!row) throw notFound(`no agent session ${request.params.id}`);
      return {
        session: ctx.app.host.wireSession(row),
        runs: ctx.app.repo.listParticipants(row.id).map((participant) => ({
          participant: participant.name,
          profileId: participant.profileId,
          profile: participant.profileSnapshot,
          ownership: participant.ownership,
          generation: participant.generation,
          turnCount: participant.turnCount,
          contextTokens: participant.contextTokens,
          providerSessionId: participant.sdkSessionId,
        })),
        messages: ctx.app.repo
          .listMessages("agent", row.id)
          .map(toWireMessage),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/transcript",
    async (request) => {
      const row = ctx.app.repo.getAgentSession(request.params.id);
      if (!row) throw notFound(`no agent session ${request.params.id}`);
      const events: ConsoleEvent[] = [];
      for await (const event of ctx.app.bus.readWithSeq({
        agentSessionId: row.id,
      })) {
        events.push(event);
      }
      return events;
    },
  );
}
