/**
 * Restart and idempotence of the coordinator_worker Pattern (execution-model
 * §5.5, §14 "Server restart"; invariants 6 no transcript decides anything,
 * 20 one Invocation per logical turn, 22 atomic allocation): every crash
 * window is closed from canonical rows alone, over a file-backed database
 * opened by successive processes, without a duplicate proposal, Task,
 * dependency, reservation, Worker, Coordinator turn, Handoff, integration,
 * or synthesis.
 *
 * Windows: (1) proposal committed, provider response lost; (2) Task and
 * reservation committed, Worker not prepared; (3) reservation transferred,
 * provider not called; (4) Worker result committed, Changeset not
 * integrated; (5) Changeset applied externally, record missing; (6) Worker
 * integrated, Handoff missing; (7) blocker frontier exists, replan not
 * prepared; (8) replan mutation committed, response lost; (9) every Task
 * resolved, synthesis not prepared; (10) synthesis succeeded, node not
 * settled; (11) Workspace release pending; (12) approval claim committed,
 * external call uncertain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactId, PlanNodeId, RequirementId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { coordinatorNode, finishRoot, proposal, propose, seedApprovalCoordinator, synthesisStep, tasksOf, turn, turnsOf, until, WIDE_GOVERNOR, workersOf, workerStep } from "./coordinator-test-support.ts";
import { COMPLETED_RESULT, FakeIntegrationWorkspace, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  /** The Integration Workspace survives a process, like the real one does. */
  integration: FakeIntegrationWorkspace;
  runId: RunId;
  nodeId: PlanNodeId;
  leafIds: RequirementId[];
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, and the file is always closed. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration });
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
  const node = h.stores.plans.getNode(w.nodeId);
  return {
    proposals: h.stores.runtimeToolCalls.listByPlanNode(w.nodeId).filter((c) => c.tool === "propose_tasks").length,
    calls: h.stores.runtimeToolCalls.listByPlanNode(w.nodeId).length,
    tasks: tasksOf(h, node).length,
    dependencies: h.stores.tasks.dependencies(w.runId).length,
    reservations: h.stores.reservations.listByParent({ type: "plan_node", id: w.nodeId }).length,
    workers: workersOf(h, node).length,
    turns: turnsOf(h, node).length,
    handoffs: h.stores.handoffs.listByRun(w.runId).length,
    integrated: h.stores.changesets.listByRun(w.runId).filter((c) => c.integrationStatus === "integrated").length,
    attempts: h.stores.invocations.listByRun(w.runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
  };
}

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration: new FakeIntegrationWorkspace(sha256Hex), runId: undefined as never, nodeId: undefined as never, leafIds: [] };
}

/** Seeds the Run, the coordinator node, and finishes the root turn in the first process. */
async function seedWorld(w: World, options: Parameters<typeof coordinatorNode>[2] = {}) {
  await withProcess(w, async (h) => {
    w.clock = h.clock;
    w.blobs = h.blobs;
    const s = seedPlanningRuntime(h);
    w.runId = s.created.run.id;
    const { node, leafIds } = coordinatorNode(h, s, options);
    w.nodeId = node.id;
    w.leafIds = leafIds;
    await finishRoot(h, s);
  }, { recover: false });
}

describe("coordinator_worker restart", () => {
  it("converges across the proposal, Worker, integration, Handoff, synthesis, and settlement windows without repeating anything", async () => {
    const w = newWorld("agentique-cw-");
    try {
      await seedWorld(w);
      const batch = () => propose([proposal({ key: "a", requirementIds: [w.leafIds[0]!] }), proposal({ key: "b", requirementIds: [w.leafIds[1]!], dependsOnKeys: ["a"] })]);
      // Window 1 (and 2): the decompose accepts its proposal, then the provider hangs; the process dies with Tasks and reservations committed and no Worker.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "runtime_tool_calls", calls: [batch()], then: { kind: "hang" } });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.stores.runtimeToolCalls.listByPlanNode(w.nodeId).length === 1);
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 2, dependencies: 1, reservations: 3, workers: 0, turns: 1 });
        expect(tasksOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.status)).toEqual(["pending", "pending"]);
      });
      // The retry replays the proposal and completes; Worker a is prepared (its reservation transferred) and the process dies before the provider is reached (window 3).
      await withProcess(w, async (h) => {
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(h.stores.invocations.listAttempts(turnsOf(h, h.stores.plans.getNode(w.nodeId))[0]!.id).map((a) => a.status)).toEqual(["interrupted"]);
        h.provider.script({ kind: "runtime_tool_calls", calls: [batch()], then: { kind: "succeed", result: COMPLETED_RESULT } }, { kind: "hang" });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => workersOf(h, h.stores.plans.getNode(w.nodeId)).length === 1 && h.provider.requests.length === 2);
        expect(h.provider.runtimeToolCalls.map((c) => c.outcome.kind === "accepted" && c.outcome.replayed)).toEqual([true]);
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 2, workers: 1, turns: 1 });
        const a = tasksOf(h, h.stores.plans.getNode(w.nodeId))[0]!;
        expect(h.stores.tasks.get(a.id)).toMatchObject({ status: "running" });
        expect(h.stores.reservations.listByChild({ type: "task", id: a.id })[0]).toMatchObject({ status: "released", releaseReason: "transferred_to_invocation" });
      });
      // Worker a's retry completes; Worker b runs; the process dies with b's result committed and nothing integrated (window 4).
      await withProcess(w, async (h) => {
        const before = work(h, w);
        expect(before.workers).toBe(1);
        h.provider.script(workerStep(h, { summary: "a", diff: "+a" }), workerStep(h, { summary: "b", diff: "+b" }));
        const settle = h.runners.coordinatorWorker.settle.bind(h.runners.coordinatorWorker);
        let workerDone = 0;
        h.runners.coordinatorWorker.settle = async (nodeId, revision, options) => {
          const node = h.stores.plans.getNode(nodeId);
          if (tasksOf(h, node).every((t) => t.status === "completed")) throw new Error("process died before integrating");
          workerDone += 1;
          return settle(nodeId, revision, options);
        };
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("infrastructure_failure");
        expect(workerDone).toBeGreaterThan(0);
        expect(tasksOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.status)).toEqual(["completed", "completed"]);
        // a was integrated and handed off in canonical order before b completed; b's result is committed with its Changeset pending.
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 2, workers: 2, turns: 1, handoffs: 1 });
        expect(h.stores.changesets.listByRun(w.runId).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated", "integrated", "pending"]);
      });
      // Window 5: b's Changeset is applied externally but the process dies before the record.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const requests = h.integrationWorkspace.requests.length;
        h.integrationWorkspace.crashAfterApply = true;
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("infrastructure_failure");
        expect(work(h, w)).toEqual(before);
        expect(h.integrationWorkspace.requests).toHaveLength(requests + 1);
        expect(h.stores.changesets.listByRun(w.runId).at(-1)!.integrationStatus).toBe("pending");
      });
      // The external application already holds; persistence catches up exactly once and the process stops before b's Handoff (window 6).
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const observed = h.integrationWorkspace.observed.length;
        const first = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(first.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node", "integrated"]]);
        expect(h.integrationWorkspace.observed).toHaveLength(observed + 1);
        expect(work(h, w)).toEqual({ ...before, integrated: before.integrated + 1 });
        expect(h.stores.handoffs.listByRun(w.runId)).toHaveLength(1);
      });
      // Window 9: b's Handoff is recorded and the process stops once every Task is resolved but before synthesis is prepared.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node", "worker_result_recorded"]]);
        expect(work(h, w)).toEqual({ ...before, handoffs: 2 });
        expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([{ kind: "start_position", nodeId: w.nodeId, position: { kind: "coordinator_turn" }, turn: "synthesize" }]);
      });
      // Synthesis is prepared and its provider call hangs; the retry succeeds but the process dies before settlement (window 10).
      let final!: ArtifactId;
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.provider.requests.length === 1);
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => [t.purpose, t.status])).toEqual([["decompose", "succeeded"], ["synthesize", "running"]]);
      });
      await withProcess(w, async (h) => {
        const holder: { artifactId?: ArtifactId } = {};
        h.provider.script(synthesisStep(h, w.runId, holder));
        const settle = h.runners.coordinatorWorker.settle.bind(h.runners.coordinatorWorker);
        h.runners.coordinatorWorker.settle = async () => {
          throw new Error("process died before settling the synthesis");
        };
        const outcome = await h.scheduler.advanceRun(w.runId);
        h.runners.coordinatorWorker.settle = settle;
        expect(outcome.stop).toBe("infrastructure_failure");
        final = holder.artifactId!;
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.status)).toEqual(["succeeded", "succeeded"]);
        expect(h.stores.plans.getNode(w.nodeId).status).toBe("running");
      });
      // Settlement: the node succeeds with the synthesis output; nothing was repeated; a further restart changes nothing.
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        // Only the ended node's result reaches the Orchestrator as one node_result turn (execution-model §4.6); the Coordinator node itself repeats nothing.
        expect(h.provider.requests.map((r) => h.stores.invocations.get(h.stores.invocations.getAttempt(r.attemptId).invocationId).purpose)).toEqual(["node_result"]);
        expect(h.stores.plans.getNode(w.nodeId)).toMatchObject({ status: "succeeded", outputArtifactIds: [final] });
        // The synthesis integrated and the node_result turn ran and integrated: one Attempt and two integrations beyond `before`.
        expect(work(h, w)).toEqual({ ...before, attempts: before.attempts + 1, integrated: before.integrated + 2 });
        expect(work(h, w)).toMatchObject({ proposals: 1, calls: 1, tasks: 2, dependencies: 1, workers: 2, turns: 2, handoffs: 2, integrated: 6 });
        // Worker manifests and Handoffs read back from rows; no transcript was consulted (the fake wrote transcripts, nobody read them).
        expect(h.stores.changesets.listByRun(w.runId).every((c) => c.integrationStatus === "integrated")).toBe(true);
      });
      await withProcess(w, async (h) => {
        const before = work(h, w);
        const seq = h.ctx.journal.lastSeq();
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(h.ctx.journal.lastSeq()).toBe(seq);
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("converges across the blocker-frontier and replan windows: one replan turn, one replacement, no duplicate after a lost replan response", async () => {
    const w = newWorld("agentique-cw-replan-");
    try {
      await seedWorld(w);
      // The one Task fails; the process stops with the frontier standing and no replan prepared (window 7).
      await withProcess(w, async (h) => {
        h.provider.script(turn([propose([proposal({ key: "a", requirementIds: [w.leafIds[0]!] })])]), workerStep(h, { status: "failed" }));
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 8 });
        expect(pass.actions.map((p) => p.action.kind)).toContain("execute_invocation");
        expect(tasksOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => t.status)).toEqual(["failed"]);
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId))).toHaveLength(1);
        expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([{ kind: "start_position", nodeId: w.nodeId, position: { kind: "coordinator_turn" }, turn: "replan" }]);
      });
      // The replan is prepared with the one blocker; it accepts a replacement, then the provider hangs (window 8).
      const replacement = (h: RuntimeHarness) => propose([proposal({ key: "a2", requirementIds: [w.leafIds[0]!], replacesTaskId: tasksOf(h, h.stores.plans.getNode(w.nodeId))[0]!.id })]);
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "derived", step: () => ({ kind: "runtime_tool_calls", calls: [replacement(h)], then: { kind: "hang" } }) });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.stores.runtimeToolCalls.listByPlanNode(w.nodeId).length === 2);
        const turns = turnsOf(h, h.stores.plans.getNode(w.nodeId));
        expect(turns.map((t) => t.purpose)).toEqual(["decompose", "replan"]);
        const manifest = h.stores.invocations.getManifest(turns[1]!.id).content;
        expect(manifest.inputs.filter((i) => i.kind === "coordinator_blocker")).toHaveLength(1);
        expect(work(h, w)).toMatchObject({ proposals: 2, tasks: 2, turns: 2, workers: 1 });
      });
      // The replan retry replays the replacement; the replacement's Worker runs; synthesis completes; every count is one.
      await withProcess(w, async (h) => {
        const holder: { artifactId?: ArtifactId } = {};
        h.provider.script({ kind: "derived", step: () => turn([replacement(h)]) }, workerStep(h, { summary: "a2", diff: "+a2" }), synthesisStep(h, w.runId, holder));
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        expect(h.provider.runtimeToolCalls.map((c) => c.outcome.kind === "accepted" && c.outcome.replayed)).toEqual([true]);
        const node = h.stores.plans.getNode(w.nodeId);
        expect(tasksOf(h, node).map((t) => [t.status, t.replacesTaskId !== null])).toEqual([["failed", false], ["completed", true]]);
        expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "replan", "synthesize"]);
        expect(work(h, w)).toMatchObject({ proposals: 2, calls: 2, tasks: 2, workers: 2, handoffs: 1 });
        expect(node).toMatchObject({ status: "succeeded", outputArtifactIds: [holder.artifactId] });
      });
      await withProcess(w, async (h) => {
        const before = work(h, w);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("retries a pending Workspace release at the next start, and conservatively consumes an approval claim whose external call is uncertain", async () => {
    const w = newWorld("agentique-cw-release-");
    try {
      let coordinator!: string;
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        coordinator = seedApprovalCoordinator(h).id;
        const { node, leafIds } = coordinatorNode(h, s, { coordinator });
        w.nodeId = node.id;
        w.leafIds = leafIds;
        await finishRoot(h, s);
      }, { recover: false });
      const WRITE = { tool: "write", input: { path: "notes.md", content: "plan" } };
      // The decompose accepts its proposal and blocks on a write approval; the Worker never starts while the turn is blocked.
      let decision!: string;
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "runtime_tool_calls", calls: [propose([proposal({ key: "a", requirementIds: [w.leafIds[0]!] })])], then: { kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } } });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        const turnInvocation = turnsOf(h, h.stores.plans.getNode(w.nodeId))[0]!;
        expect(turnInvocation.status).toBe("blocked");
        decision = turnInvocation.blockedByDecisionId!;
        h.stores.decisions.resolve(decision as never, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      });
      // Window 12: the successor claims the approval, then the process dies before the external call is known to have run.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "tool_calls", calls: [WRITE], then: { kind: "hang" } });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.stores.approvedToolCallUses.getByDecision(decision as never) !== null);
        expect(h.provider.executed).toHaveLength(1);
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 1, turns: 2, workers: 0 });
      });
      // The retry cannot reclaim: the call is intercepted again into a new Decision; the claim is never repaired or repeated.
      await withProcess(w, async (h) => {
        h.provider.script({ kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("waiting");
        expect(h.provider.executed).toEqual([]);
        expect(h.provider.authorizations.map((a) => a.authorization.kind)).toEqual(["approval_required"]);
        expect(h.stores.approvedToolCallUses.listByRun(w.runId)).toHaveLength(1);
        const turns = turnsOf(h, h.stores.plans.getNode(w.nodeId));
        expect(turns.map((t) => t.status)).toEqual(["blocked", "blocked"]);
        expect(turns[1]!.blockedByDecisionId).not.toBe(decision);
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 1, turns: 2 });
        // Deny it: the successor continues without the call and completes; the Worker and the synthesis run — but every worktree release fails (window 11).
        h.stores.decisions.resolve(turns[1]!.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] });
        const holder: { artifactId?: ArtifactId } = {};
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, workerStep(h, { summary: "a", diff: "+a" }), synthesisStep(h, w.runId, holder));
        h.executionWorkspace.failReleaseWith = new Error("worktree busy");
        const after = await h.scheduler.advanceRun(w.runId);
        expect(after).toMatchObject({ stop: "quiescent", failure: null });
        expect(h.stores.plans.getNode(w.nodeId)).toMatchObject({ status: "succeeded", outputArtifactIds: [holder.artifactId] });
        const workers = workersOf(h, h.stores.plans.getNode(w.nodeId));
        expect(workers.map((i) => [i.status, i.workspaceCleanup])).toEqual([["succeeded", "pending"]]);
        expect(h.executionDiagnostics.filter((d) => d.kind === "workspace_release_failed").map((d) => d.invocationId)).toContain(workers[0]!.id);
        expect(turnsOf(h, h.stores.plans.getNode(w.nodeId)).map((t) => [t.purpose, t.status])).toEqual([["decompose", "blocked"], ["decompose", "blocked"], ["decompose", "succeeded"], ["synthesize", "succeeded"]]);
        expect(work(h, w)).toMatchObject({ proposals: 1, tasks: 1, workers: 1, turns: 4, handoffs: 1 });
      });
      // The next start releases every outstanding worktree from rows; nothing else changes.
      await withProcess(w, async (h) => {
        const pending = h.stores.invocations.listPendingWorkspaceCleanup().map((i) => i.id);
        const workers = workersOf(h, h.stores.plans.getNode(w.nodeId));
        expect(pending).toContain(workers[0]!.id);
        expect(h.recovery.recover().workspaceReleasedInvocationIds.sort()).toEqual([...pending].sort());
        expect(h.stores.invocations.listPendingWorkspaceCleanup()).toEqual([]);
        expect(h.stores.invocations.get(workers[0]!.id).workspaceCleanup).toBe("released");
        const before = work(h, w);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w)).toEqual(before);
        expect(h.stores.approvedToolCallUses.listByRun(w.runId)).toHaveLength(1);
      }, { recover: false });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
