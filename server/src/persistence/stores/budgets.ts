import { and, eq } from "drizzle-orm";
import {
  addAllocation,
  allocationFits,
  allocationSchema,
  budgetReservationSchema,
  capacityAccount,
  ConflictError,
  InsufficientCapacityError,
  InvariantViolationError,
  isReservationPair,
  NotFoundError,
  parseOrThrow,
  ValidationError,
  ZERO_ALLOCATION,
  type Allocation,
  type BudgetReservation,
  type BudgetReservationId,
  type CapacityAccount,
  type InvocationId,
  type ReservationChildRef,
  type ReservationParentRef,
  type ReservationReleaseReason,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { budgetReservations, invocations, planNodes, runs, tasks } from "../schema.ts";
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
      status: row.status,
      transferredFromReservationId: row.transferredFromReservationId,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt,
      releaseReason: row.releaseReason,
    },
    "BudgetReservation row",
  );
}

export interface ReserveInput {
  runId: RunId;
  parent: ReservationParentRef;
  child: ReservationChildRef;
  amount: Allocation;
}

/**
 * Atomic allocation accounting over `budget_reservations`. Reservations are
 * the only record of allocation; limits live on the bounded objects and are
 * read here to compute capacity.
 */
export class BudgetReservationStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly usage: UsageStore,
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

  /** The limit of a parent as an Allocation, read from the bounded object. */
  limitOf(parent: ReservationParentRef): Allocation {
    switch (parent.type) {
      case "run": {
        const run = requireRow(
          this.ctx.db.select({ maxCostUsd: runs.maxCostUsd, maxTokens: runs.maxTokens, maxAttempts: runs.maxAttempts }).from(runs).where(eq(runs.id, parent.id)).get(),
          "Run",
          parent.id,
        );
        return { costUsd: run.maxCostUsd, tokens: run.maxTokens, attempts: run.maxAttempts };
      }
      case "plan_node": {
        const node = requireRow(
          this.ctx.db.select({ costUsd: planNodes.allocCostUsd, tokens: planNodes.allocTokens, attempts: planNodes.allocAttempts }).from(planNodes).where(eq(planNodes.id, parent.id)).get(),
          "PlanNode",
          parent.id,
        );
        return node;
      }
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
   * Unreserved capacity = limit − Σ active reserved − Σ released consumed −
   * the parent's own direct consumption (an Invocation's Attempts). Released
   * consumption is actual, not clamped, so `available` is signed: a
   * negative value is a visible overrun and rejects every new reservation.
   */
  capacity(parent: ReservationParentRef): CapacityAccount {
    const limit = this.limitOf(parent);
    let reserved: Allocation = { ...ZERO_ALLOCATION };
    let consumed: Allocation = { ...ZERO_ALLOCATION };
    for (const reservation of this.listByParent(parent)) {
      if (reservation.status === "active") reserved = addAllocation(reserved, reservation.reserved);
      else if (reservation.consumed) consumed = addAllocation(consumed, reservation.consumed);
    }
    if (parent.type === "invocation") {
      consumed = addAllocation(consumed, this.usage.consumedByInvocation(parent.id));
    }
    return capacityAccount(limit, reserved, consumed);
  }

  /** Reserves `amount` for `child` from `parent`, rejecting over-reservation. */
  reserve(input: ReserveInput, options?: WriteOptions): BudgetReservation {
    const amount = parseOrThrow(allocationSchema, input.amount, "reservation amount");
    if (!isReservationPair(input.parent.type, input.child.type)) {
      throw new ValidationError(`a ${input.parent.type} cannot hold a reservation for a ${input.child.type}`, {
        parent: input.parent,
        child: input.child,
      });
    }
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, input.runId);
      this.assertOwnership(input.parent, input.child, run.id);
      if (this.activeForChild(input.child)) {
        throw new ConflictError(`${input.child.type} ${input.child.id} already holds an active reservation`);
      }
      const account = this.capacity(input.parent);
      if (!allocationFits(amount, account.available)) {
        throw new InsufficientCapacityError(
          `${input.parent.type} ${input.parent.id} has insufficient unreserved capacity for ${input.child.type} ${input.child.id}`,
          { requested: amount, available: account.available },
        );
      }
      return this.insert(run.id, input.parent, input.child, amount, null, options);
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
   * free or doubly reserved.
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
        this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId }).from(invocations).where(eq(invocations.id, invocationId)).get(),
        "Invocation",
        invocationId,
      );
      assertSameRun("Invocation", invocationId, invocation.runId, taskReservation.runId);
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
