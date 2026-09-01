/**
 * Operator pause and resume (execution-model §3 `waiting`/`operator`, §14
 * "Operator pauses a Run"): the state/operation matrix with its typed
 * outcomes and refusals; a soft pause that stops admission while admitted
 * Attempts drain with their Usage and results; a hard pause that interrupts
 * executing Attempts with a durable, retryable classification that keeps
 * Invocation identity, Task ownership, limits, and deadlines; the
 * prepared-but-undispatched boundary; and a resume that clears only the
 * pause and recomputes readiness from rows — across Decisions, budget
 * waits, chains, parallel items, Coordinator Workers, completion
 * verification, and signoff — without repeating finished work.
 */
import { ValidationError, type PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { seedCompletedRun, seedRun, seedRunCompletionGate, seedSignoffBoundary } from "../persistence/test-support.ts";
import { advanceUntil, completionEvaluatorsOf, completionGatesOf, reportsOf, requestingStep, signoffGatesOf, synthesesOf, synthesisStep, completionEvaluatorStep } from "./completion-test-support.ts";
import { coordinatorNode, proposal, propose, tasksOf, turn, WIDE_GOVERNOR, workersOf, workerStep } from "./coordinator-test-support.ts";
import { choice, requesting, rootPort, waiver } from "./decision-test-support.ts";
import { parallelExpression, scriptByRole, seedCriteria } from "./gate-test-support.ts";
import { activeCapacity, attemptsOf, chain, delayed, eventsAfter, executing, invocationOf, planned, single, statuses, until, work } from "./run-control-test-support.ts";
import { awaitSignoff, operatorMessage } from "./signoff-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";
import { ToolCallAuthorizer } from "./tool-call-authorization.ts";

/** A Run whose Orchestrator definition carries a short wall-clock limit. */
function seedShortLimit(h: RuntimeHarness, maxWallClockMs: number) {
  const definition = h.stores.agents.ensureDefinition("orchestrator");
  const revision = h.stores.agents.appendRevision(definition.id, {
    provenance: { kind: "builtin" },
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: "You are the orchestrator.",
    capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
    toolPolicy: { read: "allowed", write: "allowed", shell: "approval_required" },
    defaultLimits: { allocation: { costUsd: 2, tokens: 20_000, attempts: 3 }, maxWallClockMs },
  });
  return seedRuntime(h, { orchestratorAgentDefinitionRevisionId: revision.id });
}

describe("Run pause and resume: the state/operation matrix", () => {
  it("refuses created and ended Runs, pauses running/waiting/verifying/awaiting_signoff Runs with explicit outcomes for repeats and escalation, and resumes to the recomputed status", async () => {
    const h = openRuntimeHarness();
    try {
      // created: nothing to withhold.
      const created = seedRuntime(h);
      expect(() => h.runControl.pause({ runId: created.created.run.id, mode: "soft" })).toThrow(expect.objectContaining({ refusal: "not_started" }));
      expect(h.runControl.resume({ runId: created.created.run.id })).toMatchObject({ kind: "not_paused", status: "created", cleared: null });
      expect(h.stores.runs.get(created.created.run.id)).toMatchObject({ status: "created", operatorPause: null });
      // running: soft, repeated soft, escalation, soft after hard, repeated hard, resume, repeated resume.
      const running = seedRun(h);
      const seq = h.ctx.journal.lastSeq();
      expect(h.runControl.pause({ runId: running.run.id, mode: "soft" })).toEqual({ kind: "paused", runId: running.run.id, requested: "soft", mode: "soft", status: "waiting", interruptedAttemptIds: [], executingAttemptIds: [] });
      expect(h.runControl.pause({ runId: running.run.id, mode: "soft" })).toMatchObject({ kind: "unchanged", requested: "soft", mode: "soft", status: "waiting" });
      expect(h.runControl.pause({ runId: running.run.id, mode: "hard" })).toMatchObject({ kind: "escalated", requested: "hard", mode: "hard", status: "waiting" });
      expect(h.runControl.pause({ runId: running.run.id, mode: "soft" })).toMatchObject({ kind: "unchanged", requested: "soft", mode: "hard", status: "waiting" });
      expect(h.runControl.pause({ runId: running.run.id, mode: "hard" })).toMatchObject({ kind: "unchanged", requested: "hard", mode: "hard", status: "waiting" });
      expect(h.stores.runs.get(running.run.id)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "hard" });
      expect(h.scheduler.reconcileRun(running.run.id)).toMatchObject({ run: { status: "waiting", waitReason: "operator", operatorPause: "hard" }, actions: [], waiting: [{ reason: "operator", wakeAt: null }], stop: "waiting" });
      expect(await h.scheduler.advanceRun(running.run.id)).toMatchObject({ stop: "waiting", actions: [], waiting: [{ reason: "operator" }] });
      expect(h.runControl.resume({ runId: running.run.id })).toEqual({ kind: "resumed", runId: running.run.id, status: "running", cleared: "hard" });
      expect(h.runControl.resume({ runId: running.run.id })).toEqual({ kind: "not_paused", runId: running.run.id, status: "running", cleared: null });
      expect(eventsAfter(h, running.run.id, seq)).toEqual(["run.paused", "run.waiting", "run.paused", "run.resumed", "run.wait_cleared"]);
      // waiting on budget: the pause supersedes the reason; the resume recomputes it rather than restoring it.
      h.stores.runs.transition(running.run.id, { to: "waiting", waitReason: "budget" });
      expect(h.runControl.pause({ runId: running.run.id, mode: "hard" })).toMatchObject({ kind: "paused", mode: "hard", status: "waiting" });
      expect(h.stores.runs.get(running.run.id)).toMatchObject({ waitReason: "operator", operatorPause: "hard" });
      expect(h.runControl.resume({ runId: running.run.id })).toMatchObject({ kind: "resumed", status: "running", cleared: "hard" });
      expect(h.stores.runs.get(running.run.id)).toMatchObject({ status: "running", waitReason: null, operatorPause: null });
      // verifying keeps its status beside the pause.
      const verifying = seedRun(h);
      seedRunCompletionGate(h, verifying);
      h.stores.runs.transition(verifying.run.id, { to: "verifying" });
      expect(h.runControl.pause({ runId: verifying.run.id, mode: "soft" })).toMatchObject({ kind: "paused", mode: "soft", status: "verifying" });
      expect(h.scheduler.reconcileRun(verifying.run.id)).toMatchObject({ actions: [], waiting: [{ reason: "operator" }], stop: "waiting" });
      expect(h.runControl.resume({ runId: verifying.run.id })).toMatchObject({ kind: "resumed", status: "verifying", cleared: "soft" });
      // awaiting_signoff keeps its status; signoff is refused meanwhile.
      const signoff = seedRun(h);
      seedSignoffBoundary(h, signoff);
      expect(h.runControl.pause({ runId: signoff.run.id, mode: "hard" })).toMatchObject({ kind: "paused", mode: "hard", status: "awaiting_signoff" });
      expect(h.scheduler.reconcileRun(signoff.run.id)).toMatchObject({ actions: [], stop: "waiting" });
      expect(h.runControl.resume({ runId: signoff.run.id })).toMatchObject({ kind: "resumed", status: "awaiting_signoff", cleared: "hard" });
      // ended Runs: completed, failed, cancelled.
      const completed = seedRun(h);
      seedCompletedRun(h, completed);
      const failed = seedRun(h);
      h.stores.runs.transition(failed.run.id, { to: "failed", failure: { kind: "root_node_failed", summary: "root failed", evidenceArtifactIds: [] } });
      const cancelled = seedRun(h);
      h.runControl.cancel({ runId: cancelled.run.id });
      for (const runId of [completed.run.id, failed.run.id, cancelled.run.id]) {
        const before = h.stores.runs.get(runId);
        expect(() => h.runControl.pause({ runId, mode: "soft" }), before.status).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
        expect(() => h.runControl.pause({ runId, mode: "hard" }), before.status).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
        expect(() => h.runControl.resume({ runId }), before.status).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
        expect(h.stores.runs.get(runId), before.status).toEqual(before);
      }
      // Strict inputs.
      expect(() => h.runControl.pause({ runId: running.run.id, mode: "medium" as never })).toThrow(ValidationError);
      expect(() => h.runControl.resume({ runId: running.run.id, mode: "soft" } as never)).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });
});

describe("soft pause", () => {
  it("stops admission while the executing step finishes with its Usage and result, starts no next step and integrates nothing, keeps the Run paused afterwards, leaves another Run unaffected, and resumes without repeating the finished step", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { runId, nodes } = await planned(h, (s) => [chain(s, ["A0", "A1"])]);
      const node = nodes[0]!;
      h.provider.script(delayed("a0"));
      const { pass } = await executing(h, runId, ["a0"]);
      const executingIds = h.executor.inFlightOf(runId);
      const seq = h.ctx.journal.lastSeq();
      const paused = h.runControl.pause({ runId, mode: "soft" });
      expect(paused).toMatchObject({ kind: "paused", mode: "soft", status: "waiting", interruptedAttemptIds: [], executingAttemptIds: executingIds });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "soft" });
      // The admitted Attempt drains to its legitimate result; nothing else starts and nothing settles.
      h.provider.release("a0");
      const finished = await pass;
      expect(finished).toMatchObject({ stop: "waiting", waiting: [{ reason: "operator" }] });
      const steps = h.stores.invocations.listByPlanNode(node.id);
      expect(steps).toHaveLength(1);
      const a0 = steps[0]!;
      expect(attemptsOf(h, a0.id)).toEqual([[1, "succeeded", null]]);
      expect(h.stores.invocations.get(a0.id)).toMatchObject({ status: "succeeded", patternPosition: { kind: "chain_step", index: 0 } });
      expect(h.stores.usage.listByAttempt(h.stores.invocations.listAttempts(a0.id)[0]!.id)).toHaveLength(1);
      expect(h.provider.requests.at(-1)).toMatchObject({ aborted: false });
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === a0.id).map((c) => c.integrationStatus)).toEqual(["pending"]);
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "soft" });
      expect(h.stores.invocations.listActive(runId)).toEqual([]);
      // Further passes admit nothing while paused: no settlement, no integration, no next step, no Event.
      const idle = h.ctx.journal.lastSeq();
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [], executed: [], waiting: [{ reason: "operator" }] });
      expect(h.runners.chain.settle(node.id, h.stores.plans.latestRevisionNumber(runId)).then((o) => o.kind)).resolves.toBe("not_admitted");
      expect(h.ctx.journal.lastSeq()).toBe(idle);
      expect(h.integrationWorkspace.requests.filter((r) => r.runId === runId)).toHaveLength(1);
      // Another Run of the same process is unaffected.
      const other = await planned(h, (s) => [single(s, "X")]);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect(await h.scheduler.advanceRun(other.runId)).toMatchObject({ stop: "quiescent" });
      expect(statuses(h, other.nodes)).toEqual(["succeeded"]);
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "soft" });
      // Resume: the finished step is settled and integrated once, the next step starts, the node completes; A0 never re-executes.
      const requests = h.provider.requests.length;
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", status: "running", cleared: "soft" });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(resumed.actions.map((a) => a.action.kind)).toEqual(["settle_node", "execute_invocation", "settle_node", "prepare_root_turn", "execute_invocation", "settle_root"]);
      expect(h.stores.invocations.listByPlanNode(node.id).map((i) => [i.patternPosition?.kind === "chain_step" ? i.patternPosition.index : -1, i.status])).toEqual([[0, "succeeded"], [1, "succeeded"]]);
      expect(attemptsOf(h, a0.id)).toEqual([[1, "succeeded", null]]);
      // The second step and the node_result turn of the succeeded node; the finished step was not repeated.
      expect(h.provider.requests).toHaveLength(requests + 2);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === a0.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
      expect(eventsAfter(h, runId, seq).filter((t) => t !== "run.integrated")).toEqual(["run.paused", "run.waiting", "run.resumed", "run.wait_cleared"]);
    } finally {
      h.close();
    }
  });

  it("holds parallel items without a duplicate, and refuses every runner, Gate, completion, and join action with not_admitted", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { runId, nodes, revisionNumber } = await planned(h, (s) => [parallelExpression(s, 2)]);
      const node = nodes[0]!;
      h.provider.script(delayed("i0"), delayed("i1"));
      const { pass } = await executing(h, runId, ["i0", "i1"]);
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", executingAttemptIds: expect.arrayContaining([]) });
      h.provider.release("i0");
      h.provider.release("i1");
      expect((await pass).stop).toBe("waiting");
      const items = h.stores.invocations.listByPlanNode(node.id);
      expect(items.map((i) => i.status)).toEqual(["succeeded", "succeeded"]);
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      // Every mutating entry point of the runner answers with the typed refusal and writes nothing.
      const before = work(h, runId);
      expect(await h.runners.parallel.settle(node.id, revisionNumber)).toMatchObject({ kind: "not_admitted", status: "waiting", operatorPause: "soft" });
      expect(h.runners.parallel.startPosition(node.id, revisionNumber, { kind: "parallel_item", index: 0, count: 2 })).toMatchObject({ kind: "not_admitted" });
      expect(h.runners.parallel.resume(node.id, revisionNumber)).toMatchObject({ kind: "not_admitted" });
      expect(h.runners.parallel.openGate(node.id, revisionNumber)).toMatchObject({ kind: "not_admitted" });
      expect(h.runners.root.settle(runId)).resolves.toMatchObject({ kind: "not_admitted" });
      expect(h.runners.root.prepareRemediation(runId)).toMatchObject({ kind: "not_admitted" });
      expect(h.runners.completion.begin(runId)).toMatchObject({ kind: "not_admitted" });
      expect(await h.runners.completion.verify(runId)).toMatchObject({ kind: "not_admitted" });
      expect(h.runners.completion.complete(runId)).toMatchObject({ kind: "not_admitted" });
      expect(work(h, runId)).toEqual(before);
      // Resume: the two items integrate in canonical order and the node succeeds with exactly two item Invocations.
      h.runControl.resume({ runId });
      expect((await h.scheduler.advanceRun(runId)).stop).toBe("quiescent");
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(2);
      expect(h.stores.changesets.listByRun(runId).filter((c) => items.some((i) => i.id === c.invocationId)).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated"]);
    } finally {
      h.close();
    }
  });

  it("lets a draining turn keep its runtime-tool behaviour and request a Decision, which the resumed Run continues in exactly one successor; a hard pause refuses further calls but keeps replay", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { invocation, attempt, port } = await rootPort(h, s);
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", executingAttemptIds: [attempt.id] });
      // A read and a Decision request are accepted while the turn drains under a soft pause.
      expect(await port.call({ tool: "read_requirements", input: {} })).toMatchObject({ kind: "read", tool: "read_requirements" });
      const requested = await port.call(choice());
      expect(requested).toMatchObject({ kind: "accepted", tool: "request_decision", replayed: false });
      // Escalated to hard: a repeated call still replays its committed result; anything else is refused before any handler runs.
      expect(h.runControl.pause({ runId, mode: "hard" })).toMatchObject({ kind: "escalated", mode: "hard", interruptedAttemptIds: [attempt.id] });
      expect(await port.call(choice())).toMatchObject({ kind: "accepted", tool: "request_decision", replayed: true, callId: (requested as { callId: string }).callId });
      expect(await port.call(waiver(s.completion.requirementId))).toMatchObject({ kind: "rejected", tool: "request_decision", reasons: [{ code: "run_not_executing" }] });
      expect(await port.call({ tool: "read_requirements", input: {} })).toMatchObject({ kind: "rejected", tool: "read_requirements", reasons: [{ code: "run_not_executing" }] });
      // Capability authorization answers `interrupted` with the pause's cause; nothing is claimed.
      const manifest = h.stores.invocations.getManifest(invocation.id).content;
      const authorizer = new ToolCallAuthorizer(h.ctx, h.stores, { runId, planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id, toolPolicy: manifest.toolPolicy, approvedCalls: manifest.approvedCalls });
      expect(authorizer.authorize({ tool: "write", input: { path: "a.txt" } })).toEqual({ kind: "interrupted", tool: "write", cause: "operator_pause" });
      expect(h.stores.runtimeToolCalls.listByInvocation(invocation.id)).toHaveLength(1);
      // The interrupted Attempt finalizes from the committed request: the Invocation ends blocked on the Decision, the Attempt is history.
      const finalized = await h.executor.executePreparedAttempt(attempt.id);
      expect(finalized.kind).toBe("decision_requested");
      expect(h.stores.invocations.get(invocation.id)).toMatchObject({ status: "blocked", blockedByDecisionId: (requested as { result: { decisionId: string } }).result.decisionId });
      // Resolved while paused: nothing continues until the resume; then exactly one successor, no relay turn.
      const decisionId = h.stores.invocations.get(invocation.id).blockedByDecisionId!;
      h.decisionRequests.resolve({ decisionId, optionId: "express" });
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [], waiting: [{ reason: "operator" }] });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", status: "running", cleared: "hard" });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.actions.map((a) => a.action.kind).slice(0, 2)).toEqual(["continue_decision_request", "execute_invocation"]);
      const successors = h.stores.invocations.listByRun(runId).filter((i) => i.continuedFromInvocationId === invocation.id);
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ purpose: invocation.purpose, status: "succeeded" });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

describe("hard pause", () => {
  it("interrupts the executing Attempt with a durable retryable classification, keeps the Invocation's identity and remaining allocation, records Usage once, and the resumed Run retries the same Invocation", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      h.provider.script(delayed("a"));
      const { pass } = await executing(h, runId, ["a"]);
      const invocation = invocationOf(h, a);
      const executingIds = h.executor.inFlightOf(runId);
      const seq = h.ctx.journal.lastSeq();
      const paused = h.runControl.pause({ runId, mode: "hard" });
      expect(paused).toMatchObject({ kind: "paused", mode: "hard", status: "waiting", interruptedAttemptIds: executingIds, executingAttemptIds: executingIds });
      expect((await pass).stop).toBe("waiting");
      // The Attempt is consumed and classified `interrupted` with a permitted retry; the Invocation stays running with its reservation.
      const [attempt] = h.stores.invocations.listAttempts(invocation.id);
      expect(attempt).toMatchObject({ number: 1, status: "interrupted", failureClass: "interrupted", failureDetail: { message: "interrupted by an operator pause", cancelled: false }, retryDecision: { permitted: true, reason: "interrupted", notBefore: null } });
      expect(h.stores.usage.listByAttempt(attempt!.id)).toHaveLength(1);
      expect(h.provider.requests.at(-1)).toMatchObject({ aborted: true, abortCause: "operator_pause" });
      expect(h.stores.invocations.get(invocation.id)).toMatchObject({ status: "running", workspaceCleanup: "pending" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })).not.toBeNull();
      expect(h.stores.leases.get(attempt!.capacityLeaseId!).status).toBe("released");
      expect(h.executor.inFlightOf(runId)).toEqual([]);
      expect(h.executionWorkspace.released.some((r) => r.invocationId === invocation.id)).toBe(false);
      // Nothing is admitted while paused: the executor refuses the retry with the closed reason; a pass performs nothing.
      expect(await h.executor.prepareNextAttempt(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "run_paused" });
      expect(h.executor.inspectInvocation(invocation.id).next).toEqual({ permitted: false, reason: "run_paused", notBefore: null });
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [] });
      expect(attemptsOf(h, invocation.id)).toEqual([[1, "interrupted", true]]);
      // Resume: the retry is a fresh second Attempt of the same Invocation, then the node completes.
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", status: "running", cleared: "hard" });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(resumed.actions.map((x) => x.action.kind)).toEqual(["execute_invocation", "settle_node", "prepare_root_turn", "execute_invocation", "settle_root"]);
      expect(attemptsOf(h, invocation.id)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
      expect(h.stores.invocations.listAttempts(invocation.id)[1]).toMatchObject({ kind: "retry", startMode: "fresh" });
      expect(h.stores.invocations.listByPlanNode(a.id)).toHaveLength(1);
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
      // The root's first turn, the node's Invocation (two Attempts), and the node_result turn.
      expect(work(h, runId)).toMatchObject({ invocations: 3, attempts: 4, usage: 4 });
      expect(eventsAfter(h, runId, seq).filter((t) => t !== "run.integrated")).toEqual(["run.paused", "run.waiting", "run.resumed", "run.wait_cleared"]);
      expect(activeCapacity(h, runId).leases).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("keeps the consequence of an exhausted Attempt allocation and of a passed wall-clock deadline: an interrupted last Attempt refuses its retry and the Invocation fails", async () => {
    const h = openRuntimeHarness();
    try {
      // A worker Invocation allows two Attempts: a transient failure consumes the first; the hard pause interrupts the last.
      const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      h.provider.script({ kind: "transient_error" });
      const first = await h.scheduler.advanceRun(runId);
      expect(first.stop).toBe("waiting");
      const invocation = invocationOf(h, a);
      const notBefore = h.stores.invocations.listAttempts(invocation.id)[0]!.retryDecision!.notBefore!;
      h.clock.set(notBefore);
      h.provider.script(delayed("a"));
      const { pass } = await executing(h, runId, ["a"]);
      expect(h.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
      expect((await pass).stop).toBe("waiting");
      expect(attemptsOf(h, invocation.id)).toEqual([[1, "failed", true], [2, "interrupted", false]]);
      expect(h.stores.invocations.listAttempts(invocation.id)[1]!.retryDecision).toEqual({ permitted: false, reason: "attempts_exhausted", notBefore: null });
      expect(h.stores.invocations.get(invocation.id)).toMatchObject({ status: "failed", failureReason: "allocation_exhausted" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })).toBeNull();
      // The node's failure is applied only once the Run is resumed; nothing changes while paused.
      expect(h.stores.plans.getNode(a.id).status).toBe("running");
      h.runControl.resume({ runId });
      expect((await h.scheduler.advanceRun(runId)).actions.map((x) => x.action.kind)).toEqual(["settle_node", "prepare_root_turn", "execute_invocation", "settle_root"]);
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ status: "failed" });
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      // The Invocation-wide deadline does not reset: an Attempt interrupted after it refuses the retry with wall_clock_exhausted.
      const s = seedShortLimit(g, 5_000);
      const runId = s.created.run.id;
      const { invocation } = startRun(g, s).prepared;
      g.provider.script(delayed("root"));
      const running = g.executor.advanceInvocation(invocation.id);
      await until(() => g.provider.delayedKeys.includes("root"));
      const deadline = g.executor.inspectInvocation(invocation.id).deadlineAt!;
      g.clock.set(new Date(Date.parse(deadline) + 1).toISOString());
      expect(g.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
      const outcome = await running;
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "interrupted", failureClass: "interrupted", retryDecision: { permitted: false, reason: "wall_clock_exhausted", notBefore: null } } });
      expect(g.stores.invocations.get(invocation.id)).toMatchObject({ status: "failed", failureReason: "allocation_exhausted" });
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "hard" });
      // The root's failure ends the Run only after the resume.
      g.runControl.resume({ runId });
      expect((await g.scheduler.advanceRun(runId)).actions.map((x) => x.action.kind)).toEqual(["settle_root"]);
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "failed", failure: { kind: "root_node_failed" } });
    } finally {
      g.close();
    }
  });

  it("never lets a prepared but undispatched Attempt reach the provider under a pause or a cancellation", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes, revisionNumber } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      h.stores.plans.transitionNode(a.id, { to: "ready" });
      const started = h.runners.single.start(a.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const prepared = await h.executor.prepareNextAttempt(started.invocationId);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const requests = h.provider.requests.length;
      // The pause commits after the Attempt was prepared and before it was dispatched: the dispatch boundary ends it without a provider call.
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", executingAttemptIds: [prepared.attempt.id] });
      const outcome = await h.executor.executePreparedAttempt(prepared.attempt.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { number: 1, status: "interrupted", failureDetail: { message: "interrupted by an operator pause" }, retryDecision: { permitted: true, reason: "interrupted" } }, settlement: { kind: "retry_pending" } });
      expect(h.provider.requests).toHaveLength(requests);
      expect(h.stores.usage.listByAttempt(prepared.attempt.id)).toEqual([]);
      expect(h.stores.leases.get(prepared.lease.id).status).toBe("released");
      expect(h.executor.inFlightOf(runId)).toEqual([]);
      // Resumed: the retry executes; the Invocation is the same.
      h.runControl.resume({ runId });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect((await h.scheduler.advanceRun(runId)).stop).toBe("quiescent");
      expect(attemptsOf(h, started.invocationId)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
      expect(h.stores.invocations.listByPlanNode(a.id)).toHaveLength(1);
      // The retried Attempt and the node_result turn of the succeeded node.
      expect(h.provider.requests).toHaveLength(requests + 2);
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      const { runId, nodes, revisionNumber } = await planned(g, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      g.stores.plans.transitionNode(a.id, { to: "ready" });
      const started = g.runners.single.start(a.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const prepared = await g.executor.prepareNextAttempt(started.invocationId);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const requests = g.provider.requests.length;
      expect(g.runControl.cancel({ runId })).toMatchObject({ kind: "cancelled", interruptedAttemptIds: [prepared.attempt.id] });
      const outcome = await g.executor.executePreparedAttempt(prepared.attempt.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "cancelled", retryDecision: { permitted: false, reason: "cancelled" } }, settlement: { kind: "settled", invocation: { status: "cancelled" } } });
      expect(g.provider.requests).toHaveLength(requests);
      expect(g.stores.plans.getNode(a.id).status).toBe("cancelled");
      expect(activeCapacity(g, runId)).toEqual({ reservations: [], leases: [] });
    } finally {
      g.close();
    }
  });

  it("ends an Attempt interrupted from the Run row when the pause's signal reached nothing: the adapter's next capability call is refused and its late result is not a result", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes } = await planned(h, (s) => [single(s, "A")]);
      const a = nodes[0]!;
      // The adapter will propose a capability call once released, then report success.
      h.provider.script(delayed("a", { kind: "tool_calls", calls: [{ tool: "write", input: { path: "a.txt" } }], then: { kind: "succeed", result: COMPLETED_RESULT } }));
      const { pass } = await executing(h, runId, ["a"]);
      const invocation = invocationOf(h, a);
      // The intent is committed without delivery (another process, a lost signal): the row alone must end the Attempt.
      h.stores.runs.pause(runId, "hard");
      h.provider.release("a");
      expect((await pass).stop).toBe("waiting");
      const request = h.provider.requests.at(-1)!;
      expect(request.aborted).toBe(false);
      expect(request.authorizations.map((x) => x.authorization)).toEqual([{ kind: "interrupted", tool: "write", cause: "operator_pause" }]);
      expect(h.provider.executed).toEqual([]);
      expect(attemptsOf(h, invocation.id)).toEqual([[1, "interrupted", true]]);
      expect(h.stores.invocations.get(invocation.id)).toMatchObject({ status: "running", result: null });
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === invocation.id)).toEqual([]);
      expect(h.executionWorkspace.collected.filter((c) => c.invocationId === invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("retries a chain at its current step and a Coordinator's Worker with its Task ownership intact, never restarting or advancing prematurely", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, nodes } = await planned(h, (s) => [chain(s, ["A0", "A1", "A2"])]);
      const node = nodes[0]!;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, delayed("a1"));
      const { pass } = await executing(h, runId, ["a1"]);
      const position = (i: { patternPosition: { kind: string; index?: number } | null }) => (i.patternPosition?.kind === "chain_step" ? i.patternPosition.index : -1);
      expect(h.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
      expect((await pass).stop).toBe("waiting");
      const steps = h.stores.invocations.listByPlanNode(node.id);
      expect(steps.map((i) => [position(i), i.status])).toEqual([[0, "succeeded"], [1, "running"]]);
      h.runControl.resume({ runId });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, { kind: "succeed", result: COMPLETED_RESULT });
      expect((await h.scheduler.advanceRun(runId)).stop).toBe("quiescent");
      const after = h.stores.invocations.listByPlanNode(node.id);
      expect(after.map((i) => [position(i), i.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
      expect(attemptsOf(h, after[0]!.id)).toEqual([[1, "succeeded", null]]);
      expect(attemptsOf(h, after[1]!.id)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
      expect(attemptsOf(h, after[2]!.id)).toEqual([[1, "succeeded", null]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
    const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(g);
      const runId = s.created.run.id;
      const { node, leafIds } = coordinatorNode(g, s, { bounds: { maxTasks: 4, maxConcurrentWorkers: 1, maxCoordinatorInvocations: 4 } });
      g.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await g.executor.advanceInvocation(s.invocation.id);
      g.provider.script(turn([propose([proposal({ key: "t1", requirementIds: [leafIds[0]!] })])]), delayed("w1", workerStep(g)));
      const { pass } = await executing(g, runId, ["w1"]);
      const [worker] = workersOf(g, node);
      const [task] = tasksOf(g, node);
      expect(task).toMatchObject({ status: "running", invocationId: worker!.id });
      expect(g.runControl.pause({ runId, mode: "hard" }).interruptedAttemptIds).toHaveLength(1);
      expect((await pass).stop).toBe("waiting");
      expect(attemptsOf(g, worker!.id)).toEqual([[1, "interrupted", true]]);
      expect(g.stores.tasks.get(task!.id)).toMatchObject({ status: "running", invocationId: worker!.id });
      g.runControl.resume({ runId });
      g.provider.script(workerStep(g));
      await g.scheduler.advanceRun(runId, { maxActions: 3 });
      expect(attemptsOf(g, worker!.id)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
      expect(workersOf(g, node)).toHaveLength(1);
      expect(g.stores.tasks.get(task!.id)).toMatchObject({ status: "completed", invocationId: worker!.id });
    } finally {
      g.close();
    }
  });
});

describe("resume", () => {
  it("clears only the pause: an open Decision keeps the Run waiting on it, an unfunded wait node keeps waiting on budget, and a stale wait reason is never restored", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      startRun(h, s);
      h.provider.script(requesting([choice()]));
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting" });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", status: "waiting" });
      expect(h.stores.runs.get(runId)).toMatchObject({ waitReason: "operator", operatorPause: "soft" });
      // Resumed with the Decision still open: the Run is running until the pass records the recomputed wait — on the Decision, not the pause.
      expect(h.runControl.resume({ runId })).toMatchObject({ kind: "resumed", status: "running" });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.actions.map((a) => a.action.kind)).toEqual(["wait_run"]);
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "decision", operatorPause: null });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      // A `wait` node that cannot be funded: the Run waits on budget before and after a pause; the pause never restores or clears that wait itself.
      const { runId, nodes } = await planned(g, (s) => [single(s, "A", { allocation: { costUsd: 1, tokens: 10, attempts: 1 }, onAllocationExhausted: "wait" } as never)]);
      const first = await g.scheduler.advanceRun(runId);
      expect(first.stop).toBe("waiting");
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
      expect(g.stores.plans.getNode(nodes[0]!.id)).toMatchObject({ status: "waiting", waitReason: "budget" });
      g.runControl.pause({ runId, mode: "hard" });
      expect(g.stores.runs.get(runId)).toMatchObject({ waitReason: "operator" });
      expect(g.runControl.resume({ runId })).toMatchObject({ status: "running" });
      const again = await g.scheduler.advanceRun(runId);
      expect(again.actions.map((a) => a.action.kind)).toEqual(["wait_run"]);
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget", operatorPause: null });
      expect(g.stores.invocations.listByPlanNode(nodes[0]!.id)).toEqual([]);
    } finally {
      g.close();
    }
  });

  it("resumes verification and signoff where they stood: a hard-paused completion Evaluator retries on the same Invocation and Gate, a soft-paused synthesis settles after the resume, and signoff is refused while paused", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { finalReserve: { costUsd: 20, tokens: 200_000, attempts: 8 } });
      const runId = s.created.run.id;
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)], evaluator: [delayed("eval", completionEvaluatorStep(h, "pass")), completionEvaluatorStep(h, "pass")] });
      const { pass } = await executing(h, runId, ["eval"]);
      expect(h.stores.runs.get(runId).status).toBe("verifying");
      const [evaluator] = completionEvaluatorsOf(h, runId);
      const paused = h.runControl.pause({ runId, mode: "hard" });
      expect(paused).toMatchObject({ kind: "paused", mode: "hard", status: "verifying" });
      expect(paused.interruptedAttemptIds).toHaveLength(1);
      expect((await pass).stop).toBe("waiting");
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "verifying", waitReason: null, operatorPause: "hard" });
      expect(attemptsOf(h, evaluator!.id)).toEqual([[1, "interrupted", true]]);
      expect(completionGatesOf(h, runId).map((x) => x.status)).toEqual(["open"]);
      expect(h.criterionExecution.observed).toHaveLength(1);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "waiting", actions: [] });
      // Resumed: the same Evaluator Invocation retries on the same Gate; checks are not rerun; the cycle completes to signoff.
      h.runControl.resume({ runId });
      const kinds = await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      expect(kinds).toEqual(["execute_invocation", "settle_run_completion_evaluator", "derive_requirement_statuses", "prepare_final_synthesis", "execute_invocation", "settle_final_synthesis"]);
      expect(completionEvaluatorsOf(h, runId)).toHaveLength(1);
      expect(attemptsOf(h, evaluator!.id)).toEqual([[1, "interrupted", true], [2, "succeeded", null]]);
      expect(completionGatesOf(h, runId)).toHaveLength(1);
      expect(h.criterionExecution.observed).toHaveLength(1);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(completionGatesOf(h, runId)[0]!.id).map((e) => e.verdict)).toEqual(["pass", "pass"]);
      void criteria;
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(g);
      const runId = s.created.run.id;
      scriptByRole(g, { orchestrator: [requestingStep(), delayed("syn", synthesisStep(g))] });
      const { pass } = await executing(g, runId, ["syn"]);
      expect(g.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", status: "verifying", interruptedAttemptIds: [] });
      g.provider.release("syn");
      expect((await pass).stop).toBe("waiting");
      const [synthesis] = synthesesOf(g, runId);
      expect(synthesis).toMatchObject({ status: "succeeded" });
      expect(reportsOf(g, runId)).toEqual([]);
      expect(signoffGatesOf(g, runId)).toEqual([]);
      expect(g.stores.runs.get(runId)).toMatchObject({ status: "verifying", operatorPause: "soft" });
      g.runControl.resume({ runId });
      expect((await g.scheduler.advanceRun(runId)).actions.map((a) => a.action.kind)).toEqual(["settle_final_synthesis"]);
      expect(g.stores.runs.get(runId).status).toBe("awaiting_signoff");
      expect(synthesesOf(g, runId)).toHaveLength(1);
      expect(reportsOf(g, runId)).toHaveLength(1);
    } finally {
      g.close();
    }
    const k = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(k);
      expect(k.runControl.pause({ runId, mode: "soft" })).toMatchObject({ kind: "paused", status: "awaiting_signoff" });
      const projection = k.signoff.inspect(runId);
      expect(projection.blockers).toEqual([{ kind: "run_paused", mode: "soft" }]);
      expect(projection.allowedActions).toEqual([]);
      await expect(k.signoff.accept({ runId, gateId: gate.id, decisionId })).rejects.toThrow(expect.objectContaining({ refusal: "run_paused" }));
      const message = operatorMessage(k, runId);
      expect(() => k.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: message.id })).toThrow(expect.objectContaining({ refusal: "run_paused" }));
      expect(k.stores.decisions.get(decisionId).status).toBe("open");
      expect(k.stores.runs.get(runId)).toMatchObject({ status: "awaiting_signoff", operatorPause: "soft" });
      expect(k.runControl.resume({ runId })).toMatchObject({ kind: "resumed", status: "awaiting_signoff" });
      expect(k.signoff.inspect(runId).allowedActions).toEqual(["accept", "request_changes"]);
      expect(await k.signoff.accept({ runId, gateId: gate.id, decisionId })).toMatchObject({ kind: "accepted", replayed: false });
      expect(k.stores.runs.get(runId).status).toBe("completed");
    } finally {
      k.close();
    }
  });
});
