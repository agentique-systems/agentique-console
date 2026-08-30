/**
 * Restart and idempotence of the evaluator_optimizer Pattern (execution-model
 * §5.6, §14 "Server restart"; invariants 6 no transcript decides anything,
 * 11 deterministic verification precedes LLM evaluation, 20 one Invocation
 * per logical turn): every crash window is closed from canonical rows
 * alone, over a file-backed database opened by successive processes, without
 * a duplicate producer, Evaluator, deterministic command result, output
 * Artifact, criterion Evaluation, overall Evaluation, Handoff, integration,
 * retry activation, or terminal transition — and the projection after a
 * reopen is identical.
 *
 * Windows: (1) producer prepared, provider not called; (2) producer result
 * committed, Changeset not integrated; (3) Changeset applied externally,
 * record missing; (4) integration recorded, command not run; (5) command
 * ran, output Artifact not recorded; (7) deterministic failure recorded,
 * overall verdict missing; (8) deterministic pass recorded, Evaluator not
 * prepared; (9) Evaluator result committed, overall Evaluation missing; (10)
 * overall failure recorded, next producer not prepared; (11) retry verdict
 * recorded, retry target not readied; (12) overall pass recorded, later
 * rounds not yet skipped; (13) final failure recorded, node not settled;
 * (14) final pass recorded, node not settled; (15) approval continuation
 * during a producer round; (16) restart with a stale verification workspace.
 * Window (6) cannot occur: the output Artifact and its criterion Evaluation
 * share one transaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcceptanceCriterionId, PlanNodeId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { criterionEvaluationsOf, evaluatorsOf, evaluatorStep, finishRoot, optimizerNodes, producersOf, producerStep, seedCriteria, until, verdictsOf } from "./optimizer-test-support.ts";
import { COMPLETED_RESULT, FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };

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
  byPath: Record<string, PlanNodeId>;
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, and the file is always closed. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), integrationWorkspace: w.integration, criterionExecution: w.checks });
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
  const nodes = Object.values(w.byPath);
  return {
    producers: nodes.reduce((n, id) => n + producersOf(h, id).length, 0),
    evaluators: nodes.reduce((n, id) => n + evaluatorsOf(h, id).length, 0),
    invocations: h.stores.invocations.listByRun(w.runId).length,
    attempts: h.stores.invocations.listByRun(w.runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    commands: w.checks.observed.length,
    outputs: h.stores.artifacts.listByRun(w.runId).filter((a) => a.title?.startsWith("check ") === true).length,
    criterionEvaluations: h.stores.evaluations.listByRun(w.runId).filter((e) => e.context?.kind === "optimizer_criterion").length,
    verdicts: h.stores.evaluations.listByRun(w.runId).filter((e) => e.context?.kind === "optimizer_verdict").length,
    handoffs: h.stores.handoffs.listByRun(w.runId).length,
    integrated: h.stores.changesets.listByRun(w.runId).filter((c) => c.integrationStatus === "integrated").length,
    events: h.ctx.journal.lastSeq(),
  };
}

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration: new FakeIntegrationWorkspace(sha256Hex), checks: new FakeAcceptanceCriterionExecution(), runId: undefined as never, nodeId: undefined as never, deterministic: [], evaluated: [], byPath: {} };
}

/** Seeds the Run, the optimizer node(s), and finishes the root turn in the first process. */
async function seedWorld(w: World, options: { maxRounds: number; producerSteps?: string[]; after?: string[]; deterministic?: number; evaluated?: number }) {
  await withProcess(w, async (h) => {
    w.clock = h.clock;
    w.blobs = h.blobs;
    const s = seedPlanningRuntime(h);
    w.runId = s.created.run.id;
    const criteria = seedCriteria(h, s, { deterministic: options.deterministic ?? 1, evaluated: options.evaluated ?? 1 });
    w.deterministic = criteria.deterministic;
    w.evaluated = criteria.evaluated;
    const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: options.maxRounds, producerSteps: options.producerSteps, after: options.after });
    w.byPath = Object.fromEntries(Object.entries(byPath).map(([p, n]) => [p, n.id]));
    w.nodeId = (byPath["e0"] ?? byPath["e0/steps/0"] ?? byPath["e0/steps/0/rounds/1/evaluate"] ?? byPath["e0/rounds/1/evaluate"])!.id;
    await finishRoot(h, s);
  }, { recover: false });
}

const statusOf = (h: RuntimeHarness, id: PlanNodeId) => h.stores.plans.getNode(id).status;

describe("evaluator_optimizer restart", () => {
  it("converges across every inline round window without repeating a producer, command, Artifact, Evaluation, Handoff, integration, or Evaluator", async () => {
    const w = newWorld("agentique-eo-");
    try {
      await seedWorld(w, { maxRounds: 2, deterministic: 2, evaluated: 1 });
      // Window 1: the producer is prepared and the provider hangs; the process dies before any result.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.provider.requests.length === 1);
        expect(work(h, w)).toMatchObject({ producers: 1, evaluators: 0, attempts: 2 });
      });
      // Window 2: the retry Attempt completes with the candidate; the process dies with the Changeset pending.
      await withProcess(w, async (h) => {
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(h.stores.invocations.listAttempts(producersOf(h, w.nodeId)[0]!.id).map((a) => a.status)).toEqual(["interrupted"]);
        h.provider.script(producerStep(h, "v1"));
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => p.action.kind)).toEqual(["execute_invocation"]);
        expect(producersOf(h, w.nodeId)[0]!.status).toBe("succeeded");
        expect(h.stores.changesets.listByRun(w.runId).at(-1)!.integrationStatus).toBe("pending");
        expect(work(h, w)).toMatchObject({ producers: 1, attempts: 3, verdicts: 0 });
      });
      // Window 3: the Changeset is applied externally but the process dies before the record.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        h.integrationWorkspace.crashAfterApply = true;
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect(work(h, w)).toEqual(before);
        expect(h.stores.changesets.listByRun(w.runId).at(-1)!.integrationStatus).toBe("pending");
      });
      // Window 4: the application already holds; persistence catches up once; the process dies before any command runs.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node", "integrated"]]);
        expect(work(h, w)).toEqual({ ...before, integrated: before.integrated + 1, events: work(h, w).events });
        expect(h.runners.evaluatorOptimizer.inspect(w.nodeId)).toEqual({ kind: "verify", round: 1 });
        expect(w.checks.observed).toEqual([]);
      });
      // Window 5: the first command runs, then the process dies before its record (its view stays live); the second command never started.
      await withProcess(w, async (h) => {
        w.checks.script(w.deterministic[0]!, { kind: "exit", exitCode: 0 });
        w.checks.crashBeforeDispose = true;
        const write = h.ctx.tx.write.bind(h.ctx.tx);
        let died = false;
        h.ctx.tx.write = ((fn: () => unknown) => {
          if (!died && w.checks.observed.length === 1) {
            died = true;
            throw new Error("process died before recording the check");
          }
          return write(fn);
        }) as typeof h.ctx.tx.write;
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        h.ctx.tx.write = write;
        w.checks.crashBeforeDispose = false;
        expect(work(h, w)).toMatchObject({ commands: 1, outputs: 0, criterionEvaluations: 0, verdicts: 0 });
        expect(w.checks.liveViews.size).toBe(1);
      });
      // Window 16 then 7: the stale view is discarded and the first command reruns; the second fails; the process dies after the criterion
      // Evaluation and the runtime verdict were committed together — so the "verdict missing" window is closed by construction; a
      // manually removed verdict is repaired from the criterion row alone.
      await withProcess(w, async (h) => {
        w.checks.script(w.deterministic[1]!, { kind: "exit", exitCode: 1, output: "lint failed\n" });
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["verify_node", "verified"]]);
        expect(pass.actions[0]!.outcome).toMatchObject({ kind: "verified", round: 1, verdict: "fail" });
        expect(w.checks.observed.map((o) => [o.acceptanceCriterionId, o.discardedStale])).toEqual([[w.deterministic[0], false], [w.deterministic[0], true], [w.deterministic[1], false]]);
        expect(w.checks.liveViews.size).toBe(0);
        expect(work(h, w)).toMatchObject({ commands: 3, outputs: 2, criterionEvaluations: 2, verdicts: 1, evaluators: 0 });
        expect(verdictsOf(h, w.nodeId)[0]).toMatchObject({ verdict: "fail", producedBy: { kind: "runtime" }, context: { round: 1 } });
      });
      // Window 10: the overall failure is recorded and the process dies before the next producer is prepared.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        expect(h.runners.evaluatorOptimizer.inspect(w.nodeId)).toEqual({ kind: "settle", invocationId: producersOf(h, w.nodeId)[0]!.id });
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node", "started"]]);
        expect(work(h, w)).toMatchObject({ ...before, producers: 2, invocations: before.invocations + 1, handoffs: before.handoffs + 1, events: work(h, w).events });
        const [p1, p2] = producersOf(h, w.nodeId);
        expect(p2!.continuedFromInvocationId).toBe(p1!.id);
        expect(h.stores.invocations.getManifest(p2!.id).content.inputs).toEqual([expect.objectContaining({ kind: "optimizer_feedback", round: 1, verdict: "fail" })]);
      });
      // Window 15: round 2's producer blocks on an approval; the process dies; the successor continues at the same position after resolution.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: producerStep(h, "v2") });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        const p2 = producersOf(h, w.nodeId)[1]!;
        expect(p2.status).toBe("blocked");
        h.stores.decisions.resolve(p2.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      });
      // Window 8: the successor completes round 2's candidate, both checks pass, and the process dies before the Evaluator is prepared.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: producerStep(h, "v2b") });
        const settle = h.runners.evaluatorOptimizer.settle.bind(h.runners.evaluatorOptimizer);
        h.runners.evaluatorOptimizer.settle = async (nodeId, revision, options) => {
          if (criterionEvaluationsOf(h, w.nodeId, 2).length === 2) throw new Error("process died before preparing the Evaluator");
          return settle(nodeId, revision, options);
        };
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect(producersOf(h, w.nodeId).map((p) => p.status)).toEqual(["succeeded", "blocked", "succeeded"]);
        expect(work(h, w)).toMatchObject({ producers: 3, evaluators: 0, commands: 5, outputs: 4, criterionEvaluations: 4, verdicts: 1 });
      });
      // Window 9: the Evaluator's result is committed and the process dies before the overall Evaluation is recorded.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        h.provider.script(evaluatorStep(h, "pass"));
        const settle = h.runners.evaluatorOptimizer.settle.bind(h.runners.evaluatorOptimizer);
        h.runners.evaluatorOptimizer.settle = async (nodeId, revision, options) => {
          const evaluator = evaluatorsOf(h, w.nodeId)[0];
          if (evaluator !== undefined && evaluator.status === "succeeded") throw new Error("process died before recording the verdict");
          return settle(nodeId, revision, options);
        };
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect(work(h, w)).toMatchObject({ ...before, evaluators: 1, invocations: before.invocations + 1, attempts: before.attempts + 1, handoffs: before.handoffs + 1, verdicts: 1, events: work(h, w).events });
        expect(evaluatorsOf(h, w.nodeId)[0]!.status).toBe("succeeded");
      });
      // Window 14: the pass verdict is recorded from the committed result and the process dies before the node settles.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const succeedNow = h.runners.evaluatorOptimizer["support"].succeedNow.bind(h.runners.evaluatorOptimizer["support"]);
        h.runners.evaluatorOptimizer["support"].succeedNow = () => {
          throw new Error("process died before settling the node");
        };
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        h.runners.evaluatorOptimizer["support"].succeedNow = succeedNow;
        // The transaction rolled back as a whole: no verdict was left behind without the settlement.
        expect(work(h, w)).toMatchObject({ ...before, verdicts: 1, events: work(h, w).events });
        expect(statusOf(h, w.nodeId)).toBe("running");
      });
      // Settlement: the verdict and the node's success land together; nothing is repeated afterwards.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome).toMatchObject({ stop: "quiescent", failure: null });
        expect(h.provider.requests).toHaveLength(0);
        expect(statusOf(h, w.nodeId)).toBe("succeeded");
        expect(verdictsOf(h, w.nodeId).map((v) => [v.context!.round, v.verdict])).toEqual([[1, "fail"], [2, "pass"]]);
        expect(criterionEvaluationsOf(h, w.nodeId, 2).map((e) => e.producedBy.kind).sort()).toEqual(["evaluator", "runtime", "runtime"]);
        expect(work(h, w)).toMatchObject({ ...before, verdicts: 2, criterionEvaluations: 5, events: work(h, w).events });
        expect(h.stores.plans.getNode(w.nodeId).outputArtifactIds).toEqual(producersOf(h, w.nodeId)[2]!.result!.artifactIds);
      });
      await withProcess(w, async (h) => {
        const before = work(h, w);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w)).toEqual(before);
        expect(w.checks.observed).toHaveLength(5);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("converges across the evaluate-only windows: a retry verdict recorded before its target is readied, a pass before later rounds are skipped, and a final failure before settlement — with an identical projection after every reopen", async () => {
    const w = newWorld("agentique-eo-edges-");
    try {
      await seedWorld(w, { maxRounds: 3, producerSteps: ["a", "b"], after: ["next"], deterministic: 1, evaluated: 1 });
      const e = (round: number) => w.byPath[`e0/steps/0/rounds/${round}/evaluate`]!;
      const p = (round: number) => w.byPath[`e0/steps/0/rounds/${round}/producer`]!;
      const next = w.byPath["e0/steps/1"]!;
      // Round 1's producer chain runs and E1's Evaluator fails; the process dies right after the verdict and E1's control success, before P2 is readied (window 11).
      await withProcess(w, async (h) => {
        h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "fail"));
        const ready = h.scheduler["#applyReadiness" as never];
        void ready;
        let settledE1 = false;
        const settle = h.runners.evaluatorOptimizer.settle.bind(h.runners.evaluatorOptimizer);
        h.runners.evaluatorOptimizer.settle = async (nodeId, revision, options) => {
          const outcome = await settle(nodeId, revision, options);
          if (outcome.kind === "succeeded") settledE1 = true;
          return outcome;
        };
        const reconcile = h.scheduler.reconcileRun.bind(h.scheduler);
        h.scheduler.reconcileRun = (runId, now) => {
          if (settledE1) throw new Error("process died before readying the retry target");
          return reconcile(runId, now);
        };
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect(statusOf(h, e(1))).toBe("succeeded");
        expect(statusOf(h, p(2))).toBe("pending");
        expect(verdictsOf(h, e(1)).map((v) => v.verdict)).toEqual(["fail"]);
        expect(h.stores.handoffs.getByKey(w.runId, `retry:${e(1)}:${p(2)}`)).not.toBeNull();
      });
      // The reopened projection is identical to the one the previous process would have computed, and readies exactly P2.
      let projected: string;
      await withProcess(w, async (h) => {
        const projection = h.scheduler.reconcileRun(w.runId);
        projected = JSON.stringify(projection);
        expect(projection.actions).toEqual([{ kind: "ready_node", nodeId: p(2) }]);
        expect(JSON.stringify(h.scheduler.reconcileRun(w.runId))).toBe(projected);
      });
      await withProcess(w, async (h) => {
        expect(JSON.stringify(h.scheduler.reconcileRun(w.runId))).toBe(projected);
        // Round 2 passes; the process dies right after E2's verdict and success, before round 3 is skipped (window 12).
        h.provider.script(producerStep(h, "a2"), producerStep(h, "b2"), evaluatorStep(h, "pass"));
        let passed = false;
        const settle = h.runners.evaluatorOptimizer.settle.bind(h.runners.evaluatorOptimizer);
        h.runners.evaluatorOptimizer.settle = async (nodeId, revision, options) => {
          const outcome = await settle(nodeId, revision, options);
          if (outcome.kind === "succeeded" && nodeId === e(2)) passed = true;
          return outcome;
        };
        const reconcile = h.scheduler.reconcileRun.bind(h.scheduler);
        h.scheduler.reconcileRun = (runId, now) => {
          if (passed) throw new Error("process died before skipping the later rounds");
          return reconcile(runId, now);
        };
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect([statusOf(h, e(2)), statusOf(h, p(3)), statusOf(h, e(3)), statusOf(h, next)]).toEqual(["succeeded", "pending", "pending", "pending"]);
      });
      // The next process skips round 3 from the verdict fact, runs the successor with E2's candidate, and repeats nothing.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome).toMatchObject({ stop: "quiescent", failure: null });
        expect([statusOf(h, p(3)), statusOf(h, e(3)), statusOf(h, next)]).toEqual(["skipped", "skipped", "succeeded"]);
        expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(next)[0]!.id).content.handoffs.map((x) => x.artifactIds)).toEqual([h.stores.plans.getNode(e(2)).outputArtifactIds]);
        // The successor's sequence Handoff already existed (created with E2's success); only its Invocation, Attempt, and integration are new.
        expect(work(h, w)).toMatchObject({ ...before, invocations: before.invocations + 1, attempts: before.attempts + 1, integrated: before.integrated + 1, events: work(h, w).events });
        expect(work(h, w)).toMatchObject({ evaluators: 2, verdicts: 2, criterionEvaluations: 4, commands: 2 });
        expect(h.stores.handoffs.listByRun(w.runId).map((x) => x.handoffKey).filter((k) => k.startsWith("retry:"))).toEqual([`retry:${e(1)}:${p(2)}`]);
      });
      await withProcess(w, async (h) => {
        const before = work(h, w);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
    // Window 13: a final failure recorded, the node not yet settled.
    const f = newWorld("agentique-eo-final-");
    try {
      await seedWorld(f, { maxRounds: 1, producerSteps: ["a", "b"], after: ["next"], deterministic: 0, evaluated: 1 });
      const e1 = f.byPath["e0/steps/0/rounds/1/evaluate"]!;
      const next = f.byPath["e0/steps/1"]!;
      await withProcess(f, async (h) => {
        h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "fail"));
        const failNow = h.runners.evaluatorOptimizer["support"].failNow.bind(h.runners.evaluatorOptimizer["support"]);
        h.runners.evaluatorOptimizer["support"].failNow = () => {
          throw new Error("process died before failing the node");
        };
        expect((await h.scheduler.advanceRun(f.runId)).stop).toBe("infrastructure_failure");
        h.runners.evaluatorOptimizer["support"].failNow = failNow;
        // The verdict and the failure share one transaction: nothing of either was left behind.
        expect(verdictsOf(h, e1)).toEqual([]);
        expect(statusOf(h, e1)).toBe("running");
        expect(evaluatorsOf(h, e1)[0]!.status).toBe("succeeded");
      });
      await withProcess(f, async (h) => {
        const outcome = await h.scheduler.advanceRun(f.runId);
        expect(outcome).toMatchObject({ stop: "quiescent", failure: null });
        expect(h.provider.requests).toHaveLength(0);
        expect(verdictsOf(h, e1).map((v) => v.verdict)).toEqual(["fail"]);
        expect([statusOf(h, e1), statusOf(h, next)]).toEqual(["failed", "skipped"]);
        expect(h.ctx.journal.read({ runId: f.runId, type: "plan_node.failed" }).map((x) => x.payload)).toEqual([expect.objectContaining({ reason: "optimizer_rounds_exhausted" })]);
      });
      await withProcess(f, async (h) => {
        const before = work(h, f);
        expect(await h.scheduler.advanceRun(f.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, f)).toEqual(before);
      });
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("never repeats a producer round or an Evaluator on repeated settlement of the same rows", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { evaluated: 1 });
      const { byPath, revisionNumber } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      h.provider.script(producerStep(h, "v1"), evaluatorStep(h, "fail"));
      await h.scheduler.advanceRun(s.created.run.id, { maxActions: 7 });
      // Two settlements of the same terminal Evaluator race in one process: one records the verdict and prepares round 2, the other writes nothing.
      const [first, second] = await Promise.all([h.runners.evaluatorOptimizer.settle(node.id, revisionNumber), h.runners.evaluatorOptimizer.settle(node.id, revisionNumber)]);
      expect([first.kind, second.kind].sort()).toEqual(["no_change", "started"]);
      expect(verdictsOf(h, node)).toHaveLength(1);
      expect(producersOf(h, node)).toHaveLength(2);
      expect(await h.runners.evaluatorOptimizer.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.runners.evaluatorOptimizer.start(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey).sort()).toEqual([`optimizer_candidate:${node.id}:1`, `optimizer_feedback:${node.id}:1`]);
      // The default provider result is not a valid Evaluator result, so a scripted pass ends the node.
      h.provider.script(producerStep(h, "v2"), evaluatorStep(h, "pass"));
      expect((await h.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      expect(h.provider.requests.filter((r) => r.request.input.text.includes("evaluator round"))).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

/** Keeps the fixture type visible for the world builder. */
export type _World = World & { seed?: typeof COMPLETED_RESULT };
