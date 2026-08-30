import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ConflictError,
  evaluationInputSchema,
  evaluationSchema,
  GATE_MACHINE,
  gateFailureSchema,
  gateInputSchema,
  gateSchema,
  InvariantViolationError,
  parseOrThrow,
  type AcceptanceCriterionId,
  type Evaluation,
  type EvaluationId,
  type EvaluationInput,
  type Gate,
  type GateFailure,
  type GateId,
  type GateInput,
  type GateKind,
  type PlanNodeId,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { acceptanceCriteria, artifacts, evaluations, gates, invocations, planNodes, runs, snapshots } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function evaluationToDomain(row: typeof evaluations.$inferSelect): Evaluation {
  // The generated index columns are projections of `context` and `subject`, never part of the domain object.
  const { contextKind: _kind, contextRound: _round, subjectCriterionId: _criterion, ...evaluation } = row;
  return parseOrThrow(evaluationSchema, evaluation, "Evaluation row");
}

function gateToDomain(row: typeof gates.$inferSelect): Gate {
  return parseOrThrow(gateSchema, row, "Gate row");
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

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
   * conflict here and a unique-index violation at the database. A Gate
   * Evaluation (execution-model §10) is admitted only for an open Gate of
   * the Run, judges exactly one of the Gate's criteria on exactly the Gate's
   * pinned Snapshot and candidate Artifacts, belongs to the Gate's Plan Node,
   * carries no optimizer context, comes from the runtime for a deterministic
   * criterion and from the Gate's own Evaluator Invocation for an evaluated
   * one, and exists at most once per Gate and criterion.
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
            this.assertCriterionProducer(run.conversationId, criterionId, valid.producedBy.kind);
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
        const gate = gateToDomain(requireRow(this.ctx.db.select().from(gates).where(eq(gates.id, valid.gateId)).get(), "Gate", valid.gateId));
        assertSameRun("Gate", valid.gateId, gate.runId, run.id);
        if (gate.status !== "open") throw new InvariantViolationError(`Gate ${valid.gateId} is ${gate.status}; it accepts no further Evaluations`);
        if (gate.kind === "node_exit") {
          // A node_exit Gate Evaluation judges exactly what the Gate pinned: its node, its Snapshot, its candidate, one of its criteria.
          if (valid.planNodeId !== gate.planNodeId) throw new InvariantViolationError(`Gate ${gate.id} belongs to PlanNode ${gate.planNodeId}, not ${String(valid.planNodeId)}`, { gateId: gate.id });
          if (valid.snapshotId !== gate.snapshotId) throw new InvariantViolationError(`Gate ${gate.id} pinned Snapshot ${gate.snapshotId}, not ${String(valid.snapshotId)}`, { gateId: gate.id });
          if (!sameIds(valid.artifactIds, gate.candidateArtifactIds)) throw new InvariantViolationError(`Gate ${gate.id} judges candidate ${gate.candidateArtifactIds.join(", ")}, not ${valid.artifactIds.join(", ")}`, { gateId: gate.id });
          if (valid.subject.kind !== "acceptance_criterion") throw new InvariantViolationError("a node_exit Gate Evaluation judges one of the Gate's Acceptance Criteria", { gateId: gate.id });
          const criterionId = valid.subject.acceptanceCriterionId;
          if (!gate.acceptanceCriterionIds.includes(criterionId)) throw new InvariantViolationError(`AcceptanceCriterion ${criterionId} is not a criterion of Gate ${gate.id}`, { gateId: gate.id, acceptanceCriterionId: criterionId });
          this.assertCriterionProducer(run.conversationId, criterionId, valid.producedBy.kind);
          if (valid.producedBy.kind === "evaluator") {
            const evaluator = requireRow(this.ctx.db.select({ gateId: invocations.gateId }).from(invocations).where(eq(invocations.id, valid.producedBy.invocationId)).get(), "Invocation", valid.producedBy.invocationId);
            if (evaluator.gateId !== gate.id) throw new InvariantViolationError(`Invocation ${valid.producedBy.invocationId} is not the Evaluator of Gate ${gate.id}`, { gateId: gate.id, invocationId: valid.producedBy.invocationId });
          }
          const existing = this.gateCriterionEvaluationsOf(gate.id).find((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId === criterionId);
          if (existing !== undefined) throw new ConflictError(`Gate ${gate.id} already evaluated AcceptanceCriterion ${criterionId} (Evaluation ${existing.id})`, { gateId: gate.id, evaluationId: existing.id });
        }
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

  /** A deterministic criterion is checked by the runtime alone; an evaluated one is judged by an Evaluator alone. */
  private assertCriterionProducer(conversationId: string, criterionId: AcceptanceCriterionId, producer: "runtime" | "evaluator"): void {
    const criterion = requireRow(this.ctx.db.select({ kind: acceptanceCriteria.kind, conversationId: acceptanceCriteria.conversationId }).from(acceptanceCriteria).where(eq(acceptanceCriteria.id, criterionId)).get(), "AcceptanceCriterion", criterionId);
    if (criterion.conversationId !== conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${criterionId} belongs to another Conversation`, { acceptanceCriterionId: criterionId });
    if (criterion.kind === "deterministic" && producer !== "runtime") throw new InvariantViolationError(`deterministic AcceptanceCriterion ${criterionId} is checked by the runtime, never by an Evaluator`, { acceptanceCriterionId: criterionId });
    if (criterion.kind === "evaluated" && producer !== "evaluator") throw new InvariantViolationError(`evaluated AcceptanceCriterion ${criterionId} is judged by an Evaluator, never by the runtime`, { acceptanceCriterionId: criterionId });
  }

  get(id: EvaluationId): Evaluation {
    return evaluationToDomain(requireRow(this.ctx.db.select().from(evaluations).where(eq(evaluations.id, id)).get(), "Evaluation", id));
  }

  listByGate(gateId: GateId): Evaluation[] {
    return this.ctx.db.select().from(evaluations).where(eq(evaluations.gateId, gateId)).orderBy(asc(evaluations.createdAt), asc(evaluations.id)).all().map(evaluationToDomain);
  }

  /** The criterion Evaluations of one Gate, by Acceptance Criterion id: one per criterion (a database unique index). */
  gateCriterionEvaluationsOf(gateId: GateId): Evaluation[] {
    return this.listByGate(gateId)
      .filter((e) => e.subject.kind === "acceptance_criterion")
      .sort((a, b) => (a.subject.kind === "acceptance_criterion" && b.subject.kind === "acceptance_criterion" && a.subject.acceptanceCriterionId < b.subject.acceptanceCriterionId ? -1 : 1));
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

/**
 * Gate rows (execution-model §10). A `node_exit` Gate is opened for a
 * `pattern` node of the Run with exactly the node's Gate criteria in id
 * order, a pinned Snapshot of the Run's Workspace, and the exact candidate
 * Artifacts; its ordinal is the next verification cycle of that node, at
 * most one Gate of the node is open at a time, and the Run's
 * `maxNodeGateCycles` bounds how many may ever open — each rule held by the
 * store and by the database (unique indexes), so racing passes converge on
 * one row. A Gate closes exactly once, `passed` or `failed` with its closed
 * failure fact; closed Gates are append-only history.
 */
export class GateStore {
  constructor(private readonly ctx: PersistenceContext) {}

  open(input: GateInput, options?: WriteOptions): Gate {
    const valid = parseOrThrow(gateInputSchema, input, "Gate input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      let ordinal: number;
      if (valid.planNodeId !== null) {
        const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind, gateAcceptanceCriterionIds: planNodes.gateAcceptanceCriterionIds }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
        assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
        if (node.kind === "join") throw new InvariantViolationError("a join node has no node_exit Gate");
        const expected = [...(node.gateAcceptanceCriterionIds ?? [])].sort();
        if (!sameIds(valid.acceptanceCriterionIds, expected)) throw new InvariantViolationError(`a node_exit Gate of PlanNode ${valid.planNodeId} carries exactly the node's Gate criteria`, { planNodeId: valid.planNodeId, acceptanceCriterionIds: valid.acceptanceCriterionIds });
        const existing = this.listByPlanNode(valid.planNodeId);
        const open = existing.find((g) => g.status === "open");
        if (open !== undefined) throw new ConflictError(`PlanNode ${valid.planNodeId} already has open Gate ${open.id}`, { planNodeId: valid.planNodeId, gateId: open.id });
        const policy = requireRow(this.ctx.db.select({ verificationPolicy: runs.verificationPolicy }).from(runs).where(eq(runs.id, run.id)).get(), "Run", run.id).verificationPolicy;
        if (existing.length >= policy.maxNodeGateCycles) throw new ConflictError(`PlanNode ${valid.planNodeId} has opened ${existing.length} node_exit Gates; the Run permits ${policy.maxNodeGateCycles}`, { planNodeId: valid.planNodeId, maxNodeGateCycles: policy.maxNodeGateCycles });
        ordinal = existing.length + 1;
      } else {
        ordinal = this.listByRun(run.id).filter((g) => g.kind === valid.kind).length + 1;
      }
      if (valid.snapshotId !== null) {
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, valid.snapshotId)).get(), "Snapshot", valid.snapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${valid.snapshotId} belongs to another Workspace`);
      }
      if (valid.candidateArtifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, valid.candidateArtifactIds)).all();
        for (const id of valid.candidateArtifactIds) assertSameRun("Artifact", id, requireRow(rows.find((r) => r.id === id), "Artifact", id).runId, run.id);
      }
      const gate: Gate = { id: this.ctx.ids("gate"), ...valid, ordinal, status: "open", failure: null, openedAt: this.ctx.clock(), closedAt: null };
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
    return this.ctx.db.select().from(gates).where(eq(gates.runId, runId)).orderBy(asc(gates.openedAt), asc(gates.id)).all().map(gateToDomain);
  }

  /** Every `node_exit` Gate of a node in ordinal order: the node's verification history. */
  listByPlanNode(planNodeId: PlanNodeId): Gate[] {
    return this.ctx.db.select().from(gates).where(and(eq(gates.planNodeId, planNodeId), eq(gates.kind, "node_exit"))).orderBy(asc(gates.ordinal)).all().map(gateToDomain);
  }

  /** The node's open `node_exit` Gate, or `null`; at most one exists (a database unique index). */
  openGateOf(planNodeId: PlanNodeId): Gate | null {
    const rows = this.listByPlanNode(planNodeId).filter((g) => g.status === "open");
    if (rows.length > 1) throw new InvariantViolationError(`PlanNode ${planNodeId} has ${rows.length} open Gates`, { planNodeId });
    return rows[0] ?? null;
  }

  /** The Gates of a Run of one kind, in ordinal order. */
  listByKind(runId: RunId, kind: GateKind): Gate[] {
    return this.ctx.db.select().from(gates).where(and(eq(gates.runId, runId), eq(gates.kind, kind))).orderBy(asc(gates.ordinal), asc(gates.id)).all().map(gateToDomain);
  }

  /** Closes an open Gate exactly once: `passed` carries no failure, `failed` carries its closed failure fact. */
  close(id: GateId, outcome: "passed" | "failed", failure: GateFailure | null = null, options?: WriteOptions): Gate {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      GATE_MACHINE.assertTransition(current.status, outcome, { gateId: id });
      if ((outcome === "failed") !== (failure !== null)) throw new InvariantViolationError("a failed Gate records its failure; a passed Gate records none", { gateId: id, outcome });
      const valid = failure === null ? null : parseOrThrow(gateFailureSchema, failure, "Gate failure");
      if (valid !== null && valid.kind === "criteria_failed" && !valid.acceptanceCriterionIds.every((c) => current.acceptanceCriterionIds.includes(c))) {
        throw new InvariantViolationError(`Gate ${id} fails only on its own criteria`, { gateId: id, acceptanceCriterionIds: valid.acceptanceCriterionIds });
      }
      const run = loadRunRef(this.ctx, current.runId);
      const next: Gate = { ...current, status: outcome, failure: valid, closedAt: this.ctx.clock() };
      parseOrThrow(gateSchema, next, "Gate");
      if (outcome === "passed") {
        this.ctx.journal.append({ type: "gate.passed", scope: runScope(run, { planNodeId: current.planNodeId }), subjectType: "gate", subjectId: id, payload: { gateId: id }, ...writeMeta(options) });
      } else {
        this.ctx.journal.append({ type: "gate.failed", scope: runScope(run, { planNodeId: current.planNodeId }), subjectType: "gate", subjectId: id, payload: { gateId: id, failure: valid! }, ...writeMeta(options) });
      }
      this.ctx.db.update(gates).set({ status: next.status, failure: next.failure, closedAt: next.closedAt }).where(eq(gates.id, id)).run();
      return next;
    });
  }
}
