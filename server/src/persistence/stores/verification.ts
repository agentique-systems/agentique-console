import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ConflictError,
  evaluationInputSchema,
  evaluationSchema,
  GATE_MACHINE,
  gateInputSchema,
  gateSchema,
  InvariantViolationError,
  parseOrThrow,
  type Evaluation,
  type EvaluationId,
  type EvaluationInput,
  type Gate,
  type GateId,
  type GateInput,
  type PlanNodeId,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { acceptanceCriteria, artifacts, evaluations, gates, invocations, planNodes, snapshots } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function evaluationToDomain(row: typeof evaluations.$inferSelect): Evaluation {
  // The generated index columns are projections of `context` and `subject`, never part of the domain object.
  const { contextKind: _kind, contextRound: _round, subjectCriterionId: _criterion, ...evaluation } = row;
  return parseOrThrow(evaluationSchema, evaluation, "Evaluation row");
}

function gateToDomain(row: typeof gates.$inferSelect): Gate {
  return parseOrThrow(gateSchema, row, "Gate row");
}

export class EvaluationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Appends an Evaluation; an Evaluator never evaluates an Artifact it
   * produced. A `route_selection` Evaluation is admitted only for a `route`
   * node whose shape binds the selected label, and only once per node: a
   * second selection is a conflict here and a unique-index violation at the
   * database, so concurrent or repeated settlement never records two. An
   * optimizer-round Evaluation (execution-model §5.6) is admitted only for an
   * `evaluator_optimizer` node, at a round its immutable shape holds (the
   * exact `maxRounds`, and the fixed round of an evaluate-only node), naming
   * a judged Snapshot of the Run's Workspace; a criterion Evaluation names one
   * of the node's Gate criteria, a deterministic one recorded by the runtime
   * alone; and at most one overall verdict per node and round, and one
   * Evaluation per node, round, and criterion, exist — a second is a
   * conflict here and a unique-index violation at the database.
   */
  record(input: EvaluationInput, options?: WriteOptions): Evaluation {
    const valid = parseOrThrow(evaluationInputSchema, input, "Evaluation input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (valid.planNodeId !== null) {
        const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind, shape: planNodes.shape, gateAcceptanceCriterionIds: planNodes.gateAcceptanceCriterionIds }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
        assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
        if (valid.subject.kind === "route_selection") {
          if (node.kind !== "pattern" || node.shape === null || node.shape.pattern !== "route") throw new InvariantViolationError(`PlanNode ${valid.planNodeId} is not a route node; it selects no branch`, { planNodeId: valid.planNodeId });
          const label = valid.subject.selectedLabel;
          if (!node.shape.branches.some((b) => b.label === label)) throw new InvariantViolationError(`PlanNode ${valid.planNodeId} binds no branch ${label}`, { planNodeId: valid.planNodeId, selectedLabel: label });
          const existing = this.routeSelectionOf(valid.planNodeId);
          if (existing !== null) throw new ConflictError(`PlanNode ${valid.planNodeId} already selected ${existing.subject.kind === "route_selection" ? existing.subject.selectedLabel : ""} (Evaluation ${existing.id})`, { planNodeId: valid.planNodeId, evaluationId: existing.id });
        }
        if (valid.context !== null) {
          const context = valid.context;
          if (node.kind !== "pattern" || node.shape === null || node.shape.pattern !== "evaluator_optimizer") throw new InvariantViolationError(`PlanNode ${valid.planNodeId} is not an evaluator_optimizer node; it has no optimizer rounds`, { planNodeId: valid.planNodeId });
          if (context.maxRounds !== node.shape.maxRounds) throw new InvariantViolationError(`PlanNode ${valid.planNodeId} has ${node.shape.maxRounds} rounds, not ${context.maxRounds}`, { planNodeId: valid.planNodeId, maxRounds: context.maxRounds });
          if (node.shape.round !== null && context.round !== node.shape.round) throw new InvariantViolationError(`PlanNode ${valid.planNodeId} evaluates round ${node.shape.round}, not ${context.round}`, { planNodeId: valid.planNodeId, round: context.round });
          if (context.kind === "optimizer_verdict") {
            const existing = this.optimizerVerdictOf(valid.planNodeId, context.round);
            if (existing !== null) throw new ConflictError(`PlanNode ${valid.planNodeId} already recorded the verdict of round ${context.round} (Evaluation ${existing.id})`, { planNodeId: valid.planNodeId, round: context.round, evaluationId: existing.id });
          } else {
            if (valid.subject.kind !== "acceptance_criterion") throw new InvariantViolationError("an optimizer criterion Evaluation judges one Acceptance Criterion");
            const criterionId = valid.subject.acceptanceCriterionId;
            if (!(node.gateAcceptanceCriterionIds as string[]).includes(criterionId)) throw new InvariantViolationError(`AcceptanceCriterion ${criterionId} is not a Gate criterion of PlanNode ${valid.planNodeId}`, { planNodeId: valid.planNodeId, acceptanceCriterionId: criterionId });
            const criterion = requireRow(this.ctx.db.select({ kind: acceptanceCriteria.kind, conversationId: acceptanceCriteria.conversationId }).from(acceptanceCriteria).where(eq(acceptanceCriteria.id, criterionId)).get(), "AcceptanceCriterion", criterionId);
            if (criterion.conversationId !== run.conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${criterionId} belongs to another Conversation`, { acceptanceCriterionId: criterionId });
            if (criterion.kind === "deterministic" && valid.producedBy.kind !== "runtime") throw new InvariantViolationError(`deterministic AcceptanceCriterion ${criterionId} is checked by the runtime, never by an Evaluator`, { acceptanceCriterionId: criterionId });
            if (criterion.kind === "evaluated" && valid.producedBy.kind !== "evaluator") throw new InvariantViolationError(`evaluated AcceptanceCriterion ${criterionId} is judged by an Evaluator, never by the runtime`, { acceptanceCriterionId: criterionId });
            const existing = this.optimizerCriterionEvaluationsOf(valid.planNodeId, context.round).find((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId === criterionId);
            if (existing !== undefined) throw new ConflictError(`PlanNode ${valid.planNodeId} already evaluated AcceptanceCriterion ${criterionId} in round ${context.round} (Evaluation ${existing.id})`, { planNodeId: valid.planNodeId, round: context.round, evaluationId: existing.id });
          }
        }
      } else if (valid.context !== null) {
        throw new InvariantViolationError("an optimizer-round Evaluation belongs to its evaluator_optimizer Plan Node");
      }
      if (valid.snapshotId !== null) {
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, valid.snapshotId)).get(), "Snapshot", valid.snapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${valid.snapshotId} belongs to another Workspace`, { snapshotId: valid.snapshotId });
      }
      if (valid.gateId !== null) {
        const gate = requireRow(this.ctx.db.select({ runId: gates.runId, status: gates.status }).from(gates).where(eq(gates.id, valid.gateId)).get(), "Gate", valid.gateId);
        assertSameRun("Gate", valid.gateId, gate.runId, run.id);
        if (gate.status !== "open") throw new InvariantViolationError(`Gate ${valid.gateId} is ${gate.status}; it accepts no further Evaluations`);
      }
      const judged = valid.artifactIds.length > 0 ? this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId, invocationId: artifacts.invocationId }).from(artifacts).where(inArray(artifacts.id, valid.artifactIds)).all() : [];
      for (const id of valid.artifactIds) assertSameRun("Artifact", id, requireRow(judged.find((r) => r.id === id), "Artifact", id).runId, run.id);
      if (valid.producedBy.kind === "evaluator") {
        const evaluatorId = valid.producedBy.invocationId;
        const evaluator = requireRow(
          this.ctx.db.select({ runId: invocations.runId, role: invocations.role, agentDefinitionRevisionId: invocations.agentDefinitionRevisionId }).from(invocations).where(eq(invocations.id, evaluatorId)).get(),
          "Invocation",
          evaluatorId,
        );
        assertSameRun("Invocation", evaluatorId, evaluator.runId, run.id);
        if (evaluator.role !== "evaluator") throw new InvariantViolationError(`Invocation ${evaluatorId} is a ${evaluator.role}, not an Evaluator`);
        if (evaluator.agentDefinitionRevisionId !== valid.producedBy.agentDefinitionRevisionId) {
          throw new InvariantViolationError("the Evaluation names a different Agent Definition revision than its Evaluator Invocation");
        }
        const selfJudged = judged.find((a) => a.invocationId === evaluatorId);
        if (selfJudged) throw new InvariantViolationError(`Evaluator ${evaluatorId} produced Artifact ${selfJudged.id} and cannot evaluate it`);
      }
      const evaluation: Evaluation = { id: this.ctx.ids("evaluation"), ...valid, createdAt: this.ctx.clock() };
      parseOrThrow(evaluationSchema, evaluation, "Evaluation");
      this.ctx.journal.append({
        type: "evaluation.recorded",
        scope: runScope(run, { planNodeId: valid.planNodeId, invocationId: valid.producedBy.kind === "evaluator" ? valid.producedBy.invocationId : null }),
        subjectType: "evaluation",
        subjectId: evaluation.id,
        payload: evaluation,
        ...writeMeta(options, valid.producedBy.kind === "evaluator" ? { kind: "invocation", invocationId: valid.producedBy.invocationId } : undefined),
      });
      this.ctx.db.insert(evaluations).values(evaluation).run();
      return evaluation;
    });
  }

  get(id: EvaluationId): Evaluation {
    return evaluationToDomain(requireRow(this.ctx.db.select().from(evaluations).where(eq(evaluations.id, id)).get(), "Evaluation", id));
  }

  listByGate(gateId: GateId): Evaluation[] {
    return this.ctx.db.select().from(evaluations).where(eq(evaluations.gateId, gateId)).orderBy(asc(evaluations.createdAt)).all().map(evaluationToDomain);
  }

  listByRun(runId: RunId): Evaluation[] {
    return this.ctx.db.select().from(evaluations).where(eq(evaluations.runId, runId)).orderBy(asc(evaluations.createdAt)).all().map(evaluationToDomain);
  }

  listByPlanNode(planNodeId: PlanNodeId): Evaluation[] {
    return this.ctx.db.select().from(evaluations).where(eq(evaluations.planNodeId, planNodeId)).orderBy(asc(evaluations.createdAt), asc(evaluations.id)).all().map(evaluationToDomain);
  }

  /** The one canonical route-selection Evaluation of a route node, or `null` before it selected. */
  routeSelectionOf(planNodeId: PlanNodeId): Evaluation | null {
    const rows = this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.planNodeId, planNodeId), sql`json_extract(${evaluations.subject}, '$.kind') = 'route_selection'`))
      .all()
      .map(evaluationToDomain);
    if (rows.length > 1) throw new InvariantViolationError(`PlanNode ${planNodeId} has ${rows.length} route-selection Evaluations`, { planNodeId });
    return rows[0] ?? null;
  }

  /** The route-selection Evaluations of every route node of a Run, keyed by node: the condition facts readiness receives. */
  routeSelectionsOf(runId: RunId): Map<PlanNodeId, Evaluation> {
    const out = new Map<PlanNodeId, Evaluation>();
    for (const evaluation of this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.runId, runId), sql`json_extract(${evaluations.subject}, '$.kind') = 'route_selection'`))
      .orderBy(asc(evaluations.createdAt), asc(evaluations.id))
      .all()
      .map(evaluationToDomain)) {
      const nodeId = evaluation.planNodeId!;
      if (out.has(nodeId)) throw new InvariantViolationError(`PlanNode ${nodeId} has two route-selection Evaluations`, { planNodeId: nodeId });
      out.set(nodeId, evaluation);
    }
    return out;
  }

  /** The one canonical overall verdict of an evaluator_optimizer node's round, or `null` before the round was judged. */
  optimizerVerdictOf(planNodeId: PlanNodeId, round: number): Evaluation | null {
    const rows = this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.planNodeId, planNodeId), sql`json_extract(${evaluations.context}, '$.kind') = 'optimizer_verdict'`, sql`json_extract(${evaluations.context}, '$.round') = ${round}`))
      .all()
      .map(evaluationToDomain);
    if (rows.length > 1) throw new InvariantViolationError(`PlanNode ${planNodeId} has ${rows.length} verdicts for round ${round}`, { planNodeId, round });
    return rows[0] ?? null;
  }

  /** Every overall round verdict of an evaluator_optimizer node, in round order; one per round. */
  optimizerVerdictsOfNode(planNodeId: PlanNodeId): Evaluation[] {
    const rows = this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.planNodeId, planNodeId), sql`json_extract(${evaluations.context}, '$.kind') = 'optimizer_verdict'`))
      .orderBy(sql`json_extract(${evaluations.context}, '$.round')`, asc(evaluations.id))
      .all()
      .map(evaluationToDomain);
    const seen = new Set<number>();
    for (const row of rows) {
      const round = row.context!.round;
      if (seen.has(round)) throw new InvariantViolationError(`PlanNode ${planNodeId} has two verdicts for round ${round}`, { planNodeId, round });
      seen.add(round);
    }
    return rows;
  }

  /** The criterion Evaluations of one evaluator_optimizer round, by Acceptance Criterion id. */
  optimizerCriterionEvaluationsOf(planNodeId: PlanNodeId, round: number): Evaluation[] {
    return this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.planNodeId, planNodeId), sql`json_extract(${evaluations.context}, '$.kind') = 'optimizer_criterion'`, sql`json_extract(${evaluations.context}, '$.round') = ${round}`))
      .all()
      .map(evaluationToDomain)
      .sort((a, b) => (a.subject.kind === "acceptance_criterion" && b.subject.kind === "acceptance_criterion" && a.subject.acceptanceCriterionId < b.subject.acceptanceCriterionId ? -1 : 1));
  }

  /**
   * Every overall optimizer-round verdict of a Run, keyed by evaluator_optimizer node and ordered by round within a node:
   * the condition facts readiness receives for `retry(round)` and the sequence edges out of an evaluate-only node.
   */
  optimizerVerdictsOf(runId: RunId): Map<PlanNodeId, Evaluation[]> {
    const out = new Map<PlanNodeId, Evaluation[]>();
    for (const evaluation of this.ctx.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.runId, runId), sql`json_extract(${evaluations.context}, '$.kind') = 'optimizer_verdict'`))
      .orderBy(sql`json_extract(${evaluations.context}, '$.round')`, asc(evaluations.id))
      .all()
      .map(evaluationToDomain)) {
      const nodeId = evaluation.planNodeId!;
      const list = out.get(nodeId) ?? [];
      if (list.some((e) => e.context!.round === evaluation.context!.round)) throw new InvariantViolationError(`PlanNode ${nodeId} has two verdicts for round ${evaluation.context!.round}`, { planNodeId: nodeId });
      list.push(evaluation);
      out.set(nodeId, list);
    }
    return out;
  }
}

export class GateStore {
  constructor(private readonly ctx: PersistenceContext) {}

  open(input: GateInput, options?: WriteOptions): Gate {
    const valid = parseOrThrow(gateInputSchema, input, "Gate input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (valid.planNodeId !== null) {
        const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
        assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
        if (node.kind === "join") throw new InvariantViolationError("a join node has no node_exit Gate");
      }
      if (valid.snapshotId !== null) {
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, valid.snapshotId)).get(), "Snapshot", valid.snapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${valid.snapshotId} belongs to another Workspace`);
      }
      const gate: Gate = { id: this.ctx.ids("gate"), ...valid, status: "open", openedAt: this.ctx.clock(), closedAt: null };
      parseOrThrow(gateSchema, gate, "Gate");
      this.ctx.journal.append({
        type: "gate.opened",
        scope: runScope(run, { planNodeId: valid.planNodeId }),
        subjectType: "gate",
        subjectId: gate.id,
        payload: gate,
        ...writeMeta(options),
      });
      this.ctx.db.insert(gates).values(gate).run();
      return gate;
    });
  }

  get(id: GateId): Gate {
    return gateToDomain(requireRow(this.ctx.db.select().from(gates).where(eq(gates.id, id)).get(), "Gate", id));
  }

  listByRun(runId: RunId): Gate[] {
    return this.ctx.db.select().from(gates).where(eq(gates.runId, runId)).orderBy(asc(gates.openedAt)).all().map(gateToDomain);
  }

  close(id: GateId, outcome: "passed" | "failed", options?: WriteOptions): Gate {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      GATE_MACHINE.assertTransition(current.status, outcome, { gateId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const next: Gate = { ...current, status: outcome, closedAt: this.ctx.clock() };
      parseOrThrow(gateSchema, next, "Gate");
      this.ctx.journal.append({
        type: outcome === "passed" ? "gate.passed" : "gate.failed",
        scope: runScope(run, { planNodeId: current.planNodeId }),
        subjectType: "gate",
        subjectId: id,
        payload: { gateId: id },
        ...writeMeta(options),
      });
      this.ctx.db.update(gates).set({ status: next.status, closedAt: next.closedAt }).where(eq(gates.id, id)).run();
      return next;
    });
  }
}
