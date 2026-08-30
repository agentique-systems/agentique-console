/**
 * Restart and idempotence of the scheduler (execution-model §14 "Server
 * restart"; invariants 6 no transcript decides anything, 15 the current
 * graph is never inferred, 17 resumption is optional, 20 one Invocation per
 * turn): after a restart the scheduler reconstructs everything from
 * canonical rows — revision, node status, Pattern positions, Invocations
 * and Attempts, retry decisions, Handoffs, Changesets, Decisions,
 * reservations, leases — and converges without repeating useful work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvocationId, PlanExpression, PlanNodeId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };
const single = (s: ReturnType<typeof seedPlanningRuntime>, title: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } });

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  runId: RunId;
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, and the file is always closed. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock }) });
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

/** Counts the work a pass could repeat by mistake: provider calls, integrations, Invocations, Handoffs, Attempts. */
function work(h: RuntimeHarness, runId: RunId) {
  return {
    invocations: h.stores.invocations.listByRun(runId).length,
    attempts: h.stores.invocations.listByRun(runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    handoffs: h.stores.handoffs.listByRun(runId).length,
    integrated: h.stores.changesets.listByRun(runId).filter((c) => c.integrationStatus === "integrated").length,
    snapshots: h.stores.snapshots.listByRun(runId).filter((x) => x.reason === "integration").length,
  };
}

describe("scheduler restart", () => {
  it("converges from every durable boundary of a chain behind a single node, executing and integrating each step exactly once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-scheduler-"));
    const w: World = { dir, file: path.join(dir, "console.db"), clock: undefined as never, runId: undefined as never };
    try {
      let nodeIds: PlanNodeId[];
      let orchestrator: InvocationId;
      // Process 1: a plan with A → chain(B0, B1) is accepted; the root's first turn completes; the process dies before any pass.
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        orchestrator = s.invocation.id;
        const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [single(s, "A"), { pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "B0" } }, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "B1" } }], allocation: { costUsd: 12, tokens: 120_000, attempts: 12 } }] }]);
        nodeIds = nodes.map((n) => n.id);
        expect(nodes.map((n) => n.kind === "pattern" && n.pattern)).toEqual(["single", "chain"]);
        h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("root"), diff: new TextEncoder().encode("+root"), empty: false };
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        expect(await h.executor.advanceInvocation(orchestrator)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded" } } });
      }, { recover: false });
      const [a, chain] = nodeIds! as [PlanNodeId, PlanNodeId];
      // Process 2: node ready but no Invocation yet — the pass readies and starts A, then the process dies while A's Attempt runs
      // (the hung provider call never returns; the pass is abandoned with the process).
      await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions.map((x) => x.kind)).toEqual(["settle_root", "ready_node"]);
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(w.runId, { maxActions: 4 });
        void pass.catch(() => undefined);
        for (let i = 0; i < 500 && h.provider.requests.length < 1; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
        expect(h.stores.plans.getNode(a).status).toBe("running");
        expect(h.stores.changesets.listByRun(w.runId).find((c) => c.invocationId === orchestrator)!.integrationStatus).toBe("integrated");
        expect(h.executor.inFlight()).toHaveLength(1);
        expect(h.stores.invocations.getAttempt(h.executor.inFlight()[0]!).status).toBe("running");
      });
      // Process 3: the interrupted Attempt is retried at the same step; A completes with a Changeset; the chain starts; B0 blocks on an approval.
      const decision = await withProcess(w, async (h) => {
        const before = work(h, w.runId);
        expect(before.attempts).toBe(2);
        expect(h.stores.invocations.listByPlanNode(a)[0]!.status).toBe("running");
        const aInvocation = h.stores.invocations.listByPlanNode(a)[0]!.id;
        h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("a"), diff: new TextEncoder().encode("+a"), empty: false };
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, { kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("waiting");
        expect(h.stores.invocations.listAttempts(aInvocation).map((x) => [x.number, x.status])).toEqual([[1, "interrupted"], [2, "succeeded"]]);
        expect(h.stores.plans.getNode(a)).toMatchObject({ status: "succeeded" });
        expect(h.stores.plans.getNode(chain)).toMatchObject({ status: "waiting", waitReason: "decision" });
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "decision" });
        const b0 = h.stores.invocations.listByPlanNode(chain)[0]!;
        expect(b0).toMatchObject({ status: "blocked", patternPosition: { kind: "chain_step", index: 0, count: 2 } });
        // The sequence Handoff from A was delivered to B0; A's Changeset was integrated before the chain started.
        expect(h.stores.invocations.getManifest(b0.id).content.handoffs.map((x) => x.source)).toEqual([{ kind: "plan_node", planNodeId: a }]);
        expect(h.stores.changesets.listByRun(w.runId).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated"]);
        expect(h.provider.requests).toHaveLength(2);
        return b0.blockedByDecisionId!;
      });
      // Process 4: nothing changed; the pass finds the same wait and repeats nothing.
      await withProcess(w, async (h) => {
        const before = work(h, w.runId);
        const seq = h.ctx.journal.lastSeq();
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome).toMatchObject({ stop: "waiting", actions: [], waiting: [{ nodeId: chain, reason: "decision" }] });
        expect(work(h, w.runId)).toEqual(before);
        expect(h.ctx.journal.lastSeq()).toBe(seq);
        expect(h.provider.requests).toHaveLength(0);
        // The Decision resolves; the process dies before any pass.
        h.stores.decisions.resolve(decision, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      });
      // Process 5: the resolved Decision is found from rows; the Run resumes; B0's successor runs the approved call once, its Changeset is integrated,
      // B1 is prepared with B0's Handoff — then the process dies after B1's Attempt succeeded but before it was settled.
      await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions.map((x) => x.kind)).toEqual(["resume_run", "resume_node"]);
        h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("b0"), diff: new TextEncoder().encode("+b0"), empty: false };
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } }, { kind: "delay", key: "b1", then: { kind: "succeed", result: COMPLETED_RESULT } });
        const pass = h.scheduler.advanceRun(w.runId);
        for (let i = 0; i < 500 && h.provider.delayedKeys.length === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
        const b1 = h.stores.invocations.listAtPosition(chain, "chain_step:1")[0]!;
        expect(b1).toMatchObject({ status: "running", continuedFromInvocationId: null });
        expect(h.stores.invocations.getManifest(b1.id).content.handoffs.map((x) => x.handoffId)).toEqual([h.stores.handoffs.getByKey(w.runId, `chain_step:${chain}:0`)!.id]);
        expect(h.provider.executed.map((e) => e.authorization.kind)).toEqual(["approved_once"]);
        expect(h.stores.approvedToolCallUses.getByDecision(decision)).not.toBeNull();
        // The Attempt finishes but the process dies before the pass settles the node.
        const settle = h.runners.chain.settle.bind(h.runners.chain);
        h.runners.chain.settle = async () => {
          throw new Error("process died before settling the final step");
        };
        h.provider.release("b1");
        const outcome = await pass;
        h.runners.chain.settle = settle;
        expect(outcome).toMatchObject({ stop: "infrastructure_failure", failure: { message: "process died before settling the final step" } });
        expect(h.stores.invocations.get(b1.id).status).toBe("succeeded");
        expect(h.stores.plans.getNode(chain).status).toBe("running");
      });
      // Process 6: the final step is settled; the node succeeds with B1's output; a further pass and restart change nothing.
      await withProcess(w, async (h) => {
        const beforeWork = work(h, w.runId);
        const b1 = h.stores.invocations.listAtPosition(chain, "chain_step:1")[0]!;
        expect(b1.status).toBe("succeeded");
        expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([{ kind: "settle_node", nodeId: chain, invocationId: b1.id }]);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        expect(h.stores.plans.getNode(chain)).toMatchObject({ status: "succeeded", outputArtifactIds: [] });
        expect(h.provider.requests).toHaveLength(0);
        const after = work(h, w.runId);
        expect(after).toEqual({ ...beforeWork, integrated: beforeWork.integrated + 1, snapshots: beforeWork.snapshots + 1 });
        expect(h.stores.changesets.listByRun(w.runId).every((c) => c.integrationStatus === "integrated")).toBe(true);
        expect(h.stores.invocations.listByRun(w.runId).map((i) => [i.patternPosition?.kind, i.status])).toEqual([["orchestrator", "succeeded"], ["single", "succeeded"], ["chain_step", "blocked"], ["chain_step", "succeeded"], ["chain_step", "succeeded"]]);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
      });
      await withProcess(w, async (h) => {
        const before = work(h, w.runId);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(work(h, w.runId)).toEqual(before);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converges after a crash between an integration and its record, and after a restart with an integration conflict", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-scheduler-"));
    const w: World = { dir, file: path.join(dir, "console.db"), clock: undefined as never, runId: undefined as never };
    try {
      const a = await withProcess(w, async (h) => {
        w.clock = h.clock;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        const { nodes } = planNodes(h, s, [single(s, "A")]);
        const nodeId = nodes[0]!.id;
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await h.executor.advanceInvocation(s.invocation.id);
        // The root's (empty) Changeset is integrated by the first action; then A's external application succeeds but the process dies before recording it.
        expect((await h.scheduler.advanceRun(w.runId, { maxActions: 1 })).actions.map((x) => x.action.kind)).toEqual(["settle_root"]);
        h.integrationWorkspace.crashAfterApply = true;
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("a"), diff: new TextEncoder().encode("+a"), empty: false };
        const outcome = await h.scheduler.advanceRun(w.runId, { maxActions: 8 });
        expect(outcome.stop).toBe("infrastructure_failure");
        expect(outcome.actions.map((x) => x.action.kind)).toEqual(["ready_node", "start_node", "execute_invocation"]);
        expect(h.stores.changesets.listByRun(w.runId).map((c) => c.integrationStatus)).toEqual(["integrated", "pending"]);
        expect(h.integrationWorkspace.requests).toHaveLength(2);
        expect(h.stores.plans.getNode(nodeId).status).toBe("running");
        return nodeId;
      }, { recover: false });
      // The Workspace provider's state survived (the fake is fresh here, so the apply happens once in this process); persistence catches up exactly once.
      await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([{ kind: "settle_node", nodeId: a, invocationId: h.stores.invocations.listByPlanNode(a)[0]!.id }]);
        h.integrationWorkspace.conflictNext.add(h.stores.changesets.listByRun(w.runId)[1]!.id);
        const outcome = await h.scheduler.advanceRun(w.runId);
        // This time the provider reports a conflict: the Changeset, the Task, and the waits are recorded; the Run waits since nothing else can proceed.
        expect(outcome).toMatchObject({ stop: "waiting", waiting: [{ nodeId: a, reason: "integration_conflict" }] });
        expect(h.stores.plans.getNode(a)).toMatchObject({ status: "waiting", waitReason: "integration_conflict" });
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "integration_conflict" });
      });
      await withProcess(w, async (h) => {
        const changeset = h.stores.changesets.listByRun(w.runId)[1]!;
        expect(changeset.integrationStatus).toBe("conflict");
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "waiting", actions: [] });
        // The conflict Task completes (the later resolution phase); the next process integrates and completes the node.
        const task = h.stores.tasks.get(changeset.conflictTaskId!);
        h.stores.tasks.transition(task.id, { to: "ready" });
        h.stores.tasks.transition(task.id, { to: "running", invocationId: h.stores.invocations.listByPlanNode(a)[0]!.id });
        h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test/resolved" }], outputArtifactIds: [] });
      });
      await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions.map((x) => x.kind)).toEqual(["resume_run", "resume_node"]);
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("quiescent");
        expect(outcome.actions.map((p) => p.action.kind)).toEqual(["resume_run", "resume_node", "settle_node"]);
        expect(h.stores.plans.getNode(a).status).toBe("succeeded");
        expect(h.stores.changesets.listByRun(w.runId).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated"]);
        expect(h.stores.runs.get(w.runId).status).toBe("running");
        expect(h.integrationWorkspace.requests).toHaveLength(1);
        expect(h.provider.requests).toHaveLength(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
