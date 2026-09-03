/**
 * Restart and concurrency of agent-requested Decisions (execution-model
 * §8.2, §14; invariants 5, 6, 20, 22): every crash window converges from
 * canonical rows alone, over a file-backed database opened by successive
 * processes — and by two connections at once — without a duplicated
 * Decision, runtime-tool call, Attempt, Invocation, Task transition,
 * reservation, workspace release, Requirement status change, or provider
 * execution.
 *
 * Windows: (1) crash before the Decision and its call commit; (2) crash
 * after the commit, before the tool response reaches the provider; (3)
 * crash after the response, before the provider returns; (4) the provider
 * returns after the blocking commit; (5) crash before Attempt settlement;
 * (6) Attempt and Invocation settlement are one transaction; (7) crash
 * after the Invocation blocked, before its workspace release; (8) crash
 * after the operator's resolution, before a scheduler pass; (9) crash
 * during continuation preparation; (10) crash after the successor commit,
 * before its provider call; (11) the runtime default resolution racing the
 * operator; (12) the waiver resolution / status-change boundary; (13) a
 * capacity-blocked continuation across reopen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvocationId, RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET } from "../persistence/test-support.ts";
import { choice, requesting, waiver } from "./decision-test-support.ts";
import { competitor, newWorld as worldAt, openProcess, withProcess as withProcessOver, type World } from "./recovery-test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** A World in a fresh temporary directory. */
function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return worldAt(dir, path.join(dir, "console.db"));
}

const removeWorld = (w: World) => fs.rmSync(w.dir, { recursive: true, force: true });

/** A process over the World whose injected failures (vitest spies) are restored when it ends. */
const withProcess = <T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}) => withProcessOver(w, body, { ...options, after: () => vi.restoreAllMocks() });

interface DecisionWorld extends World {
  /** The first root Orchestrator Invocation, prepared by the Run start. */
  invocationId: InvocationId;
  requirementId: string;
}

/** A world whose first process seeded a Run and prepared its first root turn. */
async function requestingWorld(prefix: string, overrides: Parameters<typeof seedRuntime>[1] = {}): Promise<DecisionWorld> {
  const w = newWorld(prefix) as DecisionWorld;
  await withProcess(w, (h) => {
    const s = seedRuntime(h, overrides);
    w.runId = s.created.run.id;
    w.nodeId = h.stores.plans.rootNode(s.created.run.id).id;
    w.requirementId = s.completion.requirementId;
    w.invocationId = startRun(h, s).prepared.invocation.id;
  }, { recover: false });
  return w;
}

/** Everything a repeated request, settlement, resolution, or continuation could duplicate, from rows alone. */
function facts(h: RuntimeHarness, runId: RunId) {
  const invocations = h.stores.invocations.listByRun(runId);
  const run = h.stores.runs.get(runId);
  return {
    decisions: h.stores.decisions.listByRun(runId).map((d) => [d.id, d.kind, d.status, d.resolution?.chosenOptionId ?? null, d.resolution?.resolvedBy ?? null, d.supersessionReason]),
    calls: invocations.flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).map((c) => [i.id, c.tool, c.callDigest, c.attemptId])),
    invocations: invocations.map((i) => [i.id, i.purpose, i.status, i.blockedByDecisionId, i.continuedFromInvocationId, i.workspaceCleanup, i.taskIds]),
    attempts: invocations.flatMap((i) => h.stores.invocations.listAttempts(i.id).map((a) => [a.id, a.number, a.status, a.failureClass, a.retryDecision?.reason ?? null])),
    tasks: h.stores.tasks.listByRun(runId).map((t) => [t.id, t.status, t.blockReason]),
    reservations: invocations.flatMap((i) => h.stores.reservations.listByChild({ type: "invocation", id: i.id }).map((r) => [r.id, r.status])),
    extensions: h.stores.allocationExtensions.listByRun(runId).map((e) => [e.id, e.trigger]),
    usage: h.stores.usage.totalsForRun(runId).rows,
    requirements: h.stores.requirements.listByConversation(run.conversationId).map((r) => [r.id, r.status, h.stores.requirements.history(r.id).length]),
    nodes: h.stores.plans.listNodes(runId).map((n) => [n.id, n.status, n.waitReason]),
    run: [run.status, run.waitReason],
    leases: h.governor.status().activeLeases,
    events: h.ctx.journal.read({ runId }).map((e) => e.type),
  };
}

/** Yields until `ready` holds (the fake provider works asynchronously), or fails after a bounded number of turns. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

/** The one blocked-boundary shape every settled window converges to. */
function expectBlocked(h: RuntimeHarness, w: DecisionWorld, attemptStatuses: string[]) {
  const f = facts(h, w.runId);
  expect(f.decisions).toHaveLength(1);
  expect(f.decisions[0]![2]).toBe("open");
  expect(f.calls).toHaveLength(1);
  expect(f.invocations).toHaveLength(1);
  expect(f.invocations[0]).toMatchObject([w.invocationId, expect.any(String), "blocked", f.decisions[0]![0], null, "released", []]);
  expect(f.attempts.map((a) => a[2])).toEqual(attemptStatuses);
  expect(f.attempts.at(-1)![4]).toBe("decision_requested");
  expect(f.reservations.map((r) => r[1])).toEqual(["released"]);
  expect(f.leases).toEqual([]);
  expect(f.events.filter((e) => e === "decision.requested")).toHaveLength(1);
  expect(f.events.filter((e) => e === "invocation.blocked")).toHaveLength(1);
  expect(f.events.filter((e) => e === "invocation.workspace_released")).toHaveLength(1);
  return f;
}

describe("decision request recovery", () => {
  it("converges when the process dies before the Decision and its call commit: nothing persisted, the Attempt interrupted and retried, then exactly one Decision (window 1)", async () => {
    const w = await requestingWorld("agentique-decision-w1-");
    try {
      await withProcess(w, async (h) => {
        const append = h.ctx.journal.append.bind(h.ctx.journal);
        vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
          if (input.type === "decision.requested") throw new Error("injected: died before the Decision commit");
          return append(input);
        });
        h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "hang" }, ignoreStop: true });
        void h.executor.advanceInvocation(w.invocationId).catch(() => {});
        await until(() => (h.provider.requests[0]?.runtimeToolCalls.length ?? 0) === 1);
        expect(h.provider.requests[0]!.runtimeToolCalls[0]!.outcome.kind).toBe("failed");
        const f = facts(h, w.runId);
        expect(f.decisions).toEqual([]);
        expect(f.calls).toEqual([]);
        expect(f.attempts.map((a) => a[2])).toEqual(["running"]);
        // The process dies with the provider hung.
      });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.interruptedAttemptIds).toHaveLength(1);
        expect(report.retryEligible.map((r) => r.invocationId)).toEqual([w.invocationId]);
        expect(facts(h, w.runId).decisions).toEqual([]);
        h.provider.script(requesting([choice()]));
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        expectBlocked(h, w, ["interrupted", "failed"]);
        expect(h.provider.requests).toHaveLength(1);
      }, { recover: false });
      const after = await withProcess(w, (h) => facts(h, w.runId));
      await withProcess(w, async (h) => {
        h.recovery.recover();
        await h.scheduler.advanceRun(w.runId);
        expect(facts(h, w.runId)).toEqual({ ...after, run: ["waiting", "decision"], events: [...after.events, "run.waiting"] });
        expect(h.provider.requests).toHaveLength(0);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("converges when the process dies after the commit — before the tool response, or after it before the provider returns: one interrupted Attempt, the Invocation blocked, no second provider call (windows 2 and 3)", async () => {
    for (const window of ["before the response", "after the response"] as const) {
      const w = await requestingWorld("agentique-decision-w23-");
      try {
        await withProcess(w, async (h) => {
          h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: window === "before the response" ? { kind: "hang" } : { kind: "delay", key: "w3", then: { kind: "succeed", result: COMPLETED_RESULT } }, ignoreStop: true });
          void h.executor.advanceInvocation(w.invocationId).catch(() => {});
          await until(() => window === "before the response" ? h.provider.requests[0]?.runtimeToolCalls[0]?.outcome.kind === "accepted" : h.provider.delayedKeys.includes("w3"));
          const f = facts(h, w.runId);
          expect(f.decisions.map((d) => d[2]), window).toEqual(["open"]);
          expect(f.attempts.map((a) => a[2]), window).toEqual(["running"]);
          expect(f.invocations[0]![2], window).toBe("running");
        });
        for (let reopen = 0; reopen < 2; reopen += 1) {
          await withProcess(w, async (h) => {
            const report = h.recovery.recover();
            expect(report.interruptedAttemptIds, window).toHaveLength(reopen === 0 ? 1 : 0);
            expect(report.retryEligible, window).toEqual([]);
            expect(report.failedInvocationIds, window).toEqual([]);
            const f = expectBlocked(h, w, ["interrupted"]);
            expect(f.usage, window).toBe(0);
            expect((await h.scheduler.advanceRun(w.runId)).stop, window).toBe("waiting");
            expect(h.stores.runs.get(w.runId), window).toMatchObject({ status: "waiting", waitReason: "decision" });
            expect(h.provider.requests, window).toHaveLength(0);
          }, { recover: false });
        }
      } finally {
        removeWorld(w);
      }
    }
  });

  it("keeps the boundary when the provider returns a result after the blocking commit, and a reopen changes nothing (window 4)", async () => {
    const w = await requestingWorld("agentique-decision-w4-");
    try {
      const first = await withProcess(w, async (h) => {
        h.provider.script({ kind: "runtime_tool_calls", calls: [choice()], then: { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "ignored" } }, ignoreStop: true });
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        const f = expectBlocked(h, w, ["failed"]);
        expect(f.usage).toBe(1);
        expect(h.stores.changesets.listByRun(w.runId)).toEqual([]);
        return f;
      });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.interruptedAttemptIds).toEqual([]);
        expect(report.workspaceReleasedInvocationIds).toEqual([]);
        expect(facts(h, w.runId)).toEqual(first);
        await h.scheduler.advanceRun(w.runId);
        expect(h.provider.requests).toHaveLength(0);
        expect(h.executionWorkspace.released).toEqual([]);
        expect(facts(h, w.runId)).toEqual({ ...first, run: ["waiting", "decision"], events: [...first.events, "run.waiting"] });
      });
    } finally {
      removeWorld(w);
    }
  });

  it("converges when the process dies before Attempt settlement, and settles the Attempt and the Invocation in one transaction or not at all (windows 5 and 6)", async () => {
    const injections: [string, (h: RuntimeHarness) => void][] = [
      ["before settlement", (h) => {
        vi.spyOn(h.stores.usage, "record").mockImplementationOnce(() => { throw new Error("injected: died before settlement"); });
      }],
      ["between the Attempt and the Invocation", (h) => {
        const transition = h.stores.invocations.transition.bind(h.stores.invocations);
        vi.spyOn(h.stores.invocations, "transition").mockImplementation((id, input, options) => {
          if (input.to === "blocked") throw new Error("injected: died after the Attempt, before the Invocation");
          return transition(id, input, options);
        });
      }],
    ];
    for (const [window, inject] of injections) {
      const w = await requestingWorld("agentique-decision-w56-");
      try {
        await withProcess(w, async (h) => {
          inject(h);
          h.provider.script(requesting([choice()]));
          await expect(h.executor.advanceInvocation(w.invocationId)).rejects.toThrow(/injected/);
          // The Decision and its call committed in the call's own transaction; the settlement rolled back whole: no failed Attempt beside a running Invocation.
          const f = facts(h, w.runId);
          expect(f.decisions.map((d) => d[2]), window).toEqual(["open"]);
          expect(f.calls, window).toHaveLength(1);
          expect(f.attempts.map((a) => a[2]), window).toEqual(["running"]);
          expect(f.invocations[0]![2], window).toBe("running");
          expect(f.usage, window).toBe(0);
          expect(f.events.filter((e) => e === "attempt.failed" || e === "invocation.blocked"), window).toEqual([]);
        });
        await withProcess(w, async (h) => {
          const report = h.recovery.recover();
          expect(report.interruptedAttemptIds, window).toHaveLength(1);
          expect(report.retryEligible, window).toEqual([]);
          expectBlocked(h, w, ["interrupted"]);
          await h.scheduler.advanceRun(w.runId);
          expect(h.provider.requests, window).toHaveLength(0);
        }, { recover: false });
      } finally {
        removeWorld(w);
      }
    }
  });

  it("releases the blocked Invocation's workspace exactly once when the process dies after the blocking commit, before the release (window 7)", async () => {
    const w = await requestingWorld("agentique-decision-w7-");
    try {
      await withProcess(w, async (h) => {
        h.executionWorkspace.failReleaseWith = new Error("injected: died before the release");
        h.provider.script(requesting([choice()]));
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        const f = facts(h, w.runId);
        expect(f.invocations[0]![5]).toBe("pending");
        expect(f.events.filter((e) => e === "invocation.workspace_released")).toEqual([]);
      });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.workspaceReleasedInvocationIds).toEqual([w.invocationId]);
        expect(report.interruptedAttemptIds).toEqual([]);
        expect(h.executionWorkspace.released).toHaveLength(1);
        expectBlocked(h, w, ["failed"]);
      }, { recover: false });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.workspaceReleasedInvocationIds).toEqual([]);
        expect(h.executionWorkspace.released).toEqual([]);
        expectBlocked(h, w, ["failed"]);
        h.executor.releaseWorkspace(w.invocationId);
        expect(h.executionWorkspace.released).toEqual([]);
      }, { recover: false });
    } finally {
      removeWorld(w);
    }
  });

  it("continues exactly once across restarts after the resolution, through a failed or interrupted preparation, and from a committed successor not yet executed (windows 8, 9, and 10)", async () => {
    const w = await requestingWorld("agentique-decision-w8-");
    try {
      // Window 8: the operator resolves; the process dies before any scheduler pass.
      const decisionId = await withProcess(w, async (h) => {
        h.provider.script(requesting([choice()]));
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        await h.scheduler.advanceRun(w.runId);
        const id = h.stores.invocations.get(w.invocationId).blockedByDecisionId!;
        expect(h.decisionRequests.resolve({ decisionId: id, optionId: "express" })).toMatchObject({ kind: "resolved", replayed: false });
        expect(facts(h, w.runId).invocations).toHaveLength(1);
        return id;
      });
      // Window 9: the continuation's preparation fails at the Invocation Event, then at COMMIT: nothing of the successor persists.
      for (const failure of ["event", "commit"] as const) {
        await withProcess(w, async (h) => {
          if (failure === "event") {
            const append = h.ctx.journal.append.bind(h.ctx.journal);
            vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
              if (input.type === "invocation.created") throw new Error("injected: died preparing the successor");
              return append(input);
            });
          } else {
            const exec = h.ctx.sqlite.exec.bind(h.ctx.sqlite);
            const spy = vi.spyOn(h.ctx.sqlite, "exec").mockImplementation((sql: string) => {
              if (sql === "COMMIT") {
                spy.mockRestore();
                throw new Error("injected: COMMIT failed");
              }
              return exec(sql);
            });
          }
          const pass = await h.scheduler.advanceRun(w.runId);
          expect(pass.stop, failure).toBe("infrastructure_failure");
          const f = facts(h, w.runId);
          expect(f.invocations, failure).toHaveLength(1);
          expect(f.decisions.map((d) => d[2]), failure).toEqual(["resolved"]);
          expect(f.events.filter((e) => e === "invocation.created"), failure).toHaveLength(1);
          expect(h.stores.plans.getNode(w.nodeId).status, failure).toBe("running");
        });
      }
      // Window 10: the successor commits; the process dies before its provider call.
      const prepared = await withProcess(w, async (h) => {
        // The failed passes already resumed the Run; only the continuation remains before the successor's execution.
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["continue_decision_request", "successor_prepared"]]);
        expect(h.provider.requests).toHaveLength(0);
        const f = facts(h, w.runId);
        expect(f.invocations).toHaveLength(2);
        expect(f.invocations[1]).toMatchObject([expect.any(String), f.invocations[0]![1], "pending", null, w.invocationId, "pending", []]);
        return f;
      });
      await withProcess(w, async (h) => {
        const report = h.recovery.recover();
        expect(report.interruptedAttemptIds).toEqual([]);
        expect(facts(h, w.runId)).toEqual(prepared);
        // Another pass prepares no second successor; the one successor executes once and completes.
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await h.scheduler.advanceRun(w.runId);
        const f = facts(h, w.runId);
        expect(f.invocations).toHaveLength(2);
        expect(f.invocations[1]![2]).toBe("succeeded");
        expect(f.attempts.filter((a) => a[0] !== f.attempts[0]![0])).toHaveLength(1);
        expect(h.provider.requests).toHaveLength(1);
        expect(f.decisions).toEqual([[decisionId, "operator_choice", "resolved", "express", "operator", null]]);
        expect(f.events.filter((e) => e === "decision.resolved")).toHaveLength(1);
        expect(f.events.filter((e) => e === "invocation.created")).toHaveLength(2);
      });
      const settled = await withProcess(w, (h) => facts(h, w.runId));
      await withProcess(w, async (h) => {
        h.recovery.recover();
        await h.scheduler.advanceRun(w.runId);
        expect(facts(h, w.runId)).toEqual(settled);
        expect(h.provider.requests).toHaveLength(0);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("lets the runtime default and the operator race over one database with exactly one resolution (window 11)", async () => {
    const w = await requestingWorld("agentique-decision-w11-");
    const a = openProcess(w);
    let b: RuntimeHarness | null = null;
    try {
      a.provider.script(requesting([choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: w.nodeId } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [w.nodeId] } })]));
      expect((await a.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
      const decisionId = a.stores.invocations.get(w.invocationId).blockedByDecisionId!;
      b = competitor(w);
      const rival = b;
      expect(a.decisionRequests.due(w.runId, a.clock.now()).map((d) => d.id)).toEqual([decisionId]);
      // While the default resolution holds the write lock the operator's transaction cannot begin; afterwards it conflicts or replays.
      const resolved = a.ctx.tx.write(() => {
        const outcome = a.decisionRequests.resolveDefault(decisionId, a.clock.now());
        expect(() => rival.decisionRequests.resolve({ decisionId, optionId: "express" })).toThrow(/SQLITE_BUSY|database is locked/);
        return outcome;
      });
      expect(resolved).toEqual({ kind: "resolved", decisionId, chosenOptionId: "fastify" });
      expect(() => rival.decisionRequests.resolve({ decisionId, optionId: "express" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      expect(rival.decisionRequests.resolve({ decisionId, optionId: "fastify" })).toEqual({ kind: "resolved", decisionId, chosenOptionId: "fastify", resolvedBy: "policy:use_default_after_deadline", replayed: true });
      expect(rival.decisionRequests.resolveDefault(decisionId, rival.clock.now())).toEqual({ kind: "no_change", reason: "not_open" });
      expect(rival.ctx.journal.read({ runId: w.runId, type: "decision.resolved" })).toHaveLength(1);
      expect(facts(a, w.runId)).toEqual(facts(rival, w.runId));
      // The reverse order: the operator first, then the scheduler's action finds nothing to do.
      const other = await requestingWorld("agentique-decision-w11b-");
      try {
        await withProcess(other, async (h) => {
          h.provider.script(requesting([choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: other.nodeId } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [other.nodeId] } })]));
          expect((await h.executor.advanceInvocation(other.invocationId)).kind).toBe("decision_requested");
          const id = h.stores.invocations.get(other.invocationId).blockedByDecisionId!;
          expect(h.scheduler.reconcileRun(other.runId).actions[0]).toEqual({ kind: "resolve_decision_default", decisionId: id });
          h.decisionRequests.resolve({ decisionId: id, optionId: "express" });
          const pass = await h.scheduler.advanceRun(other.runId, { maxActions: 1 });
          expect(pass.actions.map((p) => p.outcome.kind)).not.toContain("transitioned");
          expect(h.ctx.journal.read({ runId: other.runId, type: "decision.resolved" })).toHaveLength(1);
          expect(h.stores.decisions.get(id).resolution).toMatchObject({ resolvedBy: "operator", chosenOptionId: "express" });
        });
      } finally {
        removeWorld(other);
      }
    } finally {
      b?.close();
      a.close();
      removeWorld(w);
    }
  });

  it("writes a waiver's resolution and the Requirement's status change together or not at all, and reopens with exactly one of each (window 12)", async () => {
    const w = await requestingWorld("agentique-decision-w12-");
    try {
      const decisionId = await withProcess(w, async (h) => {
        h.provider.script(requesting([waiver(w.requirementId as never)]));
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        await h.scheduler.advanceRun(w.runId);
        const id = h.stores.invocations.get(w.invocationId).blockedByDecisionId!;
        vi.spyOn(h.stores.requirements, "recordStatusChange").mockImplementationOnce(() => { throw new Error("injected: died after the resolution, before the status change"); });
        expect(() => h.decisionRequests.resolve({ decisionId: id, optionId: "waive", rationale: "acceptable" })).toThrow(/injected/);
        const f = facts(h, w.runId);
        expect(f.decisions.map((d) => d[2])).toEqual(["open"]);
        expect(f.requirements.find((r) => r[0] === w.requirementId)).toEqual([w.requirementId, "open", 0]);
        expect(f.events.filter((e) => e === "decision.resolved" || e === "requirement.status_changed")).toEqual([]);
        return id;
      });
      const resolved = await withProcess(w, async (h) => {
        expect(h.decisionRequests.resolve({ decisionId, optionId: "waive", rationale: "acceptable" })).toMatchObject({ kind: "resolved", chosenOptionId: "waive", replayed: false });
        const f = facts(h, w.runId);
        expect(f.requirements.find((r) => r[0] === w.requirementId)).toEqual([w.requirementId, "waived", 1]);
        expect(f.events.filter((e) => e === "decision.resolved" || e === "requirement.status_changed")).toEqual(["decision.resolved", "requirement.status_changed"]);
        return f;
      });
      await withProcess(w, async (h) => {
        h.recovery.recover();
        expect(facts(h, w.runId)).toEqual(resolved);
        expect(h.decisionRequests.resolve({ decisionId, optionId: "waive", rationale: "again" })).toMatchObject({ kind: "resolved", replayed: true });
        expect(facts(h, w.runId)).toEqual(resolved);
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await h.scheduler.advanceRun(w.runId);
        const f = facts(h, w.runId);
        expect(f.invocations).toHaveLength(2);
        expect(f.invocations[1]).toMatchObject([expect.any(String), f.invocations[0]![1], "succeeded", null, w.invocationId, "released", []]);
        const input = h.stores.invocations.getManifest(f.invocations[1]![0] as InvocationId).content.inputs.find((i) => i.kind === "decision_resolution");
        expect(input).toMatchObject({ decisionKind: "requirement_waiver", status: "resolved", waiver: { requirementId: w.requirementId, outcome: "waived" } });
        expect(f.requirements.find((r) => r[0] === w.requirementId)).toEqual([w.requirementId, "waived", 1]);
        expect(h.provider.requests).toHaveLength(1);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("holds a capacity-blocked continuation across reopen without duplicating it, then prepares it once after a Budget Increase (window 13)", async () => {
    const w = await requestingWorld("agentique-decision-w13-", { orchestratorAllocation: INVOCATION_ALLOCATION, finalReserve: { costUsd: 0, tokens: 0, attempts: 0 }, budget: { ...DEFAULT_BUDGET, maxAttempts: INVOCATION_ALLOCATION.attempts } });
    try {
      const waiting = await withProcess(w, async (h) => {
        h.provider.script(requesting([choice()]));
        expect((await h.executor.advanceInvocation(w.invocationId)).kind).toBe("decision_requested");
        await h.scheduler.advanceRun(w.runId);
        h.decisionRequests.resolve({ decisionId: h.stores.invocations.get(w.invocationId).blockedByDecisionId!, optionId: "fastify" });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        const f = facts(h, w.runId);
        expect(f.run).toEqual(["waiting", "budget"]);
        expect(f.invocations).toHaveLength(1);
        expect(f.extensions).toEqual([]);
        return f;
      });
      for (let reopen = 0; reopen < 2; reopen += 1) {
        await withProcess(w, async (h) => {
          h.recovery.recover();
          expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([]);
          expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
          expect(facts(h, w.runId)).toEqual(waiting);
          expect(h.provider.requests).toHaveLength(0);
        });
      }
      const prepared = await withProcess(w, async (h) => {
        const increase = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: INVOCATION_ALLOCATION.attempts } }).decision;
        expect(h.budgetIncreases.resolve({ runId: w.runId, decisionId: increase.id, option: "approve" }).kind).toBe("approved");
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 2 });
        expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
        const f = facts(h, w.runId);
        expect(f.invocations).toHaveLength(2);
        expect(f.extensions.map((e) => e[1])).toEqual(["root_turn"]);
        return f;
      });
      await withProcess(w, async (h) => {
        h.recovery.recover();
        expect(facts(h, w.runId)).toEqual(prepared);
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await h.scheduler.advanceRun(w.runId);
        const f = facts(h, w.runId);
        expect(f.invocations).toHaveLength(2);
        expect(f.invocations[1]![2]).toBe("succeeded");
        expect(f.extensions).toHaveLength(1);
        expect(h.provider.requests).toHaveLength(1);
      });
    } finally {
      removeWorld(w);
    }
  });
});
