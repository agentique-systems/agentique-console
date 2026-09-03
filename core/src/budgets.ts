import { z } from "zod";
import { DomainError } from "./errors.ts";
import type { AllocationExtensionId, BudgetIncreaseId, BudgetReservationId, DecisionId, InvocationId, PlanNodeId, RunId, TaskId } from "./ids.ts";
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
  /** Sum of active charges (`max(reserved, actual)`): what active children currently count for. */
  active: Allocation;
  /** `active + consumed`: everything currently counted against the limit. */
  committed: Allocation;
  /** `limit - committed`; negative when the parent has overrun. */
  available: Allocation;
}

/** One active or released child as accounting sees it. */
export interface ReservationCharge {
  status: ReservationStatus;
  /** The effective reserved allocation: the immutable original amounts plus every Allocation Extension of the reservation. */
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
  let active: Allocation = { ...ZERO_ALLOCATION };
  for (const charge of charges) {
    if (charge.status === "active") {
      reserved = addAllocation(reserved, charge.reserved);
      active = addAllocation(active, reservationCharge(charge));
    } else {
      consumed = addAllocation(consumed, charge.actual);
    }
  }
  const committed = addAllocation(active, consumed);
  return { limit, reserved, consumed, active, committed, available: subtractAllocation(limit, committed) };
}

/** A partition of the Run Budget: its own account plus availability bounded by the global Run account. */
export interface PartitionAccount extends CapacityAccount {
  /** `min(available, global available)`, component-wise: what may still be reserved from this partition. */
  effectiveAvailable: Allocation;
}

/** The approved Budget Increases of a Run, summed per partition. */
export interface RunBudgetIncreases {
  ordinary: Allocation;
  finalReserve: Allocation;
}

export const NO_BUDGET_INCREASES: Readonly<RunBudgetIncreases> = Object.freeze({ ordinary: ZERO_ALLOCATION, finalReserve: ZERO_ALLOCATION });

/**
 * The immutable base limits of a Run Budget together with its approved
 * Budget Increases: everything the effective limits derive from. No
 * effective aggregate is stored anywhere.
 */
export interface RunBudgetLimits {
  /** The Run Budget supplied at creation (cost, tokens, Attempts): immutable. */
  baseLimit: Allocation;
  /** The final reserve chosen at creation: immutable. */
  baseFinalReserve: Allocation;
  increases: RunBudgetIncreases;
}

/**
 * A Run's capacity as two disjoint partitions of its effective Budget: the
 * ordinary pool that compiled Plan Node allocations draw from, and the final
 * reserve that only `final_synthesis` and `run_completion` consumers may
 * draw from. Every limit is derived:
 *
 *   effective global limit        = base limit + ordinary increases + final-reserve increases
 *   effective final-reserve limit = base final reserve + final-reserve increases
 *   effective ordinary limit      = effective global limit − effective final-reserve limit
 *
 * Each partition is accounted from its own reservations, so the reserve is
 * never double-counted as an ordinary child reservation and is never
 * represented as fabricated Usage. Nothing here stores an aggregate.
 */
export interface RunCapacity {
  /** The immutable base global limit. */
  baseLimit: Allocation;
  /** The immutable base final-reserve limit. */
  baseFinalReserve: Allocation;
  /** The approved Budget Increases, per partition. */
  increases: RunBudgetIncreases;
  /** The effective global limit. */
  limit: Allocation;
  /** The effective final-reserve limit. */
  finalReserve: Allocation;
  /** The whole effective Run Budget against every Run-level child of either partition. */
  global: CapacityAccount;
  /** The effective ordinary limit against the Plan Node children. */
  ordinary: PartitionAccount;
  /** The effective final-reserve limit against the final-reserve Invocations. */
  final: PartitionAccount;
}

/**
 * The global and partition accounts of a Run. The ordinary pool and the
 * final reserve are allocation partitions of one Budget, not independent
 * Budgets: a partition may reserve only what both its local availability
 * and the global availability permit, so an overrun in either partition is
 * felt by the other, while neither may claim the other's unused capacity.
 * An `ordinary` Budget Increase enlarges the global and ordinary limits; a
 * `final_reserve` increase enlarges the global and final-reserve limits.
 */
export function runCapacityAccount(budget: RunBudgetLimits, ordinary: Iterable<ReservationCharge>, final: Iterable<ReservationCharge>): RunCapacity {
  const ordinaryCharges = [...ordinary];
  const finalCharges = [...final];
  const limit = addAllocation(addAllocation(budget.baseLimit, budget.increases.ordinary), budget.increases.finalReserve);
  const finalReserve = addAllocation(budget.baseFinalReserve, budget.increases.finalReserve);
  const global = capacityAccount(limit, [...ordinaryCharges, ...finalCharges]);
  const partition = (account: CapacityAccount): PartitionAccount => ({ ...account, effectiveAvailable: minAllocation(account.available, global.available) });
  return {
    baseLimit: budget.baseLimit,
    baseFinalReserve: budget.baseFinalReserve,
    increases: budget.increases,
    limit,
    finalReserve,
    global,
    ordinary: partition(capacityAccount(subtractAllocation(limit, finalReserve), ordinaryCharges)),
    final: partition(capacityAccount(finalReserve, finalCharges)),
  };
}

// ---------------------------------------------------------------------------
// Budget Increases and Allocation Extensions (execution-model §7.6)
// ---------------------------------------------------------------------------

/** True when no quantity of `a` is negative. */
export function allocationNonNegative(a: Allocation): boolean {
  return a.costUsd >= 0 && a.tokens >= 0 && a.attempts >= 0;
}

/** True when at least one quantity of `a` is positive. */
export function allocationHasPositive(a: Allocation): boolean {
  return a.costUsd > 0 || a.tokens > 0 || a.attempts > 0;
}

/** Cost differences below this bound are float noise, never a shortfall. */
const COST_TOLERANCE = 1e-9;

/**
 * The exact component-wise amount by which `required` exceeds `available`:
 * `max(0, required − available)` per quantity, zero where the requirement is
 * covered. This is the minimum Allocation Extension that funds `required`
 * from `available`; nothing is rounded up and no spare capacity is added.
 */
export function allocationShortfall(required: Allocation, available: Allocation): Allocation {
  const cost = required.costUsd - available.costUsd;
  return {
    costUsd: cost > COST_TOLERANCE ? cost : 0,
    tokens: Math.max(0, required.tokens - available.tokens),
    attempts: Math.max(0, required.attempts - available.attempts),
  };
}

/** The sum of a set of Allocations. */
export function sumAllocations(items: Iterable<Allocation>): Allocation {
  let total: Allocation = { ...ZERO_ALLOCATION };
  for (const item of items) total = addAllocation(total, item);
  return total;
}

/** A non-negative Allocation of which at least one quantity is positive: what a Budget Increase or an Allocation Extension adds. */
export const addedAllocationSchema: z.ZodType<Allocation> = allocationSchema.refine(allocationHasPositive, { message: "at least one added quantity is positive" });

/**
 * The partition of the Run Budget a Budget Increase enlarges. An `ordinary`
 * increase expands the effective global limit and therefore ordinary
 * capacity without touching the final reserve; a `final_reserve` increase
 * expands the effective global limit and the final-reserve partition
 * together.
 */
export const BUDGET_INCREASE_PARTITIONS = ["ordinary", "final_reserve"] as const;
export type BudgetIncreasePartition = (typeof BUDGET_INCREASE_PARTITIONS)[number];

/**
 * An operator-approved, append-only enlargement of a Run's effective Budget
 * (execution-model §7.6). The Budget supplied at Run creation is the
 * immutable base Budget; a Budget Increase never rewrites it, never reduces,
 * revokes, replaces, or expires earlier capacity, never creates Usage,
 * never changes an existing Invocation's allocation, and never extends a
 * wall-clock deadline or concurrency limit. Exactly one exists per approved
 * `budget_increase` Decision.
 */
export interface BudgetIncrease {
  id: BudgetIncreaseId;
  runId: RunId;
  /** The operator-resolved `budget_increase` Decision that authorized exactly this increase. */
  decisionId: DecisionId;
  partition: BudgetIncreasePartition;
  /** The exact quantities added; non-negative, at least one positive. */
  added: Allocation;
  createdAt: Timestamp;
}

export const budgetIncreaseSchema: z.ZodType<BudgetIncrease> = z.strictObject({
  id: idSchema("budgetIncrease"),
  runId: idSchema("run"),
  decisionId: idSchema("decision"),
  partition: z.enum(BUDGET_INCREASE_PARTITIONS),
  added: addedAllocationSchema,
  createdAt: timestampSchema,
});

export interface BudgetIncreaseInput {
  runId: RunId;
  decisionId: DecisionId;
  partition: BudgetIncreasePartition;
  added: Allocation;
}

export const budgetIncreaseInputSchema: z.ZodType<BudgetIncreaseInput> = z.strictObject({
  runId: idSchema("run"),
  decisionId: idSchema("decision"),
  partition: z.enum(BUDGET_INCREASE_PARTITIONS),
  added: addedAllocationSchema,
});

/**
 * The closed runtime call sites that may extend a Plan Node's allocation:
 * an ordinary Pattern Invocation (`invocation`), a Coordinator's accepted
 * Task batch (`task_batch`), a `node_exit` Gate Evaluator
 * (`gate_evaluator`), the root's batched `gate_result` remediation turn
 * (`gate_remediation`), any other root Orchestrator turn (`root_turn`), and
 * the follow-up turn of a signoff `request_changes` (`signoff_follow_up`).
 */
export const ALLOCATION_EXTENSION_TRIGGERS = ["invocation", "task_batch", "gate_evaluator", "gate_remediation", "root_turn", "signoff_follow_up"] as const;
export type AllocationExtensionTrigger = (typeof ALLOCATION_EXTENSION_TRIGGERS)[number];

/**
 * A deterministic, append-only transfer of existing ordinary Run capacity to
 * one active Plan Node reservation (execution-model §7.6). It is not a second
 * reservation: it raises the effective reserved allocation of the Plan Node's
 * one active `Run → Plan Node` reservation by exactly the component-wise
 * shortfall the triggering work needed, never drawing from the final
 * reserve, never creating Usage, and never changing the reservation's
 * immutable original amounts or an existing Invocation's allocation. Once the
 * reservation is released its recorded consumption is the whole charge, and
 * the extension remains as provenance only.
 */
export interface AllocationExtension {
  id: AllocationExtensionId;
  runId: RunId;
  planNodeId: PlanNodeId;
  /** The Plan Node's active ordinary `Run → Plan Node` reservation the extension raises. */
  reservationId: BudgetReservationId;
  /** The exact quantities added; non-negative, at least one positive. */
  added: Allocation;
  trigger: AllocationExtensionTrigger;
  createdAt: Timestamp;
}

export const allocationExtensionSchema: z.ZodType<AllocationExtension> = z.strictObject({
  id: idSchema("allocationExtension"),
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  reservationId: idSchema("budgetReservation"),
  added: addedAllocationSchema,
  trigger: z.enum(ALLOCATION_EXTENSION_TRIGGERS),
  createdAt: timestampSchema,
});

export interface AllocationExtensionInput {
  runId: RunId;
  planNodeId: PlanNodeId;
  added: Allocation;
  trigger: AllocationExtensionTrigger;
}

export const allocationExtensionInputSchema: z.ZodType<AllocationExtensionInput> = z.strictObject({
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  added: addedAllocationSchema,
  trigger: z.enum(ALLOCATION_EXTENSION_TRIGGERS),
});

/**
 * The effective allocation of one Plan Node, from rows: the immutable
 * original reservation, every Allocation Extension of it in creation order,
 * their sum, the effective reserved allocation, and the node's account over
 * that effective limit.
 */
export interface PlanNodeAllocationProjection {
  planNodeId: PlanNodeId;
  reservationId: BudgetReservationId | null;
  reservationStatus: ReservationStatus | null;
  /** The reservation's immutable original amounts (the node's compiled allocation). */
  original: Allocation;
  extensions: AllocationExtension[];
  /** Σ extensions. */
  extended: Allocation;
  /** `original + extended`: what the node may reserve for its children in total. */
  effective: Allocation;
  account: CapacityAccount;
}

/** Why the Budget Increase service refuses an operation before writing anything; every code names a canonical fact. */
export const BUDGET_INCREASE_REFUSAL_CODES = [
  /** The Run is terminal; no Budget Increase is requested or approved for it. */
  "run_terminal",
  /** The Run's status does not admit an increase of the named partition (a final-reserve increase once verification began). */
  "partition_not_increasable",
  /** The requested quantities are not a non-negative Allocation with at least one positive quantity. */
  "invalid_increase",
  /** The named Decision is not a `budget_increase` Decision of the Run, or its subject names other facts. */
  "decision_mismatch",
  /** The rows of the increase boundary disagree with one another. */
  "boundary_inconsistent",
  /** The Decision was already resolved with the other option. */
  "conflicting_resolution",
  /** The Run already has an open `budget_increase` Decision asking for something else; one open increase Decision exists per Run. */
  "budget_increase_decision_open",
] as const;
export type BudgetIncreaseRefusalCode = (typeof BUDGET_INCREASE_REFUSAL_CODES)[number];

/** A refused Budget Increase operation: the closed code and bounded details (ids and closed facts only). */
export class BudgetIncreaseRefusedError extends DomainError {
  readonly refusal: BudgetIncreaseRefusalCode;

  constructor(refusal: BudgetIncreaseRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, { refusal, ...details });
    this.refusal = refusal;
  }
}
