/**
 * The `single` Pattern runner (execution-model §5.1): one Worker Invocation
 * of one Agent Definition revision at the `single` position, funded from
 * the node, whose completed result's Artifacts are the node's output.
 *
 * Lifecycle for an ordinary (non-root) node:
 * 1. `start`: revalidate the node as a current-revision `single` member in
 *    `ready`; in one transaction move it to `running`, ensure and deliver
 *    its sequence Handoffs, ready its owned Tasks, and prepare the one
 *    Worker Invocation bound to the typed `single` position with exactly
 *    its operation's input.
 * 2. The scheduler executes Attempts through the executor; retries stay
 *    Invocation-owned.
 * 3. `settle`: on a completed result integrate the Changeset, then set the
 *    node's exact output Artifact ids, create the current-revision sequence
 *    Handoffs, and succeed the node — unless it has Gate criteria, in which
 *    case work is complete and `awaiting_gate_phase` is reported; on a
 *    failed Invocation or a failed result fail the node; on cancellation
 *    cancel it with the cause; on an approval block wait on the Decision.
 * 4. `resume`: after the Decision resolves, prepare the successor at the
 *    same position continuing from the blocked Invocation with the typed
 *    resolution input, on a fresh reservation and worktree.
 *
 * The root Orchestrator node is a `single` node too, but it is never
 * completed by this runner (see `root.ts`).
 */
import type { PatternPosition, PlanNodeId, Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { SequentialStepEngine, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

export class SinglePatternRunner {
  readonly pattern = "single" as const;
  private readonly engine: SequentialStepEngine;

  constructor(deps: PatternRunnerDependencies) {
    this.engine = new SequentialStepEngine(deps, "single");
  }

  inspect(nodeId: PlanNodeId, now?: Timestamp): NodeAdvice {
    return this.engine.inspect(nodeId, now);
  }

  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.start(nodeId, expectedRevisionNumber, options);
  }

  /** Never advised for this Pattern; a no-op after revalidation. */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, position: PatternPosition, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.startPosition(nodeId, expectedRevisionNumber, position, options);
  }

  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): Promise<PatternRunnerOutcome> {
    return this.engine.settle(nodeId, expectedRevisionNumber, options);
  }

  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.resume(nodeId, expectedRevisionNumber, options);
  }

  /** Finishes the own work of a node that left the current membership; never activates a successor. */
  settleRemoved(nodeId: PlanNodeId, options?: WriteOptions): Promise<PatternRunnerOutcome> {
    return this.engine.settleRemoved(nodeId, options);
  }

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }
}
