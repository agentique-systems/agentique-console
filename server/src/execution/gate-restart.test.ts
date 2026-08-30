/**
 * Restart and idempotence of `node_exit` Gates (execution-model §10, §14
 * "Server restart"; invariants 6 no transcript decides anything, 11
 * verification precedes completion, 20 one Invocation per logical turn, 22
 * atomic allocation): every crash window of a Gate cycle and its
 * remediation is closed from canonical rows alone, over a file-backed
 * database opened by successive processes, without a duplicate Gate,
 * check, Evaluation, Evaluator, remediation Task, Orchestrator turn,
 * Coordinator turn, Handoff, or integration.
 *
 * Root-remediated single node (one deterministic and one evaluated
 * criterion; the first cycle fails on the Evaluator's verdict): (1) Worker
 * executing, provider response lost; (2) Worker succeeded, Changeset not
 * integrated; (3) Changeset integrated, Gate not opened; (4) Gate opened,
 * no check recorded; (5) check running, process dies mid-command; (6) check
 * recorded, Evaluator not prepared; (7) Evaluator prepared and executing,
 * response lost; (8) Evaluator succeeded, verdicts not recorded; (9) Gate
 * closed failed with its Task, root turn not prepared; (10) gate_result turn
 * prepared, not executed; (11) turn succeeded with a Changeset, not
 * integrated; (12) Changeset integrated, Tasks not addressed; (13) Task
 * addressed, second Gate not opened; (14) second Gate opened, checks
 * pending; (15) checks passed, second Evaluator prepared, not executed; (16)
 * second Evaluator passed, node not settled.
 *
 * Coordinator-remediated node (deterministic criterion; the first cycle
 * fails on the check): (17) Gate failed with its Task, replan not prepared;
 * (18) replan executing, response lost; (19) replan succeeded with a
 * proposal, Task not addressed; (20) second synthesis integrated, second Gate
 * not opened.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcceptanceCriterionId, PlanNodeId, RequirementId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { coordinatorNode, proposal, propose, synthesisStep, turn, turnsOf, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import { evaluatorsOf, finishRoot, gateEvaluatorStep, gatesOf, orchestratorStep, remediationOf, rootTurnsOf, scriptByRole, seedCriteria, singleExpression, until, workerStep } from "./gate-test-support.ts";
import { FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  /** The Integration Workspace and the verification views survive a process, like the real ones do. */
  integration: FakeIntegrationWorkspace;
  checks: FakeAcceptanceCriterionExecution;
  runId: RunId;
  nodeId: PlanNodeId;
  deterministic: AcceptanceCriterionId[];
  evaluated: AcceptanceCriterionId[];
  leafIds: RequirementId[];
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
    gates: gatesOf(h, w.nodeId).map((g) => [g.ordinal, g.status]),
    evaluators: gatesOf(h, w.nodeId).reduce((n, g) => n + evaluatorsOf(h, g.id).length, 0),
    invocations: h.stores.invocations.listByRun(w.runId).length,
    attempts: h.stores.invocations.listByRun(w.runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    commands: w.checks.observed.length,
    outputs: h.stores.artifacts.listByRun(w.runId).filter((a) => a.title?.startsWith("check ") === true).length,
    evaluations: h.stores.evaluations.listByRun(w.runId).filter((e) => e.gateId !== null).length,
    tasks: h.stores.tasks.listRemediationTasks(w.runId).map((t) => t.status),
    rootTurns: rootTurnsOf(h, w.runId).map((t) => t.purpose),
    handoffs: h.stores.handoffs.listByRun(w.runId).length,
    integrated: h.stores.changesets.listByRun(w.runId).filter((c) => c.integrationStatus === "integrated").length,
    changesets: h.stores.changesets.listByRun(w.runId).length,
    node: h.stores.plans.getNode(w.nodeId).status,
  };
}

/** The projection's canonical actions, as a process would perform them next. */
const nextActions = (h: RuntimeHarness, w: World) => h.scheduler.reconcileRun(w.runId).actions.map((a) => a.kind);

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration: new FakeIntegrationWorkspace(sha256Hex), checks: new FakeAcceptanceCriterionExecution(), runId: undefined as never, nodeId: undefined as never, deterministic: [], evaluated: [], leafIds: [] };
}

/** Performs single actions until `done` holds; the provider is asked only for what a single action executes. */
async function stepUntil(h: RuntimeHarness, w: World, done: () => boolean): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 100 && !done(); i += 1) {
    const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
    if (pass.failure) throw new Error(pass.failure.message);
    kinds.push(...pass.actions.map((p) => p.action.kind));
    if (pass.actions.length === 0 && pass.stop !== "waiting") break;
  }
  if (!done()) throw new Error(`the Run did not reach the expected state after ${kinds.join(", ")}`);
  return kinds;
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

describe("node_exit Gate restart", () => {
  it("converges across the sixteen windows of a root-remediated Gate cycle without repeating a Worker, check, Evaluator, Evaluation, Task, Orchestrator turn, or integration", async () => {
    const w = newWorld("agentique-gate-");
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
        w.deterministic = criteria.deterministic;
        w.evaluated = criteria.evaluated;
        w.nodeId = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]).nodes[0]!.id;
        await finishRoot(h, s);
      }, { recover: false });
      let before = await withProcess(w, async (h) => {
        // Window 1: the Worker is prepared and executing; the process dies before any response.
        h.provider.script({ kind: "hang" });
        await dieMidAttempt(h, w, 1);
        return work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(work(h, w)).toEqual(before);
        expect(h.stores.invocations.listByPlanNode(w.nodeId).flatMap((i) => h.stores.invocations.listAttempts(i.id).map((a) => a.status))).toEqual(["interrupted"]);
        // Window 2: the retried Worker succeeds; the process dies with its Changeset pending.
        scriptByRole(h, { worker: [workerStep(h, "a")] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        // The root's own (empty) Changeset was integrated when the first pass settled the root; the Worker's is pending.
        expect(work(h, w)).toMatchObject({ invocations: 2, attempts: 3, integrated: 1, changesets: 2, gates: [] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 3: the Changeset is integrated; the process dies before the Gate opens.
        expect(nextActions(h, w)).toEqual(["settle_node"]);
        // A gated single's settlement integrates the Changeset and leaves the node to its Gate: nothing else changes.
        expect(await oneAction(h, w, "settle_node")).toEqual({ kind: "no_change" });
        expect(work(h, w)).toMatchObject({ integrated: 2, gates: [] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["open_node_gate"]);
        // Window 4: the Gate opens; the process dies before any check.
        expect(await oneAction(h, w, "open_node_gate")).toMatchObject({ kind: "gate_opened", ordinal: 1 });
        expect(work(h, w)).toMatchObject({ gates: [[1, "open"]], commands: 0, evaluations: 0 });
        before = work(h, w);
      });
      const gate1 = await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["run_gate_checks"]);
        // Window 5: the deterministic check is running in its isolated view; the process dies mid-command.
        w.checks.script(w.deterministic[0]!, { kind: "delay", key: "gate-check", then: { kind: "exit", exitCode: 0 } });
        const pass = h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        void pass.catch(() => undefined);
        await until(() => w.checks.delayedKeys.includes("gate-check"));
        expect(work(h, w)).toMatchObject({ evaluations: 0, outputs: 0 });
        return gatesOf(h, w.nodeId)[0]!.id;
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toMatchObject({ ...before, gates: [[1, "open"]], evaluations: 0 });
        expect(w.checks.liveViews.size).toBe(1);
        // The check runs again in a fresh view (the stale one is discarded), and its outcome is recorded once; then Window 6: no Evaluator yet.
        w.checks.script(w.deterministic[0]!, { kind: "exit", exitCode: 0, output: "ok\n" });
        expect(await oneAction(h, w, "run_gate_checks")).toMatchObject({ kind: "gate_verified", verdict: "pass" });
        expect(w.checks.observed.map((o) => [o.acceptanceCriterionId, o.discardedStale, o.outcome])).toEqual([[w.deterministic[0], true, "exited"]]);
        expect(work(h, w)).toMatchObject({ evaluations: 1, outputs: 1, evaluators: 0 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["prepare_gate_evaluator"]);
        // Window 7: the Evaluator is prepared and executing; the process dies before any response.
        h.provider.script({ kind: "hang" });
        await dieMidAttempt(h, w, 1);
        expect(work(h, w)).toMatchObject({ evaluators: 1, evaluations: 1 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(evaluatorsOf(h, gate1).map((e) => [e.status, h.stores.invocations.listAttempts(e.id).map((a) => a.status)])).toEqual([["running", ["interrupted"]]]);
        // Window 8: the retried Evaluator fails the evaluated criterion; the process dies before the verdict is recorded.
        scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "fail")] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ evaluators: 1, evaluations: 1, gates: [[1, "open"]], tasks: [] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 9: the verdict is recorded, the Gate closes failed, its Task exists; the process dies before the root turn.
        expect(nextActions(h, w)).toEqual(["settle_node_gate"]);
        expect(await oneAction(h, w, "settle_node_gate")).toMatchObject({ kind: "gate_failed" });
        expect(work(h, w)).toMatchObject({ evaluations: 2, gates: [[1, "failed"]], tasks: ["pending"], rootTurns: ["operator_input"] });
        expect(h.scheduler.reconcileRun(w.runId).remediating.map((r) => r.nodeId)).toEqual([w.nodeId]);
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(h.runners.single.settleGate(w.nodeId, h.stores.plans.latestRevisionNumber(w.runId))).toEqual({ kind: "no_change" });
        // Window 10: the gate_result turn is prepared; the process dies before it executes.
        expect(await oneAction(h, w, "prepare_gate_remediation")).toMatchObject({ kind: "remediation_prepared" });
        expect(work(h, w)).toMatchObject({ rootTurns: ["operator_input", "gate_result"], tasks: ["running"], attempts: 5 });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        // Window 11: the turn succeeds with a Changeset; the process dies before integration.
        scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+fix" })] });
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ changesets: 3, integrated: 2, tasks: ["running"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 12: the Changeset is integrated; the process dies before the Task is addressed.
        expect(await oneAction(h, w, "settle_gate_remediation")).toMatchObject({ kind: "integrated" });
        expect(work(h, w)).toMatchObject({ integrated: 3, tasks: ["running"], gates: [[1, "failed"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 13: the Task is addressed; the process dies before the second Gate opens.
        expect(await oneAction(h, w, "settle_gate_remediation")).toMatchObject({ kind: "remediation_settled", completed: [expect.any(String)], ended: [] });
        expect(work(h, w)).toMatchObject({ tasks: ["completed"], gates: [[1, "failed"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 14: the second Gate opens on the new Snapshot with the previous candidate; the process dies before its checks.
        expect(await oneAction(h, w, "open_node_gate")).toMatchObject({ kind: "gate_opened", ordinal: 2 });
        const [first, second] = gatesOf(h, w.nodeId);
        expect(second).toMatchObject({ candidateArtifactIds: first!.candidateArtifactIds, snapshotId: h.stores.runs.get(w.runId).integrationSnapshotId });
        expect(second!.snapshotId).not.toBe(first!.snapshotId);
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 15: the check passes and the second Evaluator is prepared; the process dies before it executes.
        expect(await oneAction(h, w, "run_gate_checks")).toMatchObject({ kind: "gate_verified", verdict: "pass" });
        expect(await oneAction(h, w, "prepare_gate_evaluator")).toMatchObject({ kind: "gate_evaluator_prepared" });
        expect(work(h, w)).toMatchObject({ commands: 2, evaluations: 3, evaluators: 2, gates: [[1, "failed"], [2, "open"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // Window 16: the second Evaluator passes; the process dies before the node settles.
        scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "pass")] });
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ node: "running", gates: [[1, "failed"], [2, "open"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        expect(outcome.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node_gate", "gate_passed"]]);
        expect(work(h, w)).toMatchObject({ node: "succeeded", gates: [[1, "failed"], [2, "passed"]], evaluations: 4, evaluators: 2, commands: 2, tasks: ["completed"], rootTurns: ["operator_input", "gate_result"], integrated: 3 });
        expect(h.stores.plans.getNode(w.nodeId).outputArtifactIds).toEqual(gatesOf(h, w.nodeId)[0]!.candidateArtifactIds);
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

  it("converges across the four windows of a Coordinator-remediated Gate without repeating a turn, Task, Worker, synthesis, or Gate", async () => {
    const w = newWorld("agentique-gate-cw-");
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { deterministic: 1 });
        w.deterministic = criteria.deterministic;
        const { node, leafIds } = coordinatorNode(h, s, { gate: criteria.all, bounds: { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 6 } });
        w.nodeId = node.id;
        w.leafIds = leafIds;
        await finishRoot(h, s);
        // Window 17: the first synthesis fails its Gate and the remediation Task exists; the process dies before the replan is prepared.
        w.checks.script(w.deterministic[0]!, { kind: "exit", exitCode: 1, output: "failing\n" });
        scriptByRole(h, { coordinator: [turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]), synthesisStep(h, w.runId, {})], worker: [coordinatorWorkerStep(h, { summary: "a", diff: "+a" })] });
        await stepUntil(h, w, () => gatesOf(h, w.nodeId)[0]?.status === "failed");
        expect(work(h, w)).toMatchObject({ gates: [[1, "failed"]], tasks: ["pending"], rootTurns: ["operator_input"] });
      }, { recover: false });
      let before = await withProcess(w, async (h) => {
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.purpose)).toEqual(["decompose", "synthesize"]);
        expect(nextActions(h, w)).toEqual(["start_position"]);
        expect(h.scheduler.reconcileRun(w.runId).remediating).toEqual([]);
        // Window 18: the replan is prepared with the gate_failed blocker and executing; the process dies before any response.
        h.provider.script({ kind: "hang" });
        await dieMidAttempt(h, w, 1);
        const replan = turnsOf(h, h.stores.plans.getNode(w.nodeId))[2]!;
        expect(replan.purpose).toBe("replan");
        const inputs = h.stores.invocations.getManifest(replan.id).content.inputs;
        expect(inputs.find((i) => i.kind === "coordinator_blocker")).toMatchObject({ blocker: { kind: "gate_failed", gateId: gatesOf(h, w.nodeId)[0]!.id } });
        expect(inputs.some((i) => i.kind === "gate_result")).toBe(true);
        return work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.purpose)).toEqual(["decompose", "synthesize", "replan"]);
        // Window 19: the retried replan proposes the fix Task; the process dies before the remediation Task is addressed.
        scriptByRole(h, { coordinator: [turn([propose([proposal({ key: "fix", requirementIds: [w.leafIds[1]!] })])])] });
        expect(nextActions(h, w)).toEqual(["execute_invocation"]);
        await oneAction(h, w, "execute_invocation");
        expect(work(h, w)).toMatchObject({ tasks: ["pending"] });
        expect(h.stores.tasks.listByPlanNode(w.nodeId).filter((t) => t.origin === "coordinator")).toHaveLength(2);
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        // The replan's own (empty) Changeset is integrated first; the process dies before the remediation Task is addressed.
        expect(nextActions(h, w)).toEqual(["settle_node"]);
        expect(await oneAction(h, w, "settle_node")).toMatchObject({ kind: "integrated" });
        expect(work(h, w)).toMatchObject({ tasks: ["pending"] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["settle_node"]);
        expect(await oneAction(h, w, "settle_node")).toMatchObject({ kind: "gate_remediation_addressed" });
        expect(work(h, w)).toMatchObject({ tasks: ["completed"], gates: [[1, "failed"]] });
        // Window 20: the fix Worker runs and the second synthesis is integrated; the process dies before the second Gate opens.
        scriptByRole(h, { worker: [coordinatorWorkerStep(h, { summary: "fix", diff: "+fix" })], coordinator: [synthesisStep(h, w.runId, {})] });
        await stepUntil(h, w, () => {
          const turns = turnsOf(h, h.stores.plans.getNode(w.nodeId));
          const synthesis = turns[3];
          return synthesis?.purpose === "synthesize" && synthesis.status === "succeeded" && h.stores.changesets.listByRun(w.runId).every((c) => c.integrationStatus === "integrated") && nextActions(h, w)[0] === "open_node_gate";
        });
        expect(work(h, w)).toMatchObject({ gates: [[1, "failed"]] });
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(nextActions(h, w)).toEqual(["open_node_gate"]);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        expect(outcome.actions.map((p) => p.action.kind)).toEqual(["open_node_gate", "run_gate_checks", "settle_node_gate"]);
        expect(work(h, w)).toMatchObject({ node: "succeeded", gates: [[1, "failed"], [2, "passed"]], tasks: ["completed"], commands: 2, rootTurns: ["operator_input"] });
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.purpose)).toEqual(["decompose", "synthesize", "replan", "synthesize"]);
        before = work(h, w);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
