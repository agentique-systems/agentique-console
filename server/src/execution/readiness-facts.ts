/**
 * The projection of canonical condition facts for the pure readiness
 * evaluator (execution-model §4.3): the one place that reads rows to build
 * a `ReadinessInput`. Route selections come from the `route_selection`
 * Evaluations of the Run — one per route node, enforced by the database —
 * and optimizer round verdicts from the `optimizer_verdict` Evaluations of
 * the Run — one per node and round, enforced by the database, of which the
 * latest round is the node's fact — and from nothing else: no transcript,
 * Artifact content, Handoff summary, Invocation creation order, source
 * path, or Event replay. Facts are keyed by node id, so a node that a later
 * revision replaced (a new id) carries no historical fact, and a fact of a
 * node outside the current membership is inert.
 */
import type { PlanGraph, PlanNodeId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { OptimizerVerdictFact, ReadinessInput, RouteSelectionFact } from "./readiness.ts";

export function projectReadinessInput(stores: Stores, graph: PlanGraph): ReadinessInput {
  const routeSelections = new Map<PlanNodeId, RouteSelectionFact>();
  for (const [planNodeId, evaluation] of stores.evaluations.routeSelectionsOf(graph.runId)) {
    if (evaluation.subject.kind !== "route_selection") continue;
    routeSelections.set(planNodeId, { planNodeId, selectedLabel: evaluation.subject.selectedLabel, evaluationId: evaluation.id });
  }
  const optimizerVerdicts = new Map<PlanNodeId, OptimizerVerdictFact>();
  for (const [planNodeId, verdicts] of stores.evaluations.optimizerVerdictsOf(graph.runId)) {
    // Rows are ordered by round; the latest judged round is the node's condition fact, with its round explicit.
    const latest = verdicts.at(-1);
    if (latest === undefined || latest.context === null || latest.context.kind !== "optimizer_verdict") continue;
    optimizerVerdicts.set(planNodeId, { planNodeId, round: latest.context.round, maxRounds: latest.context.maxRounds, evaluationId: latest.id, verdict: latest.verdict });
  }
  return { graph, routeSelections, optimizerVerdicts };
}

/** The current graph of a Run with its condition facts: what every readiness decision and Handoff activation is computed from. */
export function currentReadinessInput(stores: Stores, runId: PlanGraph["runId"]): ReadinessInput {
  return projectReadinessInput(stores, stores.plans.currentGraph(runId));
}
