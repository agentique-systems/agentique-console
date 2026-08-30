/**
 * Final-reserve funding and global Budget accounting (execution-model §7.6;
 * invariants 10 complete Usage and 22 explicit atomic allocation).
 */
import { ConflictError, InsufficientCapacityError, InvariantViolationError, ValidationError, type Allocation, type Invocation, type InvocationPurpose, type InvocationRole } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { createPersistenceContext } from "../context.ts";
import { MemoryBlobStore } from "../blob-store.ts";
import { openDatabase } from "../database.ts";
import { createStores } from "../stores/index.ts";
import { extendPlan, nodeInput, openHarness, patternDefinition, seedAgentRevision, seedInvocation, seedManifest, seedRun, seedWorkerNode, type Harness, type Seeded } from "../test-support.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUDGET = { maxCostUsd: 100, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: null };
const RESERVE: Allocation = { costUsd: 10, tokens: 100_000, attempts: 4 };
const ZERO: Allocation = { costUsd: 0, tokens: 0, attempts: 0 };

function finalInvocation(h: Harness, s: Seeded, use: "final_synthesis" | "run_completion", overrides: Partial<{ role: InvocationRole; purpose: InvocationPurpose; planNodeId: string; allocation: Allocation; taskIds: string[] }> = {}): Invocation {
  const binding = use === "final_synthesis" ? { role: "orchestrator" as const, purpose: "final_synthesis" as const } : { role: "evaluator" as const, purpose: "evaluate" as const };
  const patternPosition = (overrides.role ?? binding.role) === "orchestrator" ? { kind: "orchestrator" as const } : (overrides.purpose ?? binding.purpose) === "select" ? { kind: "route_selection" as const } : (overrides.purpose ?? binding.purpose) === "task" ? { kind: "worker_task" as const, taskId: (overrides.taskIds?.[0] ?? "task_000000000000000000000000") as never } : null;
  // A run_completion Evaluator is a Gate Evaluator: it judges the Run's run_completion Gate with the Run's Gate Evaluator revision.
  const gateId = patternPosition === null ? h.stores.gates.open({ runId: s.run.id, planNodeId: null, kind: "run_completion", acceptanceCriterionIds: [], snapshotId: null, candidateArtifactIds: [] }).id : null;
  return h.stores.invocations.create({
    runId: s.run.id,
    planNodeId: (overrides.planNodeId ?? s.root.id) as never,
    role: overrides.role ?? binding.role,
    purpose: overrides.purpose ?? binding.purpose,
    agentDefinitionRevisionId: gateId === null ? s.definition.id : s.evaluator.id,
    continuedFromInvocationId: null,
    patternPosition,
    gateId,
    taskIds: (overrides.taskIds ?? []) as never,
    allocation: overrides.allocation ?? { costUsd: 3, tokens: 30_000, attempts: 2 },
    allocationSource: "run_final_reserve",
    finalReserveUse: use,
  });
}

/** Runs one Attempt of an Invocation that records `usage`, leaving the Invocation running. */
function spend(h: Harness, s: Seeded, invocation: Invocation, usage: { costUsd: number; tokens: number }): void {
  if (h.stores.invocations.listAttempts(invocation.id).length === 0) seedManifest(h, s, invocation);
  if (invocation.status === "pending" && h.stores.invocations.get(invocation.id).status === "pending") h.stores.invocations.transition(invocation.id, { to: "running" });
  const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
  h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
  h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: null, inputTokensUncached: usage.tokens, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: usage.costUsd, wallClockMs: 1, providerMs: null });
  h.stores.invocations.transitionAttempt(attempt.id, { to: "failed", failureClass: "provider_transient", transcriptArtifactId: null });
}

const RESULT = { status: "completed" as const, artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null };

describe("final-reserve Invocations", () => {
  it("an ordinary Invocation reserves from its Plan Node; final-synthesis and run-completion Invocations reserve directly from the Run final reserve", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const ordinary = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate" });
      expect(ordinary).toMatchObject({ allocationSource: "plan_node", finalReserveUse: null });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: ordinary.id })[0]).toMatchObject({ parent: { type: "plan_node", id: s.root.id }, capacitySource: "ordinary", finalReserveUse: null });

      const synthesis = finalInvocation(h, s, "final_synthesis");
      expect(synthesis).toMatchObject({ allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis", planNodeId: s.root.id });
      const synthesisReservation = h.stores.reservations.listByChild({ type: "invocation", id: synthesis.id })[0]!;
      expect(synthesisReservation).toMatchObject({ parent: { type: "run", id: s.run.id }, capacitySource: "final_reserve", finalReserveUse: "final_synthesis", reserved: synthesis.allocation, transferredFromReservationId: null });
      const completion = finalInvocation(h, s, "run_completion", { allocation: { costUsd: 2, tokens: 20_000, attempts: 1 } });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: completion.id })[0]).toMatchObject({ parent: { type: "run", id: s.run.id }, capacitySource: "final_reserve", finalReserveUse: "run_completion" });
      // Neither touches the root node's ordinary allocation; both consume the final reserve.
      expect(h.stores.reservations.capacity({ type: "plan_node", id: s.root.id }).reserved).toEqual(ordinary.allocation);
      const capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.final.reserved).toEqual({ costUsd: 5, tokens: 50_000, attempts: 3 });
      expect(capacity.final.available).toEqual({ costUsd: 5, tokens: 50_000, attempts: 1 });
      expect(capacity.global.reserved).toEqual({ costUsd: 15, tokens: 150_000, attempts: 8 });
      // The reservation Event carries the allocation source and use, and nothing else about the Invocation.
      const event = h.ctx.journal.read({ runId: s.run.id, type: "budget_reservation.created" }).find((e) => e.subjectId === synthesisReservation.id)!;
      expect(event.payload).toMatchObject({ capacitySource: "final_reserve", finalReserveUse: "final_synthesis", child: { type: "invocation", id: synthesis.id } });
      expect(event.scope.invocationId).toBe(synthesis.id);
    } finally {
      h.close();
    }
  });

  it("rejects final-reserve use with the wrong role, purpose, root, discriminator, Task, or Attempt allocation, and by any other consumer", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const before = h.ctx.journal.lastSeq();
      // Wrong role/purpose for the discriminator (schema), and a missing discriminator.
      expect(() => finalInvocation(h, s, "final_synthesis", { purpose: "operator_input" })).toThrow(ValidationError);
      expect(() => finalInvocation(h, s, "final_synthesis", { role: "evaluator", purpose: "evaluate" })).toThrow(ValidationError);
      expect(() => finalInvocation(h, s, "run_completion", { role: "orchestrator", purpose: "final_synthesis" })).toThrow(ValidationError);
      expect(() => h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "orchestrator", purpose: "final_synthesis", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "orchestrator" }, taskIds: [], allocation: { costUsd: 1, tokens: 1, attempts: 1 }, allocationSource: "run_final_reserve" })).toThrow(ValidationError);
      // A route selector or evaluator-optimizer Evaluator cannot use the reserve: only `evaluate` classified `run_completion` may, and a plain evaluate is plan_node.
      expect(() => finalInvocation(h, s, "run_completion", { purpose: "select" })).toThrow(ValidationError);
      const worker = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }));
      extendPlan(h, s, [worker]);
      expect(() => finalInvocation(h, s, "run_completion", { planNodeId: worker.id })).toThrow(/root Plan Node/);
      // Coordinator, Worker, and Task-bound Invocations cannot use it.
      expect(() => finalInvocation(h, s, "final_synthesis", { role: "coordinator", purpose: "decompose" })).toThrow(ValidationError);
      expect(() => finalInvocation(h, s, "run_completion", { role: "worker", purpose: "task" })).toThrow(ValidationError);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: s.root.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      expect(() => finalInvocation(h, s, "final_synthesis", { taskIds: [task.id] })).toThrow(ValidationError);
      const taskReservation = h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: s.root.id }, child: { type: "task", id: task.id }, amount: { costUsd: 1, tokens: 1, attempts: 1 } });
      expect(() => h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "orchestrator", purpose: "final_synthesis", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "orchestrator" }, taskIds: [], allocation: { costUsd: 1, tokens: 1, attempts: 1 }, allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" }, { fromTaskReservationId: taskReservation.id })).toThrow(/cannot transfer a Task reservation/);
      expect(() => finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 1, tokens: 1, attempts: 0 } })).toThrow(ValidationError);
      // Nothing was written: no Invocation, no reservation, no Event beyond the Task and its reservation.
      expect(h.stores.invocations.listByPlanNode(s.root.id)).toEqual([]);
      expect(h.stores.reservations.listByParent({ type: "run", id: s.run.id }).filter((r) => r.capacitySource === "final_reserve")).toEqual([]);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: before }).map((e) => e.type).filter((t) => t !== "gate.opened")).toEqual(["execution_plan.revised", "execution_plan.compiled", "plan_node.created", "budget_reservation.created", "task.created", "budget_reservation.created"]);
      // The store entry point is not reachable for anything but a persisted final-reserve Invocation.
      const ordinary = seedInvocation(h, s, { allocation: { costUsd: 0.5, tokens: 1, attempts: 1 } });
      expect(() => h.stores.reservations.reserveFinalInvocation({ runId: s.run.id, invocationId: ordinary.id })).toThrow(InvariantViolationError);
      expect(() => h.stores.reservations.reserveFinalInvocation({ runId: s.run.id, invocationId: "inv_000000000000000000000000" })).toThrow(/not found/);
      // The database refuses the shapes the store refuses.
      const insert = (source: string, use: string | null, role: string, purpose: string) =>
        h.database.sqlite
          .prepare("INSERT INTO invocations (id, run_id, plan_node_id, role, purpose, agent_definition_revision_id, continued_from_invocation_id, task_ids, alloc_cost_usd, alloc_tokens, alloc_attempts, allocation_source, final_reserve_use, status, wait_reason, failure_reason, result, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', 1, 1, 1, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL)")
          .run(`inv_${Math.random().toString(16).slice(2, 26).padEnd(24, "0")}`, s.run.id, s.root.id, role, purpose, s.definition.id, source, use, "2026-01-01T00:00:00.000Z");
      expect(() => insert("run_final_reserve", null, "orchestrator", "final_synthesis")).toThrow(/invocations_final_reserve_shape/);
      expect(() => insert("plan_node", "final_synthesis", "orchestrator", "final_synthesis")).toThrow(/invocations_final_reserve_shape/);
      expect(() => insert("run_final_reserve", "run_completion", "evaluator", "select")).toThrow(/invocations_final_reserve_binding/);
      expect(() => insert("run_final_reserve", "final_synthesis", "worker", "step")).toThrow(/invocations_final_reserve_binding/);
      expect(() => h.database.sqlite.prepare("INSERT INTO budget_reservations (id, run_id, parent_type, parent_id, child_type, child_id, reserved_cost_usd, reserved_tokens, reserved_attempts, consumed_cost_usd, consumed_tokens, consumed_attempts, capacity_source, final_reserve_use, status, transferred_from_reservation_id, created_at, released_at, release_reason) VALUES (?, ?, 'run', ?, 'plan_node', ?, 1, 1, 1, NULL, NULL, NULL, 'final_reserve', 'final_synthesis', 'active', NULL, ?, NULL, NULL)").run(`bres_${"1".repeat(24)}`, s.run.id, s.run.id, worker.id, "2026-01-01T00:00:00.000Z")).toThrow(/budget_reservations_final_reserve_pair/);
    } finally {
      h.close();
    }
  });

  it("creates the final Invocation and its reservation atomically; a reservation failure leaves no Invocation or Event", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const before = h.ctx.journal.lastSeq();
      expect(() => finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 11, tokens: 1, attempts: 1 } })).toThrow(InsufficientCapacityError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.invocations.listByPlanNode(s.root.id)).toEqual([]);
      const created = finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 10, tokens: 100_000, attempts: 4 } });
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: before }).map((e) => e.type)).toEqual(["invocation.created", "budget_reservation.created"]);
      expect(h.stores.reservations.runCapacity(s.run.id).final.available).toEqual(ZERO);
      expect(() => finalInvocation(h, s, "run_completion", { allocation: { costUsd: 0.01, tokens: 1, attempts: 1 } })).toThrow(InsufficientCapacityError);
      expect(() => h.stores.reservations.reserveFinalInvocation({ runId: s.run.id, invocationId: created.id })).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });

  it("attributes final Usage to the Invocation, the root node, and the Run exactly once, and never charges it to the root's ordinary reservation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const ordinary = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", allocation: { costUsd: 2, tokens: 20_000, attempts: 2 } });
      const synthesis = finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 4, tokens: 40_000, attempts: 2 } });
      spend(h, s, ordinary, { costUsd: 1, tokens: 1000 });
      spend(h, s, synthesis, { costUsd: 3, tokens: 3000 });
      // Operator-facing totals include everything, once.
      expect(h.stores.usage.totalsForInvocation(synthesis.id).costUsd).toBe(3);
      expect(h.stores.usage.totalsForPlanNode(s.root.id).costUsd).toBe(4);
      expect(h.stores.usage.totalsForRun(s.run.id)).toMatchObject({ rows: 2, costUsd: 4 });
      // Reservation accounting charges the final Invocation on its own Run-level row only.
      expect(h.stores.usage.consumedFromPlanNodeAllocation(s.root.id)).toEqual({ costUsd: 1, tokens: 1000, attempts: 1 });
      expect(h.stores.usage.consumedByInvocation(synthesis.id)).toEqual({ costUsd: 3, tokens: 3000, attempts: 1 });
      let capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.ordinary.committed).toEqual(s.root.allocation);
      expect(capacity.final.committed).toEqual({ costUsd: 4, tokens: 40_000, attempts: 2 });
      // Release everything: the final row records 3, the root row records 1, and the Run-level sum equals total Run Usage.
      h.stores.invocations.transition(synthesis.id, { to: "succeeded", result: RESULT });
      h.stores.invocations.transition(ordinary.id, { to: "succeeded", result: RESULT });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: synthesis.id })[0]).toMatchObject({ status: "released", consumed: { costUsd: 3, tokens: 3000, attempts: 1 } });
      h.stores.plans.transitionNode(s.root.id, { to: "running" });
      h.stores.plans.transitionNode(s.root.id, { to: "succeeded", outputArtifactIds: [] });
      const rootReservation = h.stores.reservations.listByChild({ type: "plan_node", id: s.root.id })[0]!;
      expect(rootReservation).toMatchObject({ status: "released", consumed: { costUsd: 1, tokens: 1000, attempts: 1 } });
      capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.global.consumed).toEqual({ costUsd: 4, tokens: 4000, attempts: 2 });
      expect(capacity.global.consumed.costUsd).toBe(h.stores.usage.totalsForRun(s.run.id).costUsd);
      expect(capacity.ordinary.consumed).toEqual({ costUsd: 1, tokens: 1000, attempts: 1 });
      expect(capacity.final.consumed).toEqual({ costUsd: 3, tokens: 3000, attempts: 1 });
    } finally {
      h.close();
    }
  });
});

describe("global Run Budget across partitions", () => {
  it("keeps ordinary under-budget behaviour and lets an ordinary overrun reduce effective final availability immediately", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: { ...BUDGET, maxCostUsd: 100, maxTokens: 1000, maxAttempts: 10 }, finalReserve: { costUsd: 10, tokens: 100, attempts: 2 }, rootAllocation: { costUsd: 60, tokens: 500, attempts: 5 } });
      let capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.ordinary.effectiveAvailable).toEqual({ costUsd: 30, tokens: 400, attempts: 3 });
      expect(capacity.final.effectiveAvailable).toEqual({ costUsd: 10, tokens: 100, attempts: 2 });
      // The root's Invocation overruns the root's reservation on cost only, while still active.
      const invocation = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", allocation: { costUsd: 60, tokens: 500, attempts: 5 } });
      spend(h, s, invocation, { costUsd: 95, tokens: 400 });
      capacity = h.stores.reservations.runCapacity(s.run.id);
      // Visible before release: the root is charged max(60, 95) = 95 on cost, max(500, 400) = 500 on tokens.
      expect(capacity.ordinary.committed).toEqual({ costUsd: 95, tokens: 500, attempts: 5 });
      expect(capacity.ordinary.available).toEqual({ costUsd: -5, tokens: 400, attempts: 3 });
      expect(capacity.global.available).toEqual({ costUsd: 5, tokens: 500, attempts: 5 });
      expect(capacity.final.available).toEqual({ costUsd: 10, tokens: 100, attempts: 2 });
      expect(capacity.final.effectiveAvailable).toEqual({ costUsd: 5, tokens: 100, attempts: 2 });
      // The reserve reports 10 locally but only 5 may be started; 6 is refused, 5 is accepted.
      expect(() => finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 6, tokens: 10, attempts: 1 } })).toThrow(InsufficientCapacityError);
      finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 5, tokens: 10, attempts: 1 } });
      expect(h.stores.reservations.runCapacity(s.run.id).global.available).toEqual({ costUsd: 0, tokens: 490, attempts: 4 });
      // Ordinary work cannot claim the unused reserve, even when the reserve is untouched.
      const node = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 0.01, tokens: 1, attempts: 1 } }));
      expect(() => extendPlan(h, s, [node])).toThrow(InsufficientCapacityError);
    } finally {
      h.close();
    }
  });

  it("lets a final overrun reduce global and ordinary effective availability, with negative availability visible and later reservations refused", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: { ...BUDGET, maxCostUsd: 100, maxTokens: 1000, maxAttempts: 10 }, finalReserve: { costUsd: 10, tokens: 100, attempts: 2 }, rootAllocation: { costUsd: 20, tokens: 200, attempts: 2 } });
      const synthesis = finalInvocation(h, s, "final_synthesis", { allocation: { costUsd: 10, tokens: 100, attempts: 2 } });
      // Overrun independently on every quantity: cost 10 → 75, tokens 100 → 850, Attempts 2 → 3 (three Attempts consumed).
      spend(h, s, synthesis, { costUsd: 30, tokens: 400 });
      const attempt2 = h.stores.invocations.createAttempt({ invocationId: synthesis.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(attempt2.id, { to: "running", capacityLeaseId: null });
      h.stores.usage.record({ attemptId: attempt2.id, model: "m", effort: null, inputTokensUncached: 450, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 45, wallClockMs: 1, providerMs: null });
      h.stores.invocations.transitionAttempt(attempt2.id, { to: "failed", failureClass: "provider_transient", transcriptArtifactId: null });
      expect(() => h.stores.invocations.createAttempt({ invocationId: synthesis.id, startMode: "fresh", resumedFromAttemptId: null })).toThrow(/consumed all/);
      let capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.final.committed).toEqual({ costUsd: 75, tokens: 850, attempts: 2 });
      expect(capacity.final.available).toEqual({ costUsd: -65, tokens: -750, attempts: 0 });
      expect(capacity.global.available).toEqual({ costUsd: 5, tokens: -50, attempts: 6 });
      expect(capacity.ordinary.available).toEqual({ costUsd: 70, tokens: 700, attempts: 6 });
      expect(capacity.ordinary.effectiveAvailable).toEqual({ costUsd: 5, tokens: -50, attempts: 6 });
      // Ordinary work is refused now on tokens, then on cost, although the ordinary partition alone would permit it.
      expect(() => extendPlan(h, s, [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 1, tokens: 1, attempts: 1 } }))])).toThrow(InsufficientCapacityError);
      expect(() => extendPlan(h, s, [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 6, tokens: 0, attempts: 1 } }))])).toThrow(InsufficientCapacityError);
      // After release the overrun is recorded, never clamped, and the accounts still agree with Usage.
      h.stores.invocations.transition(synthesis.id, { to: "failed", failureReason: "attempts_exhausted", result: null });
      const released = h.stores.reservations.listByChild({ type: "invocation", id: synthesis.id })[0]!;
      expect(released).toMatchObject({ status: "released", reserved: { costUsd: 10, tokens: 100, attempts: 2 }, consumed: { costUsd: 75, tokens: 850, attempts: 2 } });
      capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.final.available).toEqual({ costUsd: -65, tokens: -750, attempts: 0 });
      expect(capacity.global.consumed).toEqual({ costUsd: 75, tokens: 850, attempts: 2 });
      expect(capacity.global.consumed.tokens).toBe(h.stores.usage.totalsForRun(s.run.id).inputTokensUncached);
      // Final work cannot borrow ordinary capacity: a second final Invocation is refused although 70 ordinary dollars are free.
      expect(() => finalInvocation(h, s, "run_completion", { allocation: { costUsd: 1, tokens: 1, attempts: 1 } })).toThrow(InsufficientCapacityError);
    } finally {
      h.close();
    }
  });

  it("charges an active Invocation overrun at its Plan Node immediately and keeps Task transfer neutral", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 1, tokens: 1000, attempts: 1 } });
      spend(h, s, invocation, { costUsd: 4, tokens: 500 });
      const node = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(node.reserved).toEqual({ costUsd: 1, tokens: 1000, attempts: 1 });
      expect(node.committed).toEqual({ costUsd: 4, tokens: 1000, attempts: 1 });
      expect(node.available).toEqual({ costUsd: 6, tokens: 99_000, attempts: 4 });
      // A Task reservation is charged at its reserved amount and transfer leaves every account unchanged.
      const workers = seedWorkerNode(h, s, "coordinator_worker");
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: workers.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const taskReservation = h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: workers.id }, child: { type: "task", id: task.id }, amount: { costUsd: 2, tokens: 2000, attempts: 1 } });
      const beforeTransfer = { node: h.stores.reservations.capacity({ type: "plan_node", id: workers.id }), run: h.stores.reservations.runCapacity(s.run.id) };
      h.stores.invocations.create({ runId: s.run.id, planNodeId: workers.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id }, taskIds: [task.id], allocation: { costUsd: 2, tokens: 2000, attempts: 1 } }, { fromTaskReservationId: taskReservation.id });
      expect(h.stores.reservations.capacity({ type: "plan_node", id: workers.id })).toEqual(beforeTransfer.node);
      expect(h.stores.reservations.runCapacity(s.run.id)).toEqual(beforeTransfer.run);
    } finally {
      h.close();
    }
  });

  it("capacity and Usage read back identically after the database is closed and reopened", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-final-reserve-"));
    const file = path.join(dir, "console.db");
    const first = openDatabase(file);
    let expected: unknown;
    let runId!: string;
    let rootId!: string;
    try {
      const ctx = createPersistenceContext(first, new MemoryBlobStore());
      const stores = createStores(ctx);
      const h = { ctx, stores, database: first } as unknown as Harness;
      const s = seedRun(h, { budget: BUDGET, finalReserve: RESERVE });
      runId = s.run.id;
      rootId = s.root.id;
      const synthesis = finalInvocation(h, s, "final_synthesis");
      spend(h, s, synthesis, { costUsd: 7, tokens: 700 });
      expected = { capacity: stores.reservations.runCapacity(s.run.id), node: stores.reservations.capacity({ type: "plan_node", id: s.root.id }), usage: stores.usage.totalsForRun(s.run.id), invocation: stores.invocations.get(synthesis.id) };
    } finally {
      first.close();
    }
    const second = openDatabase(file);
    try {
      const stores = createStores(createPersistenceContext(second, new MemoryBlobStore()));
      expect({ capacity: stores.reservations.runCapacity(runId as never), node: stores.reservations.capacity({ type: "plan_node", id: rootId as never }), usage: stores.usage.totalsForRun(runId as never), invocation: stores.invocations.get((expected as { invocation: Invocation }).invocation.id) }).toEqual(expected);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent definition seeds", () => {
  it("the harness Orchestrator definition is a builtin", () => {
    const h = openHarness();
    try {
      expect(seedAgentRevision(h).provenance).toEqual({ kind: "builtin" });
    } finally {
      h.close();
    }
  });
});
