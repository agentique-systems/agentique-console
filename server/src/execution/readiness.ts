/**
 * Pure Plan Node readiness (execution-model §4.3, §7.1). A function of one
 * immutable `PlanGraph` — the current accepted revision's members with their
 * persisted statuses and exactly that revision's edges — to one closed,
 * typed decision per member, in deterministic scheduling order (membership
 * position, then node id).
 *
 * It queries nothing, writes nothing, mints nothing, invokes nothing, and
 * reads no transcript, historical edge, or clock; the scheduler applies the
 * decisions inside its own transactions after revalidating the revision.
 *
 * Rules for the `sequence` edges the Phase 2C Patterns use:
 * - a node with no predecessors becomes ready;
 * - a node is eligible only when every current-revision predecessor is
 *   terminal;
 * - all predecessors skipped skips the node;
 * - a failed or cancelled predecessor skips the node unless it was compiled
 *   with `runOnDependencyFailure`, in which case it becomes ready and the
 *   failures are reported for its Handoff;
 * - otherwise at least one predecessor succeeded and the node becomes ready.
 * Edges of other types, `join` nodes, and Patterns without a Phase 2C runner
 * are reported as `deferred`: the evaluator never invents their semantics.
 */
import { PLAN_NODE_MACHINE, type Pattern, type PlanEdge, type PlanEdgeType, type PlanGraph, type PlanNode, type PlanNodeId, type PlanNodeStatus } from "@agentique-console/core";

/** The Patterns whose runners exist in Phase 2C; every other Pattern is deferred, never falsely scheduled. */
export const SUPPORTED_PATTERNS: readonly Pattern[] = ["single", "chain"];

/** The edge types whose readiness semantics Phase 2C implements. */
export const SUPPORTED_EDGE_TYPES: readonly PlanEdgeType[] = ["sequence"];

export type SkipCause = "all_predecessors_skipped" | "dependency_failed";

export type DeferralReason = "later_phase_pattern" | "later_phase_edge" | "join_node";

export type ReadinessDecision =
  /** Pending, and at least one current-revision predecessor has not ended. */
  | { kind: "remain_pending"; nodeId: PlanNodeId; awaiting: PlanNodeId[] }
  /** Pending with every predecessor terminal and the rules satisfied; `dependencyFailures` is non-empty only under `runOnDependencyFailure`. */
  | { kind: "become_ready"; nodeId: PlanNodeId; dependencyFailures: PlanNodeId[] }
  /** Pending and never runnable in this revision: every predecessor skipped, or a dependency failed without opt-in. */
  | { kind: "become_skipped"; nodeId: PlanNodeId; cause: SkipCause; failed: PlanNodeId[] }
  /** Already `ready`: runnable now. */
  | { kind: "ready"; nodeId: PlanNodeId }
  /** `running` or `waiting`: its Pattern runner owns it. */
  | { kind: "active"; nodeId: PlanNodeId; status: "running" | "waiting" }
  /** Ended; nothing to decide. */
  | { kind: "terminal"; nodeId: PlanNodeId; status: Extract<PlanNodeStatus, "succeeded" | "failed" | "cancelled" | "skipped"> }
  /** Would be decided by an edge type, node kind, or Pattern of a later phase; untouched now. */
  | { kind: "deferred"; nodeId: PlanNodeId; reason: DeferralReason; pattern: Pattern | null; edgeTypes: PlanEdgeType[] };

export interface ReadinessEvaluation {
  runId: PlanGraph["runId"];
  revisionNumber: number;
  /** One decision per member, in scheduling order. */
  decisions: ReadinessDecision[];
}

/** Deterministic scheduling order: membership position, then node id. */
export function schedulingOrder(graph: PlanGraph): PlanNode[] {
  const position = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  return [...graph.nodes].sort((a, b) => (position.get(a.id)! - position.get(b.id)!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The edges of this revision entering `nodeId`, in fan-in position order. */
export function predecessorEdges(graph: PlanGraph, nodeId: PlanNodeId): PlanEdge[] {
  return graph.edges.filter((edge) => edge.targetNodeId === nodeId).sort((a, b) => a.position - b.position || (a.sourceNodeId < b.sourceNodeId ? -1 : 1));
}

/** The edges of this revision leaving `nodeId`, in target membership order. */
export function successorEdges(graph: PlanGraph, nodeId: PlanNodeId): PlanEdge[] {
  const position = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  return graph.edges.filter((edge) => edge.sourceNodeId === nodeId).sort((a, b) => (position.get(a.targetNodeId) ?? 0) - (position.get(b.targetNodeId) ?? 0) || a.position - b.position);
}

export function evaluateReadiness(graph: PlanGraph): ReadinessEvaluation {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const decisions = schedulingOrder(graph).map((node): ReadinessDecision => decide(graph, byId, node));
  return { runId: graph.runId, revisionNumber: graph.revisionNumber, decisions };
}

/** The decision for one member; exported for callers that revalidate a single node inside a transaction. */
export function decideReadiness(graph: PlanGraph, nodeId: PlanNodeId): ReadinessDecision {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const node = byId.get(nodeId);
  if (!node) throw new Error(`PlanNode ${nodeId} is not a member of revision ${graph.revisionNumber}`);
  return decide(graph, byId, node);
}

function decide(graph: PlanGraph, byId: ReadonlyMap<PlanNodeId, PlanNode>, node: PlanNode): ReadinessDecision {
  const incoming = predecessorEdges(graph, node.id);
  const edgeTypes = [...new Set(incoming.map((edge) => edge.type))].sort();
  if (node.status === "ready") return { kind: "ready", nodeId: node.id };
  if (node.status === "running" || node.status === "waiting") return { kind: "active", nodeId: node.id, status: node.status };
  if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", nodeId: node.id, status: node.status as Extract<PlanNodeStatus, "succeeded" | "failed" | "cancelled" | "skipped"> };
  // Pending: a later-phase node kind, Pattern, or edge is never decided here.
  if (node.kind === "join") return { kind: "deferred", nodeId: node.id, reason: "join_node", pattern: null, edgeTypes };
  if (edgeTypes.some((type) => !SUPPORTED_EDGE_TYPES.includes(type)) || incoming.some((edge) => byId.get(edge.sourceNodeId)?.kind === "pattern" && (byId.get(edge.sourceNodeId) as PlanNode & { kind: "pattern" }).pattern === "route")) {
    return { kind: "deferred", nodeId: node.id, reason: "later_phase_edge", pattern: node.pattern, edgeTypes };
  }
  if (!SUPPORTED_PATTERNS.includes(node.pattern)) return { kind: "deferred", nodeId: node.id, reason: "later_phase_pattern", pattern: node.pattern, edgeTypes };
  if (incoming.length === 0) return { kind: "become_ready", nodeId: node.id, dependencyFailures: [] };
  const predecessors = incoming.map((edge) => {
    const source = byId.get(edge.sourceNodeId);
    if (!source) throw new Error(`PlanEdge ${edge.id} of revision ${graph.revisionNumber} names non-member ${edge.sourceNodeId}`);
    return source;
  });
  const awaiting = predecessors.filter((p) => !PLAN_NODE_MACHINE.isTerminal(p.status)).map((p) => p.id);
  if (awaiting.length > 0) return { kind: "remain_pending", nodeId: node.id, awaiting };
  if (predecessors.every((p) => p.status === "skipped")) return { kind: "become_skipped", nodeId: node.id, cause: "all_predecessors_skipped", failed: [] };
  const failed = predecessors.filter((p) => p.status === "failed" || p.status === "cancelled").map((p) => p.id);
  if (failed.length > 0) {
    return node.runOnDependencyFailure ? { kind: "become_ready", nodeId: node.id, dependencyFailures: failed } : { kind: "become_skipped", nodeId: node.id, cause: "dependency_failed", failed };
  }
  return { kind: "become_ready", nodeId: node.id, dependencyFailures: [] };
}
