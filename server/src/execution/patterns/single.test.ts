/**
 * The `single` Pattern runner (execution-model §5.1, §6.4, §7.2, §7.4,
 * §7.6, §9.2; invariants 5 runtime-owned scheduling and retries, 7 Workers
 * only receive their manifest, 8 minimal Handoffs, 9 canonical objects by
 * id, 20 one Invocation per logical turn, 22 atomic allocation, 23
 * runtime-owned Task states, 24 at-most-once approval).
 */
import { ConflictError, type Invocation, type PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, seedReadOnlyWorker, TEST_GOVERNOR, type RuntimeHarness } from "../test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };

/** A ready single worker node (writing by default) and the accepted revision number. */
function readySingle(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, options: { agent?: string; allocation?: { costUsd: number; tokens: number; attempts: number }; gate?: string[]; policy?: "fail" | "wait" | "extend"; taskIds?: string[]; title?: string } = {}) {
  const expression = {
    pattern: "single" as const,
    operation: { agentDefinitionRevisionId: (options.agent ?? s.worker.id) as never, title: options.title ?? "work", ...(options.taskIds ? { input: { taskIds: options.taskIds as never, decisionIds: [], artifactIds: [] } } : {}) },
    allocation: options.allocation ?? { costUsd: 8, tokens: 80_000, attempts: 8 },
    ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}),
    ...(options.policy ? { onAllocationExhausted: options.policy } : {}),
  };
  const { nodes, revisionNumber } = planNodes(h, s, [expression]);
  const node = nodes[0]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  return { node: h.stores.plans.getNode(node.id), revisionNumber };
}

async function execute(h: RuntimeHarness, invocationId: Invocation["id"]) {
  return h.executor.advanceInvocation(invocationId);
}

function nodeState(h: RuntimeHarness, node: PlanNode) {
  return h.stores.plans.getNode(node.id);
}

describe("SinglePatternRunner", () => {
  it("runs a read-only single node to success: start, execute, settle with exact outputs and no Changeset, sequence Handoffs, and repeated reconciliation as a no-op", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const reader = seedReadOnlyWorker(h);
      const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: reader.id, title: "read" }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } }, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "after" }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } }] }]);
      const [node, next] = nodes as [PlanNode, PlanNode];
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      const runner = h.runners.single;
      expect(runner.inspect(node.id)).toEqual({ kind: "start" });
      const seq = h.ctx.journal.lastSeq();
      const started = runner.start(node.id, revisionNumber);
      expect(started).toMatchObject({ kind: "started", position: { kind: "single" } });
      if (started.kind !== "started") throw new Error(started.kind);
      const invocation = h.stores.invocations.get(started.invocationId);
      expect(invocation).toMatchObject({ role: "worker", purpose: "step", patternPosition: { kind: "single" }, agentDefinitionRevisionId: reader.id, taskIds: [], workspaceCleanup: "none", status: "pending" });
      expect(nodeState(h, node).status).toBe("running");
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["plan_node.started", "invocation.created", "budget_reservation.created", "context_manifest.created"]);
      // Starting again creates nothing.
      expect(runner.start(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(node.id)).toEqual({ kind: "execute", invocationId: invocation.id });
      // The executor runs the Attempt; the runner then settles the completed result.
      const artifact = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId: null, title: "report" }, new TextEncoder().encode("findings"));
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], summary: "read everything" } });
      expect(await execute(h, invocation.id)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded" } } });
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: invocation.id });
      expect(h.stores.changesets.listByRun(s.created.run.id)).toEqual([]);
      const settleSeq = h.ctx.journal.lastSeq();
      const settled = await runner.settle(node.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "succeeded", outputArtifactIds: [artifact.id] });
      if (settled.kind !== "succeeded") throw new Error(settled.kind);
      expect(nodeState(h, node)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id] });
      const handoff = h.stores.handoffs.get(settled.handoffIds[0]!);
      expect(handoff).toMatchObject({ handoffKey: `sequence:${node.id}:${next.id}`, artifactIds: [artifact.id], summary: "read everything", status: "pending", target: { kind: "plan_node", planNodeId: next.id } });
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: settleSeq }).map((e) => e.type)).toEqual(["plan_node.succeeded", "budget_reservation.released", "handoff.created"]);
      // No integration happened for a read-only node; nothing touched the port; the Run's integration Snapshot is untouched.
      expect(h.integrationWorkspace.requests).toEqual([]);
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBeNull();
      // Repeated reconciliation applies nothing.
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(node.id)).toEqual({ kind: "terminal", status: "succeeded" });
      expect(h.ctx.journal.lastSeq()).toBe(settleSeq + 3);
      // The successor node's start delivers exactly that Handoff.
      h.stores.plans.transitionNode(next.id, { to: "ready" });
      const nextStart = runner.start(next.id, revisionNumber);
      if (nextStart.kind !== "started") throw new Error(nextStart.kind);
      expect(h.stores.invocations.getManifest(nextStart.invocationId).content.handoffs.map((x) => x.handoffId)).toEqual([handoff.id]);
      expect(h.stores.handoffs.get(handoff.id).status).toBe("delivered");
      // No narrative anywhere: no conversation message was posted by any of this.
      expect(h.stores.conversations.listMessages(s.created.run.conversationId)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("integrates a writing node's Changeset before succeeding, applies owned Task results exactly, and rejects a completed result that omits an owned Task", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "add the flag", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const other = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "unrelated", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const { node, revisionNumber } = readySingle(h, s, { taskIds: [task.id] });
      const runner = h.runners.single;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      // The pending owned Task was readied and started by preparation; the unrelated Task was never touched.
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: started.invocationId });
      expect(h.stores.tasks.get(other.id).status).toBe("pending");
      expect(h.stores.invocations.get(started.invocationId).taskIds).toEqual([task.id]);
      // A completed result that does not report the owned Task is invalid: a retry follows, the Task stays running.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const first = await execute(h, started.invocationId);
      expect(first).toMatchObject({ kind: "finalized", attempt: { failureClass: "result_invalid", failureDetail: { violations: [{ code: "status_incompatible" }] } }, settlement: { kind: "retry_pending" } });
      expect(runner.inspect(node.id)).toEqual({ kind: "execute", invocationId: started.invocationId });
      expect(h.stores.tasks.get(task.id).status).toBe("running");
      // The retry completes the Task with Evidence and a Changeset with content.
      const output = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: started.invocationId, attemptId: null }, taskId: task.id, title: "flag.ts" }, new TextEncoder().encode("export const flag = true;"));
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", started.invocationId), diff: new TextEncoder().encode("+flag"), empty: false };
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [output.id], tasks: [{ taskId: task.id, status: "completed", evidence: [{ kind: "artifact", artifactId: output.id }], blocker: null }], summary: "flag added" } });
      expect(await execute(h, started.invocationId)).toMatchObject({ kind: "finalized", attempt: { number: 2, status: "succeeded" } });
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "completed", outputArtifactIds: [output.id] });
      const changeset = h.stores.changesets.listByRun(s.created.run.id)[0]!;
      expect(changeset.integrationStatus).toBe("pending");
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: started.invocationId });
      // Settle integrates first (outside any transaction), then succeeds the node in one transaction.
      const seq = h.ctx.journal.lastSeq();
      const settled = await runner.settle(node.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "succeeded", outputArtifactIds: [output.id], handoffIds: [] });
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("integrated");
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBe(h.stores.changesets.get(changeset.id).integratedSnapshotId);
      expect(h.integrationWorkspace.requests.map((r) => r.changesetId)).toEqual([changeset.id]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["snapshot.taken", "changeset.integrated", "run.integrated", "plan_node.succeeded", "budget_reservation.released"]);
      expect(nodeState(h, node)).toMatchObject({ status: "succeeded", outputArtifactIds: [output.id] });
      expect(h.stores.tasks.get(other.id).status).toBe("pending");
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
    } finally {
      h.close();
    }
  });

  it("retries within the Invocation, marks provider-capacity waits and clears them, and fails or waits on an exhausted node allocation by policy", async () => {
    const h = openRuntimeHarness({ governor: { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 1 } } } });
    try {
      const s = seedPlanningRuntime(h);
      const { node, revisionNumber } = readySingle(h, s);
      const runner = h.runners.single;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      // Capacity: the Orchestrator's turn holds the one provider slot; the node waits with the structured reason and resumes when it clears.
      h.provider.script({ kind: "hang" }, { kind: "transient_error" }, { kind: "succeed", result: COMPLETED_RESULT });
      const orchestrator = await h.executor.prepareNextAttempt(s.invocation.id);
      if (orchestrator.kind !== "prepared") throw new Error(orchestrator.kind);
      const orchestratorRun = h.executor.executePreparedAttempt(orchestrator.attempt.id);
      expect(await execute(h, started.invocationId)).toMatchObject({ kind: "capacity_refused", refusal: { reason: "provider_concurrency" } });
      expect(runner.markWaiting(node.id, revisionNumber, "provider_capacity")).toEqual({ kind: "waiting", reason: "provider_capacity", wakeAt: null });
      expect(runner.markWaiting(node.id, revisionNumber, "provider_capacity")).toEqual({ kind: "no_change" });
      expect(nodeState(h, node)).toMatchObject({ status: "waiting", waitReason: "provider_capacity" });
      expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "provider_capacity", cleared: false, wakeAt: null });
      expect(runner.resume(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      h.executor.interrupt(orchestrator.attempt.id, "cancelled");
      await orchestratorRun;
      expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "provider_capacity", cleared: true, wakeAt: null });
      expect(runner.resume(node.id, revisionNumber)).toEqual({ kind: "resumed", reason: "provider_capacity" });
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.wait_cleared" })).toHaveLength(1);
      expect(nodeState(h, node).status).toBe("running");
      // Retries are Attempts of the same Invocation; the node stays running throughout.
      const transient = await execute(h, started.invocationId);
      expect(transient).toMatchObject({ kind: "finalized", attempt: { number: 1, failureClass: "provider_transient" }, settlement: { kind: "retry_pending" } });
      const notBefore = h.stores.invocations.listAttempts(started.invocationId)[0]!.retryDecision!.notBefore!;
      expect(runner.inspect(node.id)).toEqual({ kind: "retry_not_before", invocationId: started.invocationId, notBefore });
      h.clock.set(notBefore);
      expect(await execute(h, started.invocationId)).toMatchObject({ kind: "finalized", attempt: { number: 2, kind: "retry", status: "succeeded" } });
      expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(1);
      expect(await runner.settle(node.id, revisionNumber)).toMatchObject({ kind: "succeeded" });
    } finally {
      h.close();
    }
    // Allocation policy: a node whose allocation cannot fund its Invocation fails under `fail`, waits on budget under `wait`,
    // and reports the later-phase extension under `extend` without corrupting anything.
    for (const policy of ["fail", "wait", "extend"] as const) {
      const b = openRuntimeHarness();
      try {
        const s = seedPlanningRuntime(b);
        const { node, revisionNumber } = readySingle(b, s, { allocation: { costUsd: 1, tokens: 1_000, attempts: 1 }, policy });
        const runner = b.runners.single;
        const seq = b.ctx.journal.lastSeq();
        const outcome = runner.start(node.id, revisionNumber);
        expect(b.stores.invocations.listByPlanNode(node.id)).toEqual([]);
        if (policy === "fail") {
          expect(outcome).toEqual({ kind: "failed", reason: "allocation_exhausted" });
          expect(nodeState(b, node).status).toBe("failed");
          expect(b.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["plan_node.started", "plan_node.failed", "budget_reservation.released"]);
          expect(b.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "allocation_exhausted" });
        } else if (policy === "wait") {
          expect(outcome).toEqual({ kind: "waiting", reason: "budget", wakeAt: null });
          expect(nodeState(b, node)).toMatchObject({ status: "waiting", waitReason: "budget" });
          expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "budget", cleared: false, wakeAt: null });
        } else {
          expect(outcome).toEqual({ kind: "awaiting_allocation_extension_phase" });
          expect(nodeState(b, node).status).toBe("running");
          expect(runner.inspect(node.id)).toEqual({ kind: "start" });
          expect(runner.start(node.id, revisionNumber)).toEqual({ kind: "awaiting_allocation_extension_phase" });
        }
      } finally {
        b.close();
      }
    }
  });

  it("waits on an approval Decision, then continues at the same position with a successor that carries the typed resolution, re-owns its Tasks, and widens no Tool Policy", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "run the tests", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const { node, revisionNumber } = readySingle(h, s, { taskIds: [task.id] });
      const runner = h.runners.single;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const blocked = await execute(h, started.invocationId);
      expect(blocked.kind).toBe("approval_required");
      if (blocked.kind !== "approval_required") throw new Error("unreachable");
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: started.invocationId });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "waiting", reason: "decision", wakeAt: null });
      expect(nodeState(h, node)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "blocked", blockReason: { kind: "decision", decisionId: blocked.decision.id } });
      expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "decision", cleared: false, wakeAt: null });
      expect(runner.resume(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      // The operator approves once; the successor continues at the same position from the blocked Invocation.
      h.stores.decisions.resolve(blocked.decision.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "decision", cleared: true, wakeAt: null });
      const seq = h.ctx.journal.lastSeq();
      const resumed = runner.resume(node.id, revisionNumber);
      expect(resumed).toMatchObject({ kind: "successor_prepared", position: { kind: "single" }, decisionId: blocked.decision.id });
      if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
      const successor = h.stores.invocations.get(resumed.invocationId);
      const predecessor = h.stores.invocations.get(started.invocationId);
      expect(successor).toMatchObject({ continuedFromInvocationId: predecessor.id, patternPosition: { kind: "single" }, purpose: "step", taskIds: [task.id], status: "pending" });
      expect(successor.id).not.toBe(predecessor.id);
      // A fresh reservation and worktree, never the consumed ones.
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: successor.id })).not.toBeNull();
      expect(h.stores.reservations.listByChild({ type: "invocation", id: predecessor.id })[0]!.status).toBe("released");
      expect(h.stores.invocations.getManifest(successor.id).content.worktreePath).not.toBe(h.stores.invocations.getManifest(predecessor.id).content.worktreePath);
      const manifest = h.stores.invocations.getManifest(successor.id).content;
      expect(manifest.inputs).toEqual([{ kind: "side_effect_approval_resolution", decisionId: blocked.decision.id, blockedInvocationId: predecessor.id, attemptId: blocked.attempt.id, tool: "shell", callDigest: blocked.decision.subject!.callDigest, callArtifactId: blocked.decision.subject!.callArtifactId, outcome: "approve_once" }]);
      expect(manifest.toolPolicy.shell).toBe("approval_required");
      expect(manifest.approvedCalls).toHaveLength(1);
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: successor.id });
      expect(nodeState(h, node).status).toBe("running");
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["plan_node.wait_cleared", "task.ready", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "context_manifest.created", "task.started"]);
      expect(h.stores.invocations.listAtPosition(node.id, "single").map((i) => i.id)).toEqual([predecessor.id, successor.id]);
      // Resuming again prepares nothing; the successor executes the approved call once and completes the node.
      expect(runner.resume(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(node.id)).toEqual({ kind: "execute", invocationId: successor.id });
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: { ...COMPLETED_RESULT, tasks: [{ taskId: task.id, status: "completed", evidence: [{ kind: "url", url: "https://ci.example.test/1" }], blocker: null }] } } });
      expect(await execute(h, successor.id)).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      expect(h.provider.executed.map((e) => e.authorization.kind)).toEqual(["approved_once"]);
      expect(await runner.settle(node.id, revisionNumber)).toMatchObject({ kind: "succeeded" });
      expect(h.stores.tasks.get(task.id).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("fails the node on a terminal Invocation failure or a failed result, cancels it with the cancellation cause, and fails a blocked result without a Decision", async () => {
    for (const scenario of ["provider_permanent", "result_failed", "result_blocked", "cancelled"] as const) {
      const h = openRuntimeHarness();
      try {
        const s = seedPlanningRuntime(h);
        const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
        const { node, revisionNumber } = readySingle(h, s, { taskIds: [task.id] });
        const runner = h.runners.single;
        const started = runner.start(node.id, revisionNumber);
        if (started.kind !== "started") throw new Error(started.kind);
        if (scenario === "provider_permanent") h.provider.script({ kind: "permanent_error" });
        else if (scenario === "result_failed") h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "cannot" } });
        else if (scenario === "result_blocked") h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "blocked", blocker: "needs the design doc" } });
        else h.provider.script({ kind: "hang" });
        if (scenario === "cancelled") {
          const prepared = await h.executor.prepareNextAttempt(started.invocationId);
          if (prepared.kind !== "prepared") throw new Error(prepared.kind);
          const running = h.executor.executePreparedAttempt(prepared.attempt.id);
          h.executor.interrupt(prepared.attempt.id, "cancelled");
          await running;
        } else {
          await execute(h, started.invocationId);
        }
        expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: started.invocationId });
        const seq = h.ctx.journal.lastSeq();
        const settled = await runner.settle(node.id, revisionNumber);
        const after = nodeState(h, node);
        if (scenario === "cancelled") {
          expect(settled).toEqual({ kind: "cancelled" });
          expect(after.status).toBe("cancelled");
          expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.cancelled" })[0]!.payload).toMatchObject({ reason: "invocation_cancelled" });
          expect(h.stores.tasks.get(task.id).status).toBe("blocked");
        } else {
          const reason = scenario === "provider_permanent" ? "invocation_failed" : scenario;
          expect(settled).toEqual({ kind: "failed", reason });
          expect(after.status).toBe("failed");
          expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason });
          expect(h.stores.tasks.get(task.id).status).toBe("failed");
        }
        expect(after.outputArtifactIds).toBeNull();
        expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(1);
        expect(h.stores.reservations.listByChild({ type: "plan_node", id: node.id })[0]!.status).toBe("released");
        // Settling again changes nothing; a failed node is never reported successful.
        expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
        expect(h.ctx.journal.lastSeq()).toBe(seq + (h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).length));
        expect(runner.inspect(node.id)).toEqual({ kind: "terminal", status: after.status });
      } finally {
        h.close();
      }
    }
  });

  it("waits on a Decision a blocked result names and continues with a decision_resolution successor once it resolves", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, revisionNumber } = readySingle(h, s);
      const runner = h.runners.single;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const decision = h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId: s.created.run.id, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "invocation", invocationId: started.invocationId }, question: "Which library?", options: [{ id: "a", label: "A", description: null }, { id: "b", label: "B", description: null }], recommendedOptionId: "a", rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [node.id] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "blocked", blocker: decision.id } });
      expect(await execute(h, started.invocationId)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded", result: { status: "blocked" } } } });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "waiting", reason: "decision", wakeAt: null });
      expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "decision", cleared: false, wakeAt: null });
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "b", rationale: null, artifactIds: [] });
      const resumed = runner.resume(node.id, revisionNumber);
      expect(resumed).toMatchObject({ kind: "successor_prepared", decisionId: decision.id });
      if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
      const manifest = h.stores.invocations.getManifest(resumed.invocationId).content;
      expect(manifest.inputs).toEqual([{ kind: "decision_resolution", decisionId: decision.id }]);
      expect(manifest.decisions.find((d) => d.decisionId === decision.id)).toMatchObject({ chosenOptionId: "b", resolvedSincePrevious: true });
      expect(h.stores.invocations.get(resumed.invocationId).continuedFromInvocationId).toBe(started.invocationId);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await execute(h, resumed.invocationId);
      expect(await runner.settle(node.id, revisionNumber)).toMatchObject({ kind: "succeeded" });
    } finally {
      h.close();
    }
  });

  it("records an integration conflict as a wait, integrates after the conflict Task completes, and fails the node when the Task ends otherwise", async () => {
    for (const resolution of ["completed", "cancelled"] as const) {
      const h = openRuntimeHarness();
      try {
        const s = seedPlanningRuntime(h);
        const { node, revisionNumber } = readySingle(h, s);
        const runner = h.runners.single;
        const started = runner.start(node.id, revisionNumber);
        if (started.kind !== "started") throw new Error(started.kind);
        h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", started.invocationId), diff: new TextEncoder().encode("+x"), empty: false };
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await execute(h, started.invocationId);
        const changeset = h.stores.changesets.listByRun(s.created.run.id)[0]!;
        h.integrationWorkspace.conflictNext.add(changeset.id);
        expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "waiting", reason: "integration_conflict", wakeAt: null });
        const conflicted = h.stores.changesets.get(changeset.id);
        expect(conflicted.integrationStatus).toBe("conflict");
        const task = h.stores.tasks.get(conflicted.conflictTaskId!);
        expect(task).toMatchObject({ origin: "runtime", planNodeId: node.id, status: "pending" });
        expect(nodeState(h, node)).toMatchObject({ status: "waiting", waitReason: "integration_conflict" });
        expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "integration_conflict", cleared: false, wakeAt: null });
        // Nothing proceeds while the conflict stands: no output, no Handoff, no second application.
        expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
        expect(h.integrationWorkspace.requests).toHaveLength(1);
        h.stores.tasks.transition(task.id, { to: "ready" });
        if (resolution === "completed") {
          h.stores.tasks.transition(task.id, { to: "running", invocationId: started.invocationId });
          h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test/fix" }], outputArtifactIds: [] });
        } else {
          h.stores.tasks.transition(task.id, { to: "cancelled" });
        }
        expect(runner.inspect(node.id)).toEqual({ kind: "waiting", reason: "integration_conflict", cleared: true, wakeAt: null });
        expect(runner.resume(node.id, revisionNumber)).toEqual({ kind: "resumed", reason: "integration_conflict" });
        expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: started.invocationId });
        const settled = await runner.settle(node.id, revisionNumber);
        if (resolution === "completed") {
          expect(settled).toMatchObject({ kind: "succeeded" });
          expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("integrated");
          expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).not.toBeNull();
        } else {
          expect(settled).toEqual({ kind: "failed", reason: "integration_conflict" });
          expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("conflict");
          expect(nodeState(h, node).status).toBe("failed");
        }
      } finally {
        h.close();
      }
    }
  });

  it("never falsely succeeds a node with Gate criteria, refuses the root, and does nothing under a stale revision", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.created.run.conversationId, requirementId: null, requirementRevisionId: null, taskId: h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "gate", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }).id, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const gated = { pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: "work" }, allocation: { costUsd: 8, tokens: 80_000, attempts: 8 }, gateAcceptanceCriterionIds: [criterion.id] };
      const { nodes: [node], revisionNumber } = planNodes(h, s, [gated]);
      if (!node) throw new Error("node expected");
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      const runner = h.runners.single;
      const started = runner.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", started.invocationId), diff: new TextEncoder().encode("+gated"), empty: false };
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await execute(h, started.invocationId);
      // Work completes canonically (the Changeset is integrated) but the node stays running for the Gate phase; nothing repeats.
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "awaiting_gate_phase" });
      expect(nodeState(h, node)).toMatchObject({ status: "running", outputArtifactIds: null });
      expect(h.stores.changesets.listByRun(s.created.run.id)[0]!.integrationStatus).toBe("integrated");
      expect(runner.inspect(node.id)).toEqual({ kind: "awaiting_gate_phase" });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "awaiting_gate_phase" });
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(1);
      // The root Orchestrator node is never a worker single.
      expect(() => runner.inspect(s.created.root.id)).toThrow(ConflictError);
      expect(() => runner.start(s.created.root.id, revisionNumber)).toThrow(/root Orchestrator node/);
      // A revision accepted between projection and mutation makes every action stale and writes nothing.
      const extended = planNodes(h, s, [gated, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "other" }, allocation: { costUsd: 8, tokens: 80_000, attempts: 8 } }]);
      const other = extended.nodes[1]!;
      h.stores.plans.transitionNode(other.id, { to: "ready" });
      const seq = h.ctx.journal.lastSeq();
      expect(runner.start(other.id, revisionNumber)).toEqual({ kind: "stale", expectedRevisionNumber: revisionNumber, currentRevisionNumber: revisionNumber + 1 });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "stale", expectedRevisionNumber: revisionNumber, currentRevisionNumber: revisionNumber + 1 });
      expect(runner.markWaiting(other.id, revisionNumber, "budget")).toMatchObject({ kind: "stale" });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(nodeState(h, other).status).toBe("ready");
      // A node no longer in the current membership is reported as such and never started or completed.
      expect(runner.start(other.id, revisionNumber + 1)).toMatchObject({ kind: "started" });
      const shrunk = planNodes(h, s, [gated]);
      expect(shrunk.nodes.map((n) => n.id)).toEqual([node.id]);
      expect(runner.inspect(other.id)).toMatchObject({ kind: "not_current" });
      expect(runner.start(other.id, shrunk.revisionNumber)).toMatchObject({ kind: "stale" });
    } finally {
      h.close();
    }
  });
});
