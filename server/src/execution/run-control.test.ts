/**
 * Operator Run cancellation (execution-model §3 `cancelled`, §14 "Operator
 * cancels a Run"): a durable admission barrier from every nonterminal
 * status, convergence of every kind of Run-owned work with terminal history
 * preserved, interruption of executing Attempts whose late results can
 * neither revive the Run nor publish anything, Usage retained exactly once,
 * reservations and leases settled once by their owners, idempotent replay,
 * and typed refusals for ended Runs.
 */
import { RunControlRefusedError, ValidationError, type PlanNode, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { seedRun, seedRunCompletionGate, seedSignoffBoundary } from "../persistence/test-support.ts";
import { coordinatorNode, proposal, propose, tasksOf, turn, WIDE_GOVERNOR, workersOf, workerStep } from "./coordinator-test-support.ts";
import { choice, requesting } from "./decision-test-support.ts";
import { workerStep as gateWorkerStep } from "./gate-test-support.ts";
import { activeCapacity, attemptsOf, chain, delayed, eventsAfter, executing, invocationOf, planned, single, statuses, until, work } from "./run-control-test-support.ts";
import { awaitSignoff } from "./signoff-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, seedRuntime, startRun } from "./test-support.ts";

describe("Run cancellation", () => {
  it("cancels a Run from every nonterminal status — paused ones included — once, releasing its capacity and its Conversation slot, and refuses ended Runs with run_terminal", () => {
    const h = openRuntimeHarness();
    try {
      const cases: { label: string; runId: RunId; expectedRootBefore: string }[] = [];
      // created: a Run whose root has not started.
      const created = seedRuntime(h);
      cases.push({ label: "created", runId: created.created.run.id, expectedRootBefore: "pending" });
      // running, waiting (budget), waiting (soft pause), verifying (hard pause), awaiting_signoff: persistence-seeded Runs with a ready root.
      const running = seedRun(h);
      cases.push({ label: "running", runId: running.run.id, expectedRootBefore: "ready" });
      const waiting = seedRun(h);
      h.stores.runs.transition(waiting.run.id, { to: "waiting", waitReason: "budget" });
      cases.push({ label: "waiting", runId: waiting.run.id, expectedRootBefore: "ready" });
      const softPaused = seedRun(h);
      expect(h.runControl.pause({ runId: softPaused.run.id, mode: "soft" })).toMatchObject({ kind: "paused", mode: "soft", status: "waiting" });
      cases.push({ label: "soft-paused", runId: softPaused.run.id, expectedRootBefore: "ready" });
      const verifying = seedRun(h);
      seedRunCompletionGate(h, verifying);
      h.stores.runs.transition(verifying.run.id, { to: "verifying" });
      expect(h.runControl.pause({ runId: verifying.run.id, mode: "hard" })).toMatchObject({ kind: "paused", mode: "hard", status: "verifying" });
      cases.push({ label: "verifying (hard-paused)", runId: verifying.run.id, expectedRootBefore: "ready" });
      const signoff = seedRun(h);
      seedSignoffBoundary(h, signoff);
      cases.push({ label: "awaiting_signoff", runId: signoff.run.id, expectedRootBefore: "ready" });
      for (const c of cases) {
        const before = h.stores.runs.get(c.runId);
        const root = h.stores.plans.rootNode(c.runId);
        expect(root.status, c.label).toBe(c.expectedRootBefore);
        expect(activeCapacity(h, c.runId).reservations.length, c.label).toBeGreaterThan(0);
        const seq = h.ctx.journal.lastSeq();
        const outcome = h.runControl.cancel({ runId: c.runId });
        expect(outcome, c.label).toMatchObject({ kind: "cancelled", runId: c.runId, replayed: false, interruptedAttemptIds: [], executingAttemptIds: [] });
        expect(outcome.converged, c.label).toMatchObject({ cancelledNodeIds: [root.id], cancelledInvocationIds: [], cancelledTaskIds: [], executingInvocationIds: [] });
        const after = h.stores.runs.get(c.runId);
        expect(after, c.label).toMatchObject({ status: "cancelled", waitReason: null, operatorPause: null, integrationWorkspacePath: before.integrationWorkspacePath, baseSnapshotId: before.baseSnapshotId });
        expect(after.endedAt, c.label).not.toBeNull();
        expect(h.stores.conversations.get(before.conversationId).activeRunId, c.label).toBeNull();
        expect(h.stores.plans.getNode(root.id).status, c.label).toBe("cancelled");
        expect(activeCapacity(h, c.runId), c.label).toEqual({ reservations: [], leases: [] });
        const events = h.ctx.journal.read({ runId: c.runId, afterSeq: seq });
        expect(events.map((e) => e.type), c.label).toEqual(expect.arrayContaining(["run.cancelled", "plan_node.cancelled", "budget_reservation.released"]));
        expect(events.find((e) => e.type === "plan_node.cancelled")!.payload, c.label).toMatchObject({ to: "cancelled", reason: "run_cancelled" });
        expect(events.filter((e) => e.type === "budget_reservation.released").map((e) => (e.payload as { releaseReason: string }).releaseReason), c.label).toEqual(["run_cancelled"]);
        expect(events.filter((e) => e.type === "run.cancelled"), c.label).toHaveLength(1);
        // Idempotent: a repeated cancel replays, writes nothing, and terminal history stays.
        const replaySeq = h.ctx.journal.lastSeq();
        expect(h.runControl.cancel({ runId: c.runId }), c.label).toMatchObject({ kind: "cancelled", replayed: true, converged: null, interruptedAttemptIds: [], executingAttemptIds: [] });
        expect(h.ctx.journal.lastSeq(), c.label).toBe(replaySeq);
        expect(h.stores.runs.get(c.runId), c.label).toEqual(after);
        // A cancelled Run acquires no work and is neither paused nor resumed.
        expect(h.scheduler.reconcileRun(c.runId), c.label).toMatchObject({ stop: "run_terminal", actions: [] });
        expect(() => h.runControl.pause({ runId: c.runId, mode: "soft" }), c.label).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
        expect(() => h.runControl.resume({ runId: c.runId }), c.label).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      }
      // completed and failed Runs: the closed refusal, nothing written.
      const failed = seedRun(h);
      h.stores.runs.transition(failed.run.id, { to: "failed", failure: { kind: "root_node_failed", summary: "root failed", evidenceArtifactIds: [] } });
      const failedSeq = h.ctx.journal.lastSeq();
      expect(() => h.runControl.cancel({ runId: failed.run.id })).toThrow(RunControlRefusedError);
      expect(() => h.runControl.cancel({ runId: failed.run.id })).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      expect(h.ctx.journal.lastSeq()).toBe(failedSeq);
      expect(h.stores.runs.get(failed.run.id).status).toBe("failed");
      expect(h.stores.plans.rootNode(failed.run.id).status).toBe("ready");
      // Strict input.
      expect(() => h.runControl.cancel({ runId: "run" as never })).toThrow(ValidationError);
      expect(() => h.runControl.cancel({ runId: failed.run.id, force: true } as never)).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });

});

describe("Run cancellation of executing work", () => {
  it("interrupts executing Attempts, converges every node, preserves the succeeded one, retains Usage exactly once, and admits nothing afterwards", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [single(s, "A"), single(s, "B"), single(s, "C")]);
      const [a, b, c] = nodes as [PlanNode, PlanNode, PlanNode];
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      h.provider.script(delayed("a"), delayed("b"), delayed("c"));
      const { pass } = await executing(h, runId, ["a", "b", "c"]);
      // C finishes before the cancellation and settles: succeeded, integrated.
      h.provider.release("c");
      await until(() => h.stores.plans.getNode(c.id).status === "succeeded");
      const before = work(h, runId);
      const executingIds = h.executor.inFlightOf(runId);
      expect(executingIds).toHaveLength(2);
      const seq = h.ctx.journal.lastSeq();
      const outcome = h.runControl.cancel({ runId });
      // The intent is durable before the interruption is delivered: the Run row is cancelled and the non-executing work converged in one
      // transaction; the two executing Attempts received the signal and are still finalizing.
      expect(outcome).toMatchObject({ kind: "cancelled", replayed: false, interruptedAttemptIds: executingIds, executingAttemptIds: executingIds });
      // The root's turn had ended, so the root converged at once; A's and B's nodes wait for their Attempts.
      expect(outcome.converged).toMatchObject({ cancelledInvocationIds: [], cancelledNodeIds: [h.stores.plans.rootNode(runId).id], executingInvocationIds: [invocationOf(h, a).id, invocationOf(h, b).id] });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "cancelled", operatorPause: null });
      const finished = await pass;
      expect(finished.stop).toBe("run_terminal");
      // Every Attempt ended cancelled with a refused retry; the Invocations, their nodes, and the root followed; C's history is untouched.
      for (const node of [a, b]) {
        const invocation = h.stores.invocations.get(invocationOf(h, node).id);
        expect(invocation.status).toBe("cancelled");
        expect(attemptsOf(h, invocation.id)).toEqual([[1, "cancelled", false]]);
        const [attempt] = h.stores.invocations.listAttempts(invocation.id);
        expect(attempt).toMatchObject({ failureDetail: { cancelled: true }, retryDecision: { permitted: false, reason: "cancelled", notBefore: null } });
        expect(h.stores.usage.listByAttempt(attempt!.id)).toHaveLength(1);
      }
      expect(statuses(h, [a, b, c])).toEqual(["cancelled", "cancelled", "succeeded"]);
      expect(h.stores.plans.rootNode(runId).status).toBe("cancelled");
      expect(h.ctx.journal.read({ runId, afterSeq: seq, type: "plan_node.cancelled" }).map((e) => (e.payload as { reason: string }).reason)).toEqual(["run_cancelled", "run_cancelled", "run_cancelled"]);
      expect(h.provider.requests.filter((r) => r.aborted).map((r) => r.abortCause)).toEqual(["cancelled", "cancelled"]);
      // Usage retained exactly once per Attempt; nothing refunded; every reservation and lease settled once by its owner.
      const after = work(h, runId);
      expect(after).toMatchObject({ invocations: before.invocations, attempts: before.attempts, usage: before.usage + 2, handoffs: before.handoffs });
      expect(h.stores.usage.totalsForRun(runId).costUsd).toBeGreaterThan(0);
      expect(activeCapacity(h, runId)).toEqual({ reservations: [], leases: [] });
      expect(h.ctx.journal.read({ runId, type: "budget_reservation.released" }).length).toBe(h.stores.reservations.listByParent({ type: "run", id: runId }).length + h.stores.plans.listNodes(runId).reduce((n, node) => n + h.stores.reservations.listByParent({ type: "plan_node", id: node.id }).length, 0));
      expect(h.executor.inFlightOf(runId)).toEqual([]);
      // The Integration Workspace stays; the worktrees of the ended Invocations were released after the commit, outside every transaction.
      expect(h.stores.runs.get(runId).integrationWorkspacePath).not.toBeNull();
      expect(h.executionWorkspace.released.map((r) => r.invocationId).sort()).toEqual([invocationOf(h, a).id, invocationOf(h, b).id, invocationOf(h, c).id, s.invocation.id].sort());
      expect(h.stores.invocations.listPendingWorkspaceCleanup()).toEqual([]);
      // No new work after acceptance: a pass performs nothing, the executor prepares nothing, the runners write nothing.
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [], executed: [] });
      expect(await h.executor.prepareNextAttempt(invocationOf(h, a).id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(h.provider.requests).toHaveLength(4);
      expect(h.ctx.journal.read({ runId, type: "run.cancelled" })).toHaveLength(1);
      // A repeated cancel replays without writing and interrupts nothing.
      const replaySeq = h.ctx.journal.lastSeq();
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: true, interruptedAttemptIds: [], executingAttemptIds: [] });
      expect(h.ctx.journal.lastSeq()).toBe(replaySeq);
    } finally {
      h.close();
    }
  });

  it("ends an Attempt cancelled from the Run row when the cancellation commits between the provider's return and finalization: no Changeset, no result, Usage once", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [single(s, "A")]);
      const a = nodes[0]!;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      // The Worker writes; its provider execution returns a completed result once released.
      h.provider.script(delayed("a", gateWorkerStep(h, "a")));
      const { pass } = await executing(h, runId, ["a"]);
      const invocation = invocationOf(h, a);
      // The cancellation lands after the provider returned, while the worktree state is being collected — before finalization reads the rows.
      const collect = h.executionWorkspace.collectChangeset.bind(h.executionWorkspace);
      let cancelledDuringCollection = false;
      h.executionWorkspace.collectChangeset = async (request) => {
        const outcome = h.runControl.cancel({ runId });
        cancelledDuringCollection = outcome.kind === "cancelled" && !outcome.replayed;
        return collect(request);
      };
      const snapshotsBefore = h.stores.snapshots.listByRun(runId).length;
      h.provider.release("a");
      const finished = await pass;
      expect(cancelledDuringCollection).toBe(true);
      expect(finished.stop).toBe("run_terminal");
      // The provider's result is not a result: the Attempt is cancelled from the Run row, nothing is recorded from the late success.
      expect(h.provider.requests.at(-1)).toMatchObject({ aborted: false, step: { kind: "delay" } });
      const [attempt] = h.stores.invocations.listAttempts(invocation.id);
      expect(attempt).toMatchObject({ status: "cancelled", result: null, failureDetail: { cancelled: true }, retryDecision: { permitted: false, reason: "cancelled" } });
      expect(h.stores.usage.listByAttempt(attempt!.id)).toHaveLength(1);
      expect(h.stores.invocations.get(invocation.id)).toMatchObject({ status: "cancelled", result: null });
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === invocation.id)).toEqual([]);
      expect(h.stores.snapshots.listByRun(runId)).toHaveLength(snapshotsBefore);
      expect(h.stores.plans.getNode(a.id).status).toBe("cancelled");
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "cancelled", integrationSnapshotId: h.stores.runs.get(runId).integrationSnapshotId });
      expect(h.executionWorkspace.released.some((r) => r.invocationId === invocation.id)).toBe(true);
      expect(activeCapacity(h, runId)).toEqual({ reservations: [], leases: [] });
    } finally {
      h.close();
    }
  });

  it("converges work that left the current membership, a Coordinator's Workers and Tasks, and a chain mid-way, each to its legal cancelled state", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // A chain whose first step executes while a plan revision replaces the chain: the step's node leaves the membership still running.
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const first = planNodes(h, s, [{ pattern: "chain", steps: [single(s, "A"), single(s, "B")] }]);
      const [a, b] = first.nodes as [PlanNode, PlanNode];
      h.provider.script(delayed("root"), delayed("a"));
      const { pass } = await executing(h, runId, ["root", "a"]);
      const second = planNodes(h, s, [single(s, "C")]);
      const c = second.nodes[0]!;
      expect(second.outcome.cancelledNodeIds).toEqual([b.id]);
      expect(statuses(h, [a, b, c])).toEqual(["running", "cancelled", "pending"]);
      const bEnded = h.stores.plans.getNode(b.id).endedAt;
      const outcome = h.runControl.cancel({ runId });
      expect(outcome.interruptedAttemptIds).toHaveLength(2);
      // C (unstarted, current) converged in the cancelling transaction; A (removed, executing) and the root follow their Attempts.
      expect(outcome.converged).toMatchObject({ cancelledNodeIds: [c.id], cancelledHandoffIds: [] });
      await pass;
      expect(statuses(h, [a, b, c])).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(h.stores.plans.getNode(b.id).endedAt).toBe(bEnded);
      expect(h.ctx.journal.read({ runId, type: "plan_node.cancelled" }).map((e) => (e.payload as { reason: string }).reason).sort()).toEqual(["plan_revision", "run_cancelled", "run_cancelled", "run_cancelled"]);
      expect(h.stores.plans.rootNode(runId).status).toBe("cancelled");
      expect(attemptsOf(h, invocationOf(h, a).id)).toEqual([[1, "cancelled", false]]);
      expect(h.stores.invocations.listByPlanNode(c.id)).toEqual([]);
      expect(activeCapacity(h, runId)).toEqual({ reservations: [], leases: [] });
    } finally {
      h.close();
    }
    const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // A Coordinator that proposed three Tasks: two Workers execute, one Task is pending; cancellation ends every Task legally.
      const s = seedPlanningRuntime(g);
      const runId = s.created.run.id;
      const { node, leafIds } = coordinatorNode(g, s, { bounds: { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } });
      g.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await g.executor.advanceInvocation(s.invocation.id);
      g.provider.script(turn([propose([proposal({ key: "t1", requirementIds: [leafIds[0]!] }), proposal({ key: "t2", requirementIds: [leafIds[1]!] }), proposal({ key: "t3", requirementIds: [leafIds[0]!], dependsOnKeys: ["t1"] })])]), delayed("w1", workerStep(g)), delayed("w2", workerStep(g)));
      const { pass } = await executing(g, runId, ["w1", "w2"]);
      const tasks = tasksOf(g, node);
      expect(tasks.map((t) => t.status).sort()).toEqual(["pending", "running", "running"]);
      const workers = workersOf(g, node);
      expect(workers).toHaveLength(2);
      const outcome = g.runControl.cancel({ runId });
      expect(outcome.interruptedAttemptIds).toHaveLength(2);
      // The pending Task and its reservation settled in the cancelling transaction; the running ones follow their Workers' finalization.
      expect(outcome.converged!.cancelledTaskIds).toEqual(tasks.filter((t) => t.status === "pending").map((t) => t.id));
      await pass;
      const ended = tasksOf(g, node);
      expect(ended.map((t) => t.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(ended.every((t) => t.invocationId === null)).toBe(true);
      for (const worker of workers) {
        expect(g.stores.invocations.get(worker.id).status).toBe("cancelled");
        expect(attemptsOf(g, worker.id)).toEqual([[1, "cancelled", false]]);
      }
      expect(g.stores.plans.getNode(node.id).status).toBe("cancelled");
      expect(g.ctx.journal.read({ runId, type: "task.blocked" }).map((e) => (e.payload as { blockReason: { kind: string } }).blockReason.kind)).toEqual(["replan", "replan"]);
      expect(activeCapacity(g, runId)).toEqual({ reservations: [], leases: [] });
      expect(g.stores.reservations.listByChild({ type: "task", id: tasks[0]!.id }).every((r) => r.status === "released")).toBe(true);
    } finally {
      g.close();
    }
    const k = openRuntimeHarness();
    try {
      // A chain whose second step executes: the first step's history stays, the second is cancelled, and no third step is prepared.
      const { runId, nodes } = await planned(k, (s) => [chain(s, ["A0", "A1", "A2"])]);
      const node = nodes[0]!;
      k.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, delayed("a1"));
      const { pass } = await executing(k, runId, ["a1"]);
      const position = (i: { patternPosition: { kind: string; index?: number } | null }) => (i.patternPosition?.kind === "chain_step" ? i.patternPosition.index : -1);
      expect(k.stores.invocations.listByPlanNode(node.id).map((i) => [position(i), i.status])).toEqual([[0, "succeeded"], [1, "running"]]);
      const outcome = k.runControl.cancel({ runId });
      expect(outcome.interruptedAttemptIds).toHaveLength(1);
      await pass;
      const steps = k.stores.invocations.listByPlanNode(node.id);
      expect(steps.map((i) => [position(i), i.status])).toEqual([[0, "succeeded"], [1, "cancelled"]]);
      expect(attemptsOf(k, steps[0]!.id)).toEqual([[1, "succeeded", null]]);
      expect(attemptsOf(k, steps[1]!.id)).toEqual([[1, "cancelled", false]]);
      expect(k.stores.plans.getNode(node.id).status).toBe("cancelled");
      expect(k.stores.handoffs.listByRun(runId).map((x) => x.status)).toEqual(["delivered"]);
      expect(k.stores.changesets.listByRun(runId).filter((c) => c.invocationId === steps[0]!.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
      expect(activeCapacity(k, runId)).toEqual({ reservations: [], leases: [] });
    } finally {
      k.close();
    }
  });

  it("preserves blocked Invocations, open Decisions, Gates, and Completion Requests as history and refuses every continuation from them", async () => {
    const h = openRuntimeHarness();
    try {
      // A root turn blocked on the Decision it requested: the Run waits on the Decision when it is cancelled.
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { invocation: first } = startRun(h, s).prepared;
      h.provider.script(requesting([choice()]));
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting" });
      const blocked = h.stores.invocations.get(first.id);
      expect(blocked.status).toBe("blocked");
      const decision = h.stores.decisions.get(blocked.blockedByDecisionId!);
      const seq = h.ctx.journal.lastSeq();
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false, interruptedAttemptIds: [] });
      // The blocked Invocation and its open Decision are history: neither is rewritten, resolved, or continued.
      expect(h.stores.invocations.get(first.id)).toEqual(blocked);
      expect(h.stores.decisions.get(decision.id)).toEqual(decision);
      expect(h.stores.plans.rootNode(runId).status).toBe("cancelled");
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "express" })).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      expect(h.decisionRequests.pendingContinuations(runId)).toEqual([]);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
      expect(eventsAfter(h, runId, seq, ["decision.", "invocation."])).toEqual([]);
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      // A Run awaiting signoff: its Gate, Decision, and passed Completion Request stay; signoff is refused; nothing is fabricated.
      const { runId, gate, decisionId } = await awaitSignoff(g);
      const seq = g.ctx.journal.lastSeq();
      expect(g.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false });
      expect(g.stores.gates.get(gate.id).status).toBe("open");
      expect(g.stores.decisions.get(decisionId).status).toBe("open");
      expect(g.stores.completionRequests.listByRun(runId).map((r) => r.status)).toEqual(["passed"]);
      await expect(g.signoff.accept({ runId, gateId: gate.id, decisionId })).rejects.toThrow(expect.objectContaining({ refusal: "run_not_awaiting_signoff" }));
      expect(() => g.signoff.inspect(runId)).toThrow(expect.objectContaining({ refusal: "run_not_awaiting_signoff" }));
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "cancelled", finalSnapshotId: null, finalChangesetId: null });
      expect(eventsAfter(g, runId, seq, ["gate.", "decision.", "completion_request.", "evaluation."])).toEqual([]);
      expect(await g.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
    } finally {
      g.close();
    }
  });

  it("cancels a soft-paused draining Run with the cancellation cause and a hard-paused Run whose interrupted Attempt is history", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [single(s, "A")]);
      const a = nodes[0]!;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      h.provider.script(delayed("a"));
      const { pass } = await executing(h, runId, ["a"]);
      const executingIds = h.executor.inFlightOf(runId);
      // Soft pause: the Attempt drains; the cancellation interrupts it with `cancelled`, never with the pause.
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", mode: "soft", status: "waiting", interruptedAttemptIds: [], executingAttemptIds: executingIds });
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false, interruptedAttemptIds: executingIds });
      await pass;
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "cancelled", waitReason: null, operatorPause: null });
      expect(attemptsOf(h, invocationOf(h, a).id)).toEqual([[1, "cancelled", false]]);
      expect(h.provider.requests.at(-1)!.abortCause).toBe("cancelled");
      expect(h.stores.plans.getNode(a.id).status).toBe("cancelled");
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(g);
      const runId = s.created.run.id;
      const { nodes } = planNodes(g, s, [single(s, "A")]);
      const a = nodes[0]!;
      g.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await g.executor.advanceInvocation(s.invocation.id);
      g.provider.script(delayed("a"));
      const { pass } = await executing(g, runId, ["a"]);
      // Hard pause: the Attempt is interrupted and finalized retry-eligible; the later cancellation converges the Invocation without a new Attempt.
      const paused = g.runControl.pause({ runId, mode: "hard" });
      expect(paused).toMatchObject({ kind: "paused", mode: "hard", status: "waiting" });
      expect(paused.interruptedAttemptIds).toHaveLength(1);
      expect((await pass).stop).toBe("waiting");
      const invocation = invocationOf(g, a);
      expect(attemptsOf(g, invocation.id)).toEqual([[1, "interrupted", true]]);
      expect(g.stores.invocations.get(invocation.id).status).toBe("running");
      const outcome = g.runControl.cancel({ runId });
      expect(outcome).toMatchObject({ kind: "cancelled", replayed: false, interruptedAttemptIds: [], executingAttemptIds: [] });
      expect(outcome.converged).toMatchObject({ cancelledInvocationIds: [invocation.id], cancelledNodeIds: expect.arrayContaining([a.id]) });
      expect(attemptsOf(g, invocation.id)).toEqual([[1, "interrupted", true]]);
      expect(g.stores.invocations.get(invocation.id).status).toBe("cancelled");
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "cancelled", operatorPause: null });
      expect(await g.executor.prepareNextAttempt(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(g.stores.plans.getNode(a.id).status).toBe("cancelled");
      expect(activeCapacity(g, runId)).toEqual({ reservations: [], leases: [] });
    } finally {
      g.close();
    }
  });
});
