/**
 * Evaluation shapes (execution-model §5.3, §5.6): the route-selection fact,
 * the optimizer round context paired with its subject and bound to a
 * judged Snapshot, and the typed Evaluator result and manifest inputs.
 */
import { describe, expect, it } from "vitest";
import { handoffKeyOf, handoffRouteSchema, HANDOFF_KEY_PATTERN, isIncomingHandoffKey } from "./handoffs.ts";
import { newId } from "./ids.ts";
import { evaluatorResultSchema, invocationResultSchema, manifestInputSchema } from "./invocations.ts";
import { evaluationInputSchema, evaluationSchema, OPTIMIZER_EVALUATION_CONTEXT_KINDS } from "./verification.ts";

const runId = newId("run");
const planNodeId = newId("planNode");
const snapshotId = newId("snapshot");
const criterion = newId("acceptanceCriterion");
const base = { runId, planNodeId, gateId: null, verdict: "pass" as const, evidence: [], producedBy: { kind: "runtime" as const }, artifactIds: [], snapshotId, context: null, subject: { kind: "rubric" as const, rubric: "quality" } };
const ok = (value: unknown) => evaluationInputSchema.safeParse(value).success;
const issue = (value: unknown) => evaluationInputSchema.safeParse(value).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") ?? "";

describe("Evaluation contexts", () => {
  it("pairs an optimizer context with its subject, node, Snapshot, and no Gate", () => {
    expect(OPTIMIZER_EVALUATION_CONTEXT_KINDS).toEqual(["optimizer_criterion", "optimizer_verdict"]);
    const verdict = { ...base, subject: { kind: "optimizer_round" as const }, context: { kind: "optimizer_verdict" as const, round: 2, maxRounds: 3 } };
    expect(ok(verdict)).toBe(true);
    const criterionEvaluation = { ...base, subject: { kind: "acceptance_criterion" as const, acceptanceCriterionId: criterion }, context: { kind: "optimizer_criterion" as const, round: 1, maxRounds: 3 } };
    expect(ok(criterionEvaluation)).toBe(true);
    // The pairing is closed in both directions.
    expect(issue({ ...verdict, subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion } })).toMatch(/optimizer_round/);
    expect(issue({ ...criterionEvaluation, subject: { kind: "optimizer_round" } })).toMatch(/one Acceptance Criterion/);
    expect(issue({ ...base, subject: { kind: "optimizer_round" } })).toMatch(/optimizer_verdict context/);
    // Round identity is explicit and bounded; a Snapshot and a Plan Node are required; a Gate is refused.
    expect(issue({ ...verdict, context: { kind: "optimizer_verdict", round: 4, maxRounds: 3 } })).toMatch(/within maxRounds/);
    expect(issue({ ...verdict, context: { kind: "optimizer_verdict", round: 0, maxRounds: 3 } })).toMatch(/round/);
    expect(issue({ ...verdict, snapshotId: null })).toMatch(/judged Snapshot/);
    expect(issue({ ...verdict, planNodeId: null })).toMatch(/evaluator_optimizer Plan Node/);
    expect(issue({ ...verdict, gateId: newId("gate") })).toMatch(/no Gate/);
    expect(ok({ ...verdict, context: { kind: "optimizer_verdict", round: 1, maxRounds: 3, rubric: "x" } })).toBe(false);
    // A route selection never carries a context; every other Evaluation may name a Snapshot or not.
    expect(issue({ ...base, subject: { kind: "route_selection", selectedLabel: "x" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 1 } })).toMatch(/no optimizer context/);
    expect(ok({ ...base, subject: { kind: "route_selection", selectedLabel: "x" }, snapshotId: null, artifactIds: [] })).toBe(true);
    expect(ok({ ...base, snapshotId: null })).toBe(true);
    expect(evaluationSchema.safeParse({ id: newId("evaluation"), createdAt: "2026-01-01T00:00:00.000Z", ...verdict }).success).toBe(true);
  });
});

describe("Evaluator results and optimizer manifest inputs", () => {
  const result = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "ok", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null };
  const evaluation = { verdict: "pass", criteria: [{ acceptanceCriterionId: criterion, verdict: "pass", evidence: [] }], evidence: [{ kind: "artifact", artifactId: newId("artifact") }] };

  it("types the Evaluator payload, returns it only from a completed result, and keeps it exclusive with a route selection", () => {
    expect(evaluatorResultSchema.safeParse(evaluation).success).toBe(true);
    expect(evaluatorResultSchema.safeParse({ ...evaluation, verdict: "maybe" }).success).toBe(false);
    expect(evaluatorResultSchema.safeParse({ ...evaluation, criteria: [{ acceptanceCriterionId: "ac_x", verdict: "pass", evidence: [] }] }).success).toBe(false);
    expect(invocationResultSchema.safeParse({ ...result, evaluation }).success).toBe(true);
    expect(invocationResultSchema.safeParse({ ...result, status: "failed", evaluation }).success).toBe(false);
    expect(invocationResultSchema.safeParse({ ...result, evaluation, routeSelection: { selectedLabel: "x" } }).success).toBe(false);
    expect(invocationResultSchema.safeParse({ ...result, evaluation: { verdict: "pass" } }).success).toBe(false);
  });

  it("types the candidate and feedback inputs with explicit round identity", () => {
    const candidate = { kind: "optimizer_candidate", round: 2, maxRounds: 3, snapshotId, artifactIds: [newId("artifact")], acceptanceCriterionIds: [criterion] };
    expect(manifestInputSchema.safeParse(candidate).success).toBe(true);
    expect(manifestInputSchema.safeParse({ ...candidate, round: 4 }).success).toBe(false);
    expect(manifestInputSchema.safeParse({ ...candidate, acceptanceCriterionIds: ["ac_ffffffffffffffffffffffff", "ac_000000000000000000000000"] }).success).toBe(false);
    const feedback = { kind: "optimizer_feedback", evaluationId: newId("evaluation"), round: 1, verdict: "fail", evidence: [{ kind: "snapshot", snapshotId }] };
    expect(manifestInputSchema.safeParse(feedback).success).toBe(true);
    expect(manifestInputSchema.safeParse({ ...feedback, verdict: "pass" }).success).toBe(false);
    expect(manifestInputSchema.safeParse({ ...feedback, summary: "it failed" }).success).toBe(false);
  });

  it("keys the optimizer Handoff routes canonically and treats a retry Handoff as an incoming edge transfer", () => {
    const source = newId("planNode");
    const target = newId("planNode");
    const routes = [
      { kind: "retry" as const, sourceNodeId: source, targetNodeId: target, round: 2 },
      { kind: "optimizer_candidate" as const, planNodeId: source, round: 1 },
      { kind: "optimizer_feedback" as const, planNodeId: source, round: 1 },
    ];
    expect(routes.map(handoffKeyOf)).toEqual([`retry:${source}:${target}`, `optimizer_candidate:${source}:1`, `optimizer_feedback:${source}:1`]);
    for (const route of routes) {
      expect(handoffRouteSchema.safeParse(route).success).toBe(true);
      expect(HANDOFF_KEY_PATTERN.test(handoffKeyOf(route))).toBe(true);
    }
    expect(handoffRouteSchema.safeParse({ kind: "retry", sourceNodeId: source, targetNodeId: target, round: 1 }).success).toBe(false);
    expect(handoffRouteSchema.safeParse({ kind: "retry", sourceNodeId: source, targetNodeId: source, round: 2 }).success).toBe(false);
    expect(isIncomingHandoffKey(`retry:${source}:${target}`)).toBe(true);
    expect(isIncomingHandoffKey(`optimizer_candidate:${source}:1`)).toBe(false);
    expect(isIncomingHandoffKey(`optimizer_feedback:${source}:1`)).toBe(false);
  });
});
