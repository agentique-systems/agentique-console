import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isOrchestratorModel } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import { revivalPrompt } from "../../orchestrator/interactions.ts";
import { badRequest, notFound } from "../errors.ts";

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
  status: z.enum(["open", "archived"]).optional(),
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

  app.patch<{ Params: { id: string } }>(
    "/api/user-sessions/:id",
    async (request) => {
      const parsed = PatchBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      return sessions.patch(request.params.id, parsed.data);
    },
  );

  // The operator's verdict on a proposed run completion. 409s unless the run
  // is actually awaiting one, so a stale card cannot re-close a reopened run.
  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/signoff",
    async (request) => {
      const parsed = SignoffBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      ctx.app.completion.resolve(request.params.id, parsed.data.decision, parsed.data.note);
      return ctx.app.userSessions.get(request.params.id).session;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/messages",
    async (request, reply) => {
      const parsed = MessageBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      const session = ctx.app.repo.getUserSession(request.params.id);
      const result = session?.purpose === "profile_manager"
        ? ctx.app.manager.postMessage(request.params.id, parsed.data.text)
        : ctx.app.runner.postOperatorMessage(request.params.id, parsed.data.text);
      return reply.status(202).send(result);
    },
  );

  app.post<{ Params: { id: string; interactionId: string } }>(
    "/api/user-sessions/:id/interactions/:interactionId",
    async (request) => {
      const parsed = ResolveBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.message);
      const before = ctx.app.interactions.get(request.params.interactionId);
      const resolved = ctx.app.interactions.resolveFromApi(
        request.params.id,
        request.params.interactionId,
        parsed.data,
      );
      // A seat's answer cannot come back through a tool call that no longer
      // exists, and a seat is not revived by a lane — it is woken by a
      // delivery. So a detached or stale SEAT question is answered by mailbox.
      if (before.participant !== null && (before.detached || before.status === "stale")) {
        ctx.app.host.deliverOperatorAnswer(before);
        return resolved;
      }
      // A stale MAIN-LANE interaction's parked promise died with a previous
      // process — its answer becomes a fresh resumed turn instead (M8 revival).
      if (before.participant === null && before.status === "stale") {
        if (
          before.kind === "plan_approval" &&
          "decision" in parsed.data &&
          parsed.data.decision === "approve"
        ) {
          ctx.app.repo.patchUserSession(request.params.id, { phase: "executing" });
          ctx.app.bus.append({
            type: "user_session.updated",
            userSessionId: request.params.id,
            payload: {
              sessionId: request.params.id,
              patch: { phase: "executing" },
            },
          });
        }
        ctx.app.runner.enqueueRevival(
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
      ctx.app.runner.interrupt(request.params.id);
      return reply.status(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/transcript",
    async (request) => sessions.transcript(request.params.id),
  );
}
