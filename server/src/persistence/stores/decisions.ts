import { and, asc, eq, inArray } from "drizzle-orm";
import {
  assertDecisionResolutionRules,
  ConflictError,
  decisionRequestSchema,
  decisionResolutionInputSchema,
  decisionSchema,
  parseOrThrow,
  type ConversationId,
  type Decision,
  type DecisionId,
  type DecisionRequest,
  type DecisionResolutionInput,
  type EventActor,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { decisions, planNodes, requirements, runs, tasks } from "../schema.ts";
import { assertSameConversation, conversationScope, loadConversationRef, OPERATOR_ACTOR, requireRow, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof decisions.$inferSelect;

function toDomain(row: Row): Decision {
  return parseOrThrow(
    decisionSchema,
    {
      id: row.id,
      conversationId: row.conversationId,
      runId: row.runId,
      kind: row.kind,
      resolutionPolicy: row.resolutionPolicy,
      status: row.status,
      requestedBy: row.requestedBy,
      question: row.question,
      options: row.options,
      recommendedOptionId: row.recommendedOptionId,
      rationale: row.rationale,
      affects: row.affects,
      deadlineAt: row.deadlineAt,
      activationCondition: row.activationCondition,
      resolution:
        row.resolvedBy === null
          ? null
          : {
              resolvedBy: row.resolvedBy,
              chosenOptionId: row.chosenOptionId,
              rationale: row.resolutionRationale,
              artifactIds: row.resolutionArtifactIds ?? [],
              resolvedAt: row.resolvedAt,
            },
      supersedesDecisionId: row.supersedesDecisionId,
      supersededByDecisionId: row.supersededByDecisionId,
      createdAt: row.createdAt,
    },
    "Decision row",
  );
}

function actorFor(resolvedBy: DecisionResolutionInput["resolvedBy"], decision: Decision): EventActor {
  if (resolvedBy === "operator") return OPERATOR_ACTOR;
  if (resolvedBy === "policy:use_default_after_deadline") return { kind: "policy", policy: "use_default_after_deadline" };
  return decision.requestedBy.kind === "invocation" ? { kind: "invocation", invocationId: decision.requestedBy.invocationId } : { kind: "runtime" };
}

/**
 * Decisions are append-only: a request creates one; a resolution is recorded
 * once and always writes `decision.resolved`; a later Decision may supersede
 * an earlier one by id, which is recorded on both rows.
 */
export class DecisionStore {
  constructor(private readonly ctx: PersistenceContext) {}

  request(input: DecisionRequest, options?: WriteOptions): Decision {
    const valid = parseOrThrow(decisionRequestSchema, input, "Decision request");
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, valid.conversationId);
      if (valid.runId !== null) {
        const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, valid.runId)).get(), "Run", valid.runId);
        assertSameConversation("Run", valid.runId, run.conversationId, conversation.id);
      }
      this.assertAffectsOwnership(valid, conversation.id);
      const decision: Decision = {
        id: this.ctx.ids("decision"),
        ...valid,
        status: "open",
        resolution: null,
        supersededByDecisionId: null,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(decisionSchema, decision, "Decision");
      this.ctx.journal.append({
        type: "decision.requested",
        scope: conversationScope(conversation, { runId: valid.runId }),
        subjectType: "decision",
        subjectId: decision.id,
        payload: decision,
        ...writeMeta(options, valid.requestedBy.kind === "invocation" ? { kind: "invocation", invocationId: valid.requestedBy.invocationId } : valid.requestedBy.kind === "operator" ? OPERATOR_ACTOR : undefined),
      });
      this.ctx.db.insert(decisions).values(this.toRow(decision)).run();
      if (valid.supersedesDecisionId !== null) {
        const superseded = this.get(valid.supersedesDecisionId);
        assertSameConversation("Decision", superseded.id, superseded.conversationId, conversation.id);
        if (superseded.status === "superseded") throw new ConflictError(`Decision ${superseded.id} is already superseded`);
        this.ctx.journal.append({
          type: "decision.superseded",
          scope: conversationScope(conversation, { runId: superseded.runId }),
          subjectType: "decision",
          subjectId: superseded.id,
          payload: { decisionId: superseded.id, supersededByDecisionId: decision.id },
          ...writeMeta(options),
        });
        this.ctx.db.update(decisions).set({ status: "superseded", supersededByDecisionId: decision.id }).where(eq(decisions.id, superseded.id)).run();
      }
      return decision;
    });
  }

  get(id: DecisionId): Decision {
    return toDomain(requireRow(this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get(), "Decision", id));
  }

  listByConversation(conversationId: ConversationId): Decision[] {
    return this.ctx.db.select().from(decisions).where(eq(decisions.conversationId, conversationId)).orderBy(asc(decisions.createdAt)).all().map(toDomain);
  }

  listOpen(conversationId: ConversationId): Decision[] {
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.conversationId, conversationId), eq(decisions.status, "open")))
      .orderBy(asc(decisions.createdAt))
      .all()
      .map(toDomain);
  }

  /** Resolves an open Decision once; who may resolve what is enforced by the core rules. */
  resolve(id: DecisionId, input: DecisionResolutionInput, options?: WriteOptions): Decision {
    const resolution = parseOrThrow(decisionResolutionInputSchema, input, "Decision resolution");
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      assertDecisionResolutionRules(current, resolution);
      const conversation = loadConversationRef(this.ctx, current.conversationId);
      const resolved: Decision = {
        ...current,
        status: "resolved",
        resolution: { ...resolution, resolvedAt: this.ctx.clock() },
      };
      parseOrThrow(decisionSchema, resolved, "Decision");
      this.ctx.journal.append({
        type: "decision.resolved",
        scope: conversationScope(conversation, { runId: current.runId }),
        subjectType: "decision",
        subjectId: id,
        payload: { decisionId: id, kind: current.kind, resolution: resolved.resolution as NonNullable<Decision["resolution"]> },
        ...writeMeta(options, actorFor(resolution.resolvedBy, current)),
      });
      // Only resolution columns are written; the request columns are guarded as immutable.
      this.ctx.db
        .update(decisions)
        .set({
          status: "resolved",
          resolvedBy: resolution.resolvedBy,
          chosenOptionId: resolution.chosenOptionId,
          resolutionRationale: resolution.rationale,
          resolutionArtifactIds: resolution.artifactIds,
          resolvedAt: resolved.resolution?.resolvedAt ?? null,
        })
        .where(eq(decisions.id, id))
        .run();
      return resolved;
    });
  }

  private assertAffectsOwnership(request: DecisionRequest, conversationId: string): void {
    const { requirementIds, taskIds, planNodeIds } = request.affects;
    if (requirementIds.length > 0) {
      const rows = this.ctx.db.select({ id: requirements.id, conversationId: requirements.conversationId }).from(requirements).where(inArray(requirements.id, requirementIds)).all();
      for (const id of requirementIds) {
        const row = requireRow(rows.find((r) => r.id === id), "Requirement", id);
        assertSameConversation("Requirement", id, row.conversationId, conversationId);
      }
    }
    const runIds = new Set<string>();
    if (taskIds.length > 0) {
      const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, taskIds)).all();
      for (const id of taskIds) runIds.add(requireRow(rows.find((r) => r.id === id), "Task", id).runId);
    }
    if (planNodeIds.length > 0) {
      const rows = this.ctx.db.select({ id: planNodes.id, runId: planNodes.runId }).from(planNodes).where(inArray(planNodes.id, planNodeIds)).all();
      for (const id of planNodeIds) runIds.add(requireRow(rows.find((r) => r.id === id), "PlanNode", id).runId);
    }
    for (const runId of runIds) {
      const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId)).get(), "Run", runId);
      assertSameConversation("Run", runId, run.conversationId, conversationId);
    }
  }

  private toRow(decision: Decision): Row {
    return {
      id: decision.id,
      conversationId: decision.conversationId,
      runId: decision.runId,
      kind: decision.kind,
      resolutionPolicy: decision.resolutionPolicy,
      status: decision.status,
      requestedBy: decision.requestedBy,
      question: decision.question,
      options: decision.options,
      recommendedOptionId: decision.recommendedOptionId,
      rationale: decision.rationale,
      affects: decision.affects,
      deadlineAt: decision.deadlineAt,
      activationCondition: decision.activationCondition,
      resolvedBy: decision.resolution?.resolvedBy ?? null,
      chosenOptionId: decision.resolution?.chosenOptionId ?? null,
      resolutionRationale: decision.resolution?.rationale ?? null,
      resolutionArtifactIds: decision.resolution?.artifactIds ?? null,
      resolvedAt: decision.resolution?.resolvedAt ?? null,
      supersedesDecisionId: decision.supersedesDecisionId,
      supersededByDecisionId: decision.supersededByDecisionId,
      createdAt: decision.createdAt,
    };
  }
}
