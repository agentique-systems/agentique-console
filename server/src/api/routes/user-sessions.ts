import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isOrchestratorModel } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import { InvalidInputError } from "../../errors.ts";

/**
 * Constrained to the offered list rather than accepting any string: an id with
 * no `model-catalog.ts` entry silently drops the session's rotation ceiling to
 * 68K, and a rejected request is a far better failure than a session that
 * quietly rotates twice as often.
 */
const Model = z
  .string()
  .refine(isOrchestratorModel, { message: "unknown orchestrator model" });

const CreateBody = z.object({
  workspaceId: z.string(),
  mode: z.enum(["execute", "plan_execute"]),
  message: z.string(),
  model: Model.optional(),
});

const PatchBody = z.object({
  mode: z.enum(["execute", "plan_execute"]).optional(),
  title: z.string().optional(),
  lifecycle: z.enum(["open", "archived"]).optional(),
  model: Model.optional(),
});

const MessageBody = z.object({ text: z.string() });

const SignoffBody = z.object({
  decision: z.enum(["accept", "changes"]),
  note: z.string().optional(),
});

const ResolveBody = z.union([
  z.object({
    answers: z.record(z.string(), z.array(z.string())),
    // Free text keyed by question. The service 400s if the card was not raised
    // with `allowFreeText`. Without this the only way to say something the
    // asker did not anticipate was to type in chat — which DISMISSES the card
    // rather than answering it, and (before this release) silently dismissed
    // every seat's card along with it.
    freeText: z.record(z.string(), z.string()).optional(),
    note: z.string().optional(),
  }),
  z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().optional(),
  }),
]);

export function registerUserSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const sessions = ctx.app.userSessions;

  app.get<{ Querystring: { workspaceId?: string } }>(
    "/api/user-sessions",
    async (request) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) throw new InvalidInputError("workspaceId is required");
      return sessions.list(workspaceId);
    },
  );

  app.post("/api/user-sessions", async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) throw new InvalidInputError(parsed.error.message);
    const session = sessions.create(parsed.data);
    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id",
    async (request) => sessions.get(request.params.id),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/user-sessions/:id",
    async (request) => {
      const parsed = PatchBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return sessions.patch(request.params.id, parsed.data);
    },
  );

  // The operator's verdict on a proposed run completion. 409s unless the run
  // is actually awaiting one, so a stale card cannot re-close a reopened run.
  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/signoff",
    async (request) => {
      const parsed = SignoffBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return sessions.signoff(request.params.id, parsed.data);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/messages",
    async (request, reply) => {
      const parsed = MessageBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return reply
        .status(202)
        .send(sessions.postMessage(request.params.id, parsed.data.text));
    },
  );

  app.post<{ Params: { id: string; interactionId: string } }>(
    "/api/user-sessions/:id/interactions/:interactionId",
    async (request) => {
      const parsed = ResolveBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return ctx.app.interactions.resolveAndRoute(
        request.params.id,
        request.params.interactionId,
        parsed.data,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/interrupt",
    async (request, reply) => {
      ctx.app.runner.interrupt(request.params.id);
      return reply.status(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/transcript",
    async (request) => sessions.transcript(request.params.id),
  );

  app.get<{
    Params: { id: string };
    Querystring: { beforeSeq?: string; limit?: string };
  }>("/api/user-sessions/:id/timeline", async (request) => {
    const beforeSeq =
      request.query.beforeSeq === undefined
        ? undefined
        : Number(request.query.beforeSeq);
    const limit =
      request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (
      (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    ) {
      throw new InvalidInputError("timeline cursor and limit must be positive integers");
    }
    return ctx.app.timeline.page(request.params.id, beforeSeq, limit);
  });
}
