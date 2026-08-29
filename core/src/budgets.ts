import { z } from "zod";
import type { BudgetReservationId, InvocationId, PlanNodeId, RunId, TaskId } from "./ids.ts";
import { count, idSchema, positiveCount, quantity, timestampSchema, type Timestamp } from "./validation.ts";

/**
 * A Budget is a set of limits stored on the object it bounds (Run, Plan
 * Node, Invocation). Cost, tokens, and Attempts are reserved quantities;
 * wall-clock and concurrency are limits enforced by the runtime and the
 * Resource Governor and are never reserved.
 */
export interface BudgetLimits {
  maxCostUsd: number;
  maxTokens: number;
  maxAttempts: number;
  maxWallClockMs: number | null;
  maxConcurrency: number | null;
}

export const budgetLimitsSchema: z.ZodType<BudgetLimits> = z.strictObject({
  maxCostUsd: quantity,
  maxTokens: count,
  maxAttempts: count,
  maxWallClockMs: positiveCount.nullable(),
  maxConcurrency: positiveCount.nullable(),
});

/** The three reservable quantities. */
export interface Allocation {
  costUsd: number;
  tokens: number;
  attempts: number;
}

export const allocationSchema: z.ZodType<Allocation> = z.strictObject({
  costUsd: quantity,
  tokens: count,
  attempts: count,
});

export const ZERO_ALLOCATION: Readonly<Allocation> = Object.freeze({ costUsd: 0, tokens: 0, attempts: 0 });

export function addAllocation(a: Allocation, b: Allocation): Allocation {
  return { costUsd: a.costUsd + b.costUsd, tokens: a.tokens + b.tokens, attempts: a.attempts + b.attempts };
}

export function subtractAllocation(a: Allocation, b: Allocation): Allocation {
  return { costUsd: a.costUsd - b.costUsd, tokens: a.tokens - b.tokens, attempts: a.attempts - b.attempts };
}

/** Component-wise maximum: what an active child is charged once its actual consumption exceeds its reservation. */
export function maxAllocation(a: Allocation, b: Allocation): Allocation {
  return { costUsd: Math.max(a.costUsd, b.costUsd), tokens: Math.max(a.tokens, b.tokens), attempts: Math.max(a.attempts, b.attempts) };
}

/** Component-wise minimum: a partition's availability bounded by the global Run availability. */
export function minAllocation(a: Allocation, b: Allocation): Allocation {
  return { costUsd: Math.min(a.costUsd, b.costUsd), tokens: Math.min(a.tokens, b.tokens), attempts: Math.min(a.attempts, b.attempts) };
}

/** True when every quantity of `needed` is covered by `available`. */
export function allocationFits(needed: Allocation, available: Allocation): boolean {
  return (
    needed.costUsd <= available.costUsd + 1e-9 &&
    needed.tokens <= available.tokens &&
    needed.attempts <= available.attempts
  );
}

export function allocationOfLimits(limits: BudgetLimits): Allocation {
  return { costUsd: limits.maxCostUsd, tokens: limits.maxTokens, attempts: limits.maxAttempts };
}

/** What a Plan Node or Invocation does when its allocation is exhausted. */
export const ON_ALLOCATION_EXHAUSTED_POLICIES = ["fail", "wait", "extend"] as const;
export type OnAllocationExhausted = (typeof ON_ALLOCATION_EXHAUSTED_POLICIES)[number];

/** The bounded objects that can hold a reservation pool. */
export const RESERVATION_PARENT_TYPES = ["run", "plan_node", "invocation"] as const;
export type ReservationParentType = (typeof RESERVATION_PARENT_TYPES)[number];

/** The objects (or proposed work items) a reservation is made for. */
export const RESERVATION_CHILD_TYPES = ["plan_node", "invocation", "task"] as const;
export type ReservationChildType = (typeof RESERVATION_CHILD_TYPES)[number];

/**
 * The parent/child pairs the architecture defines; anything else is rejected.
 * `run → invocation` exists only for an Invocation funded from the Run's
 * final reserve (`InvocationAllocationSource` `run_final_reserve`).
 */
export const RESERVATION_PAIRS: ReadonlyArray<readonly [ReservationParentType, ReservationChildType]> = [
  ["run", "plan_node"],
  ["run", "invocation"],
  ["plan_node", "invocation"],
  ["plan_node", "task"],
];

export function isReservationPair(parent: ReservationParentType, child: ReservationChildType): boolean {
  return RESERVATION_PAIRS.some(([p, c]) => p === parent && c === child);
}

/**
 * Which partition of a Run's capacity a Run-level reservation draws from:
 * the ordinary pool (the Run Budget less the persisted final reserve) or the
 * final reserve itself. Only the two consumers the architecture names may
 * draw from the final reserve; reservations below the Run are unpartitioned
 * and always `ordinary`.
 */
export const RESERVATION_CAPACITY_SOURCES = ["ordinary", "final_reserve"] as const;
export type ReservationCapacitySource = (typeof RESERVATION_CAPACITY_SOURCES)[number];

/**
 * The two uses the architecture permits to spend the Run's final reserve
 * (execution-model §7.6): the Orchestrator's `final_synthesis` Invocation
 * and a `run_completion` Gate's Evaluator Invocation. Nothing else may.
 */
export const FINAL_RESERVE_USES = ["final_synthesis", "run_completion"] as const;
export type FinalReserveUse = (typeof FINAL_RESERVE_USES)[number];

export const RESERVATION_STATUSES = ["active", "released"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_RELEASE_REASONS = [
  "child_terminal",
  "transferred_to_invocation",
  "task_cancelled",
  "task_rejected",
  "plan_revision_cancelled",
  "run_cancelled",
] as const;
export type ReservationReleaseReason = (typeof RESERVATION_RELEASE_REASONS)[number];

export type ReservationParentRef =
  | { type: "run"; id: RunId }
  | { type: "plan_node"; id: PlanNodeId }
  | { type: "invocation"; id: InvocationId };

export type ReservationChildRef =
  | { type: "plan_node"; id: PlanNodeId }
  | { type: "invocation"; id: InvocationId }
  | { type: "task"; id: TaskId };

export const reservationParentRefSchema: z.ZodType<ReservationParentRef> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run"), id: idSchema("run") }),
  z.strictObject({ type: z.literal("plan_node"), id: idSchema("planNode") }),
  z.strictObject({ type: z.literal("invocation"), id: idSchema("invocation") }),
]);

export const reservationChildRefSchema: z.ZodType<ReservationChildRef> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("plan_node"), id: idSchema("planNode") }),
  z.strictObject({ type: z.literal("invocation"), id: idSchema("invocation") }),
  z.strictObject({ type: z.literal("task"), id: idSchema("task") }),
]);

/**
 * The canonical record of one allocation. Created atomically with its child
 * before the child becomes runnable; released exactly once with its final
 * consumed amounts; never re-pointed. A Task reservation that becomes a
 * Worker Invocation reservation is released with reason
 * `transferred_to_invocation` and a second row is created that names it in
 * `transferredFromReservationId`.
 */
export interface BudgetReservation {
  id: BudgetReservationId;
  runId: RunId;
  parent: ReservationParentRef;
  child: ReservationChildRef;
  reserved: Allocation;
  /** Final consumed amounts, recorded on release; `null` while active. */
  consumed: Allocation | null;
  capacitySource: ReservationCapacitySource;
  /** Why a final-reserve reservation was authorized; `null` for every ordinary reservation. */
  finalReserveUse: FinalReserveUse | null;
  status: ReservationStatus;
  transferredFromReservationId: BudgetReservationId | null;
  createdAt: Timestamp;
  releasedAt: Timestamp | null;
  releaseReason: ReservationReleaseReason | null;
}

export const budgetReservationSchema: z.ZodType<BudgetReservation> = z
  .strictObject({
    id: idSchema("budgetReservation"),
    runId: idSchema("run"),
    parent: reservationParentRefSchema,
    child: reservationChildRefSchema,
    reserved: allocationSchema,
    consumed: allocationSchema.nullable(),
    capacitySource: z.enum(RESERVATION_CAPACITY_SOURCES),
    finalReserveUse: z.enum(FINAL_RESERVE_USES).nullable(),
    status: z.enum(RESERVATION_STATUSES),
    transferredFromReservationId: idSchema("budgetReservation").nullable(),
    createdAt: timestampSchema,
    releasedAt: timestampSchema.nullable(),
    releaseReason: z.enum(RESERVATION_RELEASE_REASONS).nullable(),
  })
  .refine((r) => isReservationPair(r.parent.type, r.child.type), {
    message: "reservation parent/child pair is not defined by the architecture",
    path: ["child"],
  })
  .refine((r) => r.parent.type === "run" || r.capacitySource === "ordinary", {
    message: "only a Run-level reservation can draw from the final reserve",
    path: ["capacitySource"],
  })
  .refine((r) => (r.capacitySource === "final_reserve") === (r.finalReserveUse !== null), {
    message: "a final-reserve reservation records its use; an ordinary one records none",
    path: ["finalReserveUse"],
  })
  .refine((r) => (r.parent.type === "run" && r.child.type === "invocation") === (r.capacitySource === "final_reserve"), {
    message: "a Run funds an Invocation directly only from the final reserve, and the final reserve funds only Invocations",
    path: ["child"],
  })
  .refine((r) => r.capacitySource !== "final_reserve" || r.transferredFromReservationId === null, {
    message: "a final-reserve reservation never transfers from a Task reservation",
    path: ["transferredFromReservationId"],
  })
  .refine(
    (r) =>
      r.status === "released"
        ? r.releasedAt !== null && r.releaseReason !== null && r.consumed !== null
        : r.releasedAt === null && r.releaseReason === null && r.consumed === null,
    { message: "release fields are set exactly when the reservation is released", path: ["status"] },
  );

/**
 * Capacity of a parent as seen by reservation accounting. An active child is
 * charged component-wise `max(reserved, actual attributable consumption so
 * far)`, so an overrun is visible at the parent the moment it happens, not
 * only when the child is released; a released child is charged its recorded
 * complete actual consumption. Nothing is clamped: `available` is signed.
 */
export interface CapacityAccount {
  limit: Allocation;
  /** Sum of `active` reservations' reserved amounts. */
  reserved: Allocation;
  /** Sum of released reservations' consumed amounts plus the parent's own direct consumption. */
  consumed: Allocation;
  /** Sum of active charges (`max(reserved, actual)`) plus `consumed`: everything currently counted against the limit. */
  committed: Allocation;
  /** `limit - committed`; negative when the parent has overrun. */
  available: Allocation;
}

/** One active or released child as accounting sees it. */
export interface ReservationCharge {
  status: ReservationStatus;
  reserved: Allocation;
  /** Actual attributable consumption so far (active) or the recorded complete consumption (released). */
  actual: Allocation;
}

/** The amount a child currently counts for: `max(reserved, actual)` while active, `actual` once released. */
export function reservationCharge(charge: ReservationCharge): Allocation {
  return charge.status === "active" ? maxAllocation(charge.reserved, charge.actual) : charge.actual;
}

export function capacityAccount(limit: Allocation, charges: Iterable<ReservationCharge>, direct: Allocation = ZERO_ALLOCATION): CapacityAccount {
  let reserved: Allocation = { ...ZERO_ALLOCATION };
  let consumed: Allocation = { ...direct };
  let committed: Allocation = { ...direct };
  for (const charge of charges) {
    if (charge.status === "active") reserved = addAllocation(reserved, charge.reserved);
    else consumed = addAllocation(consumed, charge.actual);
    committed = addAllocation(committed, reservationCharge(charge));
  }
  return { limit, reserved, consumed, committed, available: subtractAllocation(limit, committed) };
}

/** A partition of the Run Budget: its own account plus availability bounded by the global Run account. */
export interface PartitionAccount extends CapacityAccount {
  /** `min(available, global available)`, component-wise: what may still be reserved from this partition. */
  effectiveAvailable: Allocation;
}

/**
 * A Run's capacity as two disjoint partitions of its Budget: the ordinary
 * pool that compiled Plan Node allocations draw from, and the persisted final
 * reserve that only `final_synthesis` and `run_completion` consumers may
 * draw from. Each partition is accounted from its own reservations, so the
 * reserve is never double-counted as an ordinary child reservation and is
 * never represented as fabricated Usage.
 */
export interface RunCapacity {
  limit: Allocation;
  finalReserve: Allocation;
  /** The whole Run Budget against every Run-level child of either partition. */
  global: CapacityAccount;
  ordinary: PartitionAccount;
  final: PartitionAccount;
}

/**
 * The global and partition accounts of a Run. The ordinary pool and the
 * final reserve are allocation partitions of one Budget, not independent
 * Budgets: a partition may reserve only what both its local availability
 * and the global availability permit, so an overrun in either partition is
 * felt by the other, while neither may claim the other's unused capacity.
 */
export function runCapacityAccount(limit: Allocation, finalReserve: Allocation, ordinary: Iterable<ReservationCharge>, final: Iterable<ReservationCharge>): RunCapacity {
  const ordinaryCharges = [...ordinary];
  const finalCharges = [...final];
  const global = capacityAccount(limit, [...ordinaryCharges, ...finalCharges]);
  const partition = (account: CapacityAccount): PartitionAccount => ({ ...account, effectiveAvailable: minAllocation(account.available, global.available) });
  return {
    limit,
    finalReserve,
    global,
    ordinary: partition(capacityAccount(subtractAllocation(limit, finalReserve), ordinaryCharges)),
    final: partition(capacityAccount(finalReserve, finalCharges)),
  };
}
