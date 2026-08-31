/**
 * Reservable Plan Node capacity (execution-model §7.6): the one canonical
 * operation every runtime path that creates ordinary node-funded work goes
 * through before it reserves a child — a Pattern Invocation, a Coordinator's
 * Task batch, a `node_exit` Gate Evaluator, a root Orchestrator turn, the
 * root's batched `gate_result` remediation turn, the follow-up turn of a
 * signoff change request, the continuation of a requested Decision. No
 * Pattern runner reimplements the arithmetic.
 *
 * Given the node and the exact allocation the next child needs:
 *
 * 0. the node is re-read from rows and must be eligible to fund a child at
 *    all: a `pattern` node of the same Run in one of the exact states in
 *    which a child reservation or an Allocation Extension may legally be
 *    created (`ready`, `running`, `waiting`). A terminal, cancelled,
 *    skipped, pending, or foreign node is refused with a typed
 *    ineligibility before any arithmetic, and never reports `fits` or
 *    `funded`;
 * 1. the node's effective allocation is its immutable reservation plus its
 *    Allocation Extensions, read from rows;
 * 2. its current effective available capacity is that limit less the
 *    charges of its active and released children;
 * 3. the minimum extension is the component-wise shortfall
 *    `max(0, required − available)`;
 * 4. a zero shortfall needs nothing; otherwise the node's
 *    `onAllocationExhausted` policy decides — `fail` refuses with the
 *    allocation-exhausted result, `wait` refuses with the budget wait, and
 *    `extend` creates exactly that minimum Allocation Extension when the
 *    Run's effective ordinary available capacity covers it and otherwise
 *    refuses with the budget wait, writing nothing.
 *
 * `wait` and `extend` are different policies: `wait` keeps the node's fixed
 * effective allocation and waits only for capacity already allocated to the
 * node to return (a child reservation released or settled); it never creates
 * an Allocation Extension, and a Run Budget Increase alone never enlarges a
 * `wait` node. `extend` is the only policy that may create an extension.
 *
 * `ensure` runs inside the same root transaction that then creates the
 * child, so an extension and the work it funds commit together or not at
 * all; a restart finds both or neither, and never creates another extension
 * for work that already exists. `admits` is the read-only projection of the
 * same rule for schedulers, waits, and preflights, and lets a caller tell
 * state ineligibility from a budget shortfall. Nothing here rounds up, adds
 * spare capacity, uses a configured increment, draws from the final
 * reserve, creates Usage, or changes an existing Invocation.
 */
import {
  allocationFits,
  allocationHasPositive,
  allocationShortfall,
  ZERO_ALLOCATION,
  type Allocation,
  type AllocationExtension,
  type AllocationExtensionTrigger,
  type PatternPlanNode,
  type PlanNodeStatus,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

/** The exact Plan Node states in which a child reservation or an Allocation Extension may legally be created. */
export const CAPACITY_ADMISSIBLE_STATUSES = ["ready", "running", "waiting"] as const satisfies readonly PlanNodeStatus[];

/** Why a node cannot fund any child whatever its arithmetic: a closed state refusal, decided before capacity is read. */
export type CapacityIneligibility =
  /** The node is not in a state that may create a child: pending, or terminal (succeeded, failed, cancelled, skipped). */
  | { kind: "node_not_active"; status: PlanNodeStatus }
  /** A join node holds no allocation and creates no child. */
  | { kind: "join_node" }
  /** The node row belongs to another Run than the caller's node object claims. */
  | { kind: "foreign_run"; runId: RunId };

/** What the node can do for one required child allocation now, from rows alone. */
export interface CapacityAdmission {
  required: Allocation;
  /** The node's effective available capacity before any extension; zero for an ineligible node, whose arithmetic is never consulted. */
  available: Allocation;
  /** The exact component-wise shortfall; zero when the node already covers the requirement. */
  shortfall: Allocation;
  /** Whether the child can be funded now: directly, or through the extension the node's `extend` policy admits. Never true for an ineligible node. */
  fits: boolean;
  /** The exact Allocation Extension `ensure` would create; `null` when none is needed or none is possible. */
  extension: Allocation | null;
  /** The typed state refusal, when the node cannot fund a child regardless of arithmetic; `null` for an eligible node. */
  ineligible: CapacityIneligibility | null;
}

export type CapacityOutcome =
  /** The child may be reserved now; `extension` is the Allocation Extension created for it, or `null` when the node already covered it. */
  | { kind: "funded"; extension: AllocationExtension | null }
  /** The node cannot fund the child: `fail` ends it with `allocation_exhausted`, `wait` puts it in `waiting` with reason `budget`. Nothing was written. */
  | { kind: "refused"; policy: "fail" | "wait" }
  /** The node is not in a state that may fund a child (terminal, cancelled, skipped, pending, a join, or foreign). Nothing was written. */
  | { kind: "ineligible"; reason: CapacityIneligibility };

export class PlanNodeCapacity {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  /** The node's eligibility to fund a child, from its current row: ownership and lifecycle before any arithmetic. */
  eligibility(node: Pick<PatternPlanNode, "id" | "runId">): CapacityIneligibility | null {
    const current = this.stores.plans.getNode(node.id);
    if (current.runId !== node.runId) return { kind: "foreign_run", runId: current.runId };
    if (current.kind !== "pattern") return { kind: "join_node" };
    if (!(CAPACITY_ADMISSIBLE_STATUSES as readonly PlanNodeStatus[]).includes(current.status)) return { kind: "node_not_active", status: current.status };
    return null;
  }

  /** The read-only admission of one required child allocation: what `ensure` would do, writing nothing. */
  admits(node: PatternPlanNode, required: Allocation): CapacityAdmission {
    const ineligible = this.eligibility(node);
    if (ineligible !== null) return { required, available: { ...ZERO_ALLOCATION }, shortfall: { ...required }, fits: false, extension: null, ineligible };
    const available = this.stores.reservations.capacity({ type: "plan_node", id: node.id }).available;
    const shortfall = allocationShortfall(required, available);
    if (!allocationHasPositive(shortfall)) return { required, available, shortfall: { ...ZERO_ALLOCATION }, fits: true, extension: null, ineligible: null };
    if (node.onAllocationExhausted !== "extend") return { required, available, shortfall, fits: false, extension: null, ineligible: null };
    const fits = allocationFits(shortfall, this.stores.reservations.runCapacity(node.runId).ordinary.effectiveAvailable);
    return { required, available, shortfall, fits, extension: fits ? shortfall : null, ineligible: null };
  }

  /**
   * Inside the caller's root transaction: funds `required` for the node —
   * creating exactly the minimal Allocation Extension when the node's policy
   * is `extend` and the Run's effective ordinary capacity covers it — or
   * returns the policy's refusal, or the typed ineligibility of a node that
   * may not fund a child at all. The caller creates the child in the same
   * transaction; a failure anywhere after this call rolls the extension back
   * with everything else.
   */
  ensure(node: PatternPlanNode, required: Allocation, trigger: AllocationExtensionTrigger, options: WriteOptions): CapacityOutcome {
    if (!this.ctx.tx.inTransaction) throw new Error("Plan Node capacity is ensured inside the root transaction that creates the work it funds");
    const admission = this.admits(node, required);
    if (admission.ineligible !== null) return { kind: "ineligible", reason: admission.ineligible };
    if (!allocationHasPositive(admission.shortfall)) return { kind: "funded", extension: null };
    switch (node.onAllocationExhausted) {
      case "fail":
        return { kind: "refused", policy: "fail" };
      case "wait":
        // `wait` keeps the node's fixed allocation: no extension, whatever the Run's capacity.
        return { kind: "refused", policy: "wait" };
      case "extend": {
        if (!admission.fits) return { kind: "refused", policy: "wait" };
        const extension = this.stores.allocationExtensions.record({ runId: node.runId, planNodeId: node.id, added: admission.shortfall, trigger }, options);
        return { kind: "funded", extension };
      }
    }
  }
}
