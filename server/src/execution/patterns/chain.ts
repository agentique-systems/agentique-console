/**
 * The `chain` Pattern runner (execution-model §5.2): an ordered list of
 * leaf steps, one Worker Invocation each, strictly sequential. Step order
 * is the immutable node shape's; nothing is reconstructed from the source
 * form, Invocation creation order, or a rendered position.
 *
 * Lifecycle:
 * - `start` moves the node to `running` and prepares step 0 atomically,
 *   delivering the node's sequence Handoffs.
 * - After a step returns a valid `completed` result, `settle` integrates
 *   its Changeset (outside any transaction), then in one transaction
 *   ensures exactly one internal Handoff from that step and prepares the
 *   next step with it delivered. The next step's worktree is created from
 *   the newly integrated Snapshot; its manifest carries only its own
 *   operation input plus that Handoff — earlier Artifacts stay readable by
 *   id, never re-embedded.
 * - Retries repeat the same step (they are Attempts of the same
 *   Invocation); an approval successor continues the same step position.
 * - A failed step fails the node and no later step Invocation is created;
 *   no "skipped step" records exist for inline steps.
 * - The final step's result Artifacts are the node's output; earlier
 *   steps' Artifacts remain historical. With Gate criteria the final step's
 *   integrated result is the `node_exit` Gate's candidate (execution-model
 *   §10): the shared Gate engine judges it without rerunning any step.
 * Every action is idempotent: repeated reconciliation creates no duplicate
 * Invocation, Handoff, integration, or transition.
 */
import type { Invocation, InvocationId, PatternPlanNode, PatternPosition, PlanNodeId, Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { SequentialStepEngine, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

export class ChainPatternRunner {
  readonly pattern = "chain" as const;
  private readonly engine: SequentialStepEngine;

  constructor(deps: PatternRunnerDependencies) {
    this.engine = new SequentialStepEngine(deps, "chain");
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

  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions, continueInvocationId: InvocationId | null = null): PatternRunnerOutcome {
    return this.engine.resume(nodeId, expectedRevisionNumber, options, continueInvocationId);
  }

  /** Finishes the own work of a node that left the current membership; never activates a successor. */
  settleRemoved(nodeId: PlanNodeId, options?: WriteOptions): Promise<PatternRunnerOutcome> {
    return this.engine.settleRemoved(nodeId, options);
  }

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }

  openGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.openGate(nodeId, expectedRevisionNumber, options);
  }

  verifyGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): Promise<PatternRunnerOutcome> {
    return this.engine.verifyGate(nodeId, expectedRevisionNumber, options);
  }

  prepareGateEvaluator(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.prepareGateEvaluator(nodeId, expectedRevisionNumber, options);
  }

  settleGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome {
    return this.engine.settleGate(nodeId, expectedRevisionNumber, options);
  }

  /** The chain's current step from persisted positions: the latest Invocation at the highest step that has one, or `null` before step 0. */
  currentStep(nodeId: PlanNodeId): { index: number; count: number; invocation: Invocation } | null {
    const node = this.engine.node(nodeId);
    const latest = this.engine.latestInvocation(node);
    if (latest === null || latest.patternPosition?.kind !== "chain_step") return null;
    return { index: latest.patternPosition.index, count: latest.patternPosition.count, invocation: latest };
  }

  /** The step count from the immutable shape. */
  stepCount(node: PatternPlanNode): number {
    return this.engine.positions(node).length;
  }
}
