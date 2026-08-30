/**
 * The `chain` Pattern runner (execution-model §5.2, §6.2, §7.2, §9.2;
 * invariants 5 runtime-owned ordering, 7 Workers receive only their
 * manifest, 8 minimal Handoffs, 15 the persisted shape is the only source
 * of step order, 20 one Invocation per logical turn): steps in exact order,
 * exact per-step manifests, one internal Handoff per transfer, integration
 * before the successor, retries and approval successors on the same step,
 * failure stopping the chain, the last step's output, restart at every
 * durable boundary, and repeated reconciliation as a no-op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionId, HandoffId, Invocation, InvocationId, PlanNode, PlanNodeId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import type { MemoryBlobStore } from "../../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../../persistence/test-support.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "../test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };

function readyChain(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, count: number, options: { gate?: string[]; inputs?: { taskIds?: string[]; artifactIds?: string[]; decisionIds?: string[] }[] } = {}) {
  const steps = Array.from({ length: count }, (_, i) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: `step ${i}`, ...(options.inputs?.[i] ? { input: { taskIds: [], decisionIds: [], artifactIds: [], ...options.inputs[i] } as never } : {}) } }));
  const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "chain", steps, allocation: { costUsd: 20, tokens: 200_000, attempts: 20 }, ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}) }]);
  const node = nodes[0]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  return { node: h.stores.plans.getNode(node.id), revisionNumber };
}

/** Produces an Artifact by `invocation`, scripts a completed result naming it (with a content Changeset), and executes the Attempt. */
async function completeStep(h: RuntimeHarness, invocationId: Invocation["id"], summary: string) {
  const runId = h.stores.invocations.get(invocationId).runId;
  const artifact = h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId, attemptId: null }, taskId: null, title: summary }, new TextEncoder().encode(`content of ${summary}`));
  h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", invocationId), diff: new TextEncoder().encode(`+${summary}`), empty: false };
  const tasks = h.stores.invocations.get(invocationId).taskIds.map((taskId) => ({ taskId, status: "completed" as const, evidence: [{ kind: "artifact" as const, artifactId: artifact.id }], blocker: null }));
  h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], tasks, summary } });
  const outcome = await h.executor.advanceInvocation(invocationId);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`step did not succeed: ${outcome.kind}`);
  return { artifact, invocation: outcome.settlement.invocation };
}

function stepInvocations(h: RuntimeHarness, node: PlanNode) {
  return h.stores.invocations.listByPlanNode(node.id).map((i) => ({ id: i.id, position: i.patternPosition, status: i.status, continuedFrom: i.continuedFromInvocationId }));
}

describe("ChainPatternRunner", () => {
  it("runs three steps in exact order with exact manifests, one Handoff per transfer, integration before each successor, and the last step's Artifacts as output", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const tasks = ["t0", "t1", "t2"].map((subject) => h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject, requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }));
      const { node, revisionNumber } = readyChain(h, s, 3, { inputs: tasks.map((t) => ({ taskIds: [t.id] })) });
      const runner = h.runners.chain;
      const base = h.stores.snapshots.get(s.created.run.baseSnapshotId!).identity;
      // Step 0.
      const started = runner.start(node.id, revisionNumber);
      expect(started).toMatchObject({ kind: "started", position: { kind: "chain_step", index: 0, count: 3 } });
      if (started.kind !== "started") throw new Error(started.kind);
      expect(runner.start(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.currentStep(node.id)).toMatchObject({ index: 0, count: 3 });
      const m0 = h.stores.invocations.getManifest(started.invocationId).content;
      expect(m0.tasks.map((t) => t.taskId)).toEqual([tasks[0]!.id]);
      expect(m0.handoffs).toEqual([]);
      expect(h.stores.snapshots.get(m0.startingSnapshotId!).identity).toEqual(base);
      expect(h.stores.tasks.get(tasks[1]!.id).status).toBe("pending");
      const step0 = await completeStep(h, started.invocationId, "parsed");
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: started.invocationId });
      const seq = h.ctx.journal.lastSeq();
      const next = await runner.settle(node.id, revisionNumber);
      expect(next).toMatchObject({ kind: "step_prepared", position: { kind: "chain_step", index: 1, count: 3 } });
      if (next.kind !== "step_prepared") throw new Error(next.kind);
      // Integration preceded the successor, in its own transaction; then one Handoff and the next step atomically.
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["snapshot.taken", "changeset.integrated", "run.integrated", "handoff.created", "task.ready", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "handoff.delivered", "context_manifest.created", "task.started"]);
      const changeset0 = h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === started.invocationId)!;
      expect(changeset0.integrationStatus).toBe("integrated");
      const integrated0 = h.stores.snapshots.get(changeset0.integratedSnapshotId!).identity;
      expect(integrated0).not.toEqual(base);
      // Step 1 sees the newly integrated Snapshot, receives only its own input plus the Handoff from step 0.
      const m1 = h.stores.invocations.getManifest(next.invocationId).content;
      expect(m1.patternPosition).toEqual({ kind: "chain_step", index: 1, count: 3 });
      expect(h.stores.snapshots.get(m1.startingSnapshotId!).identity).toEqual(integrated0);
      expect(m1.tasks.map((t) => t.taskId)).toEqual([tasks[1]!.id]);
      expect(m1.handoffs).toEqual([{ handoffId: next.handoffId, source: { kind: "invocation", invocationId: started.invocationId }, taskIds: [tasks[0]!.id], artifactIds: [step0.artifact.id], summary: "parsed" }]);
      expect(m1.artifacts.map((a) => a.artifactId)).toEqual([step0.artifact.id]);
      expect(JSON.stringify(m1)).not.toContain(tasks[2]!.id);
      expect(h.stores.handoffs.get(next.handoffId)).toMatchObject({ handoffKey: `chain_step:${node.id}:0`, status: "delivered" });
      expect(h.stores.tasks.get(tasks[0]!.id).status).toBe("completed");
      expect(h.stores.tasks.get(tasks[1]!.id)).toMatchObject({ status: "running", invocationId: next.invocationId });
      // Repeated reconciliation prepares nothing twice.
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(node.id)).toEqual({ kind: "execute", invocationId: next.invocationId });
      // Step 1 → step 2.
      const step1 = await completeStep(h, next.invocationId, "typed");
      const third = await runner.settle(node.id, revisionNumber);
      if (third.kind !== "step_prepared") throw new Error(third.kind);
      expect(third.position).toEqual({ kind: "chain_step", index: 2, count: 3 });
      const m2 = h.stores.invocations.getManifest(third.invocationId).content;
      expect(m2.handoffs.map((x) => x.source)).toEqual([{ kind: "invocation", invocationId: next.invocationId }]);
      // Step 0's Artifact stays readable by id but is not re-embedded in step 2's manifest.
      expect(m2.artifacts.map((a) => a.artifactId)).toEqual([step1.artifact.id]);
      expect(JSON.stringify(m2)).not.toContain(step0.artifact.id);
      expect(h.stores.artifacts.get(step0.artifact.id).id).toBe(step0.artifact.id);
      const changeset1 = h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === next.invocationId)!;
      expect(h.stores.snapshots.get(m2.startingSnapshotId!).identity).toEqual(h.stores.snapshots.get(changeset1.integratedSnapshotId!).identity);
      // Step 2 completes the node: output is exactly step 2's Artifacts; earlier outputs are history.
      const step2 = await completeStep(h, third.invocationId, "tested");
      const done = await runner.settle(node.id, revisionNumber);
      expect(done).toEqual({ kind: "succeeded", outputArtifactIds: [step2.artifact.id], handoffIds: [] });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [step2.artifact.id] });
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBe(h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === third.invocationId)!.integratedSnapshotId);
      expect(h.integrationWorkspace.requests.map((r) => r.changesetId)).toEqual(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.id));
      expect(stepInvocations(h, node).map((i) => [i.position?.kind === "chain_step" ? i.position.index : null, i.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey)).toEqual([`chain_step:${node.id}:0`, `chain_step:${node.id}:1`]);
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(node.id)).toEqual({ kind: "terminal", status: "succeeded" });
      expect(h.stores.conversations.listMessages(s.created.run.conversationId)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("retries only the current step, keeps an approval successor on the same step, and stops after a failed middle step without creating later steps", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, revisionNumber } = readyChain(h, s, 3);
      const runner = h.runners.chain;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      await completeStep(h, started.invocationId, "first");
      const second = await runner.settle(node.id, revisionNumber);
      if (second.kind !== "step_prepared") throw new Error(second.kind);
      // A transient failure retries step 1 as a second Attempt of the same Invocation; step 0 is never re-run and step 2 does not exist.
      h.provider.script({ kind: "transient_error" });
      expect(await h.executor.advanceInvocation(second.invocationId)).toMatchObject({ kind: "finalized", settlement: { kind: "retry_pending" } });
      expect(runner.inspect(node.id)).toMatchObject({ kind: "retry_not_before", invocationId: second.invocationId });
      h.clock.advance(2_000);
      // The retry is intercepted on an approval: the step blocks, the node waits, and the successor continues at step 1.
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const blocked = await h.executor.advanceInvocation(second.invocationId);
      if (blocked.kind !== "approval_required") throw new Error(blocked.kind);
      expect(blocked.attempt.number).toBe(2);
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "waiting", reason: "decision", wakeAt: null });
      h.stores.decisions.resolve(blocked.decision.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const resumed = runner.resume(node.id, revisionNumber);
      if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
      expect(resumed.position).toEqual({ kind: "chain_step", index: 1, count: 3 });
      const successor = h.stores.invocations.get(resumed.invocationId);
      expect(successor.continuedFromInvocationId).toBe(second.invocationId);
      // The successor still receives step 0's Handoff (its predecessor's), not a new one; no duplicate Handoff exists.
      expect(h.stores.invocations.getManifest(successor.id).content.handoffs.map((x) => x.handoffId)).toEqual([second.handoffId]);
      expect(h.stores.handoffs.listByRun(s.created.run.id)).toHaveLength(1);
      expect(runner.currentStep(node.id)).toMatchObject({ index: 1, invocation: { id: successor.id } });
      expect(stepInvocations(h, node).map((i) => [i.position?.kind === "chain_step" ? i.position.index : null, i.status])).toEqual([[0, "succeeded"], [1, "blocked"], [1, "pending"]]);
      // The successor fails permanently: the node fails, step 2 is never created, no "skipped step" record exists.
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "permanent_error", message: "compiler crashed" } });
      expect(await h.executor.advanceInvocation(successor.id)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "failed", failureReason: "provider_permanent" } } });
      expect(h.provider.executed).toHaveLength(1);
      const failed = await runner.settle(node.id, revisionNumber);
      expect(failed).toEqual({ kind: "failed", reason: "invocation_failed" });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "failed", outputArtifactIds: null });
      expect(stepInvocations(h, node)).toHaveLength(3);
      expect(h.stores.invocations.listAtPosition(node.id, "chain_step:2")).toEqual([]);
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      // Step 0's Changeset was integrated; the failed step left nothing to integrate.
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
    } finally {
      h.close();
    }
    // A failed result from a middle step fails the node the same way.
    const f = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(f);
      const { node, revisionNumber } = readyChain(f, s, 2);
      const started = f.runners.chain.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      f.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "no" } });
      await f.executor.advanceInvocation(started.invocationId);
      expect(await f.runners.chain.settle(node.id, revisionNumber)).toEqual({ kind: "failed", reason: "result_failed" });
      expect(f.stores.invocations.listByPlanNode(node.id)).toHaveLength(1);
      expect(f.stores.handoffs.listByRun(s.created.run.id)).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("reports awaiting_gate_phase after the final step when the node has Gate criteria, and does nothing under a stale revision", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "g", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.created.run.conversationId, requirementId: null, requirementRevisionId: null, taskId: task.id, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const { node, revisionNumber } = readyChain(h, s, 2, { gate: [criterion.id] });
      const runner = h.runners.chain;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      await completeStep(h, started.invocationId, "a");
      const second = await runner.settle(node.id, revisionNumber);
      if (second.kind !== "step_prepared") throw new Error(second.kind);
      await completeStep(h, second.invocationId, "b");
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "awaiting_gate_phase" });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "running", outputArtifactIds: null });
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated"]);
      expect(runner.inspect(node.id)).toEqual({ kind: "awaiting_gate_phase" });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "awaiting_gate_phase" });
      expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(2);
      expect(await runner.settle(node.id, revisionNumber + 1)).toMatchObject({ kind: "stale" });
    } finally {
      h.close();
    }
  });

  it("converges after a restart at every durable boundary without repeating useful work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-chain-"));
    try {
      const file = path.join(dir, "console.db");
      let clock: TestClock;
      let blobs: MemoryBlobStore;
      let runId: RunId;
      let nodeId: PlanNodeId;
      let revisionNumber: number;
      let step0: InvocationId;
      // Boundary 1: step 0 completed, nothing settled yet (a crash before the pass that settles it).
      {
        const h = openRuntimeHarness({ base: openHarness(file) });
        clock = h.clock;
        blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        runId = s.created.run.id;
        const ready = readyChain(h, s, 3);
        nodeId = ready.node.id;
        revisionNumber = ready.revisionNumber;
        const started = h.runners.chain.start(nodeId, revisionNumber);
        if (started.kind !== "started") throw new Error(started.kind);
        step0 = started.invocationId;
        await completeStep(h, step0, "one");
        h.close();
      }
      // Boundary 2: after reopening, settling integrates and prepares step 1; simulate a crash after integration but before the next step.
      let step1: InvocationId;
      let handoff0: HandoffId;
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(h.runners.chain.inspect(nodeId)).toEqual({ kind: "settle", invocationId: step0 });
        const prepare = h.preparation.prepare.bind(h.preparation);
        h.preparation.prepare = () => {
          throw new Error("process died before preparing the next step");
        };
        await expect(h.runners.chain.settle(nodeId, revisionNumber)).rejects.toThrow(/process died/);
        h.preparation.prepare = prepare;
        // The integration is durable; the Handoff and the step were rolled back together.
        expect(h.stores.changesets.listByRun(runId)[0]!.integrationStatus).toBe("integrated");
        expect(h.stores.handoffs.listByRun(runId)).toEqual([]);
        expect(h.stores.invocations.listByPlanNode(nodeId)).toHaveLength(1);
        h.close();
      }
      // Boundary 3: reopen with the Handoff created by a separate reconciliation but not yet delivered.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        const node = h.stores.plans.getNode(nodeId);
        if (node.kind !== "pattern") throw new Error("pattern node expected");
        const ensured = h.handoffs.ensureChainStepHandoff(node, h.stores.invocations.get(step0));
        expect(ensured.created).toBe(true);
        handoff0 = ensured.handoff.id;
        expect(h.stores.handoffs.get(handoff0).status).toBe("pending");
        h.close();
      }
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        const requests = h.integrationWorkspace.requests.length;
        const outcome = await h.runners.chain.settle(nodeId, revisionNumber);
        expect(outcome).toMatchObject({ kind: "step_prepared", position: { kind: "chain_step", index: 1, count: 3 }, handoffId: handoff0 });
        if (outcome.kind !== "step_prepared") throw new Error(outcome.kind);
        step1 = outcome.invocationId;
        // No re-integration, the existing Handoff delivered, exactly one step-1 Invocation.
        expect(h.integrationWorkspace.requests).toHaveLength(requests);
        expect(h.stores.handoffs.listByRun(runId).map((x) => [x.id, x.status])).toEqual([[handoff0, "delivered"]]);
        expect(h.stores.invocations.listAtPosition(nodeId, "chain_step:1")).toHaveLength(1);
        // The step's Attempt starts, then the process dies mid-Attempt.
        h.provider.script({ kind: "hang" });
        const prepared = await h.executor.prepareNextAttempt(step1);
        expect(prepared.kind).toBe("prepared");
        h.close();
      }
      // Boundary 4: recovery interrupts the Attempt; the retry runs step 1 (not step 0) and the chain proceeds; a blocked step 2 survives a restart with its open Decision.
      let step2: InvocationId;
      let decisionId: DecisionId;
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        const report = h.recovery.recover();
        expect(report.retryEligible.map((r) => r.invocationId)).toEqual([step1]);
        expect(h.runners.chain.inspect(nodeId)).toEqual({ kind: "execute", invocationId: step1 });
        await completeStep(h, step1, "two");
        const third = await h.runners.chain.settle(nodeId, revisionNumber);
        if (third.kind !== "step_prepared") throw new Error(third.kind);
        step2 = third.invocationId;
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const blocked = await h.executor.advanceInvocation(step2);
        if (blocked.kind !== "approval_required") throw new Error(blocked.kind);
        decisionId = blocked.decision.id;
        expect(await h.runners.chain.settle(nodeId, revisionNumber)).toEqual({ kind: "waiting", reason: "decision", wakeAt: null });
        h.close();
      }
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(h.runners.chain.inspect(nodeId)).toEqual({ kind: "waiting", reason: "decision", cleared: false, wakeAt: null });
        expect(h.runners.chain.resume(nodeId, revisionNumber)).toEqual({ kind: "no_change" });
        // The Decision resolves while the process is down.
        h.stores.decisions.resolve(decisionId, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] });
        h.close();
      }
      // Boundary 5: the resolution is found from rows; the successor continues step 2; the final step completes; a crash before the node transition converges too.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        expect(h.runners.chain.inspect(nodeId)).toEqual({ kind: "waiting", reason: "decision", cleared: true, wakeAt: null });
        const resumed = h.runners.chain.resume(nodeId, revisionNumber);
        expect(resumed).toMatchObject({ kind: "successor_prepared", position: { kind: "chain_step", index: 2, count: 3 }, decisionId });
        if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
        expect(h.stores.invocations.get(resumed.invocationId).continuedFromInvocationId).toBe(step2);
        const last = await completeStep(h, resumed.invocationId, "three");
        // The process dies after integration, before the node's completion is recorded.
        const transition = h.stores.plans.transitionNode.bind(h.stores.plans);
        h.stores.plans.transitionNode = () => {
          throw new Error("process died before the node transition");
        };
        await expect(h.runners.chain.settle(nodeId, revisionNumber)).rejects.toThrow(/process died/);
        h.stores.plans.transitionNode = transition;
        expect(h.stores.changesets.listByRun(runId).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated", "integrated"]);
        expect(h.stores.plans.getNode(nodeId).status).toBe("running");
        h.close();
        const r = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        expect(r.runners.chain.inspect(nodeId)).toEqual({ kind: "settle", invocationId: resumed.invocationId });
        expect(await r.runners.chain.settle(nodeId, revisionNumber)).toEqual({ kind: "succeeded", outputArtifactIds: [last.artifact.id], handoffIds: [] });
        expect(r.integrationWorkspace.requests).toEqual([]);
        expect(r.stores.plans.getNode(nodeId)).toMatchObject({ status: "succeeded", outputArtifactIds: [last.artifact.id] });
        expect(stepInvocations(r, r.stores.plans.getNode(nodeId)).map((i) => [i.position?.kind === "chain_step" ? i.position.index : null, i.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "blocked"], [2, "succeeded"]]);
        expect(r.stores.handoffs.listByRun(runId)).toHaveLength(2);
        expect(await r.runners.chain.settle(nodeId, revisionNumber)).toEqual({ kind: "no_change" });
        r.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
