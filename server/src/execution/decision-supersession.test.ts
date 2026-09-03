/**
 * Operator supersession of a policy-resolved `operator_choice`
 * (execution-model §8.2): the original Decision stays in history as
 * `superseded`, the operator's choice is a new `operator_choice` recorded as
 * its explicit superseder and resolved by the operator, and the follow-up
 * goes through canonical turns only — the requester's pending continuation
 * carries both resolutions, or the Orchestrator's next turn receives the
 * superseding resolution as a queued input. Nothing is undone, rerun,
 * duplicated, or reallocated; a repeat replays; an operator-resolved
 * Decision, the same option, or another kind is refused.
 */
import type { ManifestInput } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { choice, drain, requesting } from "./decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** A Run whose first root turn requested a use_default_after_deadline choice that is due at once (the root is running). */
async function policyRequested(h: RuntimeHarness) {
  const s = seedRuntime(h);
  const { invocation } = startRun(h, s).prepared;
  h.provider.script(requesting([choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: s.created.root.id } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [s.created.root.id] } })]));
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "decision_requested") throw new Error(outcome.kind);
  return { s, invocation, decision: outcome.decision, runId: s.created.run.id };
}

const resolutions = (h: RuntimeHarness, invocationId: string) =>
  h.stores.invocations
    .getManifest(invocationId as never)
    .content.inputs.filter((i): i is Extract<ManifestInput, { kind: "decision_resolution" }> => i.kind === "decision_resolution")
    .map((i) => [i.decisionId, i.status, i.resolvedBy, i.selected?.optionId ?? null]);

describe("operator supersession of a policy resolution", () => {
  it("before the requester continued: the one continuation carries the superseded original and the operator's superseding resolution; no second successor, no reset allocation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { s, invocation, decision, runId } = await policyRequested(h);
      // The policy resolves (the scheduler's action, taken directly here); the continuation is not yet prepared.
      expect(h.decisionRequests.resolveDefault(decision.id, h.clock.now())).toMatchObject({ kind: "resolved", chosenOptionId: "fastify" });
      expect(h.stores.decisions.get(decision.id)).toMatchObject({ status: "resolved", resolution: { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "fastify" } });
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.continuedFromInvocationId === invocation.id)).toEqual([]);
      expect(() => h.decisionRequests.supersede({ decisionId: decision.id, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "option_unchanged" }));
      expect(() => h.decisionRequests.supersede({ decisionId: decision.id, optionId: "django" })).toThrow(expect.objectContaining({ refusal: "option_invalid" }));
      expect(() => h.decisionRequests.supersede({ decisionId: decision.id, optionId: "express" }, { actor: { kind: "runtime" } })).toThrow(expect.objectContaining({ refusal: "operator_required" }));
      const capacity = h.stores.reservations.runCapacity(runId);
      const seq = h.ctx.journal.lastSeq();
      const superseded = h.decisionRequests.supersede({ decisionId: decision.id, optionId: "express", rationale: "Express is already a dependency." });
      expect(superseded).toMatchObject({ kind: "superseded", decisionId: decision.id, chosenOptionId: "express", replayed: false, followUp: "continuation" });
      const original = h.stores.decisions.get(decision.id);
      const superseding = h.stores.decisions.get(superseded.supersedingDecisionId);
      expect(original).toMatchObject({ status: "superseded", supersededByDecisionId: superseding.id, supersessionReason: "superseding_decision", resolution: { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "fastify" } });
      expect(superseding).toMatchObject({ kind: "operator_choice", status: "resolved", requestedBy: { kind: "operator" }, supersedesDecisionId: decision.id, question: decision.question, affects: decision.affects, resolution: { resolvedBy: "operator", chosenOptionId: "express", rationale: "Express is already a dependency." } });
      expect(superseding.options).toEqual(decision.options);
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type)).toEqual(["decision.requested", "decision.superseded", "decision.resolved"]);
      expect(h.stores.reservations.runCapacity(runId)).toEqual(capacity);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
      // A repeat with the same option replays; a different option conflicts.
      expect(h.decisionRequests.supersede({ decisionId: decision.id, optionId: "express" })).toMatchObject({ kind: "superseded", supersedingDecisionId: superseding.id, replayed: true, followUp: "none" });
      expect(() => h.decisionRequests.supersede({ decisionId: decision.id, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      // The one continuation carries both resolutions: the original as history, the operator's choice as the answer.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await drain(h, runId, 4);
      const successors = h.stores.invocations.listByRun(runId).filter((i) => i.continuedFromInvocationId === invocation.id);
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ purpose: invocation.purpose, status: "succeeded" });
      expect(resolutions(h, successors[0]!.id)).toEqual([
        [decision.id, "superseded", null, null],
        [superseding.id, "resolved", "operator", "express"],
      ]);
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.role === "orchestrator")).toHaveLength(2);
      expect(h.stores.decisions.listByRun(runId).filter((d) => d.kind === "operator_choice")).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("after work proceeded on the policy choice: nothing is undone or rerun, and the superseding resolution reaches the Orchestrator as a queued input of its next turn; an operator-resolved Decision is never superseded", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { s, invocation, decision, runId } = await policyRequested(h);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await drain(h, runId, 6);
      const successor = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === invocation.id)!;
      expect(successor.status).toBe("succeeded");
      expect(resolutions(h, successor.id)).toEqual([[decision.id, "resolved", "policy:use_default_after_deadline", "fastify"]]);
      const requests = h.provider.requests.length;
      const invocations = h.stores.invocations.listByRun(runId).length;
      const superseded = h.decisionRequests.supersede({ decisionId: decision.id, optionId: "express" });
      expect(superseded).toMatchObject({ kind: "superseded", followUp: "queued_input", replayed: false });
      // The completed successor is untouched; no second successor exists; the queued input names the superseding resolution.
      expect(h.stores.invocations.get(successor.id).status).toBe("succeeded");
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.continuedFromInvocationId === invocation.id)).toHaveLength(1);
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(invocations);
      expect(h.provider.requests).toHaveLength(requests);
      expect(h.orchestratorInputs.pending(runId).map((q) => q.input)).toMatchObject([{ kind: "decision_resolution", decisionId: superseded.supersedingDecisionId, status: "resolved", resolvedBy: "operator", selected: { optionId: "express" } }]);
      // The next pass prepares one decision_resolution turn delivering it — a canonical Orchestrator turn, no injection.
      await drain(h, runId, 3);
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn).toMatchObject({ purpose: "decision_resolution", continuedFromInvocationId: successor.id });
      expect(resolutions(h, turn.id)).toEqual([[superseded.supersedingDecisionId, "resolved", "operator", "express"]]);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
      expect(h.stores.decisions.get(decision.id)).toMatchObject({ status: "superseded", supersededByDecisionId: superseded.supersedingDecisionId });
      // The superseding Decision is the operator's own resolution: it cannot be superseded in turn, and neither can any operator-resolved request.
      expect(() => h.decisionRequests.supersede({ decisionId: superseded.supersedingDecisionId, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "decision_not_requested" }));
      const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const other = await policyRequested(g);
        g.decisionRequests.resolve({ decisionId: other.decision.id, optionId: "express" });
        expect(() => g.decisionRequests.supersede({ decisionId: other.decision.id, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "not_policy_resolved" }));
        expect(g.stores.decisions.get(other.decision.id).status).toBe("resolved");
      } finally {
        g.close();
      }
    } finally {
      h.close();
    }
  });
});
