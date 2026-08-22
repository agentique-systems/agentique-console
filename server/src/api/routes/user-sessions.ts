import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isOrchestratorModel, type EvidenceRef, type RequirementRevisionWire } from "@agentique-console/shared";
import type { AppContext } from "../../context.ts";
import type { RequirementRevisionRow } from "../../db/stores/requirement-store.ts";
import { InvalidInputError } from "../../errors.ts";
import { buildCommissions } from "../../orchestrator/commissions.ts";
import { flattenRequirementGraph, type RequirementGraph } from "@agentique-console/shared";

function toRequirementRevisionWire(row: RequirementRevisionRow): RequirementRevisionWire {
  return {
    id: row.id,
    revision: row.revision,
    document: row.document,
    changeNote: row.changeNote,
    status: row.status,
    origin: row.origin,
    interactionId: row.interactionId,
    nodeCount: flattenRequirementGraph(row.graph as unknown as RequirementGraph).length,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
  };
}

function mapOrNull<T, U>(value: T | undefined, map: (value: T) => U): U | null {
  return value === undefined ? null : map(value);
}

const RequirementStatusBody = z.object({
  status: z.enum(["open", "satisfied", "violated", "infeasible"]),
  evidence: z.array(z.object({
    kind: z.enum(["file", "journal", "artifact", "task", "command", "url"]),
    ref: z.string().min(1),
    label: z.string().optional(),
  })).optional(),
  note: z.string().optional(),
});

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
  budgetUsd: z.number().positive().nullable().optional(),
  autonomy: z.enum(["standard", "away"]).optional(),
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
    // asker did not anticipate is to type in chat — which DISMISSES the card
    // rather than answering it.
    freeText: z.record(z.string(), z.string()).optional(),
    note: z.string().optional(),
  }),
  z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().optional(),
    // The operator's edited plan/spec text; on approval it becomes the
    // governing document.
    editedDocument: z.string().optional(),
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

  // Manual "resume now" for a capacity/budget pause — the operator raised
  // the budget, bought capacity, or knows the window reset early. The pause
  // is process-wide, so this delegates to the system switch (`:id` is not
  // consulted); kept for older clients, `POST /api/system/resume` is the
  // canonical route.
  app.post<{ Params: { id: string } }>(
    "/api/user-sessions/:id/resume-capacity",
    async () => {
      ctx.app.system.resume();
      return { resumed: true };
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

  // The full run-summary document behind a sign-off card's scalars.
  app.get<{ Params: { id: string; summaryId: string } }>(
    "/api/user-sessions/:id/run-summaries/:summaryId",
    async (request) =>
      // "tail" = the unsummarized end of the run, built on demand — always
      // readable, never persisted (statics beat params in fastify, but the
      // sentinel keeps it one route and one response shape).
      request.params.summaryId === "tail"
        ? ctx.app.completion.tailSummary(request.params.id)
        : ctx.app.completion.getSummary(request.params.id, request.params.summaryId),
  );

  // The living spec: revision history + the approved text that governs the run.
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/spec",
    async (request) => ({
      revisions: ctx.app.specs.listForUserSession(request.params.id),
      approved: ctx.app.specs.latestApproved(request.params.id) ?? null,
    }),
  );

  // The requirement graph: committed revisions, live nodes with derived
  // statuses, and the open-requirements frontier — the canonical spec.
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/requirements",
    async (request) => {
      const userSessionId = request.params.id;
      return {
        revisions: ctx.app.requirements.listRevisions(userSessionId).map(toRequirementRevisionWire),
        approved: mapOrNull(ctx.app.requirements.latestApproved(userSessionId), toRequirementRevisionWire),
        nodes: ctx.app.requirements.derive(userSessionId),
        frontier: ctx.app.requirements.frontier(userSessionId),
      };
    },
  );

  // The operator's own verdict on one requirement. Evidence is optional for
  // the operator alone — their word IS the gate, recorded as verifiedBy
  // "operator".
  app.post<{ Params: { id: string; requirementId: string } }>(
    "/api/user-sessions/:id/requirements/:requirementId/status",
    async (request) => {
      const parsed = RequirementStatusBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return ctx.app.requirements.reportStatus({
        userSessionId: request.params.id,
        requirementId: request.params.requirementId,
        to: parsed.data.status,
        evidence: (parsed.data.evidence ?? []) as EvidenceRef[],
        verifiedBy: "operator",
        actor: "operator",
        ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      });
    },
  );

  // The orchestration state: current working state, its history, and every
  // commission joined to its rationale and outcome — the review surface that
  // distinguishes good orchestration from lucky outcomes. Joins are by
  // stable id (buildCommissions), never by recency.
  app.get<{ Params: { id: string } }>(
    "/api/user-sessions/:id/orchestration",
    async (request) => {
      const userSessionId = request.params.id;
      return {
        current: ctx.app.orchestrationState.current(userSessionId) ?? null,
        revisions: ctx.app.orchestrationState.history(userSessionId),
        commissions: buildCommissions({ repo: ctx.app.repo, statusOf: (row) => ctx.app.host.statusOf(row) }, userSessionId),
      };
    },
  );

  app.post<{ Params: { id: string; interactionId: string } }>(
    "/api/user-sessions/:id/interactions/:interactionId",
    async (request, reply) => {
      const parsed = ResolveBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      // Requirement-marked approvals validate the operator's edited outline
      // BEFORE resolving: a parse failure returns the structured line errors
      // and leaves the card pending, so a bad edit can never eat an approval.
      if ("editedDocument" in parsed.data && parsed.data.editedDocument !== undefined && parsed.data.decision === "approve") {
        const interaction = ctx.app.interactions.get(request.params.interactionId);
        if ("requirements" in interaction.payload) {
          const validated = ctx.app.requirements.validateDocument(request.params.id, parsed.data.editedDocument);
          if (!validated.ok) {
            return reply.status(400).send({
              error: { code: "invalid_requirements", message: "the edited document does not parse as a requirement outline" },
              errors: validated.errors,
            });
          }
        }
      }
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
