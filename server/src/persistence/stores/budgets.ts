import { and, eq } from "drizzle-orm";
import {
  addAllocation,
  allocationFits,
  allocationSchema,
  budgetReservationSchema,
  capacityAccount,
  ConflictError,
  FINAL_RESERVE_USE_BINDINGS,
  InsufficientCapacityError,
  InvariantViolationError,
  isReservationPair,
  NotFoundError,
  parseOrThrow,
  ROOT_SOURCE_PATH,
  runCapacityAccount,
  subtractAllocation,
  sumAllocations,
  ValidationError,
  ZERO_ALLOCATION,
  type Allocation,
  type BudgetReservation,
  type BudgetReservationId,
  type CapacityAccount,
  type FinalReserveUse,
  type InvocationId,
  type PlanNodeAllocationProjection,
  type PlanNodeId,
  type ReservationCapacitySource,
  type ReservationCharge,
  type ReservationChildRef,
  type ReservationParentRef,
  type ReservationReleaseReason,
  type RunBudgetLimits,
  type RunCapacity,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { budgetReservations, invocations, planNodes, runs, tasks } from "../schema.ts";
import type { AllocationExtensionStore } from "./allocation-extensions.ts";
import type { BudgetIncreaseStore } from "./budget-increases.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";
import type { UsageStore } from "./usage.ts";

type Row = typeof budgetReservations.$inferSelect;

function toDomain(row: Row): BudgetReservation {
  const consumed =
    row.consumedCostUsd === null || row.consumedTokens === null || row.consumedAttempts === null
      ? null
      : { costUsd: row.consumedCostUsd, tokens: row.consumedTokens, attempts: row.consumedAttempts };
  return parseOrThrow(
    budgetReservationSchema,
    {
      id: row.id,
      runId: row.runId,
      parent: { type: row.parentType, id: row.parentId },
      child: { type: row.childType, id: row.childId },
      reserved: { costUsd: row.reservedCostUsd, tokens: row.reservedTokens, attempts: row.reservedAttempts },
      consumed,
      capacitySource: row.capacitySource,
      finalReserveUse: row.finalReserveUse,
      status: row.status,
      transferredFromReservationId: row.transferredFromReservationId,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt,
      releaseReason: row.releaseReason,
    },
    "BudgetReservation row",
  );
}

/** An ordinary reservation: from a Run's ordinary pool for a Plan Node, or from a Plan Node for an Invocation or Task. */
export interface ReserveOrdinaryInput {
  runId: RunId;
  parent: ReservationParentRef;
  child: ReservationChildRef;
  amount: Allocation;
}

/**
 * A final-reserve reservation: the Run funds one persisted final-reserve
 * Invocation directly. The Invocation row is the authorization; nothing the
 * caller passes can select final capacity for anything else.
 */
export interface ReserveFinalInvocationInput {
  runId: RunId;
  invocationId: InvocationId;
}

/**
 * Atomic allocation accounting over `budget_reservations`. Reservations are
 * the only record of allocation; limits live on the bounded objects and are
 * read here to compute capacity — a Run's effective limits derive from its
 * immutable base Budget plus its approved Budget Increases, and a Plan
 * Node's effective allocation from its immutable reservation plus its
 * Allocation Extensions; no aggregate is stored. Two reservation entry
 * points exist and neither takes a capacity source from its caller:
 * `reserveOrdinary` never touches the final reserve, and
 * `reserveFinalInvocation` funds only an Invocation whose persisted row
 * names a permitted final-reserve use.
 */
export class BudgetReservationStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly usage: UsageStore,
    private readonly increases: BudgetIncreaseStore,
    private readonly extensions: AllocationExtensionStore,
  ) {}

  get(id: BudgetReservationId): BudgetReservation {
    return toDomain(requireRow(this.ctx.db.select().from(budgetReservations).where(eq(budgetReservations.id, id)).get(), "BudgetReservation", id));
  }

  listByParent(parent: ReservationParentRef): BudgetReservation[] {
    return this.ctx.db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.parentType, parent.type), eq(budgetReservations.parentId, parent.id)))
      .all()
      .map(toDomain);
  }

  listByChild(child: ReservationChildRef): BudgetReservation[] {
    return this.ctx.db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.childType, child.type), eq(budgetReservations.childId, child.id)))
      .all()
      .map(toDomain);
  }

  activeForChild(child: ReservationChildRef): BudgetReservation | null {
    const row = this.ctx.db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.childType, child.type), eq(budgetReservations.childId, child.id), eq(budgetReservations.status, "active")))
      .get();
    return row ? toDomain(row) : null;
  }

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  /**
   * The effective limit of a parent as an Allocation. For a Run this is the
   * effective ordinary pool: the effective Run Budget less the effective
   * final reserve (`runCapacity` exposes every partition). For a Plan Node
   * it is the node's immutable compiled allocation plus every Allocation
   * Extension of its Run-level reservation. For an Invocation it is its
   * immutable allocation.
   */
  limitOf(parent: ReservationParentRef): Allocation {
    switch (parent.type) {
      case "run": {
        const capacity = this.runCapacity(parent.id);
        return subtractAllocation(capacity.limit, capacity.finalReserve);
      }
      case "plan_node":
        return this.planNodeAllocation(parent.id).effective;
      case "invocation": {
        const invocation = requireRow(
          this.ctx.db.select({ costUsd: invocations.allocCostUsd, tokens: invocations.allocTokens, attempts: invocations.allocAttempts }).from(invocations).where(eq(invocations.id, parent.id)).get(),
          "Invocation",
          parent.id,
        );
        return invocation;
      }
    }
  }

  /**
   * A parent's account: limit, reserved, consumed, committed, and signed
   * available. An active child is charged `max(reserved, actual attributable
   * consumption)` per component — an Invocation's own Usage and Attempts, a
   * Plan Node's consumption from its own allocation — so an overrun shows at
   * the parent immediately; a released child is charged its recorded
   * complete consumption; a Task reservation has no Usage and is charged
   * its reserved amount. Nothing is clamped. For a Run this is the ordinary
   * partition (see `runCapacity`).
   */
  capacity(parent: ReservationParentRef): CapacityAccount {
    if (parent.type === "run") return this.runCapacity(parent.id).ordinary;
    const direct = parent.type === "invocation" ? this.usage.consumedByInvocation(parent.id) : ZERO_ALLOCATION;
    return capacityAccount(this.limitOf(parent), this.listByParent(parent).map((r) => this.charge(r)), direct);
  }

  /**
   * A Run's global account and its two partitions. The global account
   * charges every Run-level child of either partition against the whole
   * Budget; each partition charges its own children against its own limit
   * and reports `effectiveAvailable = min(own available, global available)`.
   * An overrun in either partition therefore reduces what the other may
   * still reserve, while neither partition can claim the other's unused
   * capacity, and the final reserve is never double-counted.
   */
  runCapacity(runId: RunId): RunCapacity {
    const charges = this.listByParent({ type: "run", id: runId }).map((r) => [r.capacitySource, this.charge(r)] as const);
    return runCapacityAccount(
      this.runLimits(runId),
      charges.filter(([source]) => source === "ordinary").map(([, c]) => c),
      charges.filter(([source]) => source === "final_reserve").map(([, c]) => c),
    );
  }

  /**
   * One Plan Node's effective allocation from rows: its Run-level
   * reservation's immutable original amounts, its Allocation Extensions,
   * their sum, the effective reserved allocation, and the node's account
   * over that effective limit. A node without a reservation (a join, or a
   * node whose revision was never applied) has a zero limit.
   */
  planNodeAllocation(planNodeId: PlanNodeId): PlanNodeAllocationProjection {
    const node = requireRow(
      this.ctx.db.select({ costUsd: planNodes.allocCostUsd, tokens: planNodes.allocTokens, attempts: planNodes.allocAttempts }).from(planNodes).where(eq(planNodes.id, planNodeId)).get(),
      "PlanNode",
      planNodeId,
    );
    const reservations = this.listByChild({ type: "plan_node", id: planNodeId }).filter((r) => r.parent.type === "run");
    const reservation = reservations.find((r) => r.status === "active") ?? reservations.at(-1) ?? null;
    const extensions = reservation === null ? [] : this.extensions.listByReservation(reservation.id);
    const extended = sumAllocations(extensions.map((e) => e.added));
    const original: Allocation = { costUsd: node.costUsd, tokens: node.tokens, attempts: node.attempts };
    const effective = addAllocation(original, extended);
    const account = capacityAccount(effective, this.listByParent({ type: "plan_node", id: planNodeId }).map((r) => this.charge(r)));
    return { planNodeId, reservationId: reservation?.id ?? null, reservationStatus: reservation?.status ?? null, original, extensions, extended, effective, account };
  }

  /**
   * The current charge of one reservation: while active, its effective
   * reserved allocation (the immutable original amounts plus, for a Plan
   * Node's Run-level reservation, its Allocation Extensions) against the
   * child's actual attributable consumption so far; once released, its
   * recorded complete consumption alone — extensions are provenance, never
   * a second charge.
   */
  private charge(reservation: BudgetReservation): ReservationCharge {
    if (reservation.status === "released") {
      return { status: "released", reserved: reservation.reserved, actual: reservation.consumed ?? ZERO_ALLOCATION };
    }
    let actual: Allocation;
    let reserved = reservation.reserved;
    switch (reservation.child.type) {
      case "plan_node":
        actual = this.usage.consumedFromPlanNodeAllocation(reservation.child.id);
        if (reservation.parent.type === "run") reserved = addAllocation(reserved, this.extensions.totalByReservation(reservation.id));
        break;
      case "invocation":
        actual = this.usage.consumedByInvocation(reservation.child.id);
        break;
      case "task":
        actual = ZERO_ALLOCATION;
        break;
    }
    return { status: "active", reserved, actual };
  }

  /** The Run's immutable base limits plus its approved Budget Increases: what every effective limit derives from. */
  private runLimits(runId: string): RunBudgetLimits {
    const run = requireRow(
      this.ctx.db
        .select({
          maxCostUsd: runs.maxCostUsd,
          maxTokens: runs.maxTokens,
          maxAttempts: runs.maxAttempts,
          finalReserveCostUsd: runs.finalReserveCostUsd,
          finalReserveTokens: runs.finalReserveTokens,
          finalReserveAttempts: runs.finalReserveAttempts,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .get(),
      "Run",
      runId,
    );
    return {
      baseLimit: { costUsd: run.maxCostUsd, tokens: run.maxTokens, attempts: run.maxAttempts },
      baseFinalReserve: { costUsd: run.finalReserveCostUsd, tokens: run.finalReserveTokens, attempts: run.finalReserveAttempts },
      increases: this.increases.totalsByRun(runId as RunId),
    };
  }

  // -------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------

  /**
   * Reserves `amount` for `child` from `parent`'s ordinary capacity,
   * rejecting over-reservation. A Run-level reservation draws from the
   * ordinary partition bounded by global availability; this entry point can
   * never draw from the final reserve, and `run → invocation` is not an
   * ordinary pair.
   */
  reserveOrdinary(input: ReserveOrdinaryInput, options?: WriteOptions): BudgetReservation {
    const amount = parseOrThrow(allocationSchema, input.amount, "reservation amount");
    if (!isReservationPair(input.parent.type, input.child.type) || (input.parent.type === "run" && input.child.type === "invocation")) {
      throw new ValidationError(`a ${input.parent.type} cannot hold an ordinary reservation for a ${input.child.type}`, {
        parent: input.parent,
        child: input.child,
      });
    }
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, input.runId);
      this.assertOwnership(input.parent, input.child, run.id);
      if (input.child.type === "invocation") {
        const invocation = requireRow(this.ctx.db.select({ allocationSource: invocations.allocationSource }).from(invocations).where(eq(invocations.id, input.child.id)).get(), "Invocation", input.child.id);
        if (invocation.allocationSource !== "plan_node") {
          throw new InvariantViolationError(`Invocation ${input.child.id} is funded from the Run final reserve, not from its Plan Node`, { allocationSource: invocation.allocationSource });
        }
      }
      if (this.activeForChild(input.child)) {
        throw new ConflictError(`${input.child.type} ${input.child.id} already holds an active reservation`);
      }
      const available = input.parent.type === "run" ? this.runCapacity(run.id).ordinary.effectiveAvailable : this.capacity(input.parent).available;
      if (!allocationFits(amount, available)) {
        throw new InsufficientCapacityError(
          `${input.parent.type} ${input.parent.id} has insufficient unreserved ordinary capacity for ${input.child.type} ${input.child.id}`,
          { requested: amount, available, capacitySource: "ordinary" },
        );
      }
      return this.insert(run.id, input.parent, input.child, amount, "ordinary", null, null, options);
    });
  }

  /**
   * Funds a persisted final-reserve Invocation directly from the Run's final
   * reserve, bounded by global availability. The Invocation row is the
   * authorization: it must name `allocationSource: run_final_reserve` and a
   * `finalReserveUse` whose required role and purpose it holds, belong to
   * this Run, sit on the Run's root Plan Node, carry a non-zero Attempt
   * allocation, and hold no other active reservation. The amount reserved
   * is exactly the Invocation's own allocation. No Task transfer is
   * possible.
   */
  reserveFinalInvocation(input: ReserveFinalInvocationInput, options?: WriteOptions): BudgetReservation {
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, input.runId);
      const invocation = requireRow(
        this.ctx.db
          .select({
            runId: invocations.runId,
            planNodeId: invocations.planNodeId,
            role: invocations.role,
            purpose: invocations.purpose,
            allocationSource: invocations.allocationSource,
            finalReserveUse: invocations.finalReserveUse,
            taskIds: invocations.taskIds,
            costUsd: invocations.allocCostUsd,
            tokens: invocations.allocTokens,
            attempts: invocations.allocAttempts,
          })
          .from(invocations)
          .where(eq(invocations.id, input.invocationId))
          .get(),
        "Invocation",
        input.invocationId,
      );
      assertSameRun("Invocation", input.invocationId, invocation.runId, run.id);
      if (invocation.allocationSource !== "run_final_reserve" || invocation.finalReserveUse === null) {
        throw new InvariantViolationError(`Invocation ${input.invocationId} is not funded from the Run final reserve`, { allocationSource: invocation.allocationSource });
      }
      const use = invocation.finalReserveUse as FinalReserveUse;
      const binding = FINAL_RESERVE_USE_BINDINGS[use];
      if (invocation.role !== binding.role || invocation.purpose !== binding.purpose) {
        throw new InvariantViolationError(`final-reserve use ${use} requires ${binding.role}/${binding.purpose}, not ${invocation.role}/${invocation.purpose}`);
      }
      const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, sourcePath: planNodes.sourcePath }).from(planNodes).where(eq(planNodes.id, invocation.planNodeId)).get(), "PlanNode", invocation.planNodeId);
      if (node.runId !== run.id || node.sourcePath !== ROOT_SOURCE_PATH) {
        throw new InvariantViolationError(`a final-reserve Invocation belongs to the Run's root Plan Node, not ${invocation.planNodeId}`);
      }
      if (invocation.taskIds.length > 0) throw new InvariantViolationError("a final-reserve Invocation executes no Task and transfers no Task reservation");
      const amount = parseOrThrow(allocationSchema, { costUsd: invocation.costUsd, tokens: invocation.tokens, attempts: invocation.attempts }, "final-reserve allocation");
      if (amount.attempts < 1) throw new ValidationError("a final-reserve Invocation needs a non-zero Attempt allocation", { amount });
      const child: ReservationChildRef = { type: "invocation", id: input.invocationId };
      if (this.activeForChild(child)) throw new ConflictError(`Invocation ${input.invocationId} already holds an active reservation`);
      const available = this.runCapacity(run.id).final.effectiveAvailable;
      if (!allocationFits(amount, available)) {
        throw new InsufficientCapacityError(`Run ${run.id} has insufficient final reserve for ${use} Invocation ${input.invocationId}`, {
          requested: amount,
          available,
          capacitySource: "final_reserve",
          finalReserveUse: use,
        });
      }
      return this.insert(run.id, { type: "run", id: run.id }, child, amount, "final_reserve", use, null, options);
    });
  }

  /**
   * Releases an active reservation once, recording the child's complete
   * actual consumption and the reason. A reservation gates whether work may
   * start; it is not a cap on what is recorded afterwards. Actual
   * consumption may exceed the reserved amounts (a provider overran its
   * estimate), in which case the parent's available capacity goes negative
   * and no further reservation fits until capacity is raised. The reserved
   * amounts are never altered.
   */
  release(id: BudgetReservationId, reason: ReservationReleaseReason, consumed: Allocation, options?: WriteOptions): BudgetReservation {
    const finalConsumed = parseOrThrow(allocationSchema, consumed, "consumed allocation");
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.status !== "active") {
        throw new ConflictError(`BudgetReservation ${id} is already released`, { id, releaseReason: current.releaseReason });
      }
      const run = loadRunRef(this.ctx, current.runId);
      const releasedAt = this.ctx.clock();
      this.ctx.journal.append({
        type: "budget_reservation.released",
        scope: runScope(run),
        subjectType: "budget_reservation",
        subjectId: id,
        payload: { reservationId: id, releaseReason: reason, consumed: finalConsumed },
        ...writeMeta(options),
      });
      this.ctx.db
        .update(budgetReservations)
        .set({
          status: "released",
          releasedAt,
          releaseReason: reason,
          consumedCostUsd: finalConsumed.costUsd,
          consumedTokens: finalConsumed.tokens,
          consumedAttempts: finalConsumed.attempts,
        })
        .where(eq(budgetReservations.id, id))
        .run();
      return this.get(id);
    });
  }

  /**
   * Turns a Coordinator Task's reservation into its Worker Invocation's
   * reservation with two auditable rows in one transaction: the Task row is
   * released (`transferred_to_invocation`, consumed zero) and a new row for
   * the same amount is created for the Invocation, naming the released row.
   * The parent's reserved sum is unchanged throughout; capacity is never
   * free or doubly reserved. Only a Plan-Node-funded Invocation may receive
   * a transfer.
   */
  transferTaskToInvocation(
    taskReservationId: BudgetReservationId,
    invocationId: InvocationId,
    options?: WriteOptions,
  ): { released: BudgetReservation; created: BudgetReservation } {
    return this.ctx.tx.write(() => {
      const taskReservation = this.get(taskReservationId);
      if (taskReservation.child.type !== "task") {
        throw new ValidationError(`BudgetReservation ${taskReservationId} is not a Task reservation`);
      }
      if (taskReservation.status !== "active") {
        throw new ConflictError(`Task reservation ${taskReservationId} is already released`);
      }
      const invocation = requireRow(
        this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId, allocationSource: invocations.allocationSource }).from(invocations).where(eq(invocations.id, invocationId)).get(),
        "Invocation",
        invocationId,
      );
      assertSameRun("Invocation", invocationId, invocation.runId, taskReservation.runId);
      if (invocation.allocationSource !== "plan_node") {
        throw new InvariantViolationError(`Invocation ${invocationId} is funded from the Run final reserve and cannot receive a Task reservation`);
      }
      if (taskReservation.parent.type !== "plan_node" || invocation.planNodeId !== taskReservation.parent.id) {
        throw new InvariantViolationError(`Invocation ${invocationId} does not belong to the Task reservation's Plan Node`);
      }
      if (this.activeForChild({ type: "invocation", id: invocationId })) {
        throw new ConflictError(`Invocation ${invocationId} already holds an active reservation`);
      }
      const released = this.release(taskReservationId, "transferred_to_invocation", { ...ZERO_ALLOCATION }, options);
      const run = loadRunRef(this.ctx, taskReservation.runId);
      const created = this.insert(
        run.id,
        taskReservation.parent,
        { type: "invocation", id: invocationId },
        taskReservation.reserved,
        "ordinary",
        null,
        taskReservationId,
        options,
      );
      return { released, created };
    });
  }

  private insert(
    runId: RunId,
    parent: ReservationParentRef,
    child: ReservationChildRef,
    amount: Allocation,
    capacitySource: ReservationCapacitySource,
    finalReserveUse: FinalReserveUse | null,
    transferredFromReservationId: BudgetReservationId | null,
    options?: WriteOptions,
  ): BudgetReservation {
    const run = loadRunRef(this.ctx, runId);
    const reservation: BudgetReservation = {
      id: this.ctx.ids("budgetReservation"),
      runId,
      parent,
      child,
      reserved: amount,
      consumed: null,
      capacitySource,
      finalReserveUse,
      status: "active",
      transferredFromReservationId,
      createdAt: this.ctx.clock(),
      releasedAt: null,
      releaseReason: null,
    };
    parseOrThrow(budgetReservationSchema, reservation, "BudgetReservation");
    this.ctx.journal.append({
      type: "budget_reservation.created",
      scope: runScope(run, {
        planNodeId: parent.type === "plan_node" ? parent.id : child.type === "plan_node" ? child.id : null,
        invocationId: child.type === "invocation" ? child.id : null,
      }),
      subjectType: "budget_reservation",
      subjectId: reservation.id,
      payload: reservation,
      ...writeMeta(options),
    });
    this.ctx.db
      .insert(budgetReservations)
      .values({
        id: reservation.id,
        runId,
        parentType: parent.type,
        parentId: parent.id,
        childType: child.type,
        childId: child.id,
        reservedCostUsd: amount.costUsd,
        reservedTokens: amount.tokens,
        reservedAttempts: amount.attempts,
        consumedCostUsd: null,
        consumedTokens: null,
        consumedAttempts: null,
        capacitySource,
        finalReserveUse,
        status: "active",
        transferredFromReservationId,
        createdAt: reservation.createdAt,
        releasedAt: null,
        releaseReason: null,
      })
      .run();
    return reservation;
  }

  private assertOwnership(parent: ReservationParentRef, child: ReservationChildRef, runId: RunId): void {
    const check = (what: string, id: string, actualRunId: string | undefined) => {
      if (actualRunId === undefined) throw new NotFoundError(what, id);
      assertSameRun(what, id, actualRunId, runId);
    };
    switch (parent.type) {
      case "run":
        if (parent.id !== runId) throw new InvariantViolationError(`reservation parent Run ${parent.id} is not Run ${runId}`);
        break;
      case "plan_node":
        check("PlanNode", parent.id, this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, parent.id)).get()?.runId);
        break;
      case "invocation":
        check("Invocation", parent.id, this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, parent.id)).get()?.runId);
        break;
    }
    switch (child.type) {
      case "plan_node":
        check("PlanNode", child.id, this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, child.id)).get()?.runId);
        break;
      case "invocation":
        check("Invocation", child.id, this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, child.id)).get()?.runId);
        break;
      case "task":
        check("Task", child.id, this.ctx.db.select({ runId: tasks.runId }).from(tasks).where(eq(tasks.id, child.id)).get()?.runId);
        break;
    }
  }
}
