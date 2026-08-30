/**
 * Canonical Handoff routing (execution-model §4.3, §5.2, §7.7; invariant 8).
 * The runtime carries work between Plan Nodes and between chain steps as
 * Handoffs: routing metadata only — source, target, Task ids, output
 * Artifact ids, a bounded summary — identified by the stable key of the
 * logical transfer, never by the pass that created them. Every operation
 * here is idempotent through `HandoffStore.ensure` and the per-Run unique
 * index: repeated reconciliation, transaction retry, a restart, or racing
 * callers converge on one row per transfer.
 *
 * Transfers in Phase 2C:
 * - `sequence`: a terminal source node → a current-revision target node,
 *   carrying the source's output Artifacts when it succeeded, or its
 *   failure (no Artifacts) when the target runs on dependency failure;
 * - `chain_step`: a completed step Invocation → its own chain node, for the
 *   next step.
 * Decision and approval continuations use the typed manifest inputs
 * instead; nothing here invents a narrative Handoff.
 */
import { HANDOFF_MAX_SUMMARY_LENGTH, INVOCATION_MACHINE, PLAN_NODE_MACHINE, type Handoff, type Invocation, type PatternPlanNode, type PlanGraph, type PlanNode, type PlanNodeId, type RunId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { predecessorEdges, successorEdges } from "./readiness.ts";

export interface EnsuredHandoff {
  handoff: Handoff;
  created: boolean;
}

/** Bounds a summary to the Handoff limit on a single line. */
export function boundedHandoffSummary(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > HANDOFF_MAX_SUMMARY_LENGTH ? `${line.slice(0, HANDOFF_MAX_SUMMARY_LENGTH - 1)}…` : line;
}

export class HandoffRouter {
  constructor(private readonly stores: Stores) {}

  /**
   * The sequence Handoffs of every current-revision edge leaving a terminal
   * source node: outputs when it succeeded, a failure notice when it failed
   * or was cancelled and the target opted in, nothing when it was skipped
   * (the target skips or hears from its other predecessors). Idempotent.
   */
  ensureSequenceHandoffsFrom(graph: PlanGraph, sourceNodeId: PlanNodeId, options?: WriteOptions): EnsuredHandoff[] {
    const source = member(graph, sourceNodeId);
    if (!PLAN_NODE_MACHINE.isTerminal(source.status)) throw new Error(`PlanNode ${sourceNodeId} is ${source.status}; a sequence Handoff carries a terminal source`);
    return successorEdges(graph, sourceNodeId)
      .filter((edge) => edge.type === "sequence")
      .flatMap((edge) => this.ensureSequence(graph.runId, source, member(graph, edge.targetNodeId), options) ?? []);
  }

  /**
   * The sequence Handoffs of every current-revision edge entering a target
   * node whose source is already terminal — what the target's first
   * Invocation is delivered when it starts, including edges added by a
   * later revision after the source ended. Idempotent.
   */
  ensureSequenceHandoffsInto(graph: PlanGraph, targetNodeId: PlanNodeId, options?: WriteOptions): EnsuredHandoff[] {
    const target = member(graph, targetNodeId);
    return predecessorEdges(graph, targetNodeId)
      .filter((edge) => edge.type === "sequence")
      .flatMap((edge) => {
        const source = member(graph, edge.sourceNodeId);
        return PLAN_NODE_MACHINE.isTerminal(source.status) ? (this.ensureSequence(graph.runId, source, target, options) ?? []) : [];
      });
  }

  /** The internal chain transfer from a completed step to the next step of the same node. Idempotent by the step. */
  ensureChainStepHandoff(node: PatternPlanNode, step: Invocation, options?: WriteOptions): EnsuredHandoff {
    if (node.shape.pattern !== "chain") throw new Error(`PlanNode ${node.id} is a ${node.shape.pattern} node; only a chain has internal step Handoffs`);
    const position = step.patternPosition;
    if (position === null || position.kind !== "chain_step" || step.planNodeId !== node.id) throw new Error(`Invocation ${step.id} is not a chain step of PlanNode ${node.id}`);
    if (position.index + 1 >= position.count) throw new Error(`Invocation ${step.id} is the final step; there is no next step to hand off to`);
    if (step.status !== "succeeded" || step.result === null || step.result.status !== "completed") throw new Error(`Invocation ${step.id} did not complete; a chain step Handoff carries a completed result`);
    return this.stores.handoffs.ensure(
      {
        runId: node.runId,
        route: { kind: "chain_step", planNodeId: node.id, fromStep: position.index },
        source: { kind: "invocation", invocationId: step.id },
        target: { kind: "plan_node", planNodeId: node.id },
        taskIds: [...step.taskIds].sort(),
        artifactIds: [...step.result.artifactIds].sort(),
        summary: boundedHandoffSummary(step.result.summary),
      },
      options,
    );
  }

  /** The pending Handoffs addressed to a node, in creation order: what its next Invocation delivers. */
  pendingHandoffsFor(runId: RunId, planNodeId: PlanNodeId): Handoff[] {
    return this.stores.handoffs.listByTarget(runId, { kind: "plan_node", planNodeId }, "pending");
  }

  /** The Handoff of a chain node's transfer from step `fromStep`, if it exists. */
  chainStepHandoff(runId: RunId, planNodeId: PlanNodeId, fromStep: number): Handoff | null {
    return this.stores.handoffs.getByKey(runId, `chain_step:${planNodeId}:${fromStep}`);
  }

  private ensureSequence(runId: RunId, source: PlanNode, target: PlanNode, options?: WriteOptions): EnsuredHandoff | null {
    if (source.status === "skipped") return null;
    const succeeded = source.status === "succeeded";
    if (!succeeded && !target.runOnDependencyFailure) return null;
    const invocations = this.stores.invocations.listByPlanNode(source.id);
    const taskIds = succeeded ? [...new Set(invocations.filter((i) => INVOCATION_MACHINE.isTerminal(i.status)).flatMap((i) => i.taskIds))].sort() : [];
    const last = invocations.filter((i) => i.status === "succeeded" && i.result !== null).at(-1) ?? null;
    return this.stores.handoffs.ensure(
      {
        runId,
        route: { kind: "sequence", sourceNodeId: source.id, targetNodeId: target.id },
        source: { kind: "plan_node", planNodeId: source.id },
        target: { kind: "plan_node", planNodeId: target.id },
        taskIds,
        artifactIds: succeeded ? [...(source.outputArtifactIds ?? [])].sort() : [],
        summary: succeeded ? boundedHandoffSummary(last?.result?.summary ?? `${source.title} succeeded`) : boundedHandoffSummary(`${source.title} ${source.status}`),
      },
      options,
    );
  }
}

function member(graph: PlanGraph, nodeId: PlanNodeId): PlanNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`PlanNode ${nodeId} is not a member of revision ${graph.revisionNumber} of Run ${graph.runId}`);
  return node;
}
