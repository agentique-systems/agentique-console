/**
 * Operator control across process lifetimes (execution-model §14 "Server
 * restart", "Operator cancels a Run", "Operator pauses a Run"): the durable
 * windows a crash can fall into — a pause committed before its interruption
 * was delivered, an interruption recorded before the resume, a cancellation
 * committed before the external cleanup, soft-paused work completed before
 * the restart, and a resume committed whose response was lost — and control
 * from two connections at once. After reopening, cancelled work is never
 * retry-eligible, a pause remains until the operator resumes, recovery
 * resumes nothing, and every obligation converges without a duplicate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttemptId, InvocationId, PlanNodeId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { competitor, newWorld, withProcess, type World } from "./recovery-test-support.ts";
import { settleCancelledRunWork } from "./run-cancellation.ts";
import { attemptsOf, chain, delayed, executing, planned, single, until } from "./run-control-test-support.ts";
import { COMPLETED_RESULT } from "./test-support.ts";

function world(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-run-control-"));
  return newWorld(dir, path.join(dir, "console.db"));
}

describe("Run control across restarts", () => {
  it("(1) a hard pause committed before its interruption was delivered: recovery interrupts the dead Attempt, the Run stays paused, nothing executes until the resume, and the retry runs once", async () => {
    const w = world();
    try {
      let invocationId!: InvocationId;
      await withProcess(w, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        w.runId = runId;
        w.nodeId = nodes[0]!.id;
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(runId);
        void pass.catch(() => undefined);
        await until(() => h.executor.inFlightOf(runId).length === 1);
        invocationId = h.stores.invocations.listByPlanNode(w.nodeId)[0]!.id;
        // The intent commits; the process dies before the interruption reaches the provider.
        expect(h.stores.runs.pause(runId, "hard")).toMatchObject({ change: "paused" });
      }, { recover: false });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.interruptedAttemptIds).toHaveLength(1);
        expect(report.cancelledAttemptIds).toEqual([]);
        expect(report.retryEligible.map((r) => r.invocationId)).toEqual([invocationId]);
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "hard" });
        expect(attemptsOf(h, invocationId)).toEqual([[1, "interrupted", true]]);
        // Recovery resumes nothing: a pass admits no work, the executor refuses the retry.
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "waiting", actions: [], waiting: [{ reason: "operator" }] });
        expect(await h.executor.prepareNextAttempt(invocationId)).toMatchObject({ kind: "not_permitted", reason: "run_paused" });
        expect(h.provider.requests).toEqual([]);
        expect(h.runControl.resume({ runId: w.runId })).toMatchObject({ kind: "resumed", cleared: "hard", status: "running" });
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("quiescent");
        expect(attemptsOf(h, invocationId)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
        expect(h.stores.plans.getNode(w.nodeId).status).toBe("succeeded");
        expect(h.provider.requests).toHaveLength(1);
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("(2) an interruption recorded before the restart is not repeated: recovery finds nothing active, the pause remains, and the resumed Run retries exactly once", async () => {
    const w = world();
    try {
      let invocationId!: InvocationId;
      await withProcess(w, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        w.runId = runId;
        w.nodeId = nodes[0]!.id;
        h.provider.script(delayed("a"));
        const { pass } = await executing(h, runId, ["a"]);
        expect(h.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
        expect((await pass).stop).toBe("waiting");
        invocationId = h.stores.invocations.listByPlanNode(w.nodeId)[0]!.id;
        expect(attemptsOf(h, invocationId)).toEqual([[1, "interrupted", true]]);
      }, { recover: false });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [], retryEligible: [] });
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "hard" });
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "waiting", actions: [] });
        h.runControl.resume({ runId: w.runId });
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("quiescent");
        expect(attemptsOf(h, invocationId)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
        expect(h.stores.invocations.listByPlanNode(w.nodeId)).toHaveLength(1);
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("(3) a cancellation committed before the external cleanup: recovery ends the dead Attempt cancelled, converges the node, releases the worktree, and the Run acquires nothing", async () => {
    const w = world();
    try {
      let invocationId!: InvocationId;
      let attemptId!: AttemptId;
      await withProcess(w, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        w.runId = runId;
        w.nodeId = nodes[0]!.id;
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(runId);
        void pass.catch(() => undefined);
        await until(() => h.executor.inFlightOf(runId).length === 1);
        attemptId = h.executor.inFlightOf(runId)[0]!;
        invocationId = h.stores.invocations.listByPlanNode(w.nodeId)[0]!.id;
        // The cancelling transaction commits (the Run row and the convergence of the non-executing work); the process dies before the
        // interruption is delivered and before any worktree is released.
        h.ctx.tx.write(() => {
          h.stores.runs.transition(runId, { to: "cancelled" });
          const converged = settleCancelledRunWork(h.stores, runId, {});
          expect(converged).toMatchObject({ cancelledNodeIds: [h.stores.plans.rootNode(runId).id], executingInvocationIds: [invocationId] });
        });
        expect(h.stores.invocations.get(invocationId)).toMatchObject({ status: "running", workspaceCleanup: "pending" });
      }, { recover: false });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [attemptId], failedInvocationIds: [], retryEligible: [], workspaceReleasedInvocationIds: expect.arrayContaining([invocationId]), workspaceReleaseFailedInvocationIds: [] });
        expect(report.releasedLeaseIds).toHaveLength(1);
        const [attempt] = h.stores.invocations.listAttempts(invocationId);
        expect(attempt).toMatchObject({ status: "cancelled", failureDetail: { cancelled: true }, retryDecision: { permitted: false, reason: "cancelled", notBefore: null } });
        expect(h.stores.invocations.get(invocationId)).toMatchObject({ status: "cancelled", workspaceCleanup: "released" });
        expect(h.stores.plans.getNode(w.nodeId).status).toBe("cancelled");
        expect(h.stores.runs.get(w.runId).status).toBe("cancelled");
        expect(h.stores.reservations.activeForChild({ type: "invocation", id: invocationId })).toBeNull();
        expect(h.governor.status().activeLeases).toEqual([]);
        expect(await h.executor.prepareNextAttempt(invocationId)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "run_terminal", actions: [] });
        expect(h.provider.requests).toEqual([]);
        // A second recovery finds nothing.
        expect(h.recovery.recover()).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [], workspaceReleasedInvocationIds: [] });
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
    // The other side of the same window: the interruption was delivered and finalized, but the worktree release failed before the death.
    const v = world();
    try {
      let invocationId!: InvocationId;
      await withProcess(v, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        v.runId = runId;
        v.nodeId = nodes[0]!.id;
        h.provider.script(delayed("a"));
        const { pass } = await executing(h, runId, ["a"]);
        invocationId = h.stores.invocations.listByPlanNode(v.nodeId)[0]!.id;
        h.executionWorkspace.failReleaseWith = new Error("EBUSY: the worktree is in use");
        expect(h.runControl.cancel({ runId }).interruptedAttemptIds).toHaveLength(1);
        expect((await pass).stop).toBe("run_terminal");
        expect(h.stores.invocations.get(invocationId)).toMatchObject({ status: "cancelled", workspaceCleanup: "pending" });
        expect(h.executionDiagnostics.map((d) => d.kind)).toContain("workspace_release_failed");
      }, { recover: false });
      await withProcess(v, async (h) => {
        const report = h.recovery.recover();
        expect(report).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [], retryEligible: [], workspaceReleasedInvocationIds: [invocationId], workspaceReleaseFailedInvocationIds: [] });
        expect(h.stores.invocations.get(invocationId)).toMatchObject({ status: "cancelled", workspaceCleanup: "released" });
        expect(h.stores.invocations.listPendingWorkspaceCleanup()).toEqual([]);
        expect(await h.scheduler.advanceRun(v.runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      }, { recover: false });
    } finally {
      fs.rmSync(v.dir, { recursive: true, force: true });
    }
  });

  it("(4) soft-paused work completed before the restart is settled once after the resume and never re-executed", async () => {
    const w = world();
    try {
      let a0!: InvocationId;
      await withProcess(w, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [chain(s, ["A0", "A1"])]);
        w.runId = runId;
        w.nodeId = nodes[0]!.id;
        h.provider.script(delayed("a0"));
        const { pass } = await executing(h, runId, ["a0"]);
        expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", interruptedAttemptIds: [] });
        h.provider.release("a0");
        expect((await pass).stop).toBe("waiting");
        a0 = h.stores.invocations.listByPlanNode(w.nodeId)[0]!.id;
        expect(h.stores.invocations.get(a0).status).toBe("succeeded");
        expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === a0).map((c) => c.integrationStatus)).toEqual(["pending"]);
      }, { recover: false });
      await withProcess(w, async (h) => {
        expect(h.recovery.recover()).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [], retryEligible: [] });
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "soft" });
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "waiting", actions: [] });
        expect(h.stores.invocations.listByPlanNode(w.nodeId)).toHaveLength(1);
        h.runControl.resume({ runId: w.runId });
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        const resumed = await h.scheduler.advanceRun(w.runId);
        expect(resumed.stop).toBe("quiescent");
        expect(resumed.actions.map((x) => x.action.kind)).toEqual(["settle_node", "execute_invocation", "settle_node"]);
        expect(attemptsOf(h, a0)).toEqual([[1, "succeeded", null]]);
        expect(h.stores.invocations.listByPlanNode(w.nodeId).map((i) => i.status)).toEqual(["succeeded", "succeeded"]);
        expect(h.stores.changesets.listByRun(w.runId).filter((c) => c.invocationId === a0).map((c) => c.integrationStatus)).toEqual(["integrated"]);
        expect(h.stores.plans.getNode(w.nodeId).status).toBe("succeeded");
        expect(h.provider.requests).toHaveLength(1);
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("(5) a resume committed before its response was lost: the retried resume is not_paused, the Run has one resume Event, and the work proceeds once", async () => {
    const w = world();
    try {
      let nodeId!: PlanNodeId;
      await withProcess(w, async (h) => {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        w.runId = runId;
        nodeId = nodes[0]!.id;
        expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused" });
        expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", cleared: "soft" });
        // The caller never learns the outcome: the process dies here.
      }, { recover: false });
      await withProcess(w, async (h) => {
        h.recovery.recover();
        expect(h.runControl.resume({ runId: w.runId })).toMatchObject({ kind: "not_paused", status: "running", cleared: null });
        expect(h.ctx.journal.read({ runId: w.runId, type: "run.resumed" })).toHaveLength(1);
        expect(h.ctx.journal.read({ runId: w.runId, type: "run.paused" })).toHaveLength(1);
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("quiescent");
        expect(h.stores.plans.getNode(nodeId).status).toBe("succeeded");
        expect(h.stores.invocations.listByPlanNode(nodeId)).toHaveLength(1);
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("control from two connections converges on the same rows: an escalation from one, a resume from the other, a cancellation replayed by both", async () => {
    const w = world();
    try {
      await withProcess(w, async (a) => {
        const { runId } = await planned(a, (s) => [single(s, "A")]);
        w.runId = runId;
        const b = competitor(w);
        try {
          expect(a.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", mode: "soft" });
          expect(b.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "unchanged", mode: "soft" });
          expect(b.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "escalated", mode: "hard" });
          expect(a.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "unchanged", mode: "hard" });
          expect(a.stores.runs.get(runId)).toMatchObject({ operatorPause: "hard" });
          expect(a.runControl.resume({ runId })).toMatchObject({ kind: "resumed", cleared: "hard" });
          expect(b.runControl.resume({ runId })).toMatchObject({ kind: "not_paused" });
          expect(b.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false });
          expect(a.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: true });
          expect(a.stores.runs.get(runId)).toEqual(b.stores.runs.get(runId));
          expect(a.ctx.journal.read({ runId }).filter((e) => e.type.startsWith("run.")).map((e) => e.type)).toEqual(["run.created", "run.started", "run.paused", "run.waiting", "run.paused", "run.resumed", "run.wait_cleared", "run.cancelled"]);
        } finally {
          b.close();
        }
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
