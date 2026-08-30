/**
 * Pure Plan Node readiness (execution-model §4.3, §7.1; invariants 5 the
 * runtime owns dependencies and 15 the current graph is never inferred):
 * every predecessor-state combination, the dependency-failure policy,
 * current versus historical revisions, removed nodes, later-phase deferral,
 * and deterministic ordering — from an immutable graph alone.
 */
import { EMPTY_MANIFEST_TEMPLATE, newId, ROOT_SOURCE_PATH, type Pattern, type PlanEdge, type PlanEdgeType, type PlanGraph, type PlanNode, type PlanNodeId, type PlanNodeStatus } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { extendPlan, nodeInput, openHarness, patternDefinition, seedRun } from "../persistence/test-support.ts";
import { evaluateReadiness, decideReadiness, predecessorEdges, schedulingOrder, successorEdges, SUPPORTED_EDGE_TYPES, SUPPORTED_PATTERNS, type ReadinessDecision } from "./readiness.ts";

const runId = newId("run");
const agent = newId("agentDefinitionRevision");
const at = "2026-01-01T00:00:00.000Z";
const terminal = (status: PlanNodeStatus) => status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped";

function node(id: string, status: PlanNodeStatus, options: { pattern?: Pattern; runOnDependencyFailure?: boolean; kind?: "pattern" | "join"; sourcePath?: string } = {}): PlanNode {
  const base = { id: id as PlanNodeId, runId, createdInRevisionNumber: 1, title: id, sourcePath: options.sourcePath ?? id, status, waitReason: status === "waiting" ? ("decision" as const) : null, allocation: { costUsd: 1, tokens: 1, attempts: 1 }, maxConcurrency: null, maxWallClockMs: null, runOnDependencyFailure: options.runOnDependencyFailure ?? false, outputArtifactIds: status === "succeeded" ? [] : null, createdAt: at, startedAt: null, endedAt: terminal(status) ? at : null };
  if (options.kind === "join") return { ...base, kind: "join", fanInPolicy: "require_all", allocation: { costUsd: 0, tokens: 0, attempts: 0 } };
  const pattern = options.pattern ?? "single";
  const operation = { agentDefinitionRevisionId: agent, title: id, input: { ...EMPTY_MANIFEST_TEMPLATE }, role: "worker" as const, readOnly: false };
  const shape = pattern === "chain" ? { pattern: "chain" as const, steps: [operation, operation] } : pattern === "parallel" ? { pattern: "parallel" as const, items: [operation], aggregate: null, requireAll: true } : pattern === "route" ? { pattern: "route" as const, selector: { kind: "evaluator" as const, agentDefinitionRevisionId: agent }, branches: [{ label: "x", inline: operation }] } : { pattern: "single" as const, role: "worker" as const, operation };
  return { ...base, kind: "pattern", pattern: shape.pattern, shape, input: { ...EMPTY_MANIFEST_TEMPLATE }, onAllocationExhausted: "fail", gateAcceptanceCriterionIds: [], scope: null } as PlanNode;
}

function edge(source: string, target: string, type: PlanEdgeType = "sequence", position = 0): PlanEdge {
  const base = { id: newId("planEdge"), runId, revisionNumber: 2, sourceNodeId: source as PlanNodeId, targetNodeId: target as PlanNodeId, position, createdAt: at };
  if (type === "branch") return { ...base, type, label: "x" };
  if (type === "retry") return { ...base, type, round: 2 };
  return { ...base, type };
}

function graph(nodes: PlanNode[], edges: PlanEdge[] = []): PlanGraph {
  return { runId, revisionNumber: 2, nodes, edges };
}

const root = node("pn_root", "running", { sourcePath: ROOT_SOURCE_PATH });
const decisionFor = (nodes: PlanNode[], edges: PlanEdge[], id: string): ReadinessDecision => evaluateReadiness(graph([root, ...nodes], edges)).decisions.find((d) => d.nodeId === id)!;

describe("readiness evaluator", () => {
  it("decides every predecessor-state combination from the graph alone", () => {
    const t = (id: string, status: PlanNodeStatus) => node(id, status);
    const target = (runOnDependencyFailure: boolean) => node("pn_target", "pending", { runOnDependencyFailure });
    const cases: { name: string; predecessors: PlanNode[]; runOnDependencyFailure?: boolean; expected: Partial<ReadinessDecision> }[] = [
      { name: "no predecessors", predecessors: [], expected: { kind: "become_ready", dependencyFailures: [] } },
      { name: "pending predecessor", predecessors: [t("pn_a", "pending")], expected: { kind: "remain_pending", awaiting: ["pn_a"] } },
      { name: "ready predecessor", predecessors: [t("pn_a", "ready")], expected: { kind: "remain_pending", awaiting: ["pn_a"] } },
      { name: "running predecessor", predecessors: [t("pn_a", "running")], expected: { kind: "remain_pending", awaiting: ["pn_a"] } },
      { name: "waiting predecessor", predecessors: [t("pn_a", "waiting")], expected: { kind: "remain_pending", awaiting: ["pn_a"] } },
      { name: "one running among terminal predecessors", predecessors: [t("pn_a", "succeeded"), t("pn_b", "running")], expected: { kind: "remain_pending", awaiting: ["pn_b"] } },
      { name: "succeeded", predecessors: [t("pn_a", "succeeded")], expected: { kind: "become_ready", dependencyFailures: [] } },
      { name: "two succeeded", predecessors: [t("pn_a", "succeeded"), t("pn_b", "succeeded")], expected: { kind: "become_ready", dependencyFailures: [] } },
      { name: "skipped", predecessors: [t("pn_a", "skipped")], expected: { kind: "become_skipped", cause: "all_predecessors_skipped", failed: [] } },
      { name: "all skipped", predecessors: [t("pn_a", "skipped"), t("pn_b", "skipped")], expected: { kind: "become_skipped", cause: "all_predecessors_skipped", failed: [] } },
      { name: "all skipped even with runOnDependencyFailure", predecessors: [t("pn_a", "skipped")], runOnDependencyFailure: true, expected: { kind: "become_skipped", cause: "all_predecessors_skipped" } },
      { name: "mixed succeeded and skipped", predecessors: [t("pn_a", "succeeded"), t("pn_b", "skipped")], expected: { kind: "become_ready", dependencyFailures: [] } },
      { name: "failed", predecessors: [t("pn_a", "failed")], expected: { kind: "become_skipped", cause: "dependency_failed", failed: ["pn_a"] } },
      { name: "cancelled", predecessors: [t("pn_a", "cancelled")], expected: { kind: "become_skipped", cause: "dependency_failed", failed: ["pn_a"] } },
      { name: "failed beside succeeded", predecessors: [t("pn_a", "succeeded"), t("pn_b", "failed")], expected: { kind: "become_skipped", cause: "dependency_failed", failed: ["pn_b"] } },
      { name: "failed with runOnDependencyFailure", predecessors: [t("pn_a", "failed")], runOnDependencyFailure: true, expected: { kind: "become_ready", dependencyFailures: ["pn_a"] } },
      { name: "cancelled with runOnDependencyFailure", predecessors: [t("pn_a", "cancelled")], runOnDependencyFailure: true, expected: { kind: "become_ready", dependencyFailures: ["pn_a"] } },
      { name: "failed and skipped with runOnDependencyFailure", predecessors: [t("pn_a", "failed"), t("pn_b", "skipped")], runOnDependencyFailure: true, expected: { kind: "become_ready", dependencyFailures: ["pn_a"] } },
      { name: "failed and succeeded with runOnDependencyFailure", predecessors: [t("pn_a", "succeeded"), t("pn_b", "failed"), t("pn_c", "cancelled")], runOnDependencyFailure: true, expected: { kind: "become_ready", dependencyFailures: ["pn_b", "pn_c"] } },
      { name: "failed and running predecessors wait first", predecessors: [t("pn_a", "failed"), t("pn_b", "running")], runOnDependencyFailure: true, expected: { kind: "remain_pending", awaiting: ["pn_b"] } },
    ];
    for (const c of cases) {
      const edges = c.predecessors.map((p, i) => edge(p.id, "pn_target", "sequence", i));
      expect(decisionFor([...c.predecessors, target(c.runOnDependencyFailure ?? false)], edges, "pn_target"), c.name).toMatchObject({ nodeId: "pn_target", ...c.expected });
    }
  });

  it("reports ready, active, and terminal members without deciding anything for them", () => {
    const statuses: PlanNodeStatus[] = ["ready", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"];
    const nodes = statuses.map((status, i) => node(`pn_${i}`, status));
    const decisions = evaluateReadiness(graph([root, ...nodes], nodes.map((n, i) => edge("pn_root", n.id, "sequence", i)))).decisions;
    expect(decisions[0]).toEqual({ kind: "active", nodeId: "pn_root", status: "running" });
    expect(decisions.slice(1)).toEqual([
      { kind: "ready", nodeId: "pn_0" },
      { kind: "active", nodeId: "pn_1", status: "running" },
      { kind: "active", nodeId: "pn_2", status: "waiting" },
      { kind: "terminal", nodeId: "pn_3", status: "succeeded" },
      { kind: "terminal", nodeId: "pn_4", status: "failed" },
      { kind: "terminal", nodeId: "pn_5", status: "cancelled" },
      { kind: "terminal", nodeId: "pn_6", status: "skipped" },
    ]);
  });

  it("defers later-phase Patterns, join nodes, and non-sequence edges instead of scheduling them", () => {
    expect(SUPPORTED_PATTERNS).toEqual(["single", "chain"]);
    expect(SUPPORTED_EDGE_TYPES).toEqual(["sequence"]);
    const chain = node("pn_chain", "pending", { pattern: "chain" });
    const parallel = node("pn_parallel", "pending", { pattern: "parallel" });
    const route = node("pn_route", "pending", { pattern: "route" });
    const afterRoute = node("pn_after_route", "pending");
    const join = node("pn_join", "pending", { kind: "join" });
    const branched = node("pn_branched", "pending");
    const retried = node("pn_retried", "pending");
    const done = node("pn_done", "succeeded");
    const decisions = evaluateReadiness(
      graph([root, done, chain, parallel, route, afterRoute, join, branched, retried], [edge("pn_done", "pn_chain"), edge("pn_done", "pn_parallel"), edge("pn_route", "pn_after_route"), edge("pn_done", "pn_join", "fan_in"), edge("pn_done", "pn_branched", "branch"), edge("pn_done", "pn_retried", "retry")]),
    ).decisions;
    const by = Object.fromEntries(decisions.map((d) => [d.nodeId, d]));
    expect(by.pn_chain).toEqual({ kind: "become_ready", nodeId: "pn_chain", dependencyFailures: [] });
    expect(by.pn_parallel).toEqual({ kind: "deferred", nodeId: "pn_parallel", reason: "later_phase_pattern", pattern: "parallel", edgeTypes: ["sequence"] });
    expect(by.pn_route).toEqual({ kind: "deferred", nodeId: "pn_route", reason: "later_phase_pattern", pattern: "route", edgeTypes: [] });
    // A sequence edge out of a route node is selection-dependent: its target is deferred, never readied by plain sequence rules.
    expect(by.pn_after_route).toEqual({ kind: "deferred", nodeId: "pn_after_route", reason: "later_phase_edge", pattern: "single", edgeTypes: ["sequence"] });
    expect(by.pn_join).toEqual({ kind: "deferred", nodeId: "pn_join", reason: "join_node", pattern: null, edgeTypes: ["fan_in"] });
    expect(by.pn_branched).toEqual({ kind: "deferred", nodeId: "pn_branched", reason: "later_phase_edge", pattern: "single", edgeTypes: ["branch"] });
    expect(by.pn_retried).toEqual({ kind: "deferred", nodeId: "pn_retried", reason: "later_phase_edge", pattern: "single", edgeTypes: ["retry"] });
  });

  it("orders decisions by membership position then node id, and lists edges deterministically", () => {
    const c = node("pn_c", "pending");
    const a = node("pn_a", "pending");
    const b = node("pn_b", "pending");
    const g = graph([root, c, a, b], [edge("pn_c", "pn_b", "sequence", 1), edge("pn_a", "pn_b", "sequence", 0), edge("pn_root", "pn_a"), edge("pn_root", "pn_c")]);
    expect(schedulingOrder(g).map((n) => n.id)).toEqual(["pn_root", "pn_c", "pn_a", "pn_b"]);
    expect(evaluateReadiness(g).decisions.map((d) => d.nodeId)).toEqual(["pn_root", "pn_c", "pn_a", "pn_b"]);
    expect(predecessorEdges(g, "pn_b" as PlanNodeId).map((e) => e.sourceNodeId)).toEqual(["pn_a", "pn_c"]);
    expect(successorEdges(g, "pn_root" as PlanNodeId).map((e) => e.targetNodeId)).toEqual(["pn_c", "pn_a"]);
    // Deterministic: the same graph, however its arrays are ordered, yields the same decisions.
    const shuffled: PlanGraph = { ...g, nodes: [b, a, c, root].sort(() => 0), edges: [...g.edges].reverse() };
    const position = new Map(g.nodes.map((n, i) => [n.id, i] as const));
    const reordered = { ...shuffled, nodes: [...shuffled.nodes].sort((x, y) => position.get(x.id)! - position.get(y.id)!) };
    expect(evaluateReadiness(reordered)).toEqual(evaluateReadiness(g));
    expect(decideReadiness(g, "pn_b" as PlanNodeId)).toEqual({ kind: "remain_pending", nodeId: "pn_b", awaiting: ["pn_a", "pn_c"] });
    expect(() => decideReadiness(g, "pn_zzz" as PlanNodeId)).toThrow(/not a member/);
  });

  it("reads only the current revision: a historical edge never activates a current node, and a removed node cannot activate a successor", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const a = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0", title: "A" }));
      const b = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", title: "B" }));
      // Revision 2: A → B. A starts running; B waits on it.
      extendPlan(h, s, [a, b], [{ type: "sequence", sourceNodeId: a.id, targetNodeId: b.id, position: 0 }]);
      h.stores.plans.transitionNode(a.id, { to: "ready" });
      h.stores.plans.transitionNode(a.id, { to: "running" });
      const second = h.stores.plans.currentGraph(s.run.id);
      expect(evaluateReadiness(second).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "remain_pending", nodeId: b.id, awaiting: [a.id] });
      // Revision 3 keeps B and drops A (and the edge): B has no current predecessor and becomes ready; A's later outcome is irrelevant.
      h.ctx.tx.write(() => {
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [s.root.id, b.id], createdNodes: [], edges: [], cancelledNodeIds: [] });
      });
      const third = h.stores.plans.currentGraph(s.run.id);
      expect(third.revisionNumber).toBe(3);
      expect(third.nodes.map((n) => n.id)).toEqual([s.root.id, b.id]);
      expect(third.edges).toEqual([]);
      expect(evaluateReadiness(third).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_ready", nodeId: b.id, dependencyFailures: [] });
      // The historical graph still says what it said; it is inspectable, never executable.
      h.stores.plans.transitionNode(a.id, { to: "failed", reason: "invocation_failed" });
      expect(evaluateReadiness(h.stores.plans.graph(s.run.id, 2)).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_skipped", nodeId: b.id, cause: "dependency_failed", failed: [a.id] });
      expect(evaluateReadiness(h.stores.plans.currentGraph(s.run.id)).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_ready", nodeId: b.id, dependencyFailures: [] });
      // Revision 4 adds C behind B with a fresh edge: C is decided by that edge alone, and A (removed, failed) plays no part.
      const c = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2", title: "C" }));
      h.ctx.tx.write(() => {
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [s.root.id, b.id, c.id], createdNodes: [c], edges: [{ type: "sequence", sourceNodeId: b.id, targetNodeId: c.id, position: 0 }], cancelledNodeIds: [] });
      });
      const fourth = h.stores.plans.currentGraph(s.run.id);
      expect(evaluateReadiness(fourth).decisions.map((d) => [d.nodeId, d.kind])).toEqual([[s.root.id, "ready"], [b.id, "become_ready"], [c.id, "remain_pending"]]);
    } finally {
      h.close();
    }
  });
});
