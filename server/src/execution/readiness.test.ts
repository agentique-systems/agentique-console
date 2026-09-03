/**
 * Pure Plan Node readiness (execution-model §4.3, §7.1; invariants 5 the
 * runtime owns dependencies and 15 the current graph is never inferred):
 * readiness is a pure function over the current graph plus the explicit
 * canonical condition facts handed in — every predecessor-state
 * combination, the dependency-failure policy, `branch(label)` activation
 * from a recorded route selection, `sequence` edges out of a route,
 * `fan_in` readiness of joins, missing and contradictory facts as typed
 * failures, current versus historical revisions and facts, removed nodes,
 * later-phase deferral, and deterministic ordering — from the input alone.
 */
import { EMPTY_MANIFEST_TEMPLATE, newId, ROOT_SOURCE_PATH, type Pattern, type PlanEdge, type PlanEdgeType, type PlanGraph, type PlanNode, type PlanNodeId, type PlanNodeStatus } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { extendPlan, nodeInput, openHarness, patternDefinition, seedRun } from "../persistence/test-support.ts";
import { projectReadinessInput } from "./readiness-facts.ts";
import { decideReadiness, edgeActivation, evaluateReadiness, predecessorEdges, ReadinessFactError, schedulingOrder, successorEdges, type OptimizerVerdictFact, type ReadinessDecision, type ReadinessInput, type RouteSelectionFact } from "./readiness.ts";

const runId = newId("run");
const agent = newId("agentDefinitionRevision");
const at = "2026-01-01T00:00:00.000Z";
const terminal = (status: PlanNodeStatus) => status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped";

interface NodeOptions {
  pattern?: Pattern;
  runOnDependencyFailure?: boolean;
  kind?: "pattern" | "join";
  fanInPolicy?: "require_all" | "require_any";
  sourcePath?: string;
  /** Route branches: label → inline (`true`) or composite (`false`). */
  branches?: Record<string, boolean>;
  /** An evaluator_optimizer node's round: `null` for an inline producer, a number for an evaluate-only node. */
  round?: number | null;
  maxRounds?: number;
}

function node(id: string, status: PlanNodeStatus, options: NodeOptions = {}): PlanNode {
  const base = { id: id as PlanNodeId, runId, createdInRevisionNumber: 1, title: id, sourcePath: options.sourcePath ?? id, status, waitReason: status === "waiting" ? ("decision" as const) : null, allocation: { costUsd: 1, tokens: 1, attempts: 1 }, maxConcurrency: null, maxWallClockMs: null, runOnDependencyFailure: options.runOnDependencyFailure ?? false, outputArtifactIds: status === "succeeded" ? [] : null, createdAt: at, startedAt: null, endedAt: terminal(status) ? at : null };
  if (options.kind === "join") return { ...base, kind: "join", fanInPolicy: options.fanInPolicy ?? "require_all", allocation: { costUsd: 0, tokens: 0, attempts: 0 } };
  const pattern = options.pattern ?? "single";
  const operation = { agentDefinitionRevisionId: agent, title: id, input: { ...EMPTY_MANIFEST_TEMPLATE }, role: "worker" as const, readOnly: false };
  const branches = Object.entries(options.branches ?? { x: true })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, inline]) => ({ label, inline: inline ? operation : null }));
  const shape =
    pattern === "chain"
      ? { pattern: "chain" as const, steps: [operation, operation] }
      : pattern === "parallel"
        ? { pattern: "parallel" as const, items: [operation], aggregate: null, requireAll: true }
        : pattern === "route"
          ? { pattern: "route" as const, selector: { kind: "evaluator" as const, agentDefinitionRevisionId: agent }, branches }
          : pattern === "coordinator_worker"
            ? { pattern: "coordinator_worker" as const, coordinator: { ...operation, role: "coordinator" as const }, worker: operation, bounds: { maxTasks: 2, maxConcurrentWorkers: 1, maxCoordinatorInvocations: 2 } }
            : pattern === "evaluator_optimizer"
              ? { pattern: "evaluator_optimizer" as const, producer: (options.round ?? null) === null ? operation : null, evaluator: { ...operation, role: "evaluator" as const, readOnly: true }, maxRounds: options.maxRounds ?? 2, round: options.round ?? null }
              : { pattern: "single" as const, role: "worker" as const, operation };
  return { ...base, kind: "pattern", pattern: shape.pattern, shape, input: { ...EMPTY_MANIFEST_TEMPLATE }, onAllocationExhausted: "fail", gateAcceptanceCriterionIds: [], scope: null } as PlanNode;
}

function edge(source: string, target: string, type: PlanEdgeType = "sequence", position = 0, label = "x", round = 2): PlanEdge {
  const base = { id: newId("planEdge"), runId, revisionNumber: 2, sourceNodeId: source as PlanNodeId, targetNodeId: target as PlanNodeId, position, createdAt: at };
  if (type === "branch") return { ...base, type, label };
  if (type === "retry") return { ...base, type, round };
  return { ...base, type };
}

function graph(nodes: PlanNode[], edges: PlanEdge[] = []): PlanGraph {
  return { runId, revisionNumber: 2, nodes, edges };
}

const fact = (nodeId: string, selectedLabel: string): [PlanNodeId, RouteSelectionFact] => [nodeId as PlanNodeId, { planNodeId: nodeId as PlanNodeId, selectedLabel, evaluationId: newId("evaluation") }];
const verdict = (nodeId: string, verdict: OptimizerVerdictFact["verdict"], round = 1, maxRounds = 2): [PlanNodeId, OptimizerVerdictFact] => [nodeId as PlanNodeId, { planNodeId: nodeId as PlanNodeId, round, maxRounds, evaluationId: newId("evaluation"), verdict }];

function input(g: PlanGraph, facts: [PlanNodeId, RouteSelectionFact][] = [], verdicts: [PlanNodeId, OptimizerVerdictFact][] = []): ReadinessInput {
  return { graph: g, routeSelections: new Map(facts), optimizerVerdicts: new Map(verdicts) };
}

const root = node("pn_root", "running", { sourcePath: ROOT_SOURCE_PATH });
const decisionFor = (nodes: PlanNode[], edges: PlanEdge[], id: string, facts: [PlanNodeId, RouteSelectionFact][] = []): ReadinessDecision => evaluateReadiness(input(graph([root, ...nodes], edges), facts)).decisions.find((d) => d.nodeId === id)!;
const by = (nodes: PlanNode[], edges: PlanEdge[], facts: [PlanNodeId, RouteSelectionFact][] = [], verdicts: [PlanNodeId, OptimizerVerdictFact][] = []) => Object.fromEntries(evaluateReadiness(input(graph([root, ...nodes], edges), facts, verdicts)).decisions.map((d) => [d.nodeId, d]));

describe("readiness evaluator", () => {
  it("decides every predecessor-state combination of sequence edges from the graph alone", () => {
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
    const decisions = evaluateReadiness(input(graph([root, ...nodes], nodes.map((n, i) => edge("pn_root", n.id, "sequence", i))))).decisions;
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

  it("activates exactly the selected branch(label) edge from the recorded selection and skips every inactive branch", () => {
    // route R with inline branch `a` and composite branches `b` and `c`; B and C are the composite entries; S is the successor.
    const route = node("pn_r", "succeeded", { pattern: "route", branches: { a: true, b: false, c: false } });
    const b = node("pn_b", "pending");
    const c = node("pn_c", "pending");
    const edges = [edge("pn_r", "pn_b", "branch", 0, "b"), edge("pn_r", "pn_c", "branch", 0, "c")];
    // Composite selection `b`: only the b edge delivers; c is skipped through the all-inactive rule.
    const selectedB = by([route, b, c], edges, [fact("pn_r", "b")]);
    expect(selectedB.pn_b).toEqual({ kind: "become_ready", nodeId: "pn_b", dependencyFailures: [] });
    expect(selectedB.pn_c).toEqual({ kind: "become_skipped", nodeId: "pn_c", cause: "all_predecessors_skipped", failed: [] });
    // Inline selection `a`: every composite branch is skipped.
    const selectedA = by([route, b, c], edges, [fact("pn_r", "a")]);
    expect(selectedA.pn_b).toEqual({ kind: "become_skipped", nodeId: "pn_b", cause: "all_predecessors_skipped", failed: [] });
    expect(selectedA.pn_c).toEqual({ kind: "become_skipped", nodeId: "pn_c", cause: "all_predecessors_skipped", failed: [] });
    // The route still running: every branch target waits, whatever facts exist.
    const running = by([node("pn_r", "running", { pattern: "route", branches: { a: true, b: false, c: false } }), b, c], edges, [fact("pn_r", "b")]);
    expect(running.pn_b).toEqual({ kind: "remain_pending", nodeId: "pn_b", awaiting: ["pn_r"] });
    expect(running.pn_c).toEqual({ kind: "remain_pending", nodeId: "pn_c", awaiting: ["pn_r"] });
    // A failed, cancelled, or skipped route: branch targets follow the ordinary dependency rules, no fact needed.
    for (const status of ["failed", "cancelled"] as const) {
      const failed = by([node("pn_r", status, { pattern: "route", branches: { a: true, b: false, c: false } }), b, node("pn_c", "pending", { runOnDependencyFailure: true })], edges);
      expect(failed.pn_b).toEqual({ kind: "become_skipped", nodeId: "pn_b", cause: "dependency_failed", failed: ["pn_r"] });
      expect(failed.pn_c).toEqual({ kind: "become_ready", nodeId: "pn_c", dependencyFailures: ["pn_r"] });
    }
    const skipped = by([node("pn_r", "skipped", { pattern: "route", branches: { a: true, b: false, c: false } }), b, c], edges);
    expect(skipped.pn_b).toEqual({ kind: "become_skipped", nodeId: "pn_b", cause: "all_predecessors_skipped", failed: [] });
    // Edge activation itself is pure and closed.
    const g = graph([root, route, b, c], edges);
    expect(edgeActivation(input(g, [fact("pn_r", "b")]), edges[0]!)).toEqual({ kind: "delivers" });
    expect(edgeActivation(input(g, [fact("pn_r", "b")]), edges[1]!)).toEqual({ kind: "inactive" });
    expect(edgeActivation(input(graph([root, node("pn_r", "running", { pattern: "route", branches: { a: true, b: false, c: false } }), b, c], edges), []), edges[0]!)).toEqual({ kind: "pending" });
    expect(edgeActivation(input(graph([root, node("pn_r", "failed", { pattern: "route", branches: { a: true, b: false, c: false } }), b, c], edges), []), edges[0]!)).toEqual({ kind: "failed", status: "failed" });
  });

  it("delivers a route's sequence edges only for an inline selection, so a successor waits for the selected composite branch's exit", () => {
    // R –branch(b)→ B → S, R → S (sequence), R's inline branch a.
    const route = (status: PlanNodeStatus) => node("pn_r", status, { pattern: "route", branches: { a: true, b: false } });
    const s = node("pn_s", "pending");
    const edges = [edge("pn_r", "pn_b", "branch", 0, "b"), edge("pn_r", "pn_s", "sequence", 0), edge("pn_b", "pn_s", "sequence", 1)];
    // Composite selection: R's own sequence edge is inactive; S waits for B, then becomes ready from B alone.
    expect(by([route("succeeded"), node("pn_b", "running"), s], edges, [fact("pn_r", "b")]).pn_s).toEqual({ kind: "remain_pending", nodeId: "pn_s", awaiting: ["pn_b"] });
    expect(by([route("succeeded"), node("pn_b", "succeeded"), s], edges, [fact("pn_r", "b")]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    expect(by([route("succeeded"), node("pn_b", "failed"), s], edges, [fact("pn_r", "b")]).pn_s).toEqual({ kind: "become_skipped", nodeId: "pn_s", cause: "dependency_failed", failed: ["pn_b"] });
    expect(edgeActivation(input(graph([root, route("succeeded"), node("pn_b", "running"), s], edges), [fact("pn_r", "b")]), edges[1]!)).toEqual({ kind: "inactive" });
    // Inline selection: B is skipped and S proceeds from R once every composite alternative has been skipped.
    expect(by([route("succeeded"), node("pn_b", "pending"), s], edges, [fact("pn_r", "a")]).pn_b).toEqual({ kind: "become_skipped", nodeId: "pn_b", cause: "all_predecessors_skipped", failed: [] });
    expect(by([route("succeeded"), node("pn_b", "pending"), s], edges, [fact("pn_r", "a")]).pn_s).toEqual({ kind: "remain_pending", nodeId: "pn_s", awaiting: ["pn_b"] });
    expect(by([route("succeeded"), node("pn_b", "skipped"), s], edges, [fact("pn_r", "a")]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    expect(edgeActivation(input(graph([root, route("succeeded"), node("pn_b", "skipped"), s], edges), [fact("pn_r", "a")]), edges[1]!)).toEqual({ kind: "delivers" });
    // A failed route with no fact: S is skipped by the dependency rule (or readied with the failure when it opts in).
    expect(by([route("failed"), node("pn_b", "skipped"), s], edges).pn_s).toEqual({ kind: "become_skipped", nodeId: "pn_s", cause: "dependency_failed", failed: ["pn_r"] });
  });

  it("fails explicitly on a missing or contradictory route condition fact instead of guessing", () => {
    const route = node("pn_r", "succeeded", { pattern: "route", branches: { a: true, b: false } });
    const b = node("pn_b", "pending");
    const s = node("pn_s", "pending");
    const edges = [edge("pn_r", "pn_b", "branch", 0, "b"), edge("pn_r", "pn_s", "sequence", 0)];
    // Missing: a succeeded route without a recorded selection.
    expect(() => evaluateReadiness(input(graph([root, route, b, s], edges)))).toThrow(ReadinessFactError);
    expect(() => decideReadiness(input(graph([root, route, b, s], edges)), "pn_s" as PlanNodeId)).toThrow(/without a recorded route-selection Evaluation/);
    // Contradictory: a label the shape does not bind; a fact on a member that is not a route node; a fact whose key disagrees with its node.
    expect(() => evaluateReadiness(input(graph([root, route, b, s], edges), [fact("pn_r", "zzz")]))).toThrow(/does not bind/);
    expect(() => evaluateReadiness(input(graph([root, route, b, s], edges), [fact("pn_r", "b"), fact("pn_s", "a")]))).toThrow(/not a route node/);
    expect(() => evaluateReadiness(input(graph([root, route, b, s], edges), [["pn_b" as PlanNodeId, { planNodeId: "pn_r" as PlanNodeId, selectedLabel: "b", evaluationId: newId("evaluation") }]]))).toThrow(/keyed by/);
    // Contradictory graph: a branch edge out of a non-route node, or naming a label the route binds inline.
    expect(() => evaluateReadiness(input(graph([root, node("pn_x", "succeeded"), b], [edge("pn_x", "pn_b", "branch", 0, "b")])))).toThrow(/not a route node/);
    expect(() => evaluateReadiness(input(graph([root, route, b], [edge("pn_r", "pn_b", "branch", 0, "a")]), [fact("pn_r", "a")]))).toThrow(/composite branch/);
    // A fact for a node outside the current membership is inert: it activates nothing and breaks nothing.
    expect(by([node("pn_a", "succeeded"), s], [edge("pn_a", "pn_s")], [fact("pn_gone", "b")]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    // No fact is needed while the route has not ended or when it did not succeed.
    expect(by([node("pn_r", "running", { pattern: "route", branches: { a: true, b: false } }), b, s], edges).pn_s).toEqual({ kind: "remain_pending", nodeId: "pn_s", awaiting: ["pn_r"] });
    expect(by([node("pn_r", "cancelled", { pattern: "route", branches: { a: true, b: false } }), b, s], edges).pn_s).toMatchObject({ kind: "become_skipped", cause: "dependency_failed" });
  });

  it("makes a join ready once every fan_in predecessor is terminal, skipped when every one was skipped, and never applies the policy itself", () => {
    const join = (policy: "require_all" | "require_any" = "require_all") => node("pn_j", "pending", { kind: "join", fanInPolicy: policy });
    const edges = [edge("pn_a", "pn_j", "fan_in", 0), edge("pn_b", "pn_j", "fan_in", 1)];
    expect(by([node("pn_a", "succeeded"), node("pn_b", "running"), join()], edges).pn_j).toEqual({ kind: "remain_pending", nodeId: "pn_j", awaiting: ["pn_b"] });
    expect(by([node("pn_a", "succeeded"), node("pn_b", "succeeded"), join()], edges).pn_j).toEqual({ kind: "become_ready", nodeId: "pn_j", dependencyFailures: [] });
    // A failed predecessor still readies the join: the policy decides success or failure at settlement.
    expect(by([node("pn_a", "succeeded"), node("pn_b", "failed"), join()], edges).pn_j).toEqual({ kind: "become_ready", nodeId: "pn_j", dependencyFailures: [] });
    expect(by([node("pn_a", "failed"), node("pn_b", "cancelled"), join("require_any")], edges).pn_j).toEqual({ kind: "become_ready", nodeId: "pn_j", dependencyFailures: [] });
    expect(by([node("pn_a", "skipped"), node("pn_b", "succeeded"), join()], edges).pn_j).toEqual({ kind: "become_ready", nodeId: "pn_j", dependencyFailures: [] });
    expect(by([node("pn_a", "skipped"), node("pn_b", "skipped"), join()], edges).pn_j).toEqual({ kind: "become_skipped", nodeId: "pn_j", cause: "all_predecessors_skipped", failed: [] });
    // A ready join is reported ready (it executes deterministically from there); a join with a non-fan_in edge is a contradiction.
    expect(by([node("pn_a", "succeeded"), node("pn_b", "succeeded"), node("pn_j", "ready", { kind: "join" })], edges).pn_j).toEqual({ kind: "ready", nodeId: "pn_j" });
    expect(() => evaluateReadiness(input(graph([root, node("pn_a", "succeeded"), join()], [edge("pn_a", "pn_j", "sequence")])))).toThrow(/non-fan_in/);
    expect(() => evaluateReadiness(input(graph([root, node("pn_a", "succeeded"), node("pn_p", "pending")], [edge("pn_a", "pn_p", "fan_in")])))).toThrow(/receives a fan_in/);
  });

  it("decides every Pattern's node like any other, the evaluator_optimizer included, and a retry edge out of anything but an evaluate-only node is a contradiction", () => {
    const done = node("pn_done", "succeeded");
    const chain = node("pn_chain", "pending", { pattern: "chain" });
    const parallel = node("pn_parallel", "pending", { pattern: "parallel" });
    const route = node("pn_route", "pending", { pattern: "route" });
    const coordinator = node("pn_cw", "pending", { pattern: "coordinator_worker" });
    const optimizer = node("pn_eo", "pending", { pattern: "evaluator_optimizer" });
    const decisions = by([done, chain, parallel, route, coordinator, optimizer], [edge("pn_done", "pn_chain"), edge("pn_done", "pn_parallel"), edge("pn_done", "pn_route"), edge("pn_done", "pn_cw"), edge("pn_done", "pn_eo")]);
    for (const id of ["pn_chain", "pn_parallel", "pn_route", "pn_cw", "pn_eo"]) expect(decisions[id]).toEqual({ kind: "become_ready", nodeId: id, dependencyFailures: [] });
    const retried = node("pn_retried", "pending");
    expect(() => edgeActivation(input(graph([root, done, retried], [edge("pn_done", "pn_retried", "retry")])), edge("pn_done", "pn_retried", "retry"))).toThrow(/not an evaluate-only evaluator_optimizer node/);
    // An inline optimizer node is not a retry source either, and a retry(r) edge must leave round r − 1.
    const inline = node("pn_inline", "succeeded", { pattern: "evaluator_optimizer" });
    expect(() => edgeActivation(input(graph([root, inline, retried], [edge("pn_inline", "pn_retried", "retry")]), [], [verdict("pn_inline", "pass")]), edge("pn_inline", "pn_retried", "retry"))).toThrow(/not an evaluate-only/);
    const e1 = node("pn_e1", "succeeded", { pattern: "evaluator_optimizer", round: 1, maxRounds: 3 });
    expect(() => edgeActivation(input(graph([root, e1, retried], [edge("pn_e1", "pn_retried", "retry", 0, "x", 3)]), [], [verdict("pn_e1", "fail", 1, 3)]), edge("pn_e1", "pn_retried", "retry", 0, "x", 3))).toThrow(/retry\(3\) edge out of round 1/);
  });

  it("activates a retry(round) edge from the recorded round verdict alone: a failed or inconclusive round delivers, a pass skips every later round", () => {
    // E1 (evaluate-only, round 1 of 3) –retry(2)→ P2 → E2 (round 2) –retry(3)→ P3 → E3 (round 3); every E → S by sequence.
    const e = (id: string, status: PlanNodeStatus, round: number) => node(id, status, { pattern: "evaluator_optimizer", round, maxRounds: 3 });
    const p2 = node("pn_p2", "pending");
    const p3 = node("pn_p3", "pending");
    const s = node("pn_s", "pending");
    const edges = [
      edge("pn_e1", "pn_p2", "retry", 0, "x", 2),
      edge("pn_p2", "pn_e2", "sequence"),
      edge("pn_e2", "pn_p3", "retry", 0, "x", 3),
      edge("pn_p3", "pn_e3", "sequence"),
      edge("pn_e1", "pn_s", "sequence", 0),
      edge("pn_e2", "pn_s", "sequence", 1),
      edge("pn_e3", "pn_s", "sequence", 2),
    ];
    const world = (e1: PlanNodeStatus, e2: PlanNodeStatus, e3: PlanNodeStatus, p2s: PlanNodeStatus = "pending", p3s: PlanNodeStatus = "pending") => [e("pn_e1", e1, 1), { ...p2, status: p2s, endedAt: terminal(p2s) ? at : null, outputArtifactIds: p2s === "succeeded" ? [] : null } as PlanNode, e("pn_e2", e2, 2), { ...p3, status: p3s, endedAt: terminal(p3s) ? at : null, outputArtifactIds: p3s === "succeeded" ? [] : null } as PlanNode, e("pn_e3", e3, 3), s];
    // Round 1 failed: exactly retry(2) delivers; E1's sequence edge is inactive; S waits for the later rounds.
    const failed = by(world("succeeded", "pending", "pending"), edges, [], [verdict("pn_e1", "fail", 1, 3)]);
    expect(failed.pn_p2).toEqual({ kind: "become_ready", nodeId: "pn_p2", dependencyFailures: [] });
    expect(failed.pn_s).toEqual({ kind: "remain_pending", nodeId: "pn_s", awaiting: ["pn_e2", "pn_e3"] });
    expect(edgeActivation(input(graph([root, ...world("succeeded", "pending", "pending")], edges), [], [verdict("pn_e1", "fail", 1, 3)]), edges[4]!)).toEqual({ kind: "inactive" });
    expect(edgeActivation(input(graph([root, ...world("succeeded", "pending", "pending")], edges), [], [verdict("pn_e1", "fail", 1, 3)]), edges[0]!)).toEqual({ kind: "delivers" });
    // Inconclusive continues like a failure.
    expect(by(world("succeeded", "pending", "pending"), edges, [], [verdict("pn_e1", "inconclusive", 1, 3)]).pn_p2).toEqual({ kind: "become_ready", nodeId: "pn_p2", dependencyFailures: [] });
    // Round 1 passed: retry(2) is inactive, so P2 is skipped; its exit E2 is skipped, retry(3) is inactive, P3 and E3 are skipped, and S becomes ready from E1 alone.
    const passed = by(world("succeeded", "pending", "pending"), edges, [], [verdict("pn_e1", "pass", 1, 3)]);
    expect(passed.pn_p2).toEqual({ kind: "become_skipped", nodeId: "pn_p2", cause: "all_predecessors_skipped", failed: [] });
    expect(passed.pn_s).toEqual({ kind: "remain_pending", nodeId: "pn_s", awaiting: ["pn_e2", "pn_e3"] });
    const later = by(world("succeeded", "skipped", "pending", "skipped"), edges, [], [verdict("pn_e1", "pass", 1, 3)]);
    expect(later.pn_p3).toEqual({ kind: "become_skipped", nodeId: "pn_p3", cause: "all_predecessors_skipped", failed: [] });
    expect(by(world("succeeded", "skipped", "skipped", "skipped", "skipped"), edges, [], [verdict("pn_e1", "pass", 1, 3)]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    // Round 2 passed after round 1 failed: S proceeds from E2 once E3 is skipped; E1's own sequence edge stays inactive, E2's delivers.
    const g2 = graph([root, ...world("succeeded", "succeeded", "skipped", "succeeded", "skipped")], edges);
    const v2 = [verdict("pn_e1", "fail", 1, 3), verdict("pn_e2", "pass", 2, 3)];
    expect(evaluateReadiness(input(g2, [], v2)).decisions.find((d) => d.nodeId === "pn_s")).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    expect(edges.slice(4).map((x) => edgeActivation(input(g2, [], v2), x).kind)).toEqual(["inactive", "delivers", "inactive"]);
    // An inactive retry path is skipped, never failed: a failed evaluate-only node (its Evaluator failed) is an ordinary dependency failure.
    expect(by(world("failed", "pending", "pending"), edges).pn_p2).toEqual({ kind: "become_skipped", nodeId: "pn_p2", cause: "dependency_failed", failed: ["pn_e1"] });
    expect(by(world("failed", "pending", "pending"), edges).pn_s).toMatchObject({ kind: "remain_pending" });
    // A running evaluate-only node needs no fact yet.
    expect(by(world("running", "pending", "pending"), edges).pn_p2).toEqual({ kind: "remain_pending", nodeId: "pn_p2", awaiting: ["pn_e1"] });
  });

  it("fails explicitly on a missing, contradictory, or historical optimizer verdict fact instead of guessing an activation", () => {
    const e1 = node("pn_e1", "succeeded", { pattern: "evaluator_optimizer", round: 1, maxRounds: 3 });
    const p2 = node("pn_p2", "pending");
    const s = node("pn_s", "pending");
    const edges = [edge("pn_e1", "pn_p2", "retry", 0, "x", 2), edge("pn_e1", "pn_s", "sequence")];
    // Missing: a succeeded evaluate-only node without a verdict cannot activate either edge.
    expect(() => evaluateReadiness(input(graph([root, e1, p2, s], edges)))).toThrow(/without a recorded round verdict/);
    // Contradictory: the wrong round, the wrong maxRounds, a fact on a non-optimizer node, a fact keyed by another node, a passing inline node that did not pass.
    expect(() => evaluateReadiness(input(graph([root, e1, p2, s], edges), [], [verdict("pn_e1", "fail", 2, 3)]))).toThrow(/of round 1 recorded a verdict for round 2/);
    expect(() => evaluateReadiness(input(graph([root, e1, p2, s], edges), [], [verdict("pn_e1", "fail", 1, 2)]))).toThrow(/does not hold/);
    expect(() => evaluateReadiness(input(graph([root, e1, p2, s], edges), [], [verdict("pn_e1", "fail", 1, 3), verdict("pn_s", "pass")]))).toThrow(/not an evaluator_optimizer node/);
    expect(() => evaluateReadiness(input(graph([root, e1, p2, s], edges), [], [["pn_p2" as PlanNodeId, { planNodeId: "pn_e1" as PlanNodeId, round: 1, maxRounds: 3, evaluationId: newId("evaluation"), verdict: "fail" }]]))).toThrow(/keyed by/);
    const inline = node("pn_inline", "succeeded", { pattern: "evaluator_optimizer" });
    expect(() => evaluateReadiness(input(graph([root, inline, s], [edge("pn_inline", "pn_s")]), [], [verdict("pn_inline", "fail", 2, 2)]))).toThrow(/succeeded although its latest round verdict is fail/);
    // A verdict of a node outside the current membership is inert: nothing it names is activated.
    expect(by([node("pn_a", "succeeded"), s], [edge("pn_a", "pn_s")], [], [verdict("pn_gone", "fail", 1, 3)]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
    // An inline node that succeeded on a pass delivers along its sequence edges; the fact is consistent.
    expect(by([inline, s], [edge("pn_inline", "pn_s")], [], [verdict("pn_inline", "pass", 2, 2)]).pn_s).toEqual({ kind: "become_ready", nodeId: "pn_s", dependencyFailures: [] });
  });

  it("orders decisions by membership position then node id, and lists edges deterministically", () => {
    const c = node("pn_c", "pending");
    const a = node("pn_a", "pending");
    const b = node("pn_b", "pending");
    const g = graph([root, c, a, b], [edge("pn_c", "pn_b", "sequence", 1), edge("pn_a", "pn_b", "sequence", 0), edge("pn_root", "pn_a"), edge("pn_root", "pn_c")]);
    expect(schedulingOrder(g).map((n) => n.id)).toEqual(["pn_root", "pn_c", "pn_a", "pn_b"]);
    expect(evaluateReadiness(input(g)).decisions.map((d) => d.nodeId)).toEqual(["pn_root", "pn_c", "pn_a", "pn_b"]);
    expect(predecessorEdges(g, "pn_b" as PlanNodeId).map((e) => e.sourceNodeId)).toEqual(["pn_a", "pn_c"]);
    expect(successorEdges(g, "pn_root" as PlanNodeId).map((e) => e.targetNodeId)).toEqual(["pn_c", "pn_a"]);
    // Deterministic: the same graph, however its arrays are ordered, yields the same decisions.
    const shuffled: PlanGraph = { ...g, nodes: [b, a, c, root].sort(() => 0), edges: [...g.edges].reverse() };
    const position = new Map(g.nodes.map((n, i) => [n.id, i] as const));
    const reordered = { ...shuffled, nodes: [...shuffled.nodes].sort((x, y) => position.get(x.id)! - position.get(y.id)!) };
    expect(evaluateReadiness(input(reordered))).toEqual(evaluateReadiness(input(g)));
    expect(decideReadiness(input(g), "pn_b" as PlanNodeId)).toEqual({ kind: "remain_pending", nodeId: "pn_b", awaiting: ["pn_a", "pn_c"] });
    expect(() => decideReadiness(input(g), "pn_zzz" as PlanNodeId)).toThrow(/not a member/);
  });

  it("reads only the current revision: a historical edge never activates a current node, a removed node cannot activate a successor, and a historical selection cannot activate a current edge", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const a = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0", title: "A" }));
      const b = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", title: "B" }));
      // Revision 2: A → B. A starts running; B waits on it.
      extendPlan(h, s, [a, b], [{ type: "sequence", sourceNodeId: a.id, targetNodeId: b.id, position: 0 }]);
      h.stores.plans.transitionNode(a.id, { to: "ready" });
      h.stores.plans.transitionNode(a.id, { to: "running" });
      const second = projectReadinessInput(h.stores, h.stores.plans.currentGraph(s.run.id));
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
      expect(evaluateReadiness(projectReadinessInput(h.stores, third)).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_ready", nodeId: b.id, dependencyFailures: [] });
      // The historical graph still says what it said; it is inspectable, never executable.
      h.stores.plans.transitionNode(a.id, { to: "failed", reason: "invocation_failed" });
      expect(evaluateReadiness(projectReadinessInput(h.stores, h.stores.plans.graph(s.run.id, 2))).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_skipped", nodeId: b.id, cause: "dependency_failed", failed: [a.id] });
      expect(evaluateReadiness(projectReadinessInput(h.stores, h.stores.plans.currentGraph(s.run.id))).decisions.find((d) => d.nodeId === b.id)).toEqual({ kind: "become_ready", nodeId: b.id, dependencyFailures: [] });
      // Revision 4 adds C behind B with a fresh edge: C is decided by that edge alone, and A (removed, failed) plays no part.
      const c = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2", title: "C" }));
      h.ctx.tx.write(() => {
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [s.root.id, b.id, c.id], createdNodes: [c], edges: [{ type: "sequence", sourceNodeId: b.id, targetNodeId: c.id, position: 0 }], cancelledNodeIds: [] });
      });
      const fourth = h.stores.plans.currentGraph(s.run.id);
      expect(evaluateReadiness(projectReadinessInput(h.stores, fourth)).decisions.map((d) => [d.nodeId, d.kind])).toEqual([[s.root.id, "ready"], [b.id, "become_ready"], [c.id, "remain_pending"]]);
      // A route node R1 of revision 5 selects `y`; revision 6 replaces it with R2 (a new id, a different definition): R2's branch
      // edges are decided by R2's own (absent) selection — the historical fact of R1 is keyed by R1 and inert.
      const shape = (labels: string[]) => ({
        pattern: "route" as const,
        selector: { kind: "evaluator" as const, agentDefinitionRevisionId: s.definition.id },
        branches: labels.map((label) => ({ label, inline: null })),
      });
      const r1 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e3", title: "R1", shape: shape(["x", "y"]) }));
      const x1 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e3/branches/x", title: "X1" }));
      const y1 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e3/branches/y", title: "Y1" }));
      extendPlan(h, s, [r1, x1, y1], [
        { type: "branch", label: "x", sourceNodeId: r1.id, targetNodeId: x1.id, position: 0 },
        { type: "branch", label: "y", sourceNodeId: r1.id, targetNodeId: y1.id, position: 0 },
      ]);
      h.stores.plans.transitionNode(r1.id, { to: "ready" });
      h.stores.plans.transitionNode(r1.id, { to: "running" });
      h.stores.evaluations.record({ context: null, snapshotId: null, runId: s.run.id, planNodeId: r1.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "y" }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] });
      h.stores.plans.transitionNode(r1.id, { to: "succeeded", outputArtifactIds: [] });
      const fifth = projectReadinessInput(h.stores, h.stores.plans.currentGraph(s.run.id));
      expect(fifth.routeSelections.get(r1.id)).toMatchObject({ planNodeId: r1.id, selectedLabel: "y" });
      const fifthBy = Object.fromEntries(evaluateReadiness(fifth).decisions.map((d) => [d.nodeId, d.kind]));
      expect([fifthBy[x1.id], fifthBy[y1.id]]).toEqual(["become_skipped", "become_ready"]);
      // Revision 6: R1, X1, Y1 leave the membership (R1 ended, so it is not cancelled); R2 with branches x and z and fresh targets.
      const r2 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e4", title: "R2", shape: shape(["x", "z"]) }));
      const x2 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e4/branches/x", title: "X2" }));
      const z2 = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e4/branches/z", title: "Z2" }));
      h.ctx.tx.write(() => {
        h.stores.plans.transitionNode(x1.id, { to: "cancelled", reason: "plan_revision" });
        h.stores.plans.transitionNode(y1.id, { to: "cancelled", reason: "plan_revision" });
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({
          runId: s.run.id,
          revisionNumber: revision.number,
          membership: [s.root.id, b.id, c.id, r2.id, x2.id, z2.id],
          createdNodes: [r2, x2, z2],
          edges: [
            { type: "sequence", sourceNodeId: b.id, targetNodeId: c.id, position: 0 },
            { type: "branch", label: "x", sourceNodeId: r2.id, targetNodeId: x2.id, position: 0 },
            { type: "branch", label: "z", sourceNodeId: r2.id, targetNodeId: z2.id, position: 0 },
          ],
          cancelledNodeIds: [x1.id, y1.id],
        });
      });
      const sixth = projectReadinessInput(h.stores, h.stores.plans.currentGraph(s.run.id));
      // The historical fact is projected (facts are per node) but inert: R2 has no selection, so its branch targets wait on it.
      expect(sixth.routeSelections.has(r1.id)).toBe(true);
      expect(sixth.routeSelections.has(r2.id)).toBe(false);
      const sixthBy = Object.fromEntries(evaluateReadiness(sixth).decisions.map((d) => [d.nodeId, d]));
      expect(sixthBy[r2.id]).toEqual({ kind: "become_ready", nodeId: r2.id, dependencyFailures: [] });
      expect(sixthBy[x2.id]).toEqual({ kind: "remain_pending", nodeId: x2.id, awaiting: [r2.id] });
      expect(sixthBy[z2.id]).toEqual({ kind: "remain_pending", nodeId: z2.id, awaiting: [r2.id] });
      // The historical graph of revision 5 still reads its own selection: its branch(y) edge delivers, its branch(x) edge is inactive.
      const historical = projectReadinessInput(h.stores, h.stores.plans.graph(s.run.id, 5));
      expect(historical.routeSelections.get(r1.id)?.selectedLabel).toBe("y");
      expect(historical.graph.edges.filter((e) => e.type === "branch").map((e) => [e.type === "branch" ? e.label : "", edgeActivation(historical, e).kind])).toEqual([["x", "inactive"], ["y", "delivers"]]);
    } finally {
      h.close();
    }
  });
});
