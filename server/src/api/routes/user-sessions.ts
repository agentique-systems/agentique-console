import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { revivalPrompt } from "../../orchestrator/interactions.ts";
import { badRequest } from "../errors.ts";

const CreateBody = z.object({
  workspaceId: z.string(),
  mode: z.enum(["execute", "plan_execute"]),
  message: z.string(),
});

const PatchBody = z.object({
  mode: z.enum(["execute", "plan_execute"]).optional(),
  title: z.string().optional(),
  status: z.enum(["open", "archived"]).optional(),
});

const MessageBody = z.object({ text: z.string() });

const ResolveBody = z.union([
  z.object({ answers: z.record(z.string(), z.array(z.string())) }),
  z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().optional(),
  }),
]);

export function registerUserSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const sessions = ctx.userSessions;

  app.get<{ Querystring: { workspaceId?: string } }>(
    "/api/user-sessions",
    async (request) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) throw badRequest("workspaceId is required");
      return sessions.list(workspaceId);
    },
  );

  app.post("/api/user-sessions", async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const session = sessions.create(parsed.data);
    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id",
    async (request) => sessions.get(request.params.id),
  );

  app.get<{ Params: { id: string } }>("/api/user-sessions/:id/telemetry", async (request) => {
    sessions.get(request.params.id);
    const samples = ctx.repo.listUsage(request.params.id);
    return {
      totals: samples.reduce((total, sample) => ({ inputTokens: total.inputTokens + sample.inputTokens,
        uncachedInputTokens: total.uncachedInputTokens + sample.uncachedInputTokens,
        cacheCreationInputTokens: total.cacheCreationInputTokens + sample.cacheCreationInputTokens,
        cacheReadInputTokens: total.cacheReadInputTokens + sample.cacheReadInputTokens,
        outputTokens: total.outputTokens + sample.outputTokens, costUsd: total.costUsd + (sample.costUsd ?? 0) }),
      { inputTokens: 0, uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, costUsd: 0 }),
      samples,
    };
  });

  app.patch<{ Params: { id: string } }>(
    "/api/user-sessions/:id",
    async (request) => {
      const parsed = PatchBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      return sessions.patch(request.params.id, parsed.data);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/messages",
    async (request, reply) => {
      const parsed = MessageBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      const session = ctx.repo.getUserSession(request.params.id);
      const result = session?.purpose === "profile_manager"
        ? ctx.manager.postMessage(request.params.id, parsed.data.text)
        : ctx.runner.postOperatorMessage(request.params.id, parsed.data.text);
      return reply.status(202).send(result);
    },
  );

  app.post<{ Params: { id: string; interactionId: string } }>(
    "/api/user-sessions/:id/interactions/:interactionId",
    async (request) => {
      const parsed = ResolveBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      const before = ctx.interactions.get(request.params.interactionId);
      const resolved = ctx.interactions.resolveFromApi(
        request.params.id,
        request.params.interactionId,
        parsed.data,
      );
      // A stale interaction's parked promise died with a previous process —
      // its answer becomes a fresh resumed turn instead (M8 revival).
      if (before.status === "stale") {
        if (
          before.kind === "plan_approval" &&
          "decision" in parsed.data &&
          parsed.data.decision === "approve"
        ) {
          ctx.repo.patchUserSession(request.params.id, { phase: "executing" });
          ctx.bus.append({
            type: "user_session.updated",
            userSessionId: request.params.id,
            payload: {
              sessionId: request.params.id,
              patch: { phase: "executing" },
            },
          });
        }
        ctx.runner.enqueueRevival(
          request.params.id,
          revivalPrompt(before, parsed.data),
        );
      }
      return resolved;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/interrupt",
    async (request, reply) => {
      ctx.runner.interrupt(request.params.id);
      return reply.status(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/transcript",
    async (request) => sessions.transcript(request.params.id),
  );
}
