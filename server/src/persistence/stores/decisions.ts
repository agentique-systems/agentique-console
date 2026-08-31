import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import {
  assertDecisionResolutionRules,
  budgetIncreasePermitted,
  ConflictError,
  decisionRequestSchema,
  decisionResolutionInputSchema,
  decisionSchema,
  InvariantViolationError,
  parseOrThrow,
  RUN_MACHINE,
  TOOL_CALL_MEDIA_TYPE,
  type ConversationId,
  type Decision,
  type DecisionId,
  type DecisionRequest,
  type DecisionResolutionInput,
  type DecisionSubject,
  type EventActor,
  type RunStatus,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, attempts, completionRequests, decisions, gates, invocations, planNodes, publications, requirements, runs, tasks } from "../schema.ts";
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
      subject: row.subject,
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
      if (valid.subject !== null) this.assertSubjectOwnership(valid.subject, valid.runId);
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

  /** The one `signoff` Decision of an `operator_signoff` Gate, or `null` before it was requested; at most one exists (a database unique index). */
  signoffOf(gateId: string): Decision | null {
    const row = this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "signoff"), eq(decisions.subjectGateId, gateId))).get();
    return row ? toDomain(row) : null;
  }

  /** Every `publish` Decision of a Run, in creation order. */
  publishDecisionsOf(runId: string): Decision[] {
    return this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "publish"), eq(decisions.runId, runId))).orderBy(asc(decisions.createdAt), asc(decisions.id)).all().map(toDomain);
  }

  /** The Run's one open `publish` Decision, or `null`; at most one exists (a database unique index). */
  openPublishOf(runId: string): Decision | null {
    const rows = this.publishDecisionsOf(runId).filter((d) => d.status === "open");
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} open publish Decisions`, { runId });
    return rows[0] ?? null;
  }

  /** Every `budget_increase` Decision of a Run, in creation order. */
  budgetIncreaseDecisionsOf(runId: string): Decision[] {
    return this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "budget_increase"), eq(decisions.runId, runId))).orderBy(asc(decisions.createdAt), asc(decisions.id)).all().map(toDomain);
  }

  /** The Run's one open `budget_increase` Decision, or `null`; at most one exists (a database unique index). */
  openBudgetIncreaseOf(runId: string): Decision | null {
    const rows = this.budgetIncreaseDecisionsOf(runId).filter((d) => d.status === "open");
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} open budget_increase Decisions`, { runId });
    return rows[0] ?? null;
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

  /**
   * A side-effect approval subject names the Run's own Plan Node, Invocation,
   * Attempt, and call Artifact, consistently; a signoff subject names the
   * Run's open `operator_signoff` Gate, the passed `run_completion` Gate and
   * `passed` Completion Request that Gate presents, and exactly the Gate's
   * verified Snapshot and final-report Artifact — and the Gate has no other
   * signoff Decision. A publish subject names exactly the completed Run's
   * Workspace, Target, final Snapshot, and final Changeset, and the Run has
   * no other open publish Decision, no nonterminal Publication, and no
   * succeeded Publication.
   */
  private assertSubjectOwnership(subject: DecisionSubject, runId: string | null): void {
    if (subject.runId !== runId) throw new InvariantViolationError(`Decision subject names Run ${subject.runId}, not ${String(runId)}`);
    if (subject.kind === "budget_increase") {
      // A budget_increase is requested for a nonterminal Run whose status admits the partition, and only one is open per Run.
      const run = requireRow(this.ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, subject.runId)).get(), "Run", subject.runId);
      if (RUN_MACHINE.isTerminal(run.status as RunStatus)) throw new ConflictError(`Run ${subject.runId} is ${run.status}; no Budget Increase is requested for a terminal Run`, { runId: subject.runId, status: run.status });
      if (!budgetIncreasePermitted(run.status as RunStatus, subject.partition)) {
        throw new ConflictError(`Run ${subject.runId} is ${run.status}; its ${subject.partition} partition cannot be increased now`, { runId: subject.runId, status: run.status, partition: subject.partition });
      }
      const open = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "budget_increase"), eq(decisions.runId, subject.runId), eq(decisions.status, "open"))).get();
      if (open) throw new ConflictError(`Run ${subject.runId} already has open budget_increase Decision ${open.id}`, { runId: subject.runId, decisionId: open.id });
      return;
    }
    if (subject.kind === "publish") {
      const run = requireRow(this.ctx.db.select({ status: runs.status, workspaceId: runs.workspaceId, target: runs.target, finalSnapshotId: runs.finalSnapshotId, finalChangesetId: runs.finalChangesetId }).from(runs).where(eq(runs.id, subject.runId)).get(), "Run", subject.runId);
      if (run.status !== "completed") throw new ConflictError(`Run ${subject.runId} is ${run.status}; a publish Decision is requested for a completed Run`, { runId: subject.runId, status: run.status });
      if (run.workspaceId !== subject.workspaceId || JSON.stringify(run.target) !== JSON.stringify(subject.target) || run.finalSnapshotId !== subject.finalSnapshotId || run.finalChangesetId !== subject.finalChangesetId) {
        throw new InvariantViolationError(`publish subject disagrees with the completed Run ${subject.runId}`, { runId: subject.runId });
      }
      const open = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "publish"), eq(decisions.runId, subject.runId), eq(decisions.status, "open"))).get();
      if (open) throw new ConflictError(`Run ${subject.runId} already has open publish Decision ${open.id}`, { runId: subject.runId, decisionId: open.id });
      const active = this.ctx.db.select({ id: publications.id, status: publications.status }).from(publications).where(and(eq(publications.runId, subject.runId), notInArray(publications.status, ["succeeded", "failed"]))).get();
      if (active) throw new ConflictError(`Run ${subject.runId} has nonterminal Publication ${active.id} (${active.status})`, { runId: subject.runId, publicationId: active.id });
      const succeeded = this.ctx.db.select({ id: publications.id }).from(publications).where(and(eq(publications.runId, subject.runId), eq(publications.status, "succeeded"))).get();
      if (succeeded) throw new ConflictError(`Run ${subject.runId} was published by Publication ${succeeded.id}; a succeeded Run is never published again`, { runId: subject.runId, publicationId: succeeded.id });
      return;
    }
    if (subject.kind === "signoff") {
      const gate = requireRow(this.ctx.db.select({ runId: gates.runId, kind: gates.kind, status: gates.status, completionRequestId: gates.completionRequestId, completionGateId: gates.completionGateId, snapshotId: gates.snapshotId, reportArtifactId: gates.reportArtifactId }).from(gates).where(eq(gates.id, subject.gateId)).get(), "Gate", subject.gateId);
      if (gate.runId !== subject.runId || gate.kind !== "operator_signoff") throw new InvariantViolationError(`Gate ${subject.gateId} is not an operator_signoff Gate of Run ${subject.runId}`, { gateId: subject.gateId });
      if (gate.status !== "open") throw new ConflictError(`Gate ${subject.gateId} is ${gate.status}; a signoff Decision is requested for an open Gate`, { gateId: subject.gateId });
      if (gate.completionGateId !== subject.completionGateId || gate.completionRequestId !== subject.completionRequestId || gate.snapshotId !== subject.snapshotId || gate.reportArtifactId !== subject.reportArtifactId) {
        throw new InvariantViolationError(`signoff subject disagrees with the facts of Gate ${subject.gateId}`, { gateId: subject.gateId });
      }
      const request = requireRow(this.ctx.db.select({ status: completionRequests.status, gateId: completionRequests.gateId }).from(completionRequests).where(eq(completionRequests.id, subject.completionRequestId)).get(), "CompletionRequest", subject.completionRequestId);
      if (request.status !== "passed" || request.gateId !== subject.completionGateId) throw new InvariantViolationError(`Completion Request ${subject.completionRequestId} has not passed on Gate ${subject.completionGateId}`, { completionRequestId: subject.completionRequestId });
      const existing = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "signoff"), eq(decisions.subjectGateId, subject.gateId))).get();
      if (existing) throw new ConflictError(`Gate ${subject.gateId} already has signoff Decision ${existing.id}`, { gateId: subject.gateId, decisionId: existing.id });
      return;
    }
    const node = requireRow(this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, subject.planNodeId)).get(), "PlanNode", subject.planNodeId);
    if (node.runId !== subject.runId) throw new InvariantViolationError(`PlanNode ${subject.planNodeId} belongs to another Run`);
    const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId }).from(invocations).where(eq(invocations.id, subject.invocationId)).get(), "Invocation", subject.invocationId);
    if (invocation.runId !== subject.runId || invocation.planNodeId !== subject.planNodeId) throw new InvariantViolationError(`Invocation ${subject.invocationId} does not belong to PlanNode ${subject.planNodeId} of Run ${subject.runId}`);
    const attempt = requireRow(this.ctx.db.select({ invocationId: attempts.invocationId }).from(attempts).where(eq(attempts.id, subject.attemptId)).get(), "Attempt", subject.attemptId);
    if (attempt.invocationId !== subject.invocationId) throw new InvariantViolationError(`Attempt ${subject.attemptId} does not belong to Invocation ${subject.invocationId}`);
    const artifact = requireRow(this.ctx.db.select({ runId: artifacts.runId, digest: artifacts.digest, mediaType: artifacts.mediaType }).from(artifacts).where(eq(artifacts.id, subject.callArtifactId)).get(), "Artifact", subject.callArtifactId);
    if (artifact.runId !== subject.runId) throw new InvariantViolationError(`Artifact ${subject.callArtifactId} belongs to another Run`);
    if (artifact.digest !== subject.callDigest || artifact.mediaType !== TOOL_CALL_MEDIA_TYPE) {
      throw new InvariantViolationError(`Artifact ${subject.callArtifactId} is not the canonical call the subject names`, { digest: artifact.digest, mediaType: artifact.mediaType });
    }
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

  private toRow(decision: Decision): typeof decisions.$inferInsert {
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
      subject: decision.subject,
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
