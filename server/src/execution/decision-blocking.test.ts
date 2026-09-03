/**
 * The runtime-owned blocking boundary of an accepted `request_decision`
 * (execution-model §6.5, §7.2, §8.2; invariants 5, 6, 20): the Attempt ends
 * once with the closed `decision_requested` class and a refused retry, the
 * Invocation ends `blocked` on the requested Decision with its Tasks blocked
 * on it and its reservation, lease, and worktree released exactly once,
 * Usage is recorded exactly once, and nothing the provider does after the
 * accepted request — a completed result, a failure, a throw, a further tool
 * call, an approval-required call — overrides the boundary. A process that
 * dies after the commit converges to the same state without another
 * provider call.
 */
import { canonicalJson, type Invocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE, type FakeStep } from "../provider/fake.ts";
import { coordinatorNode, finishRoot, proposal, propose, turn, WIDE_GOVERNOR, workerStep } from "./coordinator-test-support.ts";
import { choice, requesting } from "./decision-test-support.ts";
import { scriptByRole } from "./gate-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "rm -rf build" } };

/** Everything a settled boundary must hold exactly once. */
function boundary(h: RuntimeHarness, invocation: Invocation) {
  const attempts = h.stores.invocations.listAttempts(invocation.id);
  const current = h.stores.invocations.get(invocation.id);
  return {
    attempts: attempts.map((a) => [a.number, a.status, a.failureClass, a.retryDecision?.reason ?? null]),
    invocation: [current.status, current.blockedByDecisionId, current.failureReason, current.result?.status ?? null],
    reservations: h.stores.reservations.listByChild({ type: "invocation", id: invocation.id }).map((r) => r.status),
    leases: h.governor.status().activeLeases,
    usage: h.stores.usage.totalsForInvocation(invocation.id).rows,
    cleanup: current.workspaceCleanup,
    tasks: current.taskIds.map((id) => [h.stores.tasks.get(id).status, h.stores.tasks.get(id).blockReason]),
    changesets: h.stores.changesets.listByRun(invocation.runId).filter((c) => c.invocationId === invocation.id).length,
    decisions: h.stores.decisions.listByRun(invocation.runId).filter((d) => d.kind !== "budget_increase").map((d) => [d.kind, d.status]),
  };
}

describe("request_decision blocking boundary", () => {
  it("ends the Attempt and the Invocation once on the requested Decision when the provider stops as instructed, and repeated advancement changes nothing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      const seq = h.ctx.journal.lastSeq();
      h.provider.script(requesting([choice()]));
      const outcome = await h.executor.advanceInvocation(invocation.id);
      expect(outcome.kind).toBe("decision_requested");
      if (outcome.kind !== "decision_requested") return;
      expect(h.provider.requests).toHaveLength(1);
      expect(h.provider.requests[0]!.runtimeToolCalls.map((c) => c.outcome.kind)).toEqual(["accepted"]);
      // The adapter contract: the fake stopped at the accepted blocking result and reported the typed completion; its `then` never ran.
      expect(outcome.attempt).toMatchObject({ number: 1, status: "failed", failureClass: "decision_requested", retryDecision: { permitted: false, reason: "decision_requested", notBefore: null } });
      expect(outcome.attempt.failureDetail?.message).toContain(outcome.decision.id);
      expect(outcome.attempt.result).toBeNull();
      expect(outcome.decision).toMatchObject({ kind: "operator_choice", status: "open", requestedBy: { kind: "invocation", invocationId: invocation.id } });
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "blocked", blockedByDecisionId: outcome.decision.id } });
      const blocked = h.stores.invocations.get(invocation.id);
      expect(blocked).toMatchObject({ status: "blocked", blockedByDecisionId: outcome.decision.id, failureReason: null, result: null, workspaceCleanup: "released" });
      expect(blocked.endedAt).not.toBeNull();
      expect(h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]).toMatchObject({ status: "released", consumed: { attempts: 1 } });
      expect(h.governor.status().activeLeases).toEqual([]);
      expect(h.stores.usage.totalsForInvocation(invocation.id)).toMatchObject({ rows: 1, costUsd: DEFAULT_USAGE.costUsd });
      expect(h.executor.inspectInvocation(invocation.id).next).toEqual({ permitted: false, reason: "invocation_terminal", notBefore: null });
      // One transaction after the provider returned: transcript, Usage, the failed Attempt, the lease, the blocked Invocation, the reservation.
      const events = h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual(["attempt.created", "capacity_lease.granted", "attempt.started", "invocation.started", "decision.requested", "runtime_tool_call.committed", "artifact.created", "usage.recorded", "attempt.failed", "capacity_lease.released", "invocation.blocked", "budget_reservation.released", "invocation.workspace_released"]);
      // The Run waits on the Decision and nothing else exists: no successor, no retry, no second Decision.
      const pass = await h.scheduler.advanceRun(s.created.run.id);
      expect(pass.stop).toBe("waiting");
      expect(h.stores.runs.get(s.created.run.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      const before = boundary(h, invocation);
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(await h.executor.executePreparedAttempt(outcome.attempt.id)).toMatchObject({ kind: "finalized", attempt: { id: outcome.attempt.id } });
      await h.scheduler.advanceRun(s.created.run.id);
      expect(boundary(h, invocation)).toEqual(before);
      expect(h.provider.requests).toHaveLength(1);
      expect(h.stores.invocations.listByRun(s.created.run.id)).toHaveLength(1);
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "attempt.created" })).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("ignores everything a misbehaving provider does after the accepted request: a completed result, a further tool call, a throw, a failure, and an approval-required call all settle the same blocked boundary with Usage recorded once", async () => {
    const outcomes: [string, (h: RuntimeHarness) => void][] = [
      ["returns success afterward", (h) => h.provider.script(requesting([choice()], { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "kept going" } }))],
      ["attempts a second tool call", (h) => h.provider.script({ kind: "runtime_tool_calls", calls: [choice(), { tool: "request_completion", input: {} }, choice({ question: "Another?" })], then: { kind: "succeed", result: COMPLETED_RESULT }, ignoreStop: true })],
      ["throws afterward", (h) => h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "throw", error: new Error("adapter crashed after the request") }, ignoreStop: true })],
      ["fails transiently afterward", (h) => h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "transient_error", message: "overloaded" }, ignoreStop: true })],
      ["ends on an approval-required call afterward", (h) => h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } }, ignoreStop: true })],
    ];
    for (const [label, script] of outcomes) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedRuntime(h);
        const { invocation } = startRun(h, s).prepared;
        script(h);
        const outcome = await h.executor.advanceInvocation(invocation.id);
        expect(outcome.kind, label).toBe("decision_requested");
        if (outcome.kind !== "decision_requested") continue;
        expect(outcome.attempt, label).toMatchObject({ status: "failed", failureClass: "decision_requested", retryDecision: { permitted: false, reason: "decision_requested" }, result: null });
        expect(h.stores.invocations.get(invocation.id), label).toMatchObject({ status: "blocked", blockedByDecisionId: outcome.decision.id, result: null });
        // A thrown adapter reports no Usage; every response is charged exactly once.
        expect(h.stores.usage.totalsForInvocation(invocation.id).rows, label).toBe(label === "throws afterward" ? 0 : 1);
        expect(h.stores.changesets.listByRun(s.created.run.id), label).toEqual([]);
        // Exactly one Decision was requested; the later calls were refused as the ended turn's, and no approval Decision or call Artifact exists.
        expect(h.stores.decisions.listByRun(s.created.run.id).map((d) => d.kind), label).toEqual(["operator_choice"]);
        expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === "application/x-tool-call+json"), label).toEqual([]);
        const later = h.provider.requests[0]!.runtimeToolCalls.slice(1).map((c) => (c.outcome.kind === "rejected" ? c.outcome.reasons[0]!.code : c.outcome.kind));
        if (label === "attempts a second tool call") expect(later).toEqual(["turn_ended", "decision_already_requested"]);
        expect(h.executor.inspectInvocation(invocation.id).next, label).toEqual({ permitted: false, reason: "invocation_terminal", notBefore: null });
        expect(h.governor.status().activeLeases, label).toEqual([]);
        expect(canonicalJson(h.ctx.journal.read({ runId: s.created.run.id })), label).not.toContain("kept going");
      } finally {
        h.close();
      }
    }
  });

  it("blocks a Worker's Task on the requested Decision and lets independent nodes advance while the Run stays running", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const scoped = coordinatorNode(h, s, { leaves: 2, bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } });
      await finishRoot(h, s);
      // The Coordinator proposes two Tasks; the first Worker requests a Decision, the second completes.
      const requestingWorker = requesting([choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [scoped.node.id] } })]);
      const firstTaskId = () => h.stores.tasks.listByPlanNode(scoped.node.id).sort((a, b) => (a.id < b.id ? -1 : 1))[0]!.id;
      const worker: FakeStep = { kind: "derived", step: (request) => (h.stores.invocations.get(request.invocationId).taskIds[0] === firstTaskId() ? requestingWorker : workerStep(h, { summary: "b", diff: "+b" })) };
      scriptByRole(h, { coordinator: [turn([propose([proposal({ key: "a", requirementIds: [scoped.leafIds[0]!] }), proposal({ key: "b", requirementIds: [scoped.leafIds[1]!] })])])], worker: [worker, worker] });
      for (let i = 0; i < 6; i += 1) await h.scheduler.advanceRun(runId, { maxActions: 3 });
      const tasks = h.stores.tasks.listByPlanNode(scoped.node.id).sort((a, b) => (a.id < b.id ? -1 : 1));
      const blockedWorker = h.stores.invocations.listByPlanNode(scoped.node.id).find((i) => i.status === "blocked")!;
      expect(blockedWorker).toBeDefined();
      const decision = h.stores.decisions.get(blockedWorker.blockedByDecisionId!);
      expect(decision).toMatchObject({ kind: "operator_choice", status: "open", requestedBy: { kind: "invocation", invocationId: blockedWorker.id } });
      const other = tasks.find((t) => t.id !== blockedWorker.taskIds[0])!;
      expect(h.stores.tasks.get(blockedWorker.taskIds[0]!)).toMatchObject({ status: "blocked", blockReason: { kind: "decision", decisionId: decision.id } });
      expect(h.stores.tasks.get(other.id).status).toBe("completed");
      // One blocked Worker holds nothing else back: the other Task completed and the node stays running until only the Decision remains.
      const final = await h.scheduler.advanceRun(runId);
      expect(final.stop).toBe("waiting");
      expect(h.stores.plans.getNode(scoped.node.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.invocations.listByPlanNode(scoped.node.id).filter((i) => i.role === "worker")).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("converges after a restart: an Attempt that died after committing its request ends interrupted with a refused retry and the Invocation blocked, without another provider call", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      // The provider hangs after the accepted request: the process "dies" with the Attempt running.
      h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "hang" }, ignoreStop: true });
      const prepared = await h.executor.prepareNextAttempt(invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const executing = h.executor.executePreparedAttempt(prepared.attempt.id);
      for (let i = 0; i < 50 && h.stores.runtimeToolCalls.listByInvocation(invocation.id).length === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const request = h.stores.runtimeToolCalls.listByInvocation(invocation.id)[0]!;
      expect(request.tool).toBe("request_decision");
      // A second process recovers over the same rows.
      const reopened = openRuntimeHarness({ base: h, governor: WIDE_GOVERNOR });
      const report = reopened.recovery.recover();
      expect(report.interruptedAttemptIds).toEqual([prepared.attempt.id]);
      expect(report.retryEligible).toEqual([]);
      expect(report.failedInvocationIds).toEqual([]);
      const decisionId = request.result.tool === "request_decision" ? request.result.decisionId : null;
      expect(reopened.stores.invocations.getAttempt(prepared.attempt.id)).toMatchObject({ status: "interrupted", retryDecision: { permitted: false, reason: "decision_requested" } });
      expect(reopened.stores.invocations.get(invocation.id)).toMatchObject({ status: "blocked", blockedByDecisionId: decisionId });
      expect(reopened.stores.decisions.get(decisionId!).status).toBe("open");
      expect(reopened.provider.requests).toHaveLength(0);
      expect(await reopened.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      // The first process's hung provider is released; its late finalization finds the Attempt already terminal and repeats nothing.
      h.executor.interrupt(prepared.attempt.id, "cancelled");
      await executing;
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect(h.stores.invocations.get(invocation.id).status).toBe("blocked");
    } finally {
      h.close();
    }
  });
});
