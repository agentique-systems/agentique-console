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

/** The parent/child pairs the architecture defines; anything else is rejected. */
export const RESERVATION_PAIRS: ReadonlyArray<readonly [ReservationParentType, ReservationChildType]> = [
  ["run", "plan_node"],
  ["plan_node", "invocation"],
  ["plan_node", "task"],
];

export function isReservationPair(parent: ReservationParentType, child: ReservationChildType): boolean {
  return RESERVATION_PAIRS.some(([p, c]) => p === parent && c === child);
}

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
  .refine(
    (r) =>
      r.status === "released"
        ? r.releasedAt !== null && r.releaseReason !== null && r.consumed !== null
        : r.releasedAt === null && r.releaseReason === null && r.consumed === null,
    { message: "release fields are set exactly when the reservation is released", path: ["status"] },
  );

/** Capacity of a parent as seen by reservation accounting. */
export interface CapacityAccount {
  limit: Allocation;
  /** Sum of `active` reservations. */
  reserved: Allocation;
  /** Sum of released reservations' consumed amounts plus the parent's own direct consumption. */
  consumed: Allocation;
  /** `limit - reserved - consumed`. */
  available: Allocation;
}

export function capacityAccount(limit: Allocation, reserved: Allocation, consumed: Allocation): CapacityAccount {
  return { limit, reserved, consumed, available: subtractAllocation(subtractAllocation(limit, reserved), consumed) };
}
