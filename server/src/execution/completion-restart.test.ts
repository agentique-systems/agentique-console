/**
 * Restart and idempotence of Run completion (execution-model §10, §14
 * "Server restart"; invariants 6 no transcript decides anything, 11
 * verification precedes completion, 12 one signoff boundary, 20 one
 * Invocation per logical turn, 22 atomic allocation): every crash window of
 * a completion cycle is closed from canonical rows alone, over a file-backed
 * database opened by successive processes, without a duplicate Completion
 * Request, Gate, check, Evaluation, status-history entry, Evaluator,
 * remediation Task, synthesis, report Artifact, signoff Gate, signoff
 * Decision, or Run transition.
 *
 * Passing cycle (one deterministic and one evaluated criterion): (1) the
 * requesting turn called request_completion and is executing, provider
 * response lost; (2) the turn succeeded, its Changeset not integrated; (3)
 * integrated, the Gate not opened; (4) Gate opened, no check recorded; (5)
 * check running, process dies mid-command; (6) check recorded, Evaluator not
 * prepared; (7) Evaluator prepared and executing, response lost; (8)
 * Evaluator succeeded, verdicts not recorded; (9) verdicts recorded, statuses
 * not derived; (10) statuses derived, synthesis not prepared; (11) synthesis
 * prepared and executing, response lost; (12) synthesis succeeded, Gate not
 * closed; (13) awaiting signoff.
 *
 * Failing cycle then a second cycle (one deterministic criterion): (14) the
 * check failed and is recorded, the Gate not closed; (15) Gate failed with
 * its Task, root turn not prepared; (16) gate_result turn prepared, not
 * executed; (17) turn succeeded with a Changeset, not integrated; (18)
 * integrated, Task not addressed; (19) a later turn's request accepted, turn
 * not settled; (20) second Gate opened, check pending; (21) second cycle
 * passed the checks, synthesis not prepared; (22) awaiting signoff after the
 * second cycle. Cancellation: (23) the requesting turn ended failed, the
 * request not cancelled; (24) request cancelled, the Run still running.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcceptanceCriterionId, RequirementId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { completionEvaluatorStep, completionEvaluatorsOf, completionGatesOf, prepareOperatorTurn, remediationsOf, reportsOf, requestingStep, requestsOf, signoffGatesOf, synthesesOf, synthesisStep } from "./completion-test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { orchestratorStep, rootTurnsOf, scriptByRole, seedCriteria, until } from "./gate-test-support.ts";
import { COMPLETED_RESULT, FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const WIDE_RESERVE = { costUsd: 20, tokens: 200_000, attempts: 8 };

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  integration: FakeIntegrationWorkspace;
  checks: FakeAcceptanceCriterionExecution;
  runId: RunId;
  deterministic: AcceptanceCriterionId[];
  evaluated: AcceptanceCriterionId[];
  leafId: RequirementId;
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, and the file is always closed. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration, criterionExecution: w.checks });
  try {
    if (options.recover !== false) h.recovery.recover();
    return await body(h);
  } finally {
    try {
      h.close();
    } catch {
      // A process that "died" closed its own handle already.
    }
  }
}

/** Everything a pass could repeat by mistake. */
function work(h: RuntimeHarness, w: World) {
  return {
    run: h.stores.runs.get(w.runId).status,
    requests: requestsOf(h, w.runId).map((r) => r.status),
    gates: completionGatesOf(h, w.runId).map((g) => [g.ordinal, g.status]),
    evaluators: completionEvaluatorsOf(h, w.runId).length,
    syntheses: synthesesOf(h, w.runId).length,
    invocations: h.stores.invocations.listByRun(w.runId).length,
    attempts: h.stores.invocations.listByRun(w.runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    commands: w.checks.observed.length,
    evaluations: h.stores.evaluations.listByRun(w.runId).filter((e) => e.gateId !== null).length,
    history: h.stores.requirements.history(w.leafId).map((c) => c.to),
    reports: reportsOf(h, w.runId).length,
    signoffs: signoffGatesOf(h, w.runId).map((g) => g.status),
    decisions: h.stores.decisions.listOpen(h.stores.runs.get(w.runId).conversationId).filter((d) => d.kind === "signoff").length,
    tasks: remediationsOf(h, w.runId).map((t) => t.status),
    rootTurns: rootTurnsOf(h, w.runId).map((t) => t.purpose),
    integrated: h.stores.changesets.listByRun(w.runId).filter((c) => c.integrationStatus === "integrated").length,
    changesets: h.stores.changesets.listByRun(w.runId).length,
    transitions: h.ctx.journal.read({ runId: w.runId }).filter((e) => e.type.startsWith("run.")).map((e) => e.type),
  };
}

const nextActions = (h: RuntimeHarness, w: World) => h.scheduler.reconcileRun(w.runId).actions.map((a) => a.kind);

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration: new FakeIntegrationWorkspace(sha256Hex), checks: new FakeAcceptanceCriterionExecution(), runId: undefined as never, deterministic: [], evaluated: [], leafId: undefined as never };
}

/** One action, whose kind is asserted; the process then "dies". */
async function oneAction(h: RuntimeHarness, w: World, kind: string) {
  const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
  if (pass.failure) throw new Error(pass.failure.message);
  expect(pass.actions.map((p) => p.action.kind)).toEqual([kind]);
  return pass.actions[0]!.outcome;
}

/** Starts a pass whose next provider call hangs, waits until the call is in flight, and leaves the pass to die with the process. */
async function dieMidAttempt(h: RuntimeHarness, w: World, requests: number) {
  const pass = h.scheduler.advanceRun(w.runId);
  void pass.catch(() => undefined);
  await until(() => h.provider.requests.length === requests);
}

describe("run completion restart", () => {
  it("converges across the thirteen windows of a passing cycle without repeating a request, Gate, check, Evaluation, status entry, Evaluator, synthesis, report, signoff Gate, Decision, or Run transition", async () => {
    const w = newWorld("agentique-completion-");
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
        w.runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
        w.deterministic = criteria.deterministic;
        w.evaluated = criteria.evaluated;
        w.leafId = criteria.rootId;
      }, { recover: false });
      let before = await withProcess(w, async (h) => {
        // Window 1: the turn requested completion and is executing; the process dies before any response.
        scriptByRole(h, { orchestrator: [requestingStep({ kind: "hang" })] });
        await dieMidAttempt(h, w, 1);
        await until(() => requestsOf(h, w.runId).length === 1);
        expect(work(h, w)).toMatchObject({ requests: ["requested"], gates: [], run: "running" });
        return work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(work(h, w)).toEqual(before);
        // Window 2: the retried turn replays its call (the same request) and succeeds; the process dies with its Changeset pending.
        scriptByRole(h, { orchestrator: [requestingStep()] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        expect(h.provider.runtimeToolCalls.map((c) => c.outcome.kind === "accepted" && c.outcome.replayed)).toEqual([true]);
        expect(work(h, w)).toMatchObject({ requests: ["requested"], invocations: 1, attempts: 2, changesets: 1, integrated: 0, gates: [] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 3: the Changeset is integrated; the process dies before the Gate opens.
        expect(nextActions(h, w)).toEqual(["settle_root"]);
        await oneAction(h, w, "settle_root");
        expect(work(h, w)).toMatchObject({ integrated: 1, gates: [], run: "running", requests: ["requested"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["begin_run_completion"]);
        // Window 4: the Gate opens and the Run verifies; the process dies before any check.
        expect(await oneAction(h, w, "begin_run_completion")).toMatchObject({ kind: "completion_begun", ordinal: 1 });
        expect(work(h, w)).toMatchObject({ run: "verifying", requests: ["verifying"], gates: [[1, "open"]], commands: 0, evaluations: 0 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["run_completion_checks"]);
        // Window 5: the check is running in its isolated view; the process dies mid-command.
        w.checks.script(w.deterministic[0]!, { kind: "delay", key: "completion-check", then: { kind: "exit", exitCode: 0 } });
        const pass = h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        void pass.catch(() => undefined);
        await until(() => w.checks.delayedKeys.includes("completion-check"));
        expect(work(h, w)).toMatchObject({ evaluations: 0 });
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toMatchObject({ ...before, gates: [[1, "open"]], evaluations: 0 });
        expect(w.checks.liveViews.size).toBe(1);
        // The check runs again in a fresh view (the stale one discarded) and is recorded once; then Window 6: no Evaluator yet.
        expect(await oneAction(h, w, "run_completion_checks")).toMatchObject({ kind: "completion_verified", verdict: "pass" });
        expect(w.checks.observed.map((o) => [o.acceptanceCriterionId, o.discardedStale, o.outcome])).toEqual([[w.deterministic[0], true, "exited"]]);
        expect(work(h, w)).toMatchObject({ evaluations: 1, evaluators: 0 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["prepare_run_completion_evaluator"]);
        // Window 7: the Evaluator is prepared and executing; the process dies before any response.
        h.provider.script({ kind: "hang" });
        await dieMidAttempt(h, w, 1);
        expect(work(h, w)).toMatchObject({ evaluators: 1, evaluations: 1 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(completionEvaluatorsOf(h, w.runId).map((e) => [e.status, h.stores.invocations.listAttempts(e.id).map((a) => a.status)])).toEqual([["running", ["interrupted"]]]);
        // Window 8: the retried Evaluator passes; the process dies before the verdict is recorded.
        scriptByRole(h, { evaluator: [completionEvaluatorStep(h, "pass")] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ evaluators: 1, evaluations: 1, gates: [[1, "open"]], history: [] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 9: the verdict is recorded; the process dies before the statuses are derived.
        expect(nextActions(h, w)).toEqual(["settle_run_completion_evaluator"]);
        expect(await oneAction(h, w, "settle_run_completion_evaluator")).toMatchObject({ kind: "completion_evaluations_recorded" });
        expect(work(h, w)).toMatchObject({ evaluations: 2, history: [], gates: [[1, "open"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(h.runners.completion.settleEvaluator(w.runId)).toEqual({ kind: "no_change" });
        // Window 10: the statuses are derived; the process dies before the synthesis is prepared.
        expect(await oneAction(h, w, "derive_requirement_statuses")).toMatchObject({ kind: "requirement_statuses_derived", changes: [{ requirementId: w.leafId, from: "open", to: "satisfied" }] });
        expect(work(h, w)).toMatchObject({ history: ["satisfied"], syntheses: 0 });
        expect(h.runners.completion.derive(w.runId)).toEqual({ kind: "no_change" });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["prepare_final_synthesis"]);
        // Window 11: the synthesis is prepared and executing; the process dies before any response.
        h.provider.script({ kind: "hang" });
        await dieMidAttempt(h, w, 1);
        expect(work(h, w)).toMatchObject({ syntheses: 1, reports: 0, history: ["satisfied"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 12: the retried synthesis succeeds; the process dies before the Gate closes.
        scriptByRole(h, { orchestrator: [synthesisStep(h)] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ syntheses: 1, reports: 0, gates: [[1, "open"]], run: "verifying", signoffs: [], decisions: 0 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 13: one transaction closes the Gate, ends the request, stores the report, opens the signoff boundary, and moves the Run.
        expect(nextActions(h, w)).toEqual(["settle_final_synthesis"]);
        expect(await oneAction(h, w, "settle_final_synthesis")).toMatchObject({ kind: "completion_passed" });
        expect(work(h, w)).toMatchObject({ run: "awaiting_signoff", requests: ["passed"], gates: [[1, "passed"]], reports: 1, signoffs: ["open"], decisions: 1, evaluators: 1, syntheses: 1, commands: 1, evaluations: 2, history: ["satisfied"], tasks: [] });
        expect(work(h, w).transitions).toEqual(["run.created", "run.started", "run.integrated", "run.verifying", "run.awaiting_signoff"]);
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(h.runners.completion.settleSynthesis(w.runId)).toEqual({ kind: "no_change" });
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("converges across the windows of a failed cycle, its remediation, a second cycle, and a cancelled request without repeating a Task, turn, Gate, or request", async () => {
    const w = newWorld("agentique-completion-fail-");
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
        w.runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { deterministic: 1 });
        w.deterministic = criteria.deterministic;
        w.leafId = criteria.rootId;
        // Window 14: the check failed and is recorded; the process dies before the Gate closes.
        w.checks.script(w.deterministic[0]!, { kind: "exit", exitCode: 1, output: "failing\n" });
        scriptByRole(h, { orchestrator: [requestingStep()] });
        for (const kind of ["execute_invocation", "settle_root", "begin_run_completion", "run_completion_checks"]) await oneAction(h, w, kind);
        expect(work(h, w)).toMatchObject({ run: "verifying", gates: [[1, "open"]], evaluations: 1, tasks: [] });
      }, { recover: false });
      let before = await withProcess(w, async (h) => {
        expect(work(h, w)).toMatchObject({ run: "verifying", gates: [[1, "open"]], evaluations: 1 });
        // Window 15: the Gate fails with its Task and the Run returns to running; the process dies before the root turn.
        expect(nextActions(h, w)).toEqual(["complete_run_verification"]);
        expect(await oneAction(h, w, "complete_run_verification")).toMatchObject({ kind: "completion_failed", outcome: { kind: "criteria_failed" } });
        expect(work(h, w)).toMatchObject({ run: "running", requests: ["failed"], gates: [[1, "failed"]], tasks: ["pending"], rootTurns: ["operator_input"], commands: 1 });
        return work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(h.runners.completion.complete(w.runId)).toEqual({ kind: "no_change" });
        // Window 16: the gate_result turn is prepared; the process dies before it executes.
        expect(await oneAction(h, w, "prepare_gate_remediation")).toMatchObject({ kind: "remediation_prepared" });
        expect(work(h, w)).toMatchObject({ rootTurns: ["operator_input", "gate_result"], tasks: ["running"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 17: the turn succeeds with a Changeset; the process dies before integration.
        scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+fix" })] });
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ changesets: 2, integrated: 1, tasks: ["running"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 18: the Changeset is integrated; the process dies before the Task is addressed.
        expect(await oneAction(h, w, "settle_gate_remediation")).toMatchObject({ kind: "integrated" });
        expect(work(h, w)).toMatchObject({ integrated: 2, tasks: ["running"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(await oneAction(h, w, "settle_gate_remediation")).toMatchObject({ kind: "remediation_settled" });
        expect(work(h, w)).toMatchObject({ tasks: ["completed"], requests: ["failed"], gates: [[1, "failed"]] });
        // Nothing retries completion by itself.
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        // Window 19: a later turn's request is accepted; the process dies before the turn settles.
        prepareOperatorTurn(h, w.runId);
        scriptByRole(h, { orchestrator: [requestingStep()] });
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ requests: ["failed", "requested"], gates: [[1, "failed"]], changesets: 3, integrated: 2 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 20: the second Gate opens on the new Snapshot; the process dies before its check.
        await oneAction(h, w, "settle_root");
        expect(await oneAction(h, w, "begin_run_completion")).toMatchObject({ kind: "completion_begun", ordinal: 2 });
        const [first, second] = completionGatesOf(h, w.runId);
        expect(second!.snapshotId).not.toBe(first!.snapshotId);
        expect(work(h, w)).toMatchObject({ run: "verifying", requests: ["failed", "verifying"], gates: [[1, "failed"], [2, "open"]], commands: 1 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 21: the second cycle's check passes and the statuses are derived; the process dies before the synthesis is prepared.
        expect(await oneAction(h, w, "run_completion_checks")).toMatchObject({ kind: "completion_verified", verdict: "pass" });
        expect(await oneAction(h, w, "derive_requirement_statuses")).toMatchObject({ kind: "requirement_statuses_derived" });
        expect(work(h, w)).toMatchObject({ commands: 2, evaluations: 2, history: ["satisfied"], syntheses: 0 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 22: the synthesis runs and the Run awaits signoff after the second cycle; a further process performs nothing.
        scriptByRole(h, { orchestrator: [synthesisStep(h)] });
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.actions.map((p) => p.action.kind)).toEqual(["prepare_final_synthesis", "execute_invocation", "settle_final_synthesis"]);
        expect(work(h, w)).toMatchObject({ run: "awaiting_signoff", requests: ["failed", "passed"], gates: [[1, "failed"], [2, "passed"]], reports: 1, signoffs: ["open"], decisions: 1, tasks: ["completed"], syntheses: 1 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("cancels a request whose turn ended without completing, once, across a restart", async () => {
    const w = newWorld("agentique-completion-cancel-");
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        w.leafId = s.completion.requirementId;
        // Window 23: the requesting turn ended with a failed result; the process dies before the request is cancelled.
        scriptByRole(h, { orchestrator: [requestingStep({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "gave up" } })] });
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ requests: ["requested"], run: "running" });
      }, { recover: false });
      const before = await withProcess(w, async (h) => {
        expect(work(h, w)).toMatchObject({ requests: ["requested"], run: "running" });
        // Window 24: the request is cancelled; the Run keeps running and nothing else is written.
        const kinds: string[] = [];
        while (requestsOf(h, w.runId)[0]!.status === "requested") {
          const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
          kinds.push(...pass.actions.map((p) => p.action.kind));
          if (pass.actions.length === 0) break;
        }
        expect(kinds).toContain("complete_run_verification");
        expect(work(h, w)).toMatchObject({ requests: ["cancelled"], gates: [], run: "running" });
        return work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(h.runners.completion.complete(w.runId)).toEqual({ kind: "no_change" });
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
