/**
 * Operator control under concurrency (execution-model §14): every race is
 * driven by deterministic provider and check barriers — never a sleep — and
 * both valid orderings are asserted where two exist. Control intent is
 * durable before its delivery; every boundary revalidates the Run row; a
 * stale projection performs nothing; repeated, lost, and retried control
 * requests converge to the same rows with one Event and one interruption
 * each.
 */
import { describe, expect, it } from "vitest";
import { completionGatesOf, requestingStep, synthesisStep } from "./completion-test-support.ts";
import { scriptByRole } from "./gate-test-support.ts";
import { attemptsOf, delayed, eventsAfter, executing, invocationOf, planned, single, until, work } from "./run-control-test-support.ts";
import { awaitSignoff } from "./signoff-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

describe("Run control races", () => {
  it("pause vs preparation: a projection computed before the pause performs nothing; the runner and the executor revalidate the Run row and create nothing; the resume performs the work once", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes, revisionNumber } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      const stale = h.scheduler.reconcileRun(runId);
      expect(stale.actions.map((x) => x.kind)).toEqual(["settle_root", "ready_node"]);
      h.stores.plans.transitionNode(a.id, { to: "ready" });
      const before = work(h, runId);
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", status: "waiting" });
      // The pass re-projects under the pause and performs nothing; the stale projection's actions are never applied.
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [], waiting: [{ reason: "operator" }] });
      // The runner's own transaction refuses the stale start of the ready node.
      expect(h.runners.single.start(a.id, revisionNumber)).toMatchObject({ kind: "not_admitted", status: "waiting", operatorPause: "soft" });
      expect(h.stores.invocations.listByPlanNode(a.id)).toEqual([]);
      expect(work(h, runId)).toMatchObject({ invocations: before.invocations, attempts: before.attempts, events: before.events + 2 });
      // Resumed: the work happens exactly once.
      h.runControl.resume({ runId });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(h.stores.invocations.listByPlanNode(a.id)).toHaveLength(1);
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("cancel vs provider completion, both orders: completion first keeps the succeeded step and cancels the rest; cancellation first ends the Attempt cancelled — Usage once either way", async () => {
    for (const order of ["completion first", "cancellation first"] as const) {
      const h = openRuntimeHarness();
      try {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        const a = nodes[0]!;
        h.provider.script(delayed("a"));
        const { pass } = await executing(h, runId, ["a"]);
        const invocation = invocationOf(h, a);
        if (order === "completion first") {
          h.provider.release("a");
          await until(() => h.stores.plans.getNode(a.id).status === "succeeded");
          expect((await pass).stop).toBe("quiescent");
          expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", interruptedAttemptIds: [], executingAttemptIds: [] });
          expect(attemptsOf(h, invocation.id), order).toEqual([[1, "succeeded", null]]);
          expect(h.stores.plans.getNode(a.id).status, order).toBe("succeeded");
        } else {
          expect(h.runControl.cancel({ runId }).interruptedAttemptIds).toHaveLength(1);
          expect((await pass).stop).toBe("run_terminal");
          expect(attemptsOf(h, invocation.id), order).toEqual([[1, "cancelled", false]]);
          expect(h.stores.plans.getNode(a.id).status, order).toBe("cancelled");
        }
        expect(h.stores.runs.get(runId).status, order).toBe("cancelled");
        expect(h.stores.plans.rootNode(runId).status, order).toBe("cancelled");
        expect(h.stores.usage.listByAttempt(h.stores.invocations.listAttempts(invocation.id)[0]!.id), order).toHaveLength(1);
        expect(h.stores.invocations.listByPlanNode(a.id), order).toHaveLength(1);
        expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      } finally {
        h.close();
      }
    }
  });

  it("hard pause vs provider completion, both orders: completion first keeps the result unsettled until the resume; pause first interrupts and the resume retries — one Invocation either way", async () => {
    for (const order of ["completion first", "pause first"] as const) {
      const h = openRuntimeHarness();
      try {
        const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
        const a = nodes[0]!;
        h.provider.script(delayed("a"));
        const { pass } = await executing(h, runId, ["a"]);
        const invocation = invocationOf(h, a);
        if (order === "completion first") {
          // The Attempt completes and its settlement's external integration is under way when the pause lands: the integration that
          // started finishes (nothing finished is lost), the settlement's transaction refuses, and the node stays running until the resume.
          let openGate!: () => void;
          h.integrationWorkspace.gate = new Promise<void>((resolve) => {
            openGate = resolve;
          });
          h.provider.release("a");
          await until(() => h.integrationWorkspace.requests.some((r) => r.changesetId === h.stores.changesets.listByRun(runId).find((c) => c.invocationId === invocation.id)?.id));
          expect(h.stores.invocations.get(invocation.id).status).toBe("succeeded");
          expect(h.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "paused", interruptedAttemptIds: [] });
          h.integrationWorkspace.gate = null;
          openGate();
          expect((await pass).stop, order).toBe("waiting");
          expect(attemptsOf(h, invocation.id), order).toEqual([[1, "succeeded", null]]);
          expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === invocation.id).map((c) => c.integrationStatus), order).toEqual(["integrated"]);
          expect(h.stores.plans.getNode(a.id).status, order).toBe("running");
          h.runControl.resume({ runId });
        } else {
          expect(h.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
          expect((await pass).stop).toBe("waiting");
          expect(attemptsOf(h, invocation.id), order).toEqual([[1, "interrupted", true]]);
          h.runControl.resume({ runId });
          h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        }
        expect((await h.scheduler.advanceRun(runId)).stop, order).toBe("quiescent");
        expect(h.stores.plans.getNode(a.id).status, order).toBe("succeeded");
        expect(h.stores.invocations.listByPlanNode(a.id), order).toHaveLength(1);
        expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === invocation.id).map((c) => c.integrationStatus), order).toEqual(["integrated"]);
      } finally {
        h.close();
      }
    }
  });

  it("pause and resume vs a stale projection: a projected execution refused under the pause is performed after the resume without a duplicate", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes, revisionNumber } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      h.stores.plans.transitionNode(a.id, { to: "ready" });
      const started = h.runners.single.start(a.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const stale = h.scheduler.reconcileRun(runId);
      expect(stale.actions.some((x) => x.kind === "execute_invocation" && x.invocationId === started.invocationId)).toBe(true);
      h.runControl.pause({ runId, mode: "hard" });
      expect(await h.executor.prepareNextAttempt(started.invocationId)).toMatchObject({ kind: "not_permitted", reason: "run_paused" });
      expect(h.runners.single.resume(a.id, revisionNumber)).toMatchObject({ kind: "not_admitted" });
      expect(h.stores.invocations.listAttempts(started.invocationId)).toEqual([]);
      h.runControl.resume({ runId });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect((await h.scheduler.advanceRun(runId)).stop).toBe("quiescent");
      expect(attemptsOf(h, started.invocationId)).toEqual([[1, "succeeded", null]]);
      expect(h.stores.invocations.listByPlanNode(a.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("repeated, lost, and retried control requests converge: one Event and one interruption each, whatever the repetition", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      h.provider.script(delayed("a"));
      const { pass } = await executing(h, runId, ["a"]);
      const [attemptId] = h.executor.inFlightOf(runId);
      const seq = h.ctx.journal.lastSeq();
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused" });
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "unchanged", interruptedAttemptIds: [] });
      expect(h.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "escalated", interruptedAttemptIds: [attemptId] });
      // The response of the hard pause is lost and the request retried: the interruption is not delivered twice.
      expect(h.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "unchanged", interruptedAttemptIds: [], executingAttemptIds: [attemptId] });
      expect((await pass).stop).toBe("waiting");
      expect(h.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "unchanged", interruptedAttemptIds: [], executingAttemptIds: [] });
      expect(h.provider.requests.filter((r) => r.aborted)).toHaveLength(1);
      expect(attemptsOf(h, invocationOf(h, a).id)).toEqual([[1, "interrupted", true]]);
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", cleared: "hard" });
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "not_paused", cleared: null });
      expect(eventsAfter(h, runId, seq)).toEqual(["run.paused", "run.waiting", "run.paused", "run.resumed", "run.wait_cleared"]);
      // Cancel, lose the response, retry: one cancellation Event, one convergence, nothing interrupted twice.
      const cancelSeq = h.ctx.journal.lastSeq();
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false });
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: true, converged: null });
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: true });
      expect(eventsAfter(h, runId, cancelSeq, ["run.", "plan_node.", "invocation."]).filter((t) => t === "run.cancelled")).toHaveLength(1);
      expect(h.ctx.journal.read({ runId, afterSeq: cancelSeq, type: "invocation.cancelled" })).toHaveLength(1);
      expect(h.ctx.journal.read({ runId, afterSeq: cancelSeq, type: "plan_node.cancelled" })).toHaveLength(2);
      expect(attemptsOf(h, invocationOf(h, a).id)).toEqual([[1, "interrupted", true]]);
      expect(h.stores.invocations.get(invocationOf(h, a).id).status).toBe("cancelled");
    } finally {
      h.close();
    }
  });

  it("completion and signoff advancement vs pause and cancel: a check finishing under a pause is recorded once and the Gate waits for the resume; cancelling a verifying or signoff-awaiting Run keeps its Gate and request as history", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)] });
      h.criterionExecution.script(s.completion.criterionId, { kind: "delay", key: "check", then: { kind: "exit", exitCode: 0 } });
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.criterionExecution.delayedKeys.includes("check"));
      expect(h.stores.runs.get(runId).status).toBe("verifying");
      // The pause lands while the external check runs: its outcome is recorded once; nothing after it starts until the resume.
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", status: "verifying", interruptedAttemptIds: [] });
      h.criterionExecution.release("check");
      const finished = await pass;
      expect(finished.stop).toBe("waiting");
      const [gate] = completionGatesOf(h, runId);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id).map((e) => e.verdict)).toEqual(["pass"]);
      expect(gate!.status).toBe("open");
      expect(h.stores.requirements.get(s.completion.requirementId).status).not.toBe("satisfied");
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [] });
      // Cancelled while verifying and paused: the Gate stays open and the request verifying (history); the Run ends cancelled.
      expect(h.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "cancelled", operatorPause: null });
      expect(h.stores.gates.get(gate!.id).status).toBe("open");
      expect(h.stores.completionRequests.listByRun(runId).map((r) => r.status)).toEqual(["verifying"]);
      expect(h.criterionExecution.observed).toHaveLength(1);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      expect(h.runners.completion.complete(runId)).toMatchObject({ kind: "not_admitted", status: "cancelled" });
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(g);
      g.runControl.pause({ runId, mode: "hard" });
      expect(g.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", replayed: false });
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "cancelled", operatorPause: null, finalChangesetId: null });
      expect(g.stores.gates.get(gate.id).status).toBe("open");
      expect(g.stores.decisions.get(decisionId).status).toBe("open");
      await expect(g.signoff.accept({ runId, gateId: gate.id, decisionId })).rejects.toThrow(expect.objectContaining({ refusal: "run_not_awaiting_signoff" }));
      expect(() => g.runControl.resume({ runId })).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
    } finally {
      g.close();
    }
  });
});
