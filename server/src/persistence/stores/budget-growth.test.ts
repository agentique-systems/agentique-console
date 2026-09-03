/**
 * Budget Increases and Allocation Extensions at the persistence boundary
 * (execution-model §7.6; invariant 22): the immutable base Budget, the
 * derived effective limits, the two append-only records, their store and
 * database validation, and the accounting equations they must keep true.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConflictError, InsufficientCapacityError, InvariantViolationError, ValidationError, ZERO_ALLOCATION, type Allocation, type PlanNodeId, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { extendPlan, joinDefinition, nodeInput, openHarness, patternDefinition, seedBudgetIncrease, seedBudgetIncreaseDecision, seedInvocation, seedManifest, seedRun, seedWorkerNode, SMALL_ALLOCATION, type Harness, type Seeded } from "../test-support.ts";

const BUDGET = { maxCostUsd: 30, maxTokens: 300_000, maxAttempts: 12, maxWallClockMs: null, maxConcurrency: null };
const RESERVE: Allocation = { costUsd: 5, tokens: 50_000, attempts: 2 };

/** Records one Usage row of `costUsd` against a running Attempt of `invocation`, leaving the Invocation active. */
function consume(h: Harness, invocation: { id: string }, costUsd: number, tokens = 0): void {
  const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id as never, startMode: "fresh", resumedFromAttemptId: null });
  h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
  h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: null, inputTokensUncached: tokens, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd, wallClockMs: 1, providerMs: null });
}

describe("budget increases", () => {
  it("keeps the base Budget immutable and derives the effective limits per partition; an ordinary increase never enlarges the final reserve, a final-reserve increase enlarges global and final together", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const before = h.stores.reservations.runCapacity(s.run.id);
      expect(before.baseLimit).toEqual({ costUsd: 30, tokens: 300_000, attempts: 12 });
      expect(before.increases).toEqual({ ordinary: ZERO_ALLOCATION, finalReserve: ZERO_ALLOCATION });
      expect(before.ordinary.limit).toEqual({ costUsd: 25, tokens: 250_000, attempts: 10 });
      const ordinary = seedBudgetIncrease(h, s, "ordinary", { costUsd: 10, tokens: 0, attempts: 3 });
      expect(ordinary.increase).toMatchObject({ runId: s.run.id, decisionId: ordinary.decision.id, partition: "ordinary", added: { costUsd: 10, tokens: 0, attempts: 3 } });
      const afterOrdinary = h.stores.reservations.runCapacity(s.run.id);
      expect(afterOrdinary.baseLimit).toEqual(before.baseLimit);
      expect(afterOrdinary.baseFinalReserve).toEqual(RESERVE);
      expect(afterOrdinary.increases).toEqual({ ordinary: { costUsd: 10, tokens: 0, attempts: 3 }, finalReserve: ZERO_ALLOCATION });
      expect(afterOrdinary.limit).toEqual({ costUsd: 40, tokens: 300_000, attempts: 15 });
      expect(afterOrdinary.finalReserve).toEqual(RESERVE);
      expect(afterOrdinary.ordinary.limit).toEqual({ costUsd: 35, tokens: 250_000, attempts: 13 });
      expect(afterOrdinary.final.limit).toEqual(RESERVE);
      expect(afterOrdinary.ordinary.effectiveAvailable).toEqual({ costUsd: 25, tokens: 150_000, attempts: 8 });
      expect(afterOrdinary.final.effectiveAvailable).toEqual(RESERVE);
      const final = seedBudgetIncrease(h, s, "final_reserve", { costUsd: 2, tokens: 20_000, attempts: 1 });
      const afterFinal = h.stores.reservations.runCapacity(s.run.id);
      expect(afterFinal.limit).toEqual({ costUsd: 42, tokens: 320_000, attempts: 16 });
      expect(afterFinal.finalReserve).toEqual({ costUsd: 7, tokens: 70_000, attempts: 3 });
      expect(afterFinal.ordinary.limit).toEqual({ costUsd: 35, tokens: 250_000, attempts: 13 });
      expect(afterFinal.final.effectiveAvailable).toEqual({ costUsd: 7, tokens: 70_000, attempts: 3 });
      // The Run row never changed; Usage never changed; the records are what the projections read.
      const run = h.stores.runs.get(s.run.id);
      expect(run.budget).toEqual(BUDGET);
      expect(run.finalReserve).toEqual(RESERVE);
      expect(h.stores.usage.totalsForRun(s.run.id).rows).toBe(0);
      expect(h.stores.budgetIncreases.listByRun(s.run.id).map((i) => i.id)).toEqual([ordinary.increase.id, final.increase.id]);
      expect(h.stores.budgetIncreases.byDecision(final.decision.id)).toEqual(final.increase);
      expect(h.stores.budgetIncreases.totalsByRun(s.run.id)).toEqual({ ordinary: { costUsd: 10, tokens: 0, attempts: 3 }, finalReserve: { costUsd: 2, tokens: 20_000, attempts: 1 } });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "budget_increase.recorded" }).map((e) => e.payload)).toEqual([ordinary.increase, final.increase]);
      // Ordinary capacity now admits a node the base Budget could not have funded; the final reserve is still not ordinary capacity.
      extendPlan(h, s, [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 25, tokens: 150_000, attempts: 8 } }))]);
      expect(() => extendPlan(h, s, [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2", allocation: { costUsd: 1, tokens: 0, attempts: 0 } }))])).toThrow(InsufficientCapacityError);
    } finally {
      h.close();
    }
  });

  it("admits exactly one increase per approved Decision, agreeing with the Decision's Run, partition, and quantities — at the store and at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const added = { costUsd: 1, tokens: 1_000, attempts: 1 };
      const approved = seedBudgetIncreaseDecision(h, s, "ordinary", added);
      // A wrong partition or wrong quantity, a denied Decision, an open Decision, a foreign Run: refused, nothing written.
      const seq = h.ctx.journal.lastSeq();
      expect(() => h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "final_reserve", added })).toThrow(InvariantViolationError);
      expect(() => h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "ordinary", added: { ...added, tokens: 2_000 } })).toThrow(InvariantViolationError);
      expect(() => h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "ordinary", added: ZERO_ALLOCATION })).toThrow(ValidationError);
      expect(() => h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "ordinary", added: { costUsd: -1, tokens: 0, attempts: 1 } })).toThrow(ValidationError);
      const other = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      expect(() => h.stores.budgetIncreases.record({ runId: other.run.id, decisionId: approved.id, partition: "ordinary", added })).toThrow(InvariantViolationError);
      const denied = seedBudgetIncreaseDecision(h, other, "ordinary", added, { resolve: "deny" });
      expect(() => h.stores.budgetIncreases.record({ runId: other.run.id, decisionId: denied.id, partition: "ordinary", added })).toThrow(InvariantViolationError);
      const open = seedBudgetIncreaseDecision(h, other, "ordinary", { costUsd: 2, tokens: 0, attempts: 0 }, { resolve: null });
      expect(() => h.stores.budgetIncreases.record({ runId: other.run.id, decisionId: open.id, partition: "ordinary", added: { costUsd: 2, tokens: 0, attempts: 0 } })).toThrow(InvariantViolationError);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: seq })).toEqual([]);
      expect(h.ctx.journal.read({ type: "budget_increase.recorded" })).toEqual([]);
      expect(h.stores.budgetIncreases.listByRun(s.run.id)).toEqual([]);
      // The one valid record, then the second for the same Decision is refused at the store and at the database.
      const increase = h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "ordinary", added });
      expect(() => h.stores.budgetIncreases.record({ runId: s.run.id, decisionId: approved.id, partition: "ordinary", added })).toThrow(ConflictError);
      const insert = (id: string, partition: string, cost: number, tokens: number, attempts: number, decisionId = approved.id) =>
        h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, s.run.id, decisionId, partition, cost, tokens, attempts, "2026-01-01T00:00:00.000Z");
      expect(() => insert(`binc_${"2".repeat(24)}`, "ordinary", 1, 1_000, 1)).toThrow(/UNIQUE constraint failed: budget_increases.decision_id/);
      expect(() => insert(`binc_${"3".repeat(24)}`, "ordinary", 1, 1_000, 1, open.id)).toThrow(/operator-approved budget_increase decision/);
      expect(() => insert(`binc_${"4".repeat(24)}`, "final_reserve", 1, 1_000, 1, denied.id)).toThrow(/operator-approved budget_increase decision/);
      // The row is append-only: no update, no delete.
      expect(() => h.database.sqlite.prepare("UPDATE budget_increases SET added_cost_usd = 99 WHERE id = ?").run(increase.id)).toThrow(/append-only/);
      expect(() => h.database.sqlite.prepare("DELETE FROM budget_increases WHERE id = ?").run(increase.id)).toThrow(/append-only/);
      expect(h.stores.budgetIncreases.get(increase.id)).toEqual(increase);
      // Zero or negative quantities never reach a row: no Decision can name them (core schema), and the database refuses the row itself.
      expect(() => seedBudgetIncreaseDecision(h, other, "ordinary", ZERO_ALLOCATION, { resolve: null })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', 0, 0, 0, ?)").run(`binc_${"5".repeat(24)}`, s.run.id, approved.id, "2026-01-01T00:00:00.000Z")).toThrow(/budget_increase decision|not_all_zero/);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', -1, 0, 0, ?)").run(`binc_${"8".repeat(24)}`, s.run.id, approved.id, "2026-01-01T00:00:00.000Z")).toThrow(/budget_increase decision|non_negative/);
    } finally {
      h.close();
    }
  });

  it("requests an increase only for a nonterminal Run whose status admits the partition, one open Decision per Run, resolved by the operator alone", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const added = { costUsd: 1, tokens: 0, attempts: 0 };
      const open = seedBudgetIncreaseDecision(h, s, "ordinary", added, { resolve: null });
      // A second open budget_increase Decision for the Run is refused at the store and at the database.
      expect(() => seedBudgetIncreaseDecision(h, s, "final_reserve", added, { resolve: null })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET id = id WHERE id = ?").run(open.id)).not.toThrow();
      expect((h.database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'decisions_open_budget_increase_run'").all() as { name: string }[]).length).toBe(1);
      // Only the operator resolves it: the Orchestrator and the default policy are refused by the core rules and by the database.
      expect(() => h.stores.decisions.resolve(open.id, { resolvedBy: "orchestrator", chosenOptionId: "approve", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.decisions.resolve(open.id, { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "approve", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'resolved', resolved_by = 'orchestrator', chosen_option_id = 'approve', resolved_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(open.id)).toThrow(/decisions_operator_only_kinds/);
      h.stores.decisions.resolve(open.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] });
      expect(h.stores.budgetIncreases.listByRun(s.run.id)).toEqual([]);
      // Partition restrictions follow the Run status: final_reserve is refused once verification began; ordinary still admitted awaiting signoff.
      h.stores.runs.transition(s.run.id, { to: "verifying" });
      expect(() => seedBudgetIncreaseDecision(h, s, "final_reserve", added, { resolve: null })).toThrow(ConflictError);
      h.stores.runs.transition(s.run.id, { to: "awaiting_signoff" });
      expect(() => seedBudgetIncreaseDecision(h, s, "final_reserve", added, { resolve: null })).toThrow(ConflictError);
      const ordinary = seedBudgetIncrease(h, s, "ordinary", added);
      expect(ordinary.increase.partition).toBe("ordinary");
      // A terminal Run admits nothing, at the store and at the database (an approved Decision that outlived the Run).
      const t = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const approved = seedBudgetIncreaseDecision(h, t, "ordinary", added);
      h.stores.runs.transition(t.run.id, { to: "cancelled" });
      expect(() => h.stores.budgetIncreases.record({ runId: t.run.id, decisionId: approved.id, partition: "ordinary", added })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', 1, 0, 0, ?)").run(`binc_${"6".repeat(24)}`, t.run.id, approved.id, "2026-01-01T00:00:00.000Z")).toThrow(/nonterminal run/);
      expect(() => seedBudgetIncreaseDecision(h, t, "ordinary", added, { resolve: null })).toThrow(ConflictError);
      // A decisions row cannot carry a default deadline or a zero increase for this kind.
      expect(() =>
        h.database.sqlite.prepare("INSERT INTO decisions (id, conversation_id, run_id, kind, resolution_policy, status, requested_by, question, options, recommended_option_id, rationale, affects, deadline_at, activation_condition, subject, created_at) VALUES (?, ?, ?, 'budget_increase', 'operator_required', 'open', '{\"kind\":\"operator\"}', 'q', '[{\"id\":\"approve\",\"label\":\"A\",\"description\":null},{\"id\":\"deny\",\"label\":\"D\",\"description\":null}]', NULL, NULL, '{\"requirementIds\":[],\"taskIds\":[],\"planNodeIds\":[]}', NULL, NULL, ?, ?)").run(`dec_${"7".repeat(24)}`, s.conversation.id, s.run.id, JSON.stringify({ kind: "budget_increase", runId: s.run.id, partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: 0 } }), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/decisions_budget_increase_shape/);
    } finally {
      h.close();
    }
  });
});

describe("allocation extensions", () => {
  /** A running worker node with its own allocation, its Run-level reservation, and one funded Invocation. */
  function nodeWithInvocation(h: Harness, s: Seeded, allocation: Allocation = { costUsd: 4, tokens: 40_000, attempts: 2 }) {
    const node = seedWorkerNode(h, s, "single", { allocation });
    const reservation = h.stores.reservations.activeForChild({ type: "plan_node", id: node.id })!;
    return { node, reservation };
  }

  it("raises only the node's effective allocation by the exact amount, charges original plus extensions while active, and charges actual consumption alone once released", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const { node, reservation } = nodeWithInvocation(h, s);
      const other = seedWorkerNode(h, s, "single", { allocation: { costUsd: 1, tokens: 10_000, attempts: 1 } });
      const runBefore = h.stores.reservations.runCapacity(s.run.id);
      const extension = h.stores.allocationExtensions.record({ runId: s.run.id, planNodeId: node.id, added: { costUsd: 0, tokens: 5_000, attempts: 1 }, trigger: "invocation" });
      expect(extension).toMatchObject({ runId: s.run.id, planNodeId: node.id, reservationId: reservation.id, added: { costUsd: 0, tokens: 5_000, attempts: 1 }, trigger: "invocation" });
      // The reservation row is untouched; the node's effective allocation grew by exactly the extension; the other node did not change.
      expect(h.stores.reservations.get(reservation.id)).toEqual(reservation);
      const projection = h.stores.reservations.planNodeAllocation(node.id);
      expect(projection).toMatchObject({ reservationId: reservation.id, reservationStatus: "active", original: { costUsd: 4, tokens: 40_000, attempts: 2 }, extended: { costUsd: 0, tokens: 5_000, attempts: 1 }, effective: { costUsd: 4, tokens: 45_000, attempts: 3 } });
      expect(projection.extensions).toEqual([extension]);
      expect(projection.account.limit).toEqual({ costUsd: 4, tokens: 45_000, attempts: 3 });
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id }).available).toEqual({ costUsd: 4, tokens: 45_000, attempts: 3 });
      expect(h.stores.reservations.planNodeAllocation(other.id).effective).toEqual({ costUsd: 1, tokens: 10_000, attempts: 1 });
      // The Run charges the active reservation `max(original + extensions, actual)`: the extension is counted once, not as a second child.
      const runAfter = h.stores.reservations.runCapacity(s.run.id);
      expect(runAfter.ordinary.reserved).toEqual({ costUsd: runBefore.ordinary.reserved.costUsd, tokens: runBefore.ordinary.reserved.tokens + 5_000, attempts: runBefore.ordinary.reserved.attempts + 1 });
      expect(runAfter.ordinary.available).toEqual({ costUsd: runBefore.ordinary.available.costUsd, tokens: runBefore.ordinary.available.tokens - 5_000, attempts: runBefore.ordinary.available.attempts - 1 });
      expect(runAfter.final).toEqual(runBefore.final);
      expect(h.stores.usage.totalsForRun(s.run.id).rows).toBe(0);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "allocation_extension.created" }).map((e) => e.payload)).toEqual([extension]);
      // An Invocation that only fits the extended allocation now reserves from the node.
      const invocation = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, allocation: { costUsd: 3, tokens: 42_000, attempts: 3 } });
      seedManifest(h, s, invocation);
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id }).available).toEqual({ costUsd: 1, tokens: 3_000, attempts: 0 });
      // An overrun of the effective allocation is visible at once and never clamped.
      h.stores.invocations.transition(invocation.id, { to: "running" });
      consume(h, invocation, 6, 50_000);
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id }).available).toEqual({ costUsd: -2, tokens: -5_000, attempts: 0 });
      // Active charges at the Run: the root's 10, the overrun node's max(4, 6) = 6, the other node's 1.
      expect(h.stores.reservations.runCapacity(s.run.id).ordinary.active.costUsd).toBe(10 + 6 + 1);
      // Release: the node's reservation records complete actual consumption once; the extension is provenance, charged no further.
      h.stores.invocations.transitionAttempt(h.stores.invocations.activeAttempt(invocation.id)!.id, { to: "failed", failureClass: "provider_permanent", failureDetail: { message: "boom", violations: [], tool: null, cancelled: false }, retryDecision: { permitted: false, reason: "provider_permanent", notBefore: null }, transcriptArtifactId: null });
      h.stores.invocations.transition(invocation.id, { to: "failed", failureReason: "provider_permanent", result: null });
      h.stores.plans.transitionNode(node.id, { to: "failed", reason: "invocation_failed" });
      const released = h.stores.reservations.get(reservation.id);
      expect(released.status).toBe("released");
      expect(released.reserved).toEqual({ costUsd: 4, tokens: 40_000, attempts: 2 });
      expect(released.consumed).toEqual({ costUsd: 6, tokens: 50_000, attempts: 1 });
      const runReleased = h.stores.reservations.runCapacity(s.run.id);
      expect(runReleased.ordinary.consumed).toEqual({ costUsd: 6, tokens: 50_000, attempts: 1 });
      expect(runReleased.ordinary.reserved).toEqual({ costUsd: 11, tokens: 110_000, attempts: 6 });
      expect(h.stores.reservations.planNodeAllocation(node.id)).toMatchObject({ reservationStatus: "released", extended: { costUsd: 0, tokens: 5_000, attempts: 1 } });
      // The sum of released Run-level consumption agrees with Run Usage (the root holds no Usage here).
      expect(runReleased.ordinary.consumed.costUsd).toBe(h.stores.usage.totalsForRun(s.run.id).costUsd);
    } finally {
      h.close();
    }
  });

  it("refuses a released reservation, a terminal node, a join, a foreign node, a zero or negative amount, and an amount beyond effective ordinary capacity — writing nothing — at the store and at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const { node, reservation } = nodeWithInvocation(h, s);
      const seq = h.ctx.journal.lastSeq();
      const record = (input: Partial<Parameters<typeof h.stores.allocationExtensions.record>[0]>) => h.stores.allocationExtensions.record({ runId: s.run.id, planNodeId: node.id, added: { costUsd: 1, tokens: 0, attempts: 0 }, trigger: "invocation", ...input });
      expect(() => record({ added: ZERO_ALLOCATION })).toThrow(ValidationError);
      expect(() => record({ added: { costUsd: 0, tokens: -1, attempts: 0 } })).toThrow(ValidationError);
      expect(() => record({ trigger: "operator" as never })).toThrow(ValidationError);
      // Beyond the effective ordinary availability (25 − root 10 − node 4 = 11 USD unreserved): refused; the final reserve (5 USD) is never consulted.
      expect(h.stores.reservations.runCapacity(s.run.id).ordinary.effectiveAvailable).toEqual({ costUsd: 11, tokens: 110_000, attempts: 3 });
      expect(() => record({ added: { costUsd: 11.5, tokens: 0, attempts: 0 } })).toThrow(InsufficientCapacityError);
      expect(() => record({ added: { costUsd: 0, tokens: 0, attempts: 9 } })).toThrow(InsufficientCapacityError);
      // A join holds no reservation; a foreign Run's node is refused.
      const join = nodeInput(h, joinDefinition({ sourcePath: "e9/join" }));
      extendPlan(h, s, [join]);
      expect(() => record({ planNodeId: join.id })).toThrow(InvariantViolationError);
      const other = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      expect(() => record({ planNodeId: other.root.id })).toThrow(InvariantViolationError);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["execution_plan.revised", "execution_plan.compiled", "plan_node.created"]);
      expect(h.ctx.journal.read({ type: "allocation_extension.created" })).toEqual([]);
      expect(h.stores.allocationExtensions.listByRun(s.run.id)).toEqual([]);
      // Exactly the available amount fits; then a terminal node's released reservation is never extended again.
      const exact = record({ added: { costUsd: 11, tokens: 0, attempts: 0 } });
      expect(h.stores.reservations.runCapacity(s.run.id).ordinary.effectiveAvailable.costUsd).toBe(0);
      expect(() => record({ added: { costUsd: 0.01, tokens: 0, attempts: 0 } })).toThrow(InsufficientCapacityError);
      h.stores.plans.transitionNode(node.id, { to: "cancelled", reason: "operator" });
      expect(h.stores.reservations.get(reservation.id).status).toBe("released");
      expect(() => record({ added: { costUsd: 0, tokens: 1, attempts: 0 } })).toThrow(ConflictError);
      const insert = (id: string, planNodeId: string, reservationId: string, cost = 1, tokens = 0, attempts = 0) =>
        h.database.sqlite.prepare("INSERT INTO allocation_extensions (id, run_id, plan_node_id, reservation_id, added_cost_usd, added_tokens, added_attempts, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'invocation', ?)").run(id, s.run.id, planNodeId, reservationId, cost, tokens, attempts, "2026-01-01T00:00:00.000Z");
      expect(() => insert(`aext_${"1".repeat(24)}`, node.id, reservation.id)).toThrow(/active ordinary run-to-plan-node reservation/);
      // A live node with another node's reservation, an Invocation reservation, and a join are all refused at the database.
      const live = seedWorkerNode(h, s, "single", { allocation: { costUsd: 1, tokens: 1_000, attempts: 1 } });
      const liveReservation = h.stores.reservations.activeForChild({ type: "plan_node", id: live.id })!;
      const rootReservation = h.stores.reservations.activeForChild({ type: "plan_node", id: s.root.id })!;
      expect(() => insert(`aext_${"2".repeat(24)}`, live.id, rootReservation.id)).toThrow(/active ordinary run-to-plan-node reservation/);
      const invocation = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: live.id, allocation: { costUsd: 0.5, tokens: 100, attempts: 1 } });
      const invocationReservation = h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })!;
      expect(() => insert(`aext_${"3".repeat(24)}`, live.id, invocationReservation.id)).toThrow(/active ordinary run-to-plan-node reservation/);
      expect(() => insert(`aext_${"4".repeat(24)}`, join.id, liveReservation.id)).toThrow(/active ordinary run-to-plan-node reservation/);
      expect(() => insert(`aext_${"5".repeat(24)}`, live.id, liveReservation.id, 0, 0, 0)).toThrow(/not_all_zero/);
      expect(() => insert(`aext_${"6".repeat(24)}`, live.id, liveReservation.id, -1, 0, 0)).toThrow(/non_negative/);
      expect(() => insert(`aext_${"7".repeat(24)}`, live.id, liveReservation.id)).not.toThrow();
      // Append-only: no update, no delete; the reservation's definition stays immutable too.
      expect(() => h.database.sqlite.prepare("UPDATE allocation_extensions SET added_cost_usd = 9 WHERE id = ?").run(exact.id)).toThrow(/append-only/);
      expect(() => h.database.sqlite.prepare("DELETE FROM allocation_extensions WHERE id = ?").run(exact.id)).toThrow(/append-only/);
      expect(() => h.database.sqlite.prepare("UPDATE budget_reservations SET reserved_cost_usd = reserved_cost_usd + 1 WHERE id = ?").run(liveReservation.id)).toThrow(/immutable/);
      expect(h.stores.allocationExtensions.listByPlanNode(node.id)).toEqual([exact]);
      expect(h.stores.allocationExtensions.listByReservation(reservation.id)).toEqual([exact]);
      expect(h.stores.allocationExtensions.get(exact.id)).toEqual(exact);
      // A final-reserve reservation can never be extended: the pair rule already refuses any Run → Invocation reservation.
      expect(h.stores.allocationExtensions.listByRun(s.run.id).every((e) => h.stores.reservations.get(e.reservationId).capacitySource === "ordinary")).toBe(true);
    } finally {
      h.close();
    }
  });

  it("reads the same effective limits, extensions, and increases back after close and reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-growth-"));
    const file = path.join(dir, "console.db");
    let runId!: RunId;
    let nodeId!: PlanNodeId;
    let expected!: { capacity: unknown; node: unknown };
    const first = openHarness(file);
    try {
      const s = seedRun(first, { budget: BUDGET, finalReserve: RESERVE });
      runId = s.run.id;
      const node = seedWorkerNode(first, s, "single", { allocation: SMALL_ALLOCATION });
      nodeId = node.id;
      seedBudgetIncrease(first, s, "ordinary", { costUsd: 3, tokens: 0, attempts: 2 });
      first.stores.allocationExtensions.record({ runId: s.run.id, planNodeId: node.id, added: { costUsd: 2, tokens: 0, attempts: 1 }, trigger: "gate_evaluator" });
      expected = { capacity: first.stores.reservations.runCapacity(runId), node: first.stores.reservations.planNodeAllocation(nodeId) };
    } finally {
      first.close();
    }
    const reopened = openHarness(file);
    try {
      expect(reopened.stores.reservations.runCapacity(runId)).toEqual(expected.capacity);
      expect(reopened.stores.reservations.planNodeAllocation(nodeId)).toEqual(expected.node);
      expect(reopened.stores.budgetIncreases.listByRun(runId)).toHaveLength(1);
      expect(reopened.stores.allocationExtensions.listByRun(runId)).toHaveLength(1);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

