import { and, asc, eq, isNull } from "drizzle-orm";
import {
  ConflictError,
  InvariantViolationError,
  ORCHESTRATOR_INPUT_KINDS,
  orchestratorInputSchema,
  parseOrThrow,
  type InvocationId,
  type OrchestratorInput,
  type OrchestratorInputId,
  type QueuedOrchestratorInput,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { invocations, orchestratorInputs } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof orchestratorInputs.$inferSelect;

function toDomain(row: Row): OrchestratorInput {
  return parseOrThrow(orchestratorInputSchema, row, "OrchestratorInput row");
}

/**
 * The root input queue (execution-model §4.6): typed inputs the operator's
 * actions produce for the Orchestrator's next logical turn. `enqueue` appends
 * one input for a Run that has not ended; `pending` lists the undelivered
 * inputs in queue order; `markDelivered` records the one Orchestrator
 * Invocation whose manifest lists them, once. Nothing is ever injected into
 * an active provider session and nothing here prepares an Invocation.
 */
export class OrchestratorInputStore {
  constructor(private readonly ctx: PersistenceContext) {}

  enqueue(runId: RunId, input: QueuedOrchestratorInput, options?: WriteOptions): OrchestratorInput {
    if (!(ORCHESTRATOR_INPUT_KINDS as readonly string[]).includes(input.kind)) throw new InvariantViolationError(`a ${String((input as { kind: string }).kind)} input is never queued for the Orchestrator`);
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, runId);
      const row: OrchestratorInput = { id: this.ctx.ids("orchestratorInput"), runId: run.id, kind: input.kind, input, createdAt: this.ctx.clock(), deliveredByInvocationId: null, deliveredAt: null };
      parseOrThrow(orchestratorInputSchema, row, "OrchestratorInput");
      this.ctx.journal.append({
        type: "orchestrator_input.queued",
        scope: runScope(run),
        subjectType: "orchestrator_input",
        subjectId: row.id,
        payload: row,
        ...writeMeta(options),
      });
      this.ctx.db.insert(orchestratorInputs).values(row).run();
      return row;
    });
  }

  get(id: OrchestratorInputId): OrchestratorInput {
    return toDomain(requireRow(this.ctx.db.select().from(orchestratorInputs).where(eq(orchestratorInputs.id, id)).get(), "OrchestratorInput", id));
  }

  /** The Run's undelivered inputs, oldest first (creation time, then id). */
  pending(runId: RunId): OrchestratorInput[] {
    return this.ctx.db
      .select()
      .from(orchestratorInputs)
      .where(and(eq(orchestratorInputs.runId, runId), isNull(orchestratorInputs.deliveredAt)))
      .orderBy(asc(orchestratorInputs.createdAt), asc(orchestratorInputs.id))
      .all()
      .map(toDomain);
  }

  listByRun(runId: RunId): OrchestratorInput[] {
    return this.ctx.db.select().from(orchestratorInputs).where(eq(orchestratorInputs.runId, runId)).orderBy(asc(orchestratorInputs.createdAt), asc(orchestratorInputs.id)).all().map(toDomain);
  }

  /** The inputs delivered by one Orchestrator Invocation, in queue order. */
  listDeliveredBy(invocationId: InvocationId): OrchestratorInput[] {
    return this.ctx.db.select().from(orchestratorInputs).where(eq(orchestratorInputs.deliveredByInvocationId, invocationId)).orderBy(asc(orchestratorInputs.createdAt), asc(orchestratorInputs.id)).all().map(toDomain);
  }

  /** Records that `invocationId` (an Orchestrator Invocation of the same Run) delivers these pending inputs; a delivered input is never delivered again. */
  markDelivered(ids: readonly OrchestratorInputId[], invocationId: InvocationId, options?: WriteOptions): OrchestratorInput[] {
    return this.ctx.tx.write(() => {
      const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, role: invocations.role }).from(invocations).where(eq(invocations.id, invocationId)).get(), "Invocation", invocationId);
      if (invocation.role !== "orchestrator") throw new InvariantViolationError(`Invocation ${invocationId} is a ${invocation.role}; root inputs are delivered to an Orchestrator Invocation`, { invocationId });
      const run = loadRunRef(this.ctx, invocation.runId);
      const delivered: OrchestratorInput[] = [];
      const deliveredAt = this.ctx.clock();
      for (const id of new Set(ids)) {
        const current = this.get(id);
        assertSameRun("OrchestratorInput", id, current.runId, run.id);
        if (current.deliveredByInvocationId !== null) throw new ConflictError(`OrchestratorInput ${id} was already delivered by Invocation ${current.deliveredByInvocationId}`, { orchestratorInputId: id });
        const next: OrchestratorInput = { ...current, deliveredByInvocationId: invocationId, deliveredAt };
        parseOrThrow(orchestratorInputSchema, next, "OrchestratorInput");
        this.ctx.journal.append({
          type: "orchestrator_input.delivered",
          scope: runScope(run, { invocationId }),
          subjectType: "orchestrator_input",
          subjectId: id,
          payload: { orchestratorInputId: id, invocationId },
          ...writeMeta(options),
        });
        this.ctx.db.update(orchestratorInputs).set({ deliveredByInvocationId: invocationId, deliveredAt }).where(eq(orchestratorInputs.id, id)).run();
        delivered.push(next);
      }
      return delivered;
    });
  }
}
