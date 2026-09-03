import { and, asc, eq } from "drizzle-orm";
import {
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  signoffResolutionInputSchema,
  signoffResolutionSchema,
  signoffSubjectOf,
  type ConversationMessageId,
  type DecisionId,
  type GateId,
  type InvocationId,
  type RunId,
  type SignoffResolution,
  type SignoffResolutionId,
  type SignoffResolutionInput,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { changesets, conversationMessages, decisions, gates, invocations, planNodes, signoffResolutions } from "../schema.ts";
import { assertSameRun, loadRunRef, OPERATOR_ACTOR, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof signoffResolutions.$inferSelect;

function toDomain(row: Row): SignoffResolution {
  return parseOrThrow(signoffResolutionSchema, row, "SignoffResolution row");
}

/**
 * Signoff Resolutions (execution-model §10 `operator_signoff`): the
 * append-only record of the operator's one resolution of an
 * `operator_signoff` Gate. `record` admits exactly one resolution per Gate
 * and per `signoff` Decision, only while both are open and reference each
 * other canonically; an `accept` names the Run's `final` Changeset ending at
 * the Gate's verified Snapshot, a `request_changes` names an operator
 * message of the Run's Conversation that no other resolution answered.
 * `link` records the one follow-up Orchestrator Invocation of a
 * `request_changes` resolution, once. Identity and outcome never change and
 * rows are never deleted; the database holds every rule as well (unique
 * indexes and triggers).
 */
export class SignoffResolutionStore {
  constructor(private readonly ctx: PersistenceContext) {}

  record(input: SignoffResolutionInput, options?: WriteOptions & { id?: SignoffResolutionId }): SignoffResolution {
    const valid = parseOrThrow(signoffResolutionInputSchema, input, "SignoffResolution input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      const gate = requireRow(this.ctx.db.select({ runId: gates.runId, kind: gates.kind, status: gates.status, snapshotId: gates.snapshotId }).from(gates).where(eq(gates.id, valid.gateId)).get(), "Gate", valid.gateId);
      assertSameRun("Gate", valid.gateId, gate.runId, run.id);
      if (gate.kind !== "operator_signoff") throw new InvariantViolationError(`Gate ${valid.gateId} is a ${gate.kind} Gate; a Signoff Resolution resolves an operator_signoff Gate`, { gateId: valid.gateId });
      if (gate.status !== "open") throw new ConflictError(`Gate ${valid.gateId} is ${gate.status}; a Signoff Resolution is recorded while the Gate is open`, { gateId: valid.gateId });
      const decisionRow = requireRow(this.ctx.db.select().from(decisions).where(eq(decisions.id, valid.decisionId)).get(), "Decision", valid.decisionId);
      if (decisionRow.runId !== run.id || decisionRow.conversationId !== run.conversationId) throw new InvariantViolationError(`Decision ${valid.decisionId} does not belong to Run ${run.id}`, { decisionId: valid.decisionId });
      if (decisionRow.kind !== "signoff") throw new InvariantViolationError(`Decision ${valid.decisionId} is a ${decisionRow.kind} Decision, not a signoff`, { decisionId: valid.decisionId });
      if (decisionRow.status !== "open") throw new ConflictError(`Decision ${valid.decisionId} is ${decisionRow.status}; a Signoff Resolution is recorded while the Decision is open`, { decisionId: valid.decisionId });
      const subject = signoffSubjectOf({ id: valid.decisionId, kind: decisionRow.kind, subject: decisionRow.subject });
      if (subject.gateId !== valid.gateId) throw new InvariantViolationError(`Decision ${valid.decisionId} resolves Gate ${subject.gateId}, not ${valid.gateId}`, { decisionId: valid.decisionId, gateId: valid.gateId });
      if (this.byGate(valid.gateId) !== null || this.byDecision(valid.decisionId) !== null) throw new ConflictError(`Gate ${valid.gateId} is already resolved`, { gateId: valid.gateId });
      if (valid.outcome === "accept") {
        const changeset = requireRow(this.ctx.db.select({ runId: changesets.runId, kind: changesets.kind, afterSnapshotId: changesets.afterSnapshotId }).from(changesets).where(eq(changesets.id, valid.finalChangesetId)).get(), "Changeset", valid.finalChangesetId);
        assertSameRun("Changeset", valid.finalChangesetId, changeset.runId, run.id);
        if (changeset.kind !== "final") throw new InvariantViolationError(`Changeset ${valid.finalChangesetId} is not the Run's final Changeset`, { changesetId: valid.finalChangesetId });
        if (changeset.afterSnapshotId !== gate.snapshotId) throw new InvariantViolationError(`final Changeset ${valid.finalChangesetId} ends at Snapshot ${changeset.afterSnapshotId}, not the verified Snapshot ${gate.snapshotId} of Gate ${valid.gateId}`, { changesetId: valid.finalChangesetId, gateId: valid.gateId });
      } else {
        const message = requireRow(this.ctx.db.select({ conversationId: conversationMessages.conversationId, runId: conversationMessages.runId, author: conversationMessages.author }).from(conversationMessages).where(eq(conversationMessages.id, valid.operatorMessageId)).get(), "ConversationMessage", valid.operatorMessageId);
        if (message.conversationId !== run.conversationId) throw new InvariantViolationError(`ConversationMessage ${valid.operatorMessageId} belongs to another Conversation`, { operatorMessageId: valid.operatorMessageId });
        if (message.runId !== null && message.runId !== run.id) throw new InvariantViolationError(`ConversationMessage ${valid.operatorMessageId} was posted in another Run`, { operatorMessageId: valid.operatorMessageId });
        if (message.author !== "operator") throw new InvariantViolationError(`ConversationMessage ${valid.operatorMessageId} is not an operator message`, { operatorMessageId: valid.operatorMessageId });
        const consumed = this.ctx.db.select({ id: signoffResolutions.id }).from(signoffResolutions).where(eq(signoffResolutions.operatorMessageId, valid.operatorMessageId)).get();
        if (consumed !== undefined) throw new ConflictError(`ConversationMessage ${valid.operatorMessageId} already answered Signoff Resolution ${consumed.id}`, { operatorMessageId: valid.operatorMessageId, signoffResolutionId: consumed.id });
      }
      const resolution: SignoffResolution = {
        id: options?.id ?? this.ctx.ids("signoffResolution"),
        runId: run.id,
        gateId: valid.gateId,
        decisionId: valid.decisionId,
        outcome: valid.outcome,
        operatorMessageId: valid.outcome === "request_changes" ? valid.operatorMessageId : null,
        finalChangesetId: valid.outcome === "accept" ? valid.finalChangesetId : null,
        followUpInvocationId: null,
        resolvedAt: this.ctx.clock(),
      };
      parseOrThrow(signoffResolutionSchema, resolution, "SignoffResolution");
      this.ctx.journal.append({
        type: "signoff_resolution.recorded",
        scope: runScope(run),
        subjectType: "signoff_resolution",
        subjectId: resolution.id,
        payload: resolution,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.insert(signoffResolutions).values(resolution).run();
      return resolution;
    });
  }

  /**
   * Records the one follow-up Invocation of a `request_changes` resolution:
   * a root `decision_resolution` Orchestrator Invocation of the Run; set
   * once (the database refuses a second link).
   */
  link(id: SignoffResolutionId, followUpInvocationId: InvocationId, options?: WriteOptions): SignoffResolution {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.outcome !== "request_changes") throw new ConflictError(`Signoff Resolution ${id} is an ${current.outcome} resolution; only request_changes prepares a follow-up Invocation`, { signoffResolutionId: id });
      if (current.followUpInvocationId !== null) throw new ConflictError(`Signoff Resolution ${id} already prepared follow-up Invocation ${current.followUpInvocationId}`, { signoffResolutionId: id, followUpInvocationId: current.followUpInvocationId });
      const run = loadRunRef(this.ctx, current.runId);
      const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, role: invocations.role, purpose: invocations.purpose, planNodeId: invocations.planNodeId }).from(invocations).where(eq(invocations.id, followUpInvocationId)).get(), "Invocation", followUpInvocationId);
      assertSameRun("Invocation", followUpInvocationId, invocation.runId, run.id);
      if (invocation.role !== "orchestrator" || invocation.purpose !== "decision_resolution") throw new InvariantViolationError(`Invocation ${followUpInvocationId} (${invocation.role}/${invocation.purpose}) is not a root decision_resolution Orchestrator turn`, { followUpInvocationId });
      const node = requireRow(this.ctx.db.select({ sourcePath: planNodes.sourcePath }).from(planNodes).where(eq(planNodes.id, invocation.planNodeId)).get(), "PlanNode", invocation.planNodeId);
      if (node.sourcePath !== "root") throw new InvariantViolationError(`Invocation ${followUpInvocationId} does not belong to the root Plan Node`, { followUpInvocationId });
      const linked: SignoffResolution = { ...current, followUpInvocationId };
      parseOrThrow(signoffResolutionSchema, linked, "SignoffResolution");
      this.ctx.journal.append({
        type: "signoff_resolution.linked",
        scope: runScope(run, { invocationId: followUpInvocationId }),
        subjectType: "signoff_resolution",
        subjectId: id,
        payload: { signoffResolutionId: id, followUpInvocationId },
        ...writeMeta(options),
      });
      this.ctx.db.update(signoffResolutions).set({ followUpInvocationId }).where(eq(signoffResolutions.id, id)).run();
      return linked;
    });
  }

  get(id: SignoffResolutionId): SignoffResolution {
    return toDomain(requireRow(this.ctx.db.select().from(signoffResolutions).where(eq(signoffResolutions.id, id)).get(), "SignoffResolution", id));
  }

  /** The resolution of an `operator_signoff` Gate, or `null` while it is open; at most one exists (a database unique index). */
  byGate(gateId: GateId): SignoffResolution | null {
    const row = this.ctx.db.select().from(signoffResolutions).where(eq(signoffResolutions.gateId, gateId)).get();
    return row ? toDomain(row) : null;
  }

  /** The resolution of a `signoff` Decision, or `null` while it is open; at most one exists (a database unique index). */
  byDecision(decisionId: DecisionId): SignoffResolution | null {
    const row = this.ctx.db.select().from(signoffResolutions).where(eq(signoffResolutions.decisionId, decisionId)).get();
    return row ? toDomain(row) : null;
  }

  /** The `request_changes` resolution an operator message answered, or `null`; a message answers at most one (a database unique index). */
  byOperatorMessage(operatorMessageId: ConversationMessageId): SignoffResolution | null {
    const row = this.ctx.db.select().from(signoffResolutions).where(eq(signoffResolutions.operatorMessageId, operatorMessageId)).get();
    return row ? toDomain(row) : null;
  }

  /** The resolution a follow-up Invocation continues, or `null`. */
  byFollowUp(invocationId: InvocationId): SignoffResolution | null {
    const row = this.ctx.db.select().from(signoffResolutions).where(and(eq(signoffResolutions.followUpInvocationId, invocationId))).get();
    return row ? toDomain(row) : null;
  }

  /** Every resolution of a Run, in resolution order. */
  listByRun(runId: RunId): SignoffResolution[] {
    return this.ctx.db.select().from(signoffResolutions).where(eq(signoffResolutions.runId, runId)).orderBy(asc(signoffResolutions.resolvedAt), asc(signoffResolutions.id)).all().map(toDomain);
  }
}
