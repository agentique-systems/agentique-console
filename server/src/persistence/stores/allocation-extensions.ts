import { and, asc, eq } from "drizzle-orm";
import {
  allocationExtensionInputSchema,
  allocationExtensionSchema,
  allocationFits,
  ConflictError,
  InsufficientCapacityError,
  InvariantViolationError,
  parseOrThrow,
  PLAN_NODE_MACHINE,
  RUN_MACHINE,
  sumAllocations,
  type Allocation,
  type AllocationExtension,
  type AllocationExtensionId,
  type AllocationExtensionInput,
  type BudgetReservationId,
  type PlanNodeId,
  type PlanNodeStatus,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { allocationExtensions, budgetReservations, planNodes } from "../schema.ts";
import { loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof allocationExtensions.$inferSelect;

function toDomain(row: Row): AllocationExtension {
  return parseOrThrow(
    allocationExtensionSchema,
    {
      id: row.id,
      runId: row.runId,
      planNodeId: row.planNodeId,
      reservationId: row.reservationId,
      added: { costUsd: row.addedCostUsd, tokens: row.addedTokens, attempts: row.addedAttempts },
      trigger: row.trigger,
      createdAt: row.createdAt,
    },
    "AllocationExtension row",
  );
}

/** The ordinary Run capacity an extension is checked against, read from the reservation accounting (never from a stored aggregate). */
export interface OrdinaryCapacitySource {
  ordinaryAvailable(runId: RunId): Allocation;
}

/**
 * Allocation Extensions (execution-model §7.6): the append-only record of
 * every deterministic transfer of existing ordinary Run capacity to one Plan
 * Node's active reservation. `record` admits a row only for a nonterminal
 * `pattern` Plan Node of a nonterminal Run whose active ordinary
 * `Run → Plan Node` reservation it names, with non-negative quantities of
 * which at least one is positive, and only when the Run's effective
 * ordinary available capacity covers them — the final reserve is never
 * consulted; the baseline migration's trigger re-checks the reservation and
 * node facts at insertion. Nothing here changes the reservation's own
 * amounts, creates Usage, or touches an Invocation. The runtime calls it
 * inside the same root transaction that creates the work the extension
 * funds, so both commit or neither does.
 */
export class AllocationExtensionStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly capacity: OrdinaryCapacitySource,
  ) {}

  record(input: AllocationExtensionInput, options?: WriteOptions & { id?: AllocationExtensionId }): AllocationExtension {
    const valid = parseOrThrow(allocationExtensionInputSchema, input, "AllocationExtension input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new ConflictError(`Run ${run.id} is ${run.status}; no allocation is extended`, { runId: run.id, status: run.status });
      const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind, status: planNodes.status }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
      if (node.runId !== run.id) throw new InvariantViolationError(`PlanNode ${valid.planNodeId} belongs to Run ${node.runId}, not ${run.id}`, { planNodeId: valid.planNodeId });
      if (node.kind !== "pattern") throw new InvariantViolationError(`join node ${valid.planNodeId} holds no allocation and cannot be extended`, { planNodeId: valid.planNodeId });
      if (PLAN_NODE_MACHINE.isTerminal(node.status as PlanNodeStatus)) throw new ConflictError(`PlanNode ${valid.planNodeId} is ${node.status}; a terminal node's allocation is never extended`, { planNodeId: valid.planNodeId, status: node.status });
      const reservation = this.ctx.db
        .select()
        .from(budgetReservations)
        .where(and(eq(budgetReservations.childType, "plan_node"), eq(budgetReservations.childId, valid.planNodeId), eq(budgetReservations.status, "active")))
        .get();
      if (reservation === undefined) throw new ConflictError(`PlanNode ${valid.planNodeId} holds no active reservation; a released reservation is never extended`, { planNodeId: valid.planNodeId });
      if (reservation.parentType !== "run" || reservation.parentId !== run.id || reservation.runId !== run.id || reservation.capacitySource !== "ordinary") {
        throw new InvariantViolationError(`reservation ${reservation.id} is not the ordinary Run-level reservation of PlanNode ${valid.planNodeId}`, { reservationId: reservation.id });
      }
      const available = this.capacity.ordinaryAvailable(run.id);
      if (!allocationFits(valid.added, available)) {
        throw new InsufficientCapacityError(`Run ${run.id} has insufficient effective ordinary capacity to extend PlanNode ${valid.planNodeId}`, { requested: valid.added, available, capacitySource: "ordinary" });
      }
      const extension: AllocationExtension = {
        id: options?.id ?? this.ctx.ids("allocationExtension"),
        runId: run.id,
        planNodeId: valid.planNodeId,
        reservationId: reservation.id as BudgetReservationId,
        added: valid.added,
        trigger: valid.trigger,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(allocationExtensionSchema, extension, "AllocationExtension");
      this.ctx.journal.append({
        type: "allocation_extension.created",
        scope: runScope(run, { planNodeId: extension.planNodeId }),
        subjectType: "allocation_extension",
        subjectId: extension.id,
        payload: extension,
        ...writeMeta(options),
      });
      this.ctx.db
        .insert(allocationExtensions)
        .values({ id: extension.id, runId: extension.runId, planNodeId: extension.planNodeId, reservationId: extension.reservationId, addedCostUsd: extension.added.costUsd, addedTokens: extension.added.tokens, addedAttempts: extension.added.attempts, trigger: extension.trigger, createdAt: extension.createdAt })
        .run();
      return extension;
    });
  }

  get(id: AllocationExtensionId): AllocationExtension {
    return toDomain(requireRow(this.ctx.db.select().from(allocationExtensions).where(eq(allocationExtensions.id, id)).get(), "AllocationExtension", id));
  }

  /** Every extension of a Run, in creation order. */
  listByRun(runId: RunId): AllocationExtension[] {
    return this.ctx.db.select().from(allocationExtensions).where(eq(allocationExtensions.runId, runId)).orderBy(asc(allocationExtensions.createdAt), asc(allocationExtensions.id)).all().map(toDomain);
  }

  /** Every extension of a Plan Node, in creation order. */
  listByPlanNode(planNodeId: PlanNodeId): AllocationExtension[] {
    return this.ctx.db.select().from(allocationExtensions).where(eq(allocationExtensions.planNodeId, planNodeId)).orderBy(asc(allocationExtensions.createdAt), asc(allocationExtensions.id)).all().map(toDomain);
  }

  /** Every extension of one reservation, in creation order. */
  listByReservation(reservationId: BudgetReservationId): AllocationExtension[] {
    return this.ctx.db.select().from(allocationExtensions).where(eq(allocationExtensions.reservationId, reservationId)).orderBy(asc(allocationExtensions.createdAt), asc(allocationExtensions.id)).all().map(toDomain);
  }

  /** Σ added of one reservation's extensions: what its effective reserved allocation adds to its immutable original amounts. */
  totalByReservation(reservationId: BudgetReservationId): Allocation {
    return sumAllocations(this.listByReservation(reservationId).map((e) => e.added));
  }
}
