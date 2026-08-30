/**
 * Canonical Handoff routing (execution-model §4.3, §5.2, §5.3, §5.4, §7.7;
 * invariant 8). The runtime carries work between Plan Nodes and inside a
 * node as Handoffs: routing metadata only — source, target, Task ids,
 * output Artifact ids, a bounded summary — identified by the stable key of
 * the logical transfer, never by the pass that created them. Every
 * operation here is idempotent through `HandoffStore.ensure` and the
 * per-Run unique index: repeated reconciliation, transaction retry, a
 * restart, or racing callers converge on one row per transfer.
 *
 * Transfers:
 * - `sequence`: a terminal source node → a current-revision target node
 *   along a delivering `sequence` edge, carrying the source's output
 *   Artifacts when it succeeded, or its failure (no Artifacts) when the
 *   target runs on dependency failure. A `sequence` edge out of a `route`
 *   node delivers only for an inline selection; a join's output is its
 *   index Artifact;
 * - `branch`: a succeeded `route` node → the entry node of the composite
 *   branch it selected, along the one active `branch(label)` edge, carrying
 *   no Artifacts;
 * - `chain_step`: a completed step Invocation → its own chain node, for the
 *   next step;
 * - `parallel_index`: a parallel node → itself, delivering its canonical
 *   index Artifact to its aggregation Invocation;
 * - `worker_result`: a completed, integrated Worker Invocation of a
 *   coordinator_worker node → its node, carrying the Task's output
 *   Artifacts for the next Coordinator turn; one per completed current Task.
 * Which edges deliver is decided by the pure readiness evaluator over the
 * graph and its explicit condition facts; nothing here infers a selection.
 * Decision and approval continuations use the typed manifest inputs
 * instead; nothing here invents a narrative Handoff.
 */
import { HANDOFF_MAX_SUMMARY_LENGTH, INVOCATION_MACHINE, isIncomingHandoffKey, PLAN_NODE_MACHINE, type ArtifactId, type Handoff, type Invocation, type PatternPlanNode, type PlanEdge, type PlanGraph, type PlanNode, type PlanNodeId, type RunId, type Task, type TaskId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { edgeActivation, predecessorEdges, successorEdges, type ReadinessInput } from "./readiness.ts";

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
   * The Handoffs of every current-revision `sequence` and `branch` edge
   * leaving a terminal source node that is active for its target: outputs
   * when the source succeeded and the edge delivers, a failure notice when
   * it failed or was cancelled and the target opted in, nothing when the
   * edge is inactive (a skipped source, an unselected branch, a composite
   * selection's own sequence edges). Idempotent.
   */
  ensureEdgeHandoffsFrom(input: ReadinessInput, sourceNodeId: PlanNodeId, options?: WriteOptions): EnsuredHandoff[] {
    const source = member(input.graph, sourceNodeId);
    if (!PLAN_NODE_MACHINE.isTerminal(source.status)) throw new Error(`PlanNode ${sourceNodeId} is ${source.status}; an edge Handoff carries a terminal source`);
    return successorEdges(input.graph, sourceNodeId).flatMap((edge) => this.ensureEdge(input, edge, options) ?? []);
  }

  /**
   * The Handoffs of every current-revision `sequence` and `branch` edge
   * entering a target node whose source is already terminal and active —
   * what the target's first Invocation is delivered when it starts,
   * including edges added by a later revision after the source ended.
   * Idempotent.
   */
  ensureEdgeHandoffsInto(input: ReadinessInput, targetNodeId: PlanNodeId, options?: WriteOptions): EnsuredHandoff[] {
    member(input.graph, targetNodeId);
    return predecessorEdges(input.graph, targetNodeId).flatMap((edge) => (PLAN_NODE_MACHINE.isTerminal(member(input.graph, edge.sourceNodeId).status) ? (this.ensureEdge(input, edge, options) ?? []) : []));
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

  /** The internal parallel transfer of the node's index Artifact to its aggregation. Idempotent by the node. */
  ensureParallelIndexHandoff(node: PatternPlanNode, indexArtifactId: ArtifactId, options?: WriteOptions): EnsuredHandoff {
    if (node.shape.pattern !== "parallel" || node.shape.aggregate === null) throw new Error(`PlanNode ${node.id} is not a parallel node with an aggregation`);
    return this.stores.handoffs.ensure(
      {
        runId: node.runId,
        route: { kind: "parallel_index", planNodeId: node.id },
        source: { kind: "plan_node", planNodeId: node.id },
        target: { kind: "plan_node", planNodeId: node.id },
        taskIds: [],
        artifactIds: [indexArtifactId],
        summary: boundedHandoffSummary(`${node.title} index`),
      },
      options,
    );
  }

  /**
   * The internal coordinator_worker transfer of one completed current Task's Worker result to its node, created only
   * once the Worker's Changeset is integrated. Idempotent by the Task.
   */
  ensureWorkerResultHandoff(node: PatternPlanNode, worker: Invocation, task: Task, options?: WriteOptions): EnsuredHandoff {
    if (node.shape.pattern !== "coordinator_worker") throw new Error(`PlanNode ${node.id} is not a coordinator_worker node`);
    const position = worker.patternPosition;
    if (position === null || position.kind !== "worker_task" || position.taskId !== task.id || worker.planNodeId !== node.id) throw new Error(`Invocation ${worker.id} is not the Worker of Task ${task.id} on PlanNode ${node.id}`);
    if (worker.status !== "succeeded" || worker.result === null || worker.result.status !== "completed") throw new Error(`Invocation ${worker.id} did not complete; a Worker-result Handoff carries a completed result`);
    if (task.status !== "completed") throw new Error(`Task ${task.id} is ${task.status}; a Worker-result Handoff carries a completed Task`);
    return this.stores.handoffs.ensure(
      {
        runId: node.runId,
        route: { kind: "worker_result", planNodeId: node.id, taskId: task.id },
        source: { kind: "invocation", invocationId: worker.id },
        target: { kind: "plan_node", planNodeId: node.id },
        taskIds: [task.id],
        artifactIds: [...task.outputArtifactIds].sort(),
        summary: boundedHandoffSummary(worker.result.summary),
      },
      options,
    );
  }

  /** The Worker-result Handoff of one Task, if it exists. */
  workerResultHandoff(runId: RunId, planNodeId: PlanNodeId, taskId: TaskId): Handoff | null {
    return this.stores.handoffs.getByKey(runId, `worker_result:${planNodeId}:${taskId}`);
  }

  /** Every Worker-result Handoff of a node, in creation order; `status` narrows to one lifecycle state. */
  workerResultHandoffs(runId: RunId, planNodeId: PlanNodeId, status?: Handoff["status"]): Handoff[] {
    return this.stores.handoffs.listByTarget(runId, { kind: "plan_node", planNodeId }, status).filter((h) => h.handoffKey.startsWith(`worker_result:${planNodeId}:`));
  }

  /** The pending edge Handoffs addressed to a node, in creation order: what its next Invocation delivers. */
  pendingHandoffsFor(runId: RunId, planNodeId: PlanNodeId): Handoff[] {
    return this.incomingHandoffsFor(runId, planNodeId).filter((h) => h.status === "pending");
  }

  /** Every non-cancelled edge Handoff (`sequence`, `branch`) addressed to a node, in creation order, whether or not an earlier Invocation already received it. */
  incomingHandoffsFor(runId: RunId, planNodeId: PlanNodeId): Handoff[] {
    return this.stores.handoffs.listByTarget(runId, { kind: "plan_node", planNodeId }).filter((h) => h.status !== "cancelled" && isIncomingHandoffKey(h.handoffKey));
  }

  /** The Handoff of a chain node's transfer from step `fromStep`, if it exists. */
  chainStepHandoff(runId: RunId, planNodeId: PlanNodeId, fromStep: number): Handoff | null {
    return this.stores.handoffs.getByKey(runId, `chain_step:${planNodeId}:${fromStep}`);
  }

  /** The Handoff of a parallel node's index to its aggregation, if it exists. */
  parallelIndexHandoff(runId: RunId, planNodeId: PlanNodeId): Handoff | null {
    return this.stores.handoffs.getByKey(runId, `parallel_index:${planNodeId}`);
  }

  private ensureEdge(input: ReadinessInput, edge: PlanEdge, options?: WriteOptions): EnsuredHandoff | null {
    if (edge.type !== "sequence" && edge.type !== "branch") return null;
    const source = member(input.graph, edge.sourceNodeId);
    const target = member(input.graph, edge.targetNodeId);
    const activation = edgeActivation(input, edge);
    if (activation.kind === "pending" || activation.kind === "inactive") return null;
    if (edge.type === "branch") {
      if (activation.kind !== "delivers") return null;
      return this.stores.handoffs.ensure(
        {
          runId: input.graph.runId,
          route: { kind: "branch", sourceNodeId: source.id, targetNodeId: target.id, label: edge.label },
          source: { kind: "plan_node", planNodeId: source.id },
          target: { kind: "plan_node", planNodeId: target.id },
          taskIds: [],
          artifactIds: [],
          summary: boundedHandoffSummary(`${source.title} selected ${edge.label}`),
        },
        options,
      );
    }
    const succeeded = activation.kind === "delivers";
    if (!succeeded && !target.runOnDependencyFailure) return null;
    const invocations = source.kind === "pattern" ? this.stores.invocations.listByPlanNode(source.id) : [];
    const taskIds = succeeded ? [...new Set(invocations.filter((i) => INVOCATION_MACHINE.isTerminal(i.status)).flatMap((i) => i.taskIds))].sort() : [];
    const last = invocations.filter((i) => i.status === "succeeded" && i.result !== null).at(-1) ?? null;
    return this.stores.handoffs.ensure(
      {
        runId: input.graph.runId,
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
