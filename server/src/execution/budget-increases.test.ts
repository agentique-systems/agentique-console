/**
 * Run Budget Increases (execution-model §7.6, §8.2; invariants 19 and 22):
 * the operator-only `budget_increase` Decision, its exact typed subject, the
 * one Budget Increase an approval records, replay and conflict rules, the
 * partition and status restrictions, and the separation from every model
 * path — no runtime tool, no Orchestrator Invocation, no Usage, no Run
 * transition.
 */
import { BudgetIncreaseRefusedError, effectiveRuntimeTools, RUNTIME_TOOLS_BY_ROLE, RUNTIME_TOOL_CALL_TOOLS, ValidationError, type BudgetIncreaseRefusalCode, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { awaitSignoff } from "./signoff-test-support.ts";
import { openRuntimeHarness, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const refusal = (work: () => unknown): BudgetIncreaseRefusalCode => {
  try {
    work();
  } catch (error) {
    if (error instanceof BudgetIncreaseRefusedError) return error.refusal;
    throw error;
  }
  throw new Error("expected a Budget Increase refusal");
};

/** Every row and Event that a Budget Increase operation may touch, for "nothing was written" assertions. */
function budgetWork(h: RuntimeHarness, runId: RunId) {
  return {
    decisions: h.stores.decisions.budgetIncreaseDecisionsOf(runId).map((d) => [d.id, d.status, d.resolution?.chosenOptionId ?? null]),
    increases: h.stores.budgetIncreases.listByRun(runId).map((i) => i.id),
    invocations: h.stores.invocations.listByRun(runId).map((i) => i.id),
    run: (({ status, waitReason, budget, finalReserve, updatedAt }) => ({ status, waitReason, budget, finalReserve, updatedAt }))(h.stores.runs.get(runId)),
    usage: h.stores.usage.totalsForRun(runId),
    events: h.ctx.journal.read({ runId }).map((e) => e.type),
  };
}

describe("budget increase requests", () => {
  it("opens one operator-required budget_increase Decision with the exact typed subject, replays an identical request, and refuses a conflicting one while it is open", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const added = { costUsd: 5, tokens: 0, attempts: 2 };
      const { decision, replayed } = h.budgetIncreases.request({ runId, partition: "ordinary", added });
      expect(replayed).toBe(false);
      expect(decision).toMatchObject({ kind: "budget_increase", runId, resolutionPolicy: "operator_required", status: "open", requestedBy: { kind: "operator" }, deadlineAt: null, activationCondition: null, subject: { kind: "budget_increase", runId, partition: "ordinary", added } });
      expect(decision.options.map((o) => o.id)).toEqual(["approve", "deny"]);
      expect(h.budgetIncreases.request({ runId, partition: "ordinary", added })).toEqual({ decision, replayed: true });
      expect(refusal(() => h.budgetIncreases.request({ runId, partition: "ordinary", added: { ...added, tokens: 1 } }))).toBe("budget_increase_decision_open");
      expect(refusal(() => h.budgetIncreases.request({ runId, partition: "final_reserve", added }))).toBe("budget_increase_decision_open");
      expect(h.stores.decisions.budgetIncreaseDecisionsOf(runId)).toHaveLength(1);
      // Nothing is granted until approved: the effective limits are the base limits.
      const capacity = h.stores.reservations.runCapacity(runId);
      expect(capacity.increases).toEqual({ ordinary: { costUsd: 0, tokens: 0, attempts: 0 }, finalReserve: { costUsd: 0, tokens: 0, attempts: 0 } });
      expect(capacity.limit).toEqual(capacity.baseLimit);
      expect(h.stores.budgetIncreases.listByRun(runId)).toEqual([]);
      // Invalid increases are refused before any write: zero, negative, an unknown partition.
      for (const invalid of [{ costUsd: 0, tokens: 0, attempts: 0 }, { costUsd: -1, tokens: 0, attempts: 1 }]) {
        expect(refusal(() => h.budgetIncreases.request({ runId, partition: "ordinary", added: invalid }))).toBe("invalid_increase");
      }
      expect(refusal(() => h.budgetIncreases.request({ runId, partition: "global" as never, added }))).toBe("invalid_increase");
      // The projection: the open Decision, no increase yet, only `resolve` allowed while one is open.
      const projection = h.budgetIncreases.inspect(runId);
      expect(projection).toMatchObject({ runId, runStatus: "created", openDecision: { decisionId: decision.id, partition: "ordinary", added }, increases: [], extensions: [], allowedActions: ["resolve"] });
      expect(projection.decisions).toEqual([{ decisionId: decision.id, partition: "ordinary", added, status: "open", chosenOptionId: null, budgetIncreaseId: null }]);
      expect(projection.capacity).toEqual(capacity);
    } finally {
      h.close();
    }
  });

  it("admits an ordinary increase until the Run ends and a final-reserve increase only before verification began; a terminal Run admits nothing", async () => {
    const h = openRuntimeHarness();
    try {
      // created: both partitions may be requested.
      const created = seedRuntime(h).created.run.id;
      expect(h.budgetIncreases.inspect(created).allowedActions).toEqual(["request_ordinary", "request_final_reserve"]);
      // awaiting_signoff: ordinary only.
      const signoff = await awaitSignoff(h);
      expect(h.budgetIncreases.inspect(signoff.runId).allowedActions).toEqual(["request_ordinary"]);
      expect(refusal(() => h.budgetIncreases.request({ runId: signoff.runId, partition: "final_reserve", added: { costUsd: 1, tokens: 0, attempts: 0 } }))).toBe("partition_not_increasable");
      expect(h.budgetIncreases.request({ runId: signoff.runId, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }).decision.status).toBe("open");
      // verifying: neither partition — only the completion engine's final-reserve work executes, and the reserve is frozen once verification began.
      const verifying = seedRuntime(h).created.run.id;
      h.stores.runs.transition(verifying, { to: "running" });
      h.stores.runs.transition(verifying, { to: "verifying" });
      expect(refusal(() => h.budgetIncreases.request({ runId: verifying, partition: "final_reserve", added: { costUsd: 1, tokens: 0, attempts: 0 } }))).toBe("partition_not_increasable");
      expect(refusal(() => h.budgetIncreases.request({ runId: verifying, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }))).toBe("partition_not_increasable");
      expect(h.budgetIncreases.inspect(verifying).allowedActions).toEqual([]);
      // waiting: both partitions.
      const waiting = seedRuntime(h).created.run.id;
      h.stores.runs.transition(waiting, { to: "running" });
      h.stores.runs.transition(waiting, { to: "waiting", waitReason: "budget" });
      expect(h.budgetIncreases.inspect(waiting).allowedActions).toEqual(["request_ordinary", "request_final_reserve"]);
      // terminal: nothing, and an approval of a Decision that outlived the Run is refused.
      const cancelled = seedRuntime(h).created.run.id;
      const late = h.budgetIncreases.request({ runId: cancelled, partition: "final_reserve", added: { costUsd: 1, tokens: 0, attempts: 0 } }).decision;
      h.stores.runs.transition(cancelled, { to: "cancelled" });
      expect(refusal(() => h.budgetIncreases.request({ runId: cancelled, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }))).toBe("run_terminal");
      expect(refusal(() => h.budgetIncreases.resolve({ runId: cancelled, decisionId: late.id, option: "approve" }))).toBe("run_terminal");
      expect(h.stores.decisions.get(late.id).status).toBe("open");
      expect(h.budgetIncreases.inspect(cancelled).allowedActions).toEqual(["resolve"]);
      // A denial is still recorded for a terminal Run's open Decision: it creates nothing.
      expect(h.budgetIncreases.resolve({ runId: cancelled, decisionId: late.id, option: "deny" })).toEqual({ kind: "denied", decisionId: late.id, replayed: false });
      expect(h.stores.budgetIncreases.listByRun(cancelled)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("budget increase resolution", () => {
  it("deny resolves the Decision and creates nothing; approve records exactly one increase in one correlation chain; identical retries replay and conflicting ones write nothing", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const denied = h.budgetIncreases.request({ runId, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }).decision;
      const beforeDeny = budgetWork(h, runId);
      expect(h.budgetIncreases.resolve({ runId, decisionId: denied.id, option: "deny" })).toEqual({ kind: "denied", decisionId: denied.id, replayed: false });
      expect(budgetWork(h, runId)).toEqual({ ...beforeDeny, decisions: [[denied.id, "resolved", "deny"]], events: [...beforeDeny.events, "decision.resolved"] });
      expect(h.budgetIncreases.resolve({ runId, decisionId: denied.id, option: "deny" })).toEqual({ kind: "denied", decisionId: denied.id, replayed: true });
      expect(refusal(() => h.budgetIncreases.resolve({ runId, decisionId: denied.id, option: "approve" }))).toBe("conflicting_resolution");
      // Approval: the Decision resolves and the one increase is recorded, journaled in one chain; nothing else moves.
      const added = { costUsd: 3, tokens: 30_000, attempts: 2 };
      const approved = h.budgetIncreases.request({ runId, partition: "final_reserve", added }).decision;
      const before = budgetWork(h, runId);
      const outcome = h.budgetIncreases.resolve({ runId, decisionId: approved.id, option: "approve" });
      expect(outcome).toMatchObject({ kind: "approved", decisionId: approved.id, replayed: false });
      const increase = h.stores.budgetIncreases.get(outcome.kind === "approved" ? outcome.budgetIncreaseId : ("" as never));
      expect(increase).toMatchObject({ runId, decisionId: approved.id, partition: "final_reserve", added });
      const after = budgetWork(h, runId);
      expect(after).toEqual({ ...before, decisions: [...before.decisions.slice(0, 1), [approved.id, "resolved", "approve"]], increases: [increase.id], events: [...before.events, "decision.resolved", "budget_increase.recorded"] });
      const events = h.ctx.journal.read({ runId }).slice(-2);
      expect(events.map((e) => e.type)).toEqual(["decision.resolved", "budget_increase.recorded"]);
      expect(events[1]!.correlationId).toBe(events[0]!.correlationId);
      expect(events[1]!.causationSeq).toBe(events[0]!.seq);
      expect(events.map((e) => e.actor)).toEqual([{ kind: "operator" }, { kind: "operator" }]);
      // The effective limits grew exactly; the base Budget on the Run did not; no Usage, Invocation, or Run transition exists for it.
      const capacity = h.stores.reservations.runCapacity(runId);
      expect(capacity.increases.finalReserve).toEqual(added);
      expect(capacity.finalReserve).toEqual({ costUsd: 5 + 3, tokens: 50_000 + 30_000, attempts: 3 + 2 });
      expect(capacity.limit).toEqual({ costUsd: 103, tokens: 1_030_000, attempts: 52 });
      expect(h.stores.runs.get(runId).budget).toEqual(s.created.run.budget);
      expect(h.stores.runs.get(runId).finalReserve).toEqual(s.created.run.finalReserve);
      expect(after.usage).toEqual(before.usage);
      expect(after.invocations).toEqual(before.invocations);
      expect(after.run.status).toBe("running");
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.purpose === "decision_resolution")).toEqual([]);
      // Identical approval retries replay the canonical increase; a conflicting denial writes nothing.
      expect(h.budgetIncreases.resolve({ runId, decisionId: approved.id, option: "approve" })).toEqual({ kind: "approved", decisionId: approved.id, budgetIncreaseId: increase.id, replayed: true });
      expect(refusal(() => h.budgetIncreases.resolve({ runId, decisionId: approved.id, option: "deny" }))).toBe("conflicting_resolution");
      expect(budgetWork(h, runId)).toEqual(after);
      expect(h.budgetIncreases.inspect(runId).decisions.map((d) => [d.decisionId, d.chosenOptionId, d.budgetIncreaseId])).toEqual([[denied.id, "deny", null], [approved.id, "approve", increase.id]]);
      expect(h.budgetIncreases.inspect(runId).allowedActions).toEqual(["request_ordinary", "request_final_reserve"]);
    } finally {
      h.close();
    }
  });

  it("refuses a non-operator resolver, a policy resolution, a foreign Run, a mismatched Decision, and a subject that disagrees, and no runtime tool or model path can create an increase", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const other = seedRuntime(h).created.run.id;
      const decision = h.budgetIncreases.request({ runId, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }).decision;
      const before = budgetWork(h, runId);
      // The core rules and the database admit only the operator; the service resolves only as the operator.
      expect(() => h.stores.decisions.resolve(decision.id, { resolvedBy: "orchestrator", chosenOptionId: "approve", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.decisions.resolve(decision.id, { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "approve", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'resolved', resolved_by = 'orchestrator', chosen_option_id = 'approve', resolved_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(decision.id)).toThrow(/decisions_operator_only_kinds/);
      // A foreign Run, an unknown Decision, a Decision of another kind, and a foreign option are refused typed.
      expect(refusal(() => h.budgetIncreases.resolve({ runId: other, decisionId: decision.id, option: "approve" }))).toBe("decision_mismatch");
      expect(refusal(() => h.budgetIncreases.resolve({ runId, decisionId: `dec_${"0".repeat(24)}`, option: "approve" }))).toBe("decision_mismatch");
      expect(refusal(() => h.budgetIncreases.resolve({ runId, decisionId: decision.id, option: "publish" as never }))).toBe("decision_mismatch");
      const otherKind = h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "More?", options: [{ id: "approve", label: "A", description: null }, { id: "deny", label: "D", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      expect(refusal(() => h.budgetIncreases.resolve({ runId, decisionId: otherKind.id, option: "approve" }))).toBe("decision_mismatch");
      expect(budgetWork(h, runId).increases).toEqual([]);
      expect(budgetWork(h, runId).decisions).toEqual(before.decisions);
      // An increase is never recorded for a Decision whose subject names other quantities, and never twice for one Decision (store and database).
      h.budgetIncreases.resolve({ runId, decisionId: decision.id, option: "approve" });
      expect(() => h.stores.budgetIncreases.record({ runId, decisionId: decision.id, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } })).toThrow(/already authorized/);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', 1, 0, 0, ?)").run(`binc_${"9".repeat(24)}`, runId, decision.id, "2026-01-01T00:00:00.000Z")).toThrow(/UNIQUE constraint failed: budget_increases.decision_id/);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', 2, 0, 0, ?)").run(`binc_${"8".repeat(24)}`, runId, decision.id, "2026-01-01T00:00:00.000Z")).toThrow(/operator-approved budget_increase decision/);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'final_reserve', 1, 0, 0, ?)").run(`binc_${"7".repeat(24)}`, runId, decision.id, "2026-01-01T00:00:00.000Z")).toThrow(/operator-approved budget_increase decision/);
      expect(h.stores.budgetIncreases.listByRun(runId)).toHaveLength(1);
      // No runtime tool exposes a Budget Increase to any role or purpose, and no Orchestrator turn was created by the resolution.
      expect(RUNTIME_TOOL_CALL_TOOLS).toEqual(["propose_tasks", "update_task", "request_completion", "request_decision", "write_artifact", "create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]);
      for (const role of ["orchestrator", "coordinator", "worker", "evaluator"] as const) {
        expect(RUNTIME_TOOLS_BY_ROLE[role].some((tool) => /budget|increase|allocation|extend/i.test(tool))).toBe(false);
        expect(effectiveRuntimeTools(RUNTIME_TOOLS_BY_ROLE[role], role, role === "orchestrator" ? "operator_input" : role === "coordinator" ? "decompose" : role === "worker" ? "step" : "evaluate").some((tool) => /budget|increase|allocation|extend/i.test(tool))).toBe(false);
      }
      const started = startRun(h, s);
      expect(h.stores.invocations.listByRun(runId).map((i) => i.purpose)).toEqual(["operator_input"]);
      expect(started.prepared.manifest.content.inputs.some((i) => /budget|increase/i.test(i.kind))).toBe(false);
    } finally {
      h.close();
    }
  });
});
