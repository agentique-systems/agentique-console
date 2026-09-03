/**
 * Resolving agent-requested Decisions (execution-model §8.1, §8.2;
 * invariants 13, 19): the operator resolves an `operator_choice` or a
 * `requirement_waiver` through the service boundary (identical replays,
 * conflicting refusals, no provider, no continuation inside the
 * transaction); a `waive` sets the pinned Requirement `waived` in the same
 * transaction; a stale waiver is superseded, never applied to a newer
 * revision; a `use_default_after_deadline` Decision is resolved by the
 * scheduler's `resolve_decision_default` action from persisted rows and the
 * caller's clock once due — a deadline or an activation condition — with
 * the deadline projected as `wakeAt` and an operator/default race producing
 * exactly one resolution.
 */
import { DecisionRequestRefusedError, type DecisionId, type DecisionRequestRefusalCode, type RuntimeToolCallRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { seedArtifact } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { choice, decisionOf, requesting, rootPort, waiver } from "./decision-test-support.ts";
import { asSeeded, COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const refusal = (code: DecisionRequestRefusalCode) => expect.objectContaining({ refusal: code });

/** A Run whose first root turn ended blocked on the given request; the Run waits on the Decision. */
async function blockedRoot(h: RuntimeHarness, calls: RuntimeToolCallRequest[] | ((s: ReturnType<typeof seedRuntime>) => RuntimeToolCallRequest[])) {
  const s = seedRuntime(h);
  const { invocation } = startRun(h, s).prepared;
  h.provider.script(requesting(typeof calls === "function" ? calls(s) : calls));
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "decision_requested") throw new Error(`expected decision_requested, got ${outcome.kind}`);
  await h.scheduler.advanceRun(s.created.run.id);
  return { s, invocation, decision: outcome.decision };
}

/** A Run with a root turn blocked on a requirement_waiver of a fresh leaf; returns the leaf, its revision, and the Decision. */
async function blockedWaiver(h: RuntimeHarness, options: { evidence?: boolean } = {}) {
  const s = seedPlanningRuntime(h);
  const conversationId = s.created.run.conversationId;
  const rootId = h.ctx.ids("requirement");
  const leaves = [h.ctx.ids("requirement"), h.ctx.ids("requirement")];
  const revision = h.stores.requirements.createRevision({
    conversationId,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] },
      ...leaves.map((id, index) => ({ id, parentId: rootId, composition: null, statement: `Leaf ${index + 1}`, position: index, acceptanceCriterionIds: [] })),
    ],
  });
  const r = await rootPort(h, s);
  const evidence = options.evidence ? seedArtifact(h, asSeeded(s), "evidence", { invocationId: r.invocation.id }) : null;
  const accepted = await r.port.call(waiver(leaves[0]!, evidence ? { evidenceArtifactIds: [evidence.id] } : {}));
  const decisionId = decisionOf(accepted);
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  const outcome = await h.executor.executePreparedAttempt(r.attempt.id);
  if (outcome.kind !== "decision_requested") throw new Error(`expected decision_requested, got ${outcome.kind}`);
  await h.scheduler.advanceRun(s.created.run.id);
  return { s, invocation: r.invocation, decisionId, leaves, rootId, revision, evidence };
}

describe("operator resolution of requested decisions", () => {
  it("resolves an operator_choice once: the chosen option, the operator resolver, one decision.resolved Event, no provider call and no successor inside the transaction; identical replays return the same outcome, conflicts are refused", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { s, invocation, decision } = await blockedRoot(h, [choice()]);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "nope" })).toThrow(refusal("option_invalid"));
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express" }, { actor: { kind: "runtime" } })).toThrow(refusal("operator_required"));
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express" }, { actor: { kind: "invocation", invocationId: invocation.id } })).toThrow(refusal("operator_required"));
      expect(() => h.decisionRequests.resolve({ decisionId: "dec_000000000000000000000000" as DecisionId, optionId: "express" })).toThrow(refusal("decision_not_requested"));
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express", artifactIds: ["art_000000000000000000000000" as never] })).toThrow(refusal("evidence_invalid"));
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      const resolved = h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express", rationale: "team preference" });
      expect(resolved).toEqual({ kind: "resolved", decisionId: decision.id, chosenOptionId: "express", resolvedBy: "operator", replayed: false });
      expect(h.stores.decisions.get(decision.id)).toMatchObject({ status: "resolved", resolution: { resolvedBy: "operator", chosenOptionId: "express", rationale: "team preference", artifactIds: [] } });
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.map((e) => [e.type, e.actor])).toEqual([["decision.resolved", { kind: "operator" }]]);
      expect(h.provider.requests).toHaveLength(1);
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
      // Replays and conflicts.
      expect(h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express" })).toEqual({ kind: "resolved", decisionId: decision.id, chosenOptionId: "express", resolvedBy: "operator", replayed: true });
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "fastify" })).toThrow(refusal("conflicting_resolution"));
      expect(h.ctx.journal.lastSeq()).toBe(seq + 1);
      // A Decision not requested by an agent (the operator's own, an approval, an increase) is never resolved here.
      const operatorOwn = h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "q", options: [{ id: "a", label: "A", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      expect(() => h.decisionRequests.resolve({ decisionId: operatorOwn.id, optionId: "a" })).toThrow(refusal("decision_not_requested"));
      expect(() => h.decisionRequests.resolve({ decisionId: operatorOwn.id, optionId: "a" })).toThrow(DecisionRequestRefusedError);
    } finally {
      h.close();
    }
  });

  it("waives the pinned Requirement on `waive` in the same transaction as the resolution, with the operator actor, rationale, Evidence, and the Decision reference; `deny` resolves without touching the Requirement", async () => {
    for (const option of ["waive", "deny"] as const) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const { s, decisionId, leaves, revision, evidence } = await blockedWaiver(h, { evidence: true });
        const runId = s.created.run.id;
        const seq = h.ctx.journal.lastSeq();
        expect(() => h.decisionRequests.resolve({ decisionId, optionId: option })).toThrow(refusal("rationale_required"));
        expect(h.stores.requirements.get(leaves[0]!).status).toBe("open");
        const resolved = h.decisionRequests.resolve({ decisionId, optionId: option, rationale: option === "waive" ? "acceptable risk" : "must be met", artifactIds: [evidence!.id] });
        expect(resolved).toEqual({ kind: "resolved", decisionId, chosenOptionId: option, resolvedBy: "operator", replayed: false });
        const decision = h.stores.decisions.get(decisionId);
        expect(decision).toMatchObject({ status: "resolved", resolution: { resolvedBy: "operator", chosenOptionId: option, artifactIds: [evidence!.id] }, subject: { requirementId: leaves[0], requirementRevisionId: revision.id } });
        const events = h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
        if (option === "waive") {
          expect(events).toEqual(["decision.resolved", "requirement.status_changed"]);
          expect(h.stores.requirements.get(leaves[0]!).status).toBe("waived");
          const change = h.stores.requirements.history(leaves[0]!).at(-1)!;
          expect(change).toMatchObject({ to: "waived", actor: "operator", decisionId, runId, rationale: "acceptable risk", evidence: [{ kind: "artifact", artifactId: evidence!.id }] });
        } else {
          expect(events).toEqual(["decision.resolved"]);
          expect(h.stores.requirements.get(leaves[0]!).status).toBe("open");
          expect(h.stores.requirements.history(leaves[0]!)).toEqual([]);
        }
        expect(h.stores.requirements.get(leaves[1]!).status).toBe("open");
        expect(h.decisionRequests.resolve({ decisionId, optionId: option, rationale: "again" })).toMatchObject({ kind: "resolved", replayed: true });
        expect(() => h.decisionRequests.resolve({ decisionId, optionId: option === "waive" ? "deny" : "waive", rationale: "x" })).toThrow(refusal("conflicting_resolution"));
        expect(h.ctx.journal.read({ runId, afterSeq: seq })).toHaveLength(option === "waive" ? 2 : 1);
        expect(h.provider.requests).toHaveLength(1);
      } finally {
        h.close();
      }
    }
  });

  it("supersedes a waiver whose pinned Requirement went stale — a newer revision, a retired Requirement, or a Requirement no longer waivable — and applies no waiver to the newer state", async () => {
    const stalers: [string, (h: RuntimeHarness, w: Awaited<ReturnType<typeof blockedWaiver>>) => void][] = [
      ["a newer Requirement revision", (h, w) => {
        h.stores.requirements.createRevision({ conversationId: w.s.created.run.conversationId, approvedByDecisionId: null, tree: [{ id: w.rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }, { id: w.leaves[0]!, parentId: w.rootId, composition: null, statement: "Leaf 1 (revised)", position: 0, acceptanceCriterionIds: [] }, { id: w.leaves[1]!, parentId: w.rootId, composition: null, statement: "Leaf 2", position: 1, acceptanceCriterionIds: [] }] });
      }],
      ["a retired Requirement", (h, w) => {
        h.stores.requirements.createRevision({ conversationId: w.s.created.run.conversationId, approvedByDecisionId: null, tree: [{ id: w.rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }, { id: w.leaves[1]!, parentId: w.rootId, composition: null, statement: "Leaf 2", position: 0, acceptanceCriterionIds: [] }] });
      }],
      ["a Requirement waived meanwhile", (h, w) => {
        // Another operator-resolved waiver of the same Requirement (seeded directly) already applied.
        const other = h.stores.decisions.request({ conversationId: w.s.created.run.conversationId, runId: w.s.created.run.id, kind: "requirement_waiver", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "waive?", options: [{ id: "waive", label: "W", description: null }, { id: "deny", label: "D", description: null }], recommendedOptionId: null, rationale: "r", affects: { requirementIds: [w.leaves[0]!], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: { kind: "requirement_waiver", runId: w.s.created.run.id, requirementId: w.leaves[0]!, requirementRevisionId: w.revision.id, evidenceArtifactIds: [] }, supersedesDecisionId: null });
        h.stores.decisions.resolve(other.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "direct", artifactIds: [] });
        h.stores.requirements.recordStatusChange({ requirementId: w.leaves[0]!, runId: w.s.created.run.id, to: "waived", actor: "operator", evidence: [], gateId: null, decisionId: other.id, rationale: "direct" });
      }],
    ];
    for (const [label, stale] of stalers) {
      for (const option of ["waive", "deny"] as const) {
        const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
        try {
          const w = await blockedWaiver(h);
          const runId = w.s.created.run.id;
          stale(h, w);
          const statusBefore = h.stores.requirements.get(w.leaves[0]!).status;
          const historyBefore = h.stores.requirements.history(w.leaves[0]!).length;
          const seq = h.ctx.journal.lastSeq();
          const outcome = h.decisionRequests.resolve({ decisionId: w.decisionId, optionId: option, rationale: "late" });
          expect(outcome, `${label} / ${option}`).toEqual({ kind: "superseded", decisionId: w.decisionId, reason: "requirement_waiver_stale", replayed: false });
          expect(h.stores.decisions.get(w.decisionId), label).toMatchObject({ status: "superseded", supersessionReason: "requirement_waiver_stale", supersededByDecisionId: null, resolution: null });
          expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type), label).toEqual(["decision.superseded"]);
          // Nothing was applied to the Requirement, whatever its newer state is.
          expect(h.stores.requirements.get(w.leaves[0]!).status, label).toBe(statusBefore);
          expect(h.stores.requirements.history(w.leaves[0]!), label).toHaveLength(historyBefore);
          // The superseded outcome replays; an operator cannot resolve it afterwards.
          expect(h.decisionRequests.resolve({ decisionId: w.decisionId, optionId: option, rationale: "late" }), label).toEqual({ kind: "superseded", decisionId: w.decisionId, reason: "requirement_waiver_stale", replayed: true });
          expect(h.ctx.journal.lastSeq(), label).toBe(seq + 1);
          expect(h.provider.requests, label).toHaveLength(1);
        } finally {
          h.close();
        }
      }
    }
  });
});

describe("default resolution of requested decisions", () => {
  it("resolves a use_default_after_deadline Decision by the scheduler once its deadline has passed, projecting the deadline as wakeAt before then, and never resolves an operator_required one", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const deadlineAt = new Date(Date.parse(h.clock.now()) + 60_000).toISOString();
      const { s, decision } = await blockedRoot(h, (seed) => [choice({ resolutionPolicy: { kind: "use_default_after_deadline", deadlineAt }, affects: { requirementIds: [], taskIds: [], planNodeIds: [seed.created.root.id] } })]);
      const runId = s.created.run.id;
      expect(decision).toMatchObject({ resolutionPolicy: "use_default_after_deadline", deadlineAt, recommendedOptionId: "fastify", status: "open" });
      // Before the deadline: the Run waits on the Decision, no action is projected, and the deadline is the wake time.
      let projection = h.scheduler.reconcileRun(runId);
      expect(projection.actions).toEqual([]);
      expect(projection.wakeAt).toBe(deadlineAt);
      expect(projection.stop).toBe("waiting");
      expect(h.decisionRequests.due(runId, h.clock.now())).toEqual([]);
      expect(h.decisionRequests.resolveDefault(decision.id, h.clock.now())).toEqual({ kind: "no_change", reason: "not_due" });
      expect(h.stores.decisions.get(decision.id).status).toBe("open");
      // At the deadline: the action is projected, performed once, and resolves to the persisted recommendation by policy.
      h.clock.set(deadlineAt);
      projection = h.scheduler.reconcileRun(runId);
      expect(projection.actions[0]).toEqual({ kind: "resume_run", reason: "decision" });
      expect(projection.actions.some((a) => a.kind === "resolve_decision_default" && a.decisionId === decision.id)).toBe(true);
      expect(projection.wakeAt).toBeNull();
      const seq = h.ctx.journal.lastSeq();
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["resume_run", "transitioned"], ["resolve_decision_default", "transitioned"]]);
      const resolved = h.stores.decisions.get(decision.id);
      expect(resolved).toMatchObject({ status: "resolved", resolution: { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "fastify", rationale: null } });
      expect(h.ctx.journal.read({ runId, afterSeq: seq, type: "decision.resolved" }).map((e) => e.actor)).toEqual([{ kind: "policy", policy: "use_default_after_deadline" }]);
      // Once more changes nothing: the action is no longer projected and a repeated call is a no-op.
      expect(h.scheduler.reconcileRun(runId).actions.some((a) => a.kind === "resolve_decision_default")).toBe(false);
      expect(h.decisionRequests.resolveDefault(decision.id, h.clock.now())).toEqual({ kind: "no_change", reason: "not_open" });
      expect(h.ctx.journal.read({ runId, type: "decision.resolved" })).toHaveLength(1);
      // An operator_required Decision is never resolved by policy, whatever the clock says.
      const h2 = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const other = await blockedRoot(h2, [choice()]);
        h2.clock.advance(365 * 24 * 3_600_000);
        expect(h2.decisionRequests.due(other.s.created.run.id, h2.clock.now())).toEqual([]);
        expect(h2.decisionRequests.resolveDefault(other.decision.id, h2.clock.now())).toEqual({ kind: "no_change", reason: "not_default_policy" });
        expect(h2.scheduler.reconcileRun(other.s.created.run.id).actions).toEqual([]);
        expect(h2.stores.decisions.get(other.decision.id).status).toBe("open");
      } finally {
        h2.close();
      }
    } finally {
      h.close();
    }
  });

  it("resolves on an activation condition that already holds on the next pass, and an operator/default race yields exactly one resolution either way", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // The root node is running: `plan_node_ready` of the root holds at once, so the Decision is due on the very next pass.
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      h.provider.script(requesting([choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: s.created.root.id } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [s.created.root.id] } })]));
      const outcome = await h.executor.advanceInvocation(invocation.id);
      if (outcome.kind !== "decision_requested") throw new Error(outcome.kind);
      const runId = s.created.run.id;
      expect(h.decisionRequests.activationConditionHolds({ kind: "plan_node_ready", planNodeId: s.created.root.id })).toBe(true);
      expect(h.decisionRequests.activationConditionHolds({ kind: "plan_node_ready", planNodeId: "pn_000000000000000000000000" as never })).toBe(false);
      expect(h.decisionRequests.due(runId, h.clock.now()).map((d) => d.id)).toEqual([outcome.decision.id]);
      expect(h.scheduler.reconcileRun(runId).actions[0]).toEqual({ kind: "resolve_decision_default", decisionId: outcome.decision.id });
      // The operator answers first: the scheduler's action then finds the Decision resolved and changes nothing.
      h.decisionRequests.resolve({ decisionId: outcome.decision.id, optionId: "express" });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(pass.actions.map((a) => a.outcome.kind)).not.toContain("transitioned");
      expect(h.stores.decisions.get(outcome.decision.id).resolution).toMatchObject({ resolvedBy: "operator", chosenOptionId: "express" });
      expect(h.ctx.journal.read({ runId, type: "decision.resolved" })).toHaveLength(1);
      // The reverse race: the default resolves first, and the operator's later different answer is a conflict, an identical one a replay.
      const h2 = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const t = seedRuntime(h2);
        const started = startRun(h2, t).prepared;
        h2.provider.script(requesting([choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: t.created.root.id } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [t.created.root.id] } })]));
        const second = await h2.executor.advanceInvocation(started.invocation.id);
        if (second.kind !== "decision_requested") throw new Error(second.kind);
        expect(h2.decisionRequests.resolveDefault(second.decision.id, h2.clock.now())).toEqual({ kind: "resolved", decisionId: second.decision.id, chosenOptionId: "fastify" });
        expect(() => h2.decisionRequests.resolve({ decisionId: second.decision.id, optionId: "express" })).toThrow(refusal("conflicting_resolution"));
        expect(h2.decisionRequests.resolve({ decisionId: second.decision.id, optionId: "fastify" })).toEqual({ kind: "resolved", decisionId: second.decision.id, chosenOptionId: "fastify", resolvedBy: "policy:use_default_after_deadline", replayed: true });
        expect(h2.ctx.journal.read({ runId: t.created.run.id, type: "decision.resolved" })).toHaveLength(1);
      } finally {
        h2.close();
      }
    } finally {
      h.close();
    }
  });
});
