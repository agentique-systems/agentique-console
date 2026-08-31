/**
 * Reservable Plan Node capacity (execution-model §7.6): the one canonical
 * operation every runtime path that creates ordinary node-funded work goes
 * through before it reserves a child — a Pattern Invocation, a Coordinator's
 * Task batch, a `node_exit` Gate Evaluator, a root Orchestrator turn, the
 * root's batched `gate_result` remediation turn, the follow-up turn of a
 * signoff change request. No Pattern runner reimplements the arithmetic.
 *
 * Given the node and the exact allocation the next child needs:
 *
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
 * `ensure` runs inside the same root transaction that then creates the
 * child, so an extension and the work it funds commit together or not at
 * all; a restart finds both or neither, and never creates another extension
 * for work that already exists. `admits` is the read-only projection of the
 * same rule for schedulers, waits, and preflights. Nothing here rounds up,
 * adds spare capacity, uses a configured increment, draws from the final
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
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

/** What the node can do for one required child allocation now, from rows alone. */
export interface CapacityAdmission {
  required: Allocation;
  /** The node's effective available capacity before any extension. */
  available: Allocation;
  /** The exact component-wise shortfall; zero when the node already covers the requirement. */
  shortfall: Allocation;
  /** Whether the child can be funded now: directly, or through the extension the node's `extend` policy admits. */
  fits: boolean;
  /** The exact Allocation Extension `ensure` would create; `null` when none is needed or none is possible. */
  extension: Allocation | null;
}

export type CapacityOutcome =
  /** The child may be reserved now; `extension` is the Allocation Extension created for it, or `null` when the node already covered it. */
  | { kind: "funded"; extension: AllocationExtension | null }
  /** The node cannot fund the child: `fail` ends it with `allocation_exhausted`, `wait` puts it in `waiting` with reason `budget`. Nothing was written. */
  | { kind: "refused"; policy: "fail" | "wait" };

export class PlanNodeCapacity {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  /** The read-only admission of one required child allocation: what `ensure` would do, writing nothing. */
  admits(node: PatternPlanNode, required: Allocation): CapacityAdmission {
    const available = this.stores.reservations.capacity({ type: "plan_node", id: node.id }).available;
    const shortfall = allocationShortfall(required, available);
    if (!allocationHasPositive(shortfall)) return { required, available, shortfall: { ...ZERO_ALLOCATION }, fits: true, extension: null };
    if (node.onAllocationExhausted !== "extend") return { required, available, shortfall, fits: false, extension: null };
    const fits = allocationFits(shortfall, this.stores.reservations.runCapacity(node.runId).ordinary.effectiveAvailable);
    return { required, available, shortfall, fits, extension: fits ? shortfall : null };
  }

  /**
   * Inside the caller's root transaction: funds `required` for the node —
   * creating exactly the minimal Allocation Extension when the node's policy
   * is `extend` and the Run's effective ordinary capacity covers it — or
   * returns the policy's refusal. The caller creates the child in the same
   * transaction; a failure anywhere after this call rolls the extension back
   * with everything else.
   */
  ensure(node: PatternPlanNode, required: Allocation, trigger: AllocationExtensionTrigger, options: WriteOptions): CapacityOutcome {
    if (!this.ctx.tx.inTransaction) throw new Error("Plan Node capacity is ensured inside the root transaction that creates the work it funds");
    const admission = this.admits(node, required);
    if (!allocationHasPositive(admission.shortfall)) return { kind: "funded", extension: null };
    switch (node.onAllocationExhausted) {
      case "fail":
        return { kind: "refused", policy: "fail" };
      case "wait":
        return { kind: "refused", policy: "wait" };
      case "extend": {
        if (!admission.fits) return { kind: "refused", policy: "wait" };
        const extension = this.stores.allocationExtensions.record({ runId: node.runId, planNodeId: node.id, added: admission.shortfall, trigger }, options);
        return { kind: "funded", extension };
      }
    }
  }
}
