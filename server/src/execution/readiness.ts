/**
 * Pure Plan Node readiness (execution-model §4.3, §7.1). A function of one
 * immutable `ReadinessInput` — the current accepted revision's `PlanGraph`
 * (its members with their persisted statuses and exactly that revision's
 * edges) plus the explicit canonical condition facts that decide
 * conditional edges — to one closed, typed decision per member, in
 * deterministic scheduling order (membership position, then node id).
 *
 * Readiness is pure over the graph plus explicit facts: it queries nothing,
 * writes nothing, mints nothing, invokes nothing, and reads no store,
 * transcript, Artifact content, Handoff summary, Invocation order, Event,
 * or clock. The caller projects the facts from canonical rows (the
 * route-selection Evaluations of the Run) and hands them in; the evaluator
 * never infers a condition from anything else. A fact that is missing where
 * an edge needs it, or that contradicts the graph, is a typed
 * `ReadinessFactError` — never guessed readiness. The scheduler applies the
 * decisions inside its own transactions after revalidating the revision.
 *
 * Edge activation, per current-revision edge into a pending node:
 * - `sequence` from an ordinary node: pending until the source is terminal;
 *   inactive when the source was skipped; failed when it failed or was
 *   cancelled; delivering when it succeeded;
 * - `sequence` from a `route` node: as above, except that a succeeded route
 *   delivers only when its recorded selection is an inline branch — a
 *   composite selection delivers through the branch's exits instead, so the
 *   edge is inactive;
 * - `branch(label)` from a `route` node: as a sequence edge, except that a
 *   succeeded route delivers only when its recorded selection is exactly
 *   `label`; every other label is inactive, which skips the branch's
 *   subgraph through the ordinary all-inactive rule;
 * - `fan_in` into a `join`: the join becomes ready when every fan-in source
 *   is terminal, skipped when every one was skipped; its policy is applied
 *   at settlement, never here;
 * - `retry(round)`: deferred to a later phase; the evaluator never invents
 *   its semantics.
 *
 * A pending pattern node with no predecessors becomes ready; with every edge
 * inactive it is skipped; with a failed edge it is skipped unless it was
 * compiled with `runOnDependencyFailure`, in which case it becomes ready with
 * the failures reported for its Handoff; otherwise, once every edge has
 * settled and at least one delivers, it becomes ready.
 */
import {
  InvariantViolationError,
  PLAN_NODE_MACHINE,
  type EvaluationId,
  type Pattern,
  type PlanEdge,
  type PlanEdgeType,
  type PlanGraph,
  type PlanNode,
  type PlanNodeId,
  type PlanNodeStatus,
} from "@agentique-console/core";

/** The Patterns whose runners exist; every other Pattern is deferred, never falsely scheduled. */
export const SUPPORTED_PATTERNS: readonly Pattern[] = ["single", "chain", "route", "parallel"];

/** The edge types whose readiness semantics are implemented; `retry` is deferred. */
export const SUPPORTED_EDGE_TYPES: readonly PlanEdgeType[] = ["sequence", "branch", "fan_in"];

/** The canonical route-selection fact of one route node, projected from its `route_selection` Evaluation. */
export interface RouteSelectionFact {
  planNodeId: PlanNodeId;
  selectedLabel: string;
  evaluationId: EvaluationId;
}

/**
 * Everything readiness decides from: the current graph and the explicit
 * canonical condition facts. `routeSelections` is keyed by route node id and
 * carries at most one selection per node. Later phases add the facts their
 * conditional edges need (a `retry(round)` edge reads the round's
 * Evaluation verdict) as further members of this input, never as queries.
 */
export interface ReadinessInput {
  graph: PlanGraph;
  routeSelections: ReadonlyMap<PlanNodeId, RouteSelectionFact>;
}

/** A condition fact readiness needs is missing or contradicts the graph; a typed invariant failure, never guessed readiness. */
export class ReadinessFactError extends InvariantViolationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export type SkipCause = "all_predecessors_skipped" | "dependency_failed";

export type DeferralReason = "later_phase_pattern" | "later_phase_edge";

export type ReadinessDecision =
  /** Pending, and at least one current-revision predecessor has not ended. */
  | { kind: "remain_pending"; nodeId: PlanNodeId; awaiting: PlanNodeId[] }
  /** Pending with every edge settled and the rules satisfied; `dependencyFailures` is non-empty only under `runOnDependencyFailure`. */
  | { kind: "become_ready"; nodeId: PlanNodeId; dependencyFailures: PlanNodeId[] }
  /** Pending and never runnable in this revision: every edge inactive, or a dependency failed without opt-in. */
  | { kind: "become_skipped"; nodeId: PlanNodeId; cause: SkipCause; failed: PlanNodeId[] }
  /** Already `ready`: runnable now (a join executes deterministically from here). */
  | { kind: "ready"; nodeId: PlanNodeId }
  /** `running` or `waiting`: its Pattern runner owns it. */
  | { kind: "active"; nodeId: PlanNodeId; status: "running" | "waiting" }
  /** Ended; nothing to decide. */
  | { kind: "terminal"; nodeId: PlanNodeId; status: Extract<PlanNodeStatus, "succeeded" | "failed" | "cancelled" | "skipped"> }
  /** Would be decided by an edge type or Pattern of a later phase; untouched now. */
  | { kind: "deferred"; nodeId: PlanNodeId; reason: DeferralReason; pattern: Pattern | null; edgeTypes: PlanEdgeType[] };

export interface ReadinessEvaluation {
  runId: PlanGraph["runId"];
  revisionNumber: number;
  /** One decision per member, in scheduling order. */
  decisions: ReadinessDecision[];
}

/** What one current-revision edge does for its target right now. */
export type EdgeActivation =
  /** The source has not ended. */
  | { kind: "pending" }
  /** The source succeeded and this edge delivers its outputs. */
  | { kind: "delivers" }
  /** The source failed or was cancelled. */
  | { kind: "failed"; status: "failed" | "cancelled" }
  /** The edge delivers nothing: the source was skipped, or its selection did not activate this edge. */
  | { kind: "inactive" };

/** Deterministic scheduling order: membership position, then node id. */
export function schedulingOrder(graph: PlanGraph): PlanNode[] {
  const position = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  return [...graph.nodes].sort((a, b) => (position.get(a.id)! - position.get(b.id)!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The edges of this revision entering `nodeId`, in fan-in position order, then edge id. */
export function predecessorEdges(graph: PlanGraph, nodeId: PlanNodeId): PlanEdge[] {
  return graph.edges.filter((edge) => edge.targetNodeId === nodeId).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The edges of this revision leaving `nodeId`, in target membership order. */
export function successorEdges(graph: PlanGraph, nodeId: PlanNodeId): PlanEdge[] {
  const position = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  return graph.edges.filter((edge) => edge.sourceNodeId === nodeId).sort((a, b) => (position.get(a.targetNodeId) ?? 0) - (position.get(b.targetNodeId) ?? 0) || a.position - b.position);
}

function member(input: ReadinessInput, byId: ReadonlyMap<PlanNodeId, PlanNode>, edge: PlanEdge, nodeId: PlanNodeId): PlanNode {
  const node = byId.get(nodeId);
  if (!node) throw new ReadinessFactError(`PlanEdge ${edge.id} of revision ${input.graph.revisionNumber} names non-member ${nodeId}`, { edgeId: edge.id, nodeId });
  return node;
}

/**
 * The selection fact of a succeeded route node, checked against the node it
 * belongs to: present, naming a branch the node's shape binds. A fact for
 * a node that is not a route node, or a label the shape does not bind, is
 * contradictory; a succeeded route node without a fact is missing one.
 */
function selectionOf(input: ReadinessInput, node: PlanNode): { label: string; inline: boolean } {
  if (node.kind !== "pattern" || node.shape.pattern !== "route") throw new ReadinessFactError(`PlanNode ${node.id} is not a route node and selects nothing`, { nodeId: node.id });
  const fact = input.routeSelections.get(node.id);
  if (!fact) throw new ReadinessFactError(`route PlanNode ${node.id} succeeded without a recorded route-selection Evaluation`, { nodeId: node.id });
  const binding = node.shape.branches.find((b) => b.label === fact.selectedLabel);
  if (!binding) throw new ReadinessFactError(`route PlanNode ${node.id} recorded selection ${fact.selectedLabel}, which its shape does not bind`, { nodeId: node.id, selectedLabel: fact.selectedLabel, evaluationId: fact.evaluationId });
  return { label: binding.label, inline: binding.inline !== null };
}

/** Every recorded fact for a member must belong to a route node of the graph and name a bound label; facts for non-members are inert. */
function assertFactsConsistent(input: ReadinessInput, byId: ReadonlyMap<PlanNodeId, PlanNode>): void {
  for (const [nodeId, fact] of input.routeSelections) {
    if (fact.planNodeId !== nodeId) throw new ReadinessFactError(`route-selection fact keyed by ${nodeId} names PlanNode ${fact.planNodeId}`, { nodeId, factNodeId: fact.planNodeId });
    const node = byId.get(nodeId);
    if (!node) continue;
    if (node.kind !== "pattern" || node.shape.pattern !== "route") throw new ReadinessFactError(`PlanNode ${nodeId} is not a route node yet carries a route-selection fact`, { nodeId });
    if (!node.shape.branches.some((b) => b.label === fact.selectedLabel)) throw new ReadinessFactError(`route PlanNode ${nodeId} recorded selection ${fact.selectedLabel}, which its shape does not bind`, { nodeId, selectedLabel: fact.selectedLabel });
  }
}

/** The activation of one current-revision edge from the graph and the facts alone. */
export function edgeActivation(input: ReadinessInput, edge: PlanEdge): EdgeActivation {
  const byId = new Map(input.graph.nodes.map((node) => [node.id, node] as const));
  return activation(input, byId, edge);
}

function activation(input: ReadinessInput, byId: ReadonlyMap<PlanNodeId, PlanNode>, edge: PlanEdge): EdgeActivation {
  const source = member(input, byId, edge, edge.sourceNodeId);
  if (edge.type === "retry") throw new ReadinessFactError(`PlanEdge ${edge.id} is a retry edge; its activation belongs to a later phase`, { edgeId: edge.id });
  if (!PLAN_NODE_MACHINE.isTerminal(source.status)) return { kind: "pending" };
  if (source.status === "skipped") return { kind: "inactive" };
  if (source.status === "failed" || source.status === "cancelled") return { kind: "failed", status: source.status };
  // Succeeded.
  switch (edge.type) {
    case "fan_in":
      return { kind: "delivers" };
    case "branch": {
      const shape = source.kind === "pattern" && source.shape.pattern === "route" ? source.shape : null;
      if (shape === null) throw new ReadinessFactError(`PlanEdge ${edge.id} is a branch edge out of ${source.id}, which is not a route node`, { edgeId: edge.id, nodeId: source.id });
      const binding = shape.branches.find((b) => b.label === edge.label);
      if (!binding || binding.inline !== null) throw new ReadinessFactError(`PlanEdge ${edge.id} names branch ${edge.label}, which route PlanNode ${source.id} does not bind as a composite branch`, { edgeId: edge.id, nodeId: source.id, label: edge.label });
      return selectionOf(input, source).label === edge.label ? { kind: "delivers" } : { kind: "inactive" };
    }
    case "sequence":
      if (source.kind === "pattern" && source.shape.pattern === "route") return selectionOf(input, source).inline ? { kind: "delivers" } : { kind: "inactive" };
      return { kind: "delivers" };
  }
}

export function evaluateReadiness(input: ReadinessInput): ReadinessEvaluation {
  const byId = new Map(input.graph.nodes.map((node) => [node.id, node] as const));
  assertFactsConsistent(input, byId);
  const decisions = schedulingOrder(input.graph).map((node): ReadinessDecision => decide(input, byId, node));
  return { runId: input.graph.runId, revisionNumber: input.graph.revisionNumber, decisions };
}

/** The decision for one member; exported for callers that revalidate a single node inside a transaction. */
export function decideReadiness(input: ReadinessInput, nodeId: PlanNodeId): ReadinessDecision {
  const byId = new Map(input.graph.nodes.map((node) => [node.id, node] as const));
  assertFactsConsistent(input, byId);
  const node = byId.get(nodeId);
  if (!node) throw new Error(`PlanNode ${nodeId} is not a member of revision ${input.graph.revisionNumber}`);
  return decide(input, byId, node);
}

function decide(input: ReadinessInput, byId: ReadonlyMap<PlanNodeId, PlanNode>, node: PlanNode): ReadinessDecision {
  const incoming = predecessorEdges(input.graph, node.id);
  const edgeTypes = [...new Set(incoming.map((edge) => edge.type))].sort();
  if (node.status === "ready") return { kind: "ready", nodeId: node.id };
  if (node.status === "running" || node.status === "waiting") return { kind: "active", nodeId: node.id, status: node.status };
  if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", nodeId: node.id, status: node.status as Extract<PlanNodeStatus, "succeeded" | "failed" | "cancelled" | "skipped"> };
  // Pending: a later-phase edge or Pattern is never decided here.
  if (edgeTypes.some((type) => !SUPPORTED_EDGE_TYPES.includes(type))) {
    return { kind: "deferred", nodeId: node.id, reason: "later_phase_edge", pattern: node.kind === "pattern" ? node.pattern : null, edgeTypes };
  }
  if (node.kind === "pattern" && !SUPPORTED_PATTERNS.includes(node.pattern)) return { kind: "deferred", nodeId: node.id, reason: "later_phase_pattern", pattern: node.pattern, edgeTypes };
  if (node.kind === "join") {
    if (incoming.some((edge) => edge.type !== "fan_in")) throw new ReadinessFactError(`join PlanNode ${node.id} has a non-fan_in edge`, { nodeId: node.id, edgeTypes });
    if (incoming.length === 0) throw new ReadinessFactError(`join PlanNode ${node.id} has no fan_in predecessor`, { nodeId: node.id });
  } else if (incoming.some((edge) => edge.type === "fan_in")) {
    throw new ReadinessFactError(`pattern PlanNode ${node.id} receives a fan_in edge`, { nodeId: node.id });
  }
  if (incoming.length === 0) return { kind: "become_ready", nodeId: node.id, dependencyFailures: [] };
  const activations = incoming.map((edge) => ({ edge, source: member(input, byId, edge, edge.sourceNodeId), activation: activation(input, byId, edge) }));
  const awaiting = [...new Set(activations.filter((a) => a.activation.kind === "pending").map((a) => a.source.id))];
  if (awaiting.length > 0) return { kind: "remain_pending", nodeId: node.id, awaiting };
  if (activations.every((a) => a.activation.kind === "inactive")) return { kind: "become_skipped", nodeId: node.id, cause: "all_predecessors_skipped", failed: [] };
  // A join settles its policy over every terminal source; readiness only says the sources have all ended.
  if (node.kind === "join") return { kind: "become_ready", nodeId: node.id, dependencyFailures: [] };
  const failed = [...new Set(activations.filter((a) => a.activation.kind === "failed").map((a) => a.source.id))];
  if (failed.length > 0) {
    return node.runOnDependencyFailure ? { kind: "become_ready", nodeId: node.id, dependencyFailures: failed } : { kind: "become_skipped", nodeId: node.id, cause: "dependency_failed", failed };
  }
  return { kind: "become_ready", nodeId: node.id, dependencyFailures: [] };
}
