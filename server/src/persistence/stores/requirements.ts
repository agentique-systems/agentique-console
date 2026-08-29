import { and, asc, eq } from "drizzle-orm";
import {
  acceptanceCriterionSchema,
  assertRequirementStatusChangeRules,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  REQUIREMENT_MACHINE,
  requirementRevisionSchema,
  requirementSchema,
  requirementStatusChangeInputSchema,
  requirementTreeSchema,
  ValidationError,
  type AcceptanceCheck,
  type AcceptanceCriterion,
  type AcceptanceCriterionId,
  type ConversationId,
  type DecisionId,
  type Requirement,
  type RequirementId,
  type RequirementRevision,
  type RequirementRevisionId,
  type RequirementStatusChange,
  type RequirementStatusChangeInput,
  type RequirementTreeEntry,
  type TaskId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { acceptanceCriteria, decisions, gates, requirementRevisions, requirementStatusChanges, requirements, runs, tasks } from "../schema.ts";
import {
  assertSameConversation,
  conversationScope,
  loadConversationRef,
  OPERATOR_ACTOR,
  requireRow,
  RUNTIME_ACTOR,
  writeMeta,
  type WriteOptions,
} from "./support.ts";

function toDomain(row: typeof requirements.$inferSelect): Requirement {
  return parseOrThrow(requirementSchema, row, "Requirement row");
}

function revisionToDomain(row: typeof requirementRevisions.$inferSelect): RequirementRevision {
  return parseOrThrow(requirementRevisionSchema, row, "RequirementRevision row");
}

function changeToDomain(row: typeof requirementStatusChanges.$inferSelect): RequirementStatusChange {
  return {
    seq: row.seq,
    requirementId: row.requirementId as RequirementId,
    conversationId: row.conversationId as ConversationId,
    runId: row.runId as RequirementStatusChange["runId"],
    from: row.fromStatus as RequirementStatusChange["from"],
    to: row.toStatus as RequirementStatusChange["to"],
    actor: row.actor as RequirementStatusChange["actor"],
    evidence: row.evidence,
    gateId: row.gateId as RequirementStatusChange["gateId"],
    decisionId: row.decisionId as RequirementStatusChange["decisionId"],
    rationale: row.rationale,
    createdAt: row.createdAt,
  };
}

function criterionToDomain(row: typeof acceptanceCriteria.$inferSelect): AcceptanceCriterion {
  return parseOrThrow(
    acceptanceCriterionSchema,
    {
      id: row.id,
      conversationId: row.conversationId,
      requirementId: row.requirementId,
      requirementRevisionId: row.requirementRevisionId,
      taskId: row.taskId,
      check: row.check,
      createdAt: row.createdAt,
    },
    "AcceptanceCriterion row",
  );
}

export interface RequirementRevisionInput {
  conversationId: ConversationId;
  tree: RequirementTreeEntry[];
  approvedByDecisionId: DecisionId | null;
}

export interface AcceptanceCriterionInput {
  conversationId: ConversationId;
  requirementId: RequirementId | null;
  requirementRevisionId: RequirementRevisionId | null;
  taskId: TaskId | null;
  check: AcceptanceCheck;
}

/**
 * Requirement revisions (immutable tree snapshots per Conversation), the
 * per-Requirement current status, the append-only status history with
 * Evidence, and Acceptance Criteria. `satisfied` is reachable only by the
 * runtime from a Gate; `waived` only by the operator through a resolved
 * `requirement_waiver` Decision.
 */
export class RequirementStore {
  constructor(private readonly ctx: PersistenceContext) {}

  createRevision(input: RequirementRevisionInput, options?: WriteOptions): RequirementRevision {
    const tree = parseOrThrow(requirementTreeSchema, input.tree, "Requirement tree");
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, input.conversationId);
      if (input.approvedByDecisionId !== null) {
        const decision = requireRow(
          this.ctx.db.select({ conversationId: decisions.conversationId, status: decisions.status }).from(decisions).where(eq(decisions.id, input.approvedByDecisionId)).get(),
          "Decision",
          input.approvedByDecisionId,
        );
        assertSameConversation("Decision", input.approvedByDecisionId, decision.conversationId, conversation.id);
        if (decision.status !== "resolved") throw new ConflictError(`approving Decision ${input.approvedByDecisionId} is not resolved`);
      }
      const last = this.currentRevision(conversation.id);
      const now = this.ctx.clock();
      const revision: RequirementRevision = {
        id: this.ctx.ids("requirementRevision"),
        conversationId: conversation.id,
        number: (last?.number ?? 0) + 1,
        approvedByDecisionId: input.approvedByDecisionId,
        tree,
        createdAt: now,
      };
      this.ctx.journal.append({
        type: "requirement_revision.created",
        scope: conversationScope(conversation),
        subjectType: "requirement_revision",
        subjectId: revision.id,
        payload: revision,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.insert(requirementRevisions).values(revision).run();

      const existing = new Map(this.listByConversation(conversation.id).map((r) => [r.id, r] as const));
      for (const entry of tree) {
        const current = existing.get(entry.id);
        if (current) {
          if (current.status === "retired") {
            throw new ValidationError(`Requirement ${entry.id} is retired and cannot reappear in a revision`);
          }
          continue;
        }
        const requirement: Requirement = {
          id: entry.id,
          conversationId: conversation.id,
          status: "open",
          createdInRevisionId: revision.id,
          retiredInRevisionId: null,
          createdAt: now,
          updatedAt: now,
        };
        this.ctx.journal.append({
          type: "requirement.created",
          scope: conversationScope(conversation),
          subjectType: "requirement",
          subjectId: requirement.id,
          payload: { requirementId: requirement.id, requirementRevisionId: revision.id },
          ...writeMeta(options, OPERATOR_ACTOR),
        });
        this.ctx.db.insert(requirements).values(requirement).run();
      }
      const inTree = new Set(tree.map((e) => e.id));
      for (const requirement of existing.values()) {
        if (!inTree.has(requirement.id) && requirement.status !== "retired") {
          this.recordStatusChange(
            { requirementId: requirement.id, runId: null, to: "retired", actor: "runtime", evidence: [], gateId: null, decisionId: null, rationale: `removed in revision ${revision.number}` },
            { ...options, retiredInRevisionId: revision.id },
          );
        }
      }
      return revision;
    });
  }

  getRevision(id: RequirementRevisionId): RequirementRevision {
    return revisionToDomain(requireRow(this.ctx.db.select().from(requirementRevisions).where(eq(requirementRevisions.id, id)).get(), "RequirementRevision", id));
  }

  currentRevision(conversationId: ConversationId): RequirementRevision | null {
    const row = this.ctx.db
      .select()
      .from(requirementRevisions)
      .where(eq(requirementRevisions.conversationId, conversationId))
      .orderBy(asc(requirementRevisions.number))
      .all()
      .at(-1);
    return row ? revisionToDomain(row) : null;
  }

  get(id: RequirementId): Requirement {
    return toDomain(requireRow(this.ctx.db.select().from(requirements).where(eq(requirements.id, id)).get(), "Requirement", id));
  }

  listByConversation(conversationId: ConversationId): Requirement[] {
    return this.ctx.db.select().from(requirements).where(eq(requirements.conversationId, conversationId)).all().map(toDomain);
  }

  history(requirementId: RequirementId): RequirementStatusChange[] {
    return this.ctx.db
      .select()
      .from(requirementStatusChanges)
      .where(eq(requirementStatusChanges.requirementId, requirementId))
      .orderBy(asc(requirementStatusChanges.seq))
      .all()
      .map(changeToDomain);
  }

  /**
   * Records one status change: validates the domain rules, the transition
   * table, and — for `waived` — that the named Decision is a resolved,
   * operator-resolved `requirement_waiver` naming this Requirement; for
   * `satisfied`, that the Gate exists in a Run of this Conversation.
   */
  recordStatusChange(input: RequirementStatusChangeInput, options?: WriteOptions & { retiredInRevisionId?: RequirementRevisionId }): RequirementStatusChange {
    const valid = parseOrThrow(requirementStatusChangeInputSchema, input, "Requirement status change");
    assertRequirementStatusChangeRules(valid);
    return this.ctx.tx.write(() => {
      const current = this.get(valid.requirementId);
      REQUIREMENT_MACHINE.assertTransition(current.status, valid.to, { requirementId: valid.requirementId });
      const conversation = loadConversationRef(this.ctx, current.conversationId);
      if (valid.runId !== null) {
        const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, valid.runId)).get(), "Run", valid.runId);
        assertSameConversation("Run", valid.runId, run.conversationId, conversation.id);
      }
      if (valid.to === "waived") this.assertOperatorWaiver(valid.decisionId as DecisionId, current);
      if (valid.gateId !== null) {
        const gate = requireRow(this.ctx.db.select({ runId: gates.runId }).from(gates).where(eq(gates.id, valid.gateId)).get(), "Gate", valid.gateId);
        const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, gate.runId)).get(), "Run", gate.runId);
        assertSameConversation("Gate", valid.gateId, run.conversationId, conversation.id);
      }
      if (valid.to === "retired" && !options?.retiredInRevisionId) {
        throw new InvariantViolationError("retired is reached only through a Requirement revision that removes the Requirement");
      }
      const now = this.ctx.clock();
      this.ctx.journal.append({
        type: "requirement.status_changed",
        scope: conversationScope(conversation, { runId: valid.runId }),
        subjectType: "requirement",
        subjectId: valid.requirementId,
        payload: {
          requirementId: valid.requirementId,
          from: current.status,
          to: valid.to,
          actor: valid.actor,
          evidence: valid.evidence,
          gateId: valid.gateId,
          decisionId: valid.decisionId,
        },
        ...writeMeta(options, valid.actor === "operator" ? OPERATOR_ACTOR : RUNTIME_ACTOR),
      });
      const inserted = this.ctx.db
        .insert(requirementStatusChanges)
        .values({
          requirementId: valid.requirementId,
          conversationId: conversation.id,
          runId: valid.runId,
          fromStatus: current.status,
          toStatus: valid.to,
          actor: valid.actor,
          evidence: valid.evidence,
          gateId: valid.gateId,
          decisionId: valid.decisionId,
          rationale: valid.rationale,
          createdAt: now,
        })
        .returning()
        .get();
      this.ctx.db
        .update(requirements)
        .set({ status: valid.to, updatedAt: now, retiredInRevisionId: valid.to === "retired" ? (options?.retiredInRevisionId ?? null) : null })
        .where(eq(requirements.id, valid.requirementId))
        .run();
      return changeToDomain(inserted);
    });
  }

  createAcceptanceCriterion(input: AcceptanceCriterionInput, options?: WriteOptions): AcceptanceCriterion {
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, input.conversationId);
      if (input.requirementId !== null) {
        const requirement = this.get(input.requirementId);
        assertSameConversation("Requirement", input.requirementId, requirement.conversationId, conversation.id);
        if (input.requirementRevisionId === null) throw new ValidationError("a Requirement criterion is pinned to a revision");
        const revision = this.getRevision(input.requirementRevisionId);
        assertSameConversation("RequirementRevision", input.requirementRevisionId, revision.conversationId, conversation.id);
      }
      if (input.taskId !== null) {
        const task = requireRow(this.ctx.db.select({ runId: tasks.runId }).from(tasks).where(eq(tasks.id, input.taskId)).get(), "Task", input.taskId);
        const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, task.runId)).get(), "Run", task.runId);
        assertSameConversation("Task", input.taskId, run.conversationId, conversation.id);
      }
      const criterion: AcceptanceCriterion = {
        id: this.ctx.ids("acceptanceCriterion"),
        conversationId: conversation.id,
        requirementId: input.requirementId,
        requirementRevisionId: input.requirementRevisionId,
        taskId: input.taskId,
        check: input.check,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(acceptanceCriterionSchema, criterion, "AcceptanceCriterion");
      this.ctx.journal.append({
        type: "acceptance_criterion.created",
        scope: conversationScope(conversation),
        subjectType: "acceptance_criterion",
        subjectId: criterion.id,
        payload: criterion,
        ...writeMeta(options),
      });
      this.ctx.db
        .insert(acceptanceCriteria)
        .values({
          id: criterion.id,
          conversationId: criterion.conversationId,
          requirementId: criterion.requirementId,
          requirementRevisionId: criterion.requirementRevisionId,
          taskId: criterion.taskId,
          kind: criterion.check.kind,
          check: criterion.check as unknown as Record<string, unknown>,
          createdAt: criterion.createdAt,
        })
        .run();
      return criterion;
    });
  }

  getAcceptanceCriterion(id: AcceptanceCriterionId): AcceptanceCriterion {
    return criterionToDomain(requireRow(this.ctx.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.id, id)).get(), "AcceptanceCriterion", id));
  }

  listAcceptanceCriteria(owner: { requirementId: RequirementId } | { taskId: TaskId }): AcceptanceCriterion[] {
    const condition = "requirementId" in owner ? eq(acceptanceCriteria.requirementId, owner.requirementId) : eq(acceptanceCriteria.taskId, owner.taskId);
    return this.ctx.db.select().from(acceptanceCriteria).where(and(condition)).orderBy(asc(acceptanceCriteria.createdAt)).all().map(criterionToDomain);
  }

  private assertOperatorWaiver(decisionId: DecisionId, requirement: Requirement): void {
    const decision = requireRow(
      this.ctx.db
        .select({ conversationId: decisions.conversationId, kind: decisions.kind, status: decisions.status, resolvedBy: decisions.resolvedBy, affects: decisions.affects })
        .from(decisions)
        .where(eq(decisions.id, decisionId))
        .get(),
      "Decision",
      decisionId,
    );
    assertSameConversation("Decision", decisionId, decision.conversationId, requirement.conversationId);
    if (decision.kind !== "requirement_waiver") {
      throw new InvariantViolationError(`Decision ${decisionId} is a ${decision.kind}, not a requirement_waiver`, { kind: decision.kind });
    }
    if (decision.status !== "resolved" || decision.resolvedBy !== "operator") {
      throw new InvariantViolationError(`requirement_waiver ${decisionId} has not been resolved by the operator`, {
        status: decision.status,
        resolvedBy: decision.resolvedBy,
      });
    }
    if (!decision.affects.requirementIds.includes(requirement.id)) {
      throw new InvariantViolationError(`requirement_waiver ${decisionId} does not name Requirement ${requirement.id}`);
    }
  }
}
