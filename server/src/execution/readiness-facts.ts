/**
 * The projection of canonical condition facts for the pure readiness
 * evaluator (execution-model §4.3): the one place that reads rows to build
 * a `ReadinessInput`. Route selections come from the `route_selection`
 * Evaluations of the Run — one per route node, enforced by the database —
 * and from nothing else: no transcript, Artifact content, Handoff summary,
 * Invocation creation order, source path, or Event replay. Facts are keyed
 * by node id, so a node that a later revision replaced (a new id) carries
 * no historical selection, and a fact of a node outside the current
 * membership is inert.
 */
import type { PlanGraph, PlanNodeId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { ReadinessInput, RouteSelectionFact } from "./readiness.ts";

export function projectReadinessInput(stores: Stores, graph: PlanGraph): ReadinessInput {
  const routeSelections = new Map<PlanNodeId, RouteSelectionFact>();
  for (const [planNodeId, evaluation] of stores.evaluations.routeSelectionsOf(graph.runId)) {
    if (evaluation.subject.kind !== "route_selection") continue;
    routeSelections.set(planNodeId, { planNodeId, selectedLabel: evaluation.subject.selectedLabel, evaluationId: evaluation.id });
  }
  return { graph, routeSelections };
}

/** The current graph of a Run with its condition facts: what every readiness decision and Handoff activation is computed from. */
export function currentReadinessInput(stores: Stores, runId: PlanGraph["runId"]): ReadinessInput {
  return projectReadinessInput(stores, stores.plans.currentGraph(runId));
}
