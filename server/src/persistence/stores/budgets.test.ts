import { ConflictError, InsufficientCapacityError, InvariantViolationError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { coordinatorWorkerDefinition, extendPlan, nodeInput, openHarness, patternDefinition, seedInvocation, seedManifest, seedRequirements, seedRun, seedWorkerNode, SMALL_ALLOCATION } from "../test-support.ts";

describe("budget reservations", () => {
  it("reserves atomically from the parent's unreserved capacity and rejects over-reservation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: { maxCostUsd: 25, maxTokens: 250_000, maxAttempts: 12, maxWallClockMs: null, maxConcurrency: null } });
      // The root node already holds 10 / 100k / 5.
      let account = h.stores.reservations.capacity({ type: "run", id: s.run.id });
      expect(account.reserved).toEqual(SMALL_ALLOCATION);
      expect(account.available).toEqual({ costUsd: 15, tokens: 150_000, attempts: 7 });
      extendPlan(h, s, [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 15, tokens: 100_000, attempts: 5 } }))]);
      account = h.stores.reservations.capacity({ type: "run", id: s.run.id });
      expect(account.available).toEqual({ costUsd: 0, tokens: 50_000, attempts: 2 });
      const before = h.ctx.journal.lastSeq();
      const extra = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2", allocation: { costUsd: 0.01, tokens: 1, attempts: 1 } }));
      expect(() => extendPlan(h, s, [extra])).toThrow(InsufficientCapacityError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.reservations.listByParent({ type: "run", id: s.run.id }).filter((r) => r.status === "active")).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("partitions Run capacity into the ordinary pool and the persisted final reserve, bounded by the global Budget (invariant 22)", () => {
    const h = openHarness();
    try {
      const finalReserve = { costUsd: 5, tokens: 50_000, attempts: 3 };
      const s = seedRun(h, { budget: { maxCostUsd: 30, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: null }, finalReserve });
      const capacity = h.stores.reservations.runCapacity(s.run.id);
      expect(capacity.limit).toEqual({ costUsd: 30, tokens: 1_000_000, attempts: 50 });
      expect(capacity.finalReserve).toEqual(finalReserve);
      expect(capacity.global).toMatchObject({ limit: capacity.limit, reserved: SMALL_ALLOCATION, committed: SMALL_ALLOCATION, available: { costUsd: 20, tokens: 900_000, attempts: 45 } });
      expect(capacity.ordinary).toMatchObject({ limit: { costUsd: 25, tokens: 950_000, attempts: 47 }, reserved: SMALL_ALLOCATION, available: { costUsd: 15, tokens: 850_000, attempts: 42 }, effectiveAvailable: { costUsd: 15, tokens: 850_000, attempts: 42 } });
      expect(capacity.final).toEqual({ limit: finalReserve, reserved: { costUsd: 0, tokens: 0, attempts: 0 }, consumed: { costUsd: 0, tokens: 0, attempts: 0 }, committed: { costUsd: 0, tokens: 0, attempts: 0 }, available: finalReserve, effectiveAvailable: finalReserve });
      // `capacity` of the Run is the ordinary partition: the reserve is never available to compiled nodes.
      expect(h.stores.reservations.capacity({ type: "run", id: s.run.id })).toEqual(capacity.ordinary);
      // The ordinary entry point cannot name final capacity: there is no such parameter, and run → invocation is not an ordinary pair.
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 0.5, tokens: 1, attempts: 1 } });
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "run", id: s.run.id }, child: { type: "invocation", id: invocation.id }, amount: { costUsd: 0.1, tokens: 1, attempts: 1 } })).toThrow(ValidationError);
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "run", id: s.run.id }, child: { type: "plan_node", id: s.root.id }, amount: { costUsd: 16, tokens: 1, attempts: 1 }, capacitySource: "final_reserve" } as never)).toThrow();
      expect(h.stores.reservations.runCapacity(s.run.id).final.reserved).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
    } finally {
      h.close();
    }
  });

  it("validates parent/child pairs, ownership, and one active reservation per child", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "run", id: s.run.id }, child: { type: "invocation", id: invocation.id }, amount: { costUsd: 1, tokens: 1, attempts: 1 } })).toThrow(ValidationError);
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: s.root.id }, child: { type: "invocation", id: invocation.id }, amount: { costUsd: 1, tokens: 1, attempts: 1 } })).toThrow(ConflictError);
      const other = seedRun(h);
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: other.root.id }, child: { type: "task", id: "task_000000000000000000000000" }, amount: { costUsd: 1, tokens: 1, attempts: 1 } })).toThrow(InvariantViolationError);
      expect(() => h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: s.root.id }, child: { type: "task", id: "task_000000000000000000000000" }, amount: { costUsd: -1, tokens: 1, attempts: 1 } })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });

  it("releases once with final consumption, keeps the history, and returns the remainder", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 4, tokens: 40_000, attempts: 2 } });
      const reservation = h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })!;
      const nodeBefore = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(nodeBefore.available).toEqual({ costUsd: 6, tokens: 60_000, attempts: 3 });
      expect(() => h.stores.reservations.release(reservation.id, "child_terminal", { costUsd: -1, tokens: 0, attempts: 0 })).toThrow(ValidationError);
      const released = h.stores.reservations.release(reservation.id, "child_terminal", { costUsd: 1, tokens: 10_000, attempts: 1 });
      expect(released.status).toBe("released");
      expect(released.consumed).toEqual({ costUsd: 1, tokens: 10_000, attempts: 1 });
      expect(released.releasedAt).not.toBeNull();
      expect(() => h.stores.reservations.release(reservation.id, "child_terminal", { costUsd: 0, tokens: 0, attempts: 0 })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE budget_reservations SET status = 'active' WHERE id = ?").run(reservation.id)).toThrow(/never changes again/);
      const nodeAfter = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(nodeAfter.reserved).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
      expect(nodeAfter.consumed).toEqual({ costUsd: 1, tokens: 10_000, attempts: 1 });
      expect(nodeAfter.available).toEqual({ costUsd: 9, tokens: 90_000, attempts: 4 });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })).toHaveLength(1);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "budget_reservation.released" })).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("transfers a Task reservation to its Worker Invocation with two rows in one transaction", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s);
      const node = nodeInput(h, coordinatorWorkerDefinition(s.definition.id, { sourcePath: "e1", scope: { requirementRevisionId: revision.id, requirementIds: [leafIds[0]!] } }));
      extendPlan(h, s, [node]);
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      h.stores.plans.transitionNode(node.id, { to: "running" });
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: node.id, origin: "coordinator", subject: "t", requirementIds: [leafIds[0]!], requirementRevisionId: revision.id, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const amount = { costUsd: 3, tokens: 30_000, attempts: 2 };
      const taskReservation = h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: node.id }, child: { type: "task", id: task.id }, amount });
      const before = h.stores.reservations.capacity({ type: "plan_node", id: node.id });
      expect(before.reserved).toEqual(amount);

      const invocation = h.stores.invocations.create(
        { runId: s.run.id, planNodeId: node.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id }, taskIds: [task.id], allocation: amount },
        { fromTaskReservationId: taskReservation.id },
      );
      const rows = h.stores.reservations.listByParent({ type: "plan_node", id: node.id });
      expect(rows).toHaveLength(2);
      const released = rows.find((r) => r.id === taskReservation.id)!;
      const created = rows.find((r) => r.child.type === "invocation")!;
      expect(released.status).toBe("released");
      expect(released.releaseReason).toBe("transferred_to_invocation");
      expect(released.consumed).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
      expect(created.status).toBe("active");
      expect(created.child).toEqual({ type: "invocation", id: invocation.id });
      expect(created.reserved).toEqual(amount);
      expect(created.transferredFromReservationId).toBe(taskReservation.id);
      // Never free and never doubly reserved: the node's reserved sum is unchanged.
      const after = h.stores.reservations.capacity({ type: "plan_node", id: node.id });
      expect(after.reserved).toEqual(amount);
      expect(after.available).toEqual(before.available);
      expect(() => h.stores.reservations.transferTaskToInvocation(taskReservation.id, invocation.id)).toThrow(ConflictError);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "budget_reservation.created" }).map((e) => (e.payload as { child: { type: string } }).child.type)).toEqual(expect.arrayContaining(["task", "invocation"]));
    } finally {
      h.close();
    }
  });

  it("rolls the whole transfer back when the Invocation reservation cannot be created", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const node = seedWorkerNode(h, s, "coordinator_worker");
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: node.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const taskReservation = h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: node.id }, child: { type: "task", id: task.id }, amount: { costUsd: 1, tokens: 1000, attempts: 1 } });
      const before = h.ctx.journal.lastSeq();
      // The Invocation names a different allocation than the Task reservation carries.
      expect(() =>
        h.stores.invocations.create(
          { runId: s.run.id, planNodeId: node.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id }, taskIds: [task.id], allocation: { costUsd: 2, tokens: 1000, attempts: 1 } },
          { fromTaskReservationId: taskReservation.id },
        ),
      ).toThrow(InvariantViolationError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.reservations.get(taskReservation.id).status).toBe("active");
      expect(h.stores.invocations.listByPlanNode(node.id)).toEqual([]);
      // Cancelling the Task releases the reservation without an Invocation reservation.
      h.stores.reservations.release(taskReservation.id, "task_cancelled", { costUsd: 0, tokens: 0, attempts: 0 });
      expect(h.stores.reservations.listByParent({ type: "plan_node", id: node.id }).map((r) => r.status)).toEqual(["released"]);
    } finally {
      h.close();
    }
  });

  it("run-level capacity distinguishes consumed, reserved, and available, using Usage for consumption", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: { maxCostUsd: 20, maxTokens: 200_000, maxAttempts: 10, maxWallClockMs: null, maxConcurrency: null } });
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 2, tokens: 20_000, attempts: 2 } });
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: "low", inputTokensUncached: 1000, cacheCreationTokens: 500, cacheReadTokens: 2000, outputTokens: 500, costUsd: 0.4, wallClockMs: 1, providerMs: null });
      const invocationAccount = h.stores.reservations.capacity({ type: "invocation", id: invocation.id });
      expect(invocationAccount.consumed).toEqual({ costUsd: 0.4, tokens: 4000, attempts: 1 });
      expect(invocationAccount.available).toEqual({ costUsd: 1.6, tokens: 16_000, attempts: 1 });
      h.stores.invocations.transition(invocation.id, { to: "running" });
      h.stores.invocations.transition(invocation.id, { to: "cancelled" });
      const nodeAccount = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(nodeAccount.consumed).toEqual({ costUsd: 0.4, tokens: 4000, attempts: 1 });
      expect(nodeAccount.reserved).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
      h.stores.plans.transitionNode(s.root.id, { to: "running" });
      h.stores.plans.transitionNode(s.root.id, { to: "cancelled", reason: "operator" });
      const runAccount = h.stores.reservations.capacity({ type: "run", id: s.run.id });
      expect(runAccount.consumed).toEqual({ costUsd: 0.4, tokens: 4000, attempts: 1 });
      expect(runAccount.reserved).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
      expect(runAccount.available).toEqual({ costUsd: 19.6, tokens: 196_000, attempts: 9 });
    } finally {
      h.close();
    }
  });
});

describe("reservation overrun", () => {
  it("records complete actual consumption above the reservation and propagates it to node and Run capacity", () => {
    const h = openHarness();
    try {
      // Run Budget equals the root node allocation, so any overrun shows at every level.
      const s = seedRun(h, { budget: { maxCostUsd: 10, maxTokens: 100_000, maxAttempts: 5, maxWallClockMs: null, maxConcurrency: null } });
      const reserved = { costUsd: 1, tokens: 1000, attempts: 1 };
      const invocation = seedInvocation(h, s, { allocation: reserved });
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
      h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: null, inputTokensUncached: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 500, costUsd: 10.5, wallClockMs: 5, providerMs: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "succeeded", result: { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "", openItems: [], blocker: null, runOutcome: null }, transcriptArtifactId: null });
      h.stores.invocations.transition(invocation.id, { to: "running" });
      h.stores.invocations.transition(invocation.id, { to: "cancelled" });

      const released = h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!;
      expect(released.status).toBe("released");
      expect(released.reserved).toEqual(reserved);
      expect(released.consumed).toEqual({ costUsd: 10.5, tokens: 1500, attempts: 1 });
      const releaseEvent = h.ctx.journal.read({ runId: s.run.id, type: "budget_reservation.released" }).at(-1)!;
      expect(releaseEvent.payload).toEqual({ reservationId: released.id, releaseReason: "child_terminal", consumed: { costUsd: 10.5, tokens: 1500, attempts: 1 } });
      expect(() => h.database.sqlite.prepare("UPDATE budget_reservations SET consumed_cost_usd = 1 WHERE id = ?").run(released.id)).toThrow(/never changes again/);

      const node = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(node.consumed).toEqual({ costUsd: 10.5, tokens: 1500, attempts: 1 });
      expect(node.available).toEqual({ costUsd: -0.5, tokens: 98_500, attempts: 4 });
      expect(() => seedInvocation(h, s, { allocation: { costUsd: 0.01, tokens: 1, attempts: 1 } })).toThrow(InsufficientCapacityError);

      h.stores.plans.transitionNode(s.root.id, { to: "running" });
      h.stores.plans.transitionNode(s.root.id, { to: "cancelled", reason: "operator" });
      const nodeReservation = h.stores.reservations.listByChild({ type: "plan_node", id: s.root.id })[0]!;
      expect(nodeReservation.reserved).toEqual(SMALL_ALLOCATION);
      expect(nodeReservation.consumed).toEqual({ costUsd: 10.5, tokens: 1500, attempts: 1 });
      const run = h.stores.reservations.capacity({ type: "run", id: s.run.id });
      expect(run.consumed.costUsd).toBe(h.stores.usage.totalsForRun(s.run.id).costUsd);
      expect(run.available).toEqual({ costUsd: -0.5, tokens: 98_500, attempts: 4 });
      const late = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e9", allocation: { costUsd: 0.01, tokens: 1, attempts: 1 } }));
      expect(() => extendPlan(h, s, [late])).toThrow(InsufficientCapacityError);
    } finally {
      h.close();
    }
  });

  it("treats tokens and Attempts like cost: release never clamps, and reserved values are kept", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: s.root.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const reservation = h.stores.reservations.reserveOrdinary({ runId: s.run.id, parent: { type: "plan_node", id: s.root.id }, child: { type: "task", id: task.id }, amount: { costUsd: 1, tokens: 100, attempts: 1 } });
      const released = h.stores.reservations.release(reservation.id, "task_cancelled", { costUsd: 2.5, tokens: 250, attempts: 3 });
      expect(released.reserved).toEqual({ costUsd: 1, tokens: 100, attempts: 1 });
      expect(released.consumed).toEqual({ costUsd: 2.5, tokens: 250, attempts: 3 });
      const account = h.stores.reservations.capacity({ type: "plan_node", id: s.root.id });
      expect(account.consumed).toEqual({ costUsd: 2.5, tokens: 250, attempts: 3 });
      expect(account.available).toEqual({ costUsd: 7.5, tokens: 99_750, attempts: 2 });
      expect(() => h.stores.reservations.release(reservation.id, "task_cancelled", { costUsd: 0, tokens: 0, attempts: 0 })).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });

  it("keeps under-budget releases unchanged", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 4, tokens: 40_000, attempts: 2 } });
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: null, inputTokensUncached: 100, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100, costUsd: 0.5, wallClockMs: 1, providerMs: null });
      h.stores.invocations.transition(invocation.id, { to: "running" });
      h.stores.invocations.transition(invocation.id, { to: "cancelled" });
      const released = h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!;
      expect(released.consumed).toEqual({ costUsd: 0.5, tokens: 200, attempts: 1 });
      expect(h.stores.reservations.capacity({ type: "plan_node", id: s.root.id }).available).toEqual({ costUsd: 9.5, tokens: 99_800, attempts: 4 });
    } finally {
      h.close();
    }
  });
});

describe("usage ordering", () => {
  const record = (h: ReturnType<typeof openHarness>, attemptId: string, costUsd: number) =>
    h.stores.usage.record({ attemptId: attemptId as never, model: "m", effort: null, inputTokensUncached: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 10, costUsd, wallClockMs: 1, providerMs: null });

  it("accepts Usage after the Attempt ends but before the Invocation ends, and rejects it afterwards", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "interrupted", transcriptArtifactId: null });
      // Final Usage lands after the Attempt is terminal; the Invocation is still live.
      expect(record(h, attempt.id, 0.25).costUsd).toBe(0.25);
      h.stores.invocations.transition(invocation.id, { to: "running" });
      h.stores.invocations.transition(invocation.id, { to: "failed", failureReason: "attempts_exhausted", result: null });
      const released = h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!;
      expect(released.consumed).toEqual({ costUsd: 0.25, tokens: 20, attempts: 1 });

      const seqBefore = h.ctx.journal.lastSeq();
      const totalsBefore = h.stores.usage.totalsForRun(s.run.id);
      expect(() => record(h, attempt.id, 99)).toThrow(ConflictError);
      expect(h.ctx.journal.lastSeq()).toBe(seqBefore);
      expect(h.stores.usage.totalsForRun(s.run.id)).toEqual(totalsBefore);
      expect(h.stores.usage.listByAttempt(attempt.id)).toHaveLength(1);
      expect(h.stores.reservations.capacity({ type: "plan_node", id: s.root.id }).consumed).toEqual({ costUsd: 0.25, tokens: 20, attempts: 1 });
    } finally {
      h.close();
    }
  });
});
