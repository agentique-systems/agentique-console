import { asc, eq, inArray } from "drizzle-orm";
import {
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
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, evaluations, gates, invocations, planNodes, snapshots } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function evaluationToDomain(row: typeof evaluations.$inferSelect): Evaluation {
  return parseOrThrow(evaluationSchema, row, "Evaluation row");
}

function gateToDomain(row: typeof gates.$inferSelect): Gate {
  return parseOrThrow(gateSchema, row, "Gate row");
}

export class EvaluationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /** Appends an Evaluation; an Evaluator never evaluates an Artifact it produced. */
  record(input: EvaluationInput, options?: WriteOptions): Evaluation {
    const valid = parseOrThrow(evaluationInputSchema, input, "Evaluation input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (valid.planNodeId !== null) {
        const node = requireRow(this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
        assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
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
