/**
 * Atomic Invocation preparation (execution-model §6.1, §7.6; invariants 20
 * one Invocation per logical turn and 22 explicit atomic allocation).
 */
import { ConflictError, InsufficientCapacityError, ValidationError, type Invocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { accepted, COMPLETED_RESULT, openRuntimeHarness, propose, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

function counts(h: RuntimeHarness): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ["invocations", "context_manifests", "budget_reservations", "snapshots", "handoffs", "tasks", "events"]) {
    out[table] = (h.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

async function complete(h: RuntimeHarness, invocation: Invocation) {
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`expected success, got ${outcome.kind}`);
}

function coordinatorNode(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) {
  const outcome = accepted(propose(h, s, [{ pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: s.worker.id, title: "coordinator" }, worker: { agentDefinitionRevisionId: s.worker.id, title: "worker" }, allocation: { costUsd: 20, tokens: 200_000, attempts: 10 } }]));
  const node = outcome.graph.nodes[1]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  return node;
}

describe("InvocationPreparationService", () => {
  it("creates the Invocation, its reservation, its Snapshot, and exactly one manifest atomically, with one Event per change", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const seq = h.ctx.journal.lastSeq();
      const { prepared } = startRun(h, s);
      const events = h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual(["plan_node.ready", "plan_node.started", "run.started", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "context_manifest.created"]);
      expect(prepared.invocation.status).toBe("pending");
      expect(prepared.invocation.workspaceCleanup).toBe("pending");
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: prepared.invocation.id })).toMatchObject({ parent: { type: "plan_node", id: s.created.root.id }, reserved: prepared.invocation.allocation });
      expect(h.executionWorkspace.prepared).toHaveLength(1);
      expect(h.executionWorkspace.prepared[0]!.request).toEqual({ runId: s.created.run.id, invocationId: prepared.invocation.id, role: "orchestrator", writes: true, integrationWorkspacePath: s.created.run.integrationWorkspacePath, integrationSnapshot: h.stores.snapshots.get(s.created.run.baseSnapshotId!).identity });
      expect(h.stores.invocations.createAttempt({ invocationId: prepared.invocation.id, startMode: "fresh", resumedFromAttemptId: null }).kind).toBe("initial");
    } finally {
      h.close();
    }
  });

  it("funds ordinary Invocations from the node, Task Invocations by reservation transfer, and final Invocations from the Run final reserve", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const node = coordinatorNode(h, s);
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: node.id, origin: "orchestrator", subject: "write the flag", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const reservation = h.stores.reservations.reserveOrdinary({ runId: s.created.run.id, parent: { type: "plan_node", id: node.id }, child: { type: "task", id: task.id }, amount: { costUsd: 2, tokens: 20_000, attempts: 2 } });
      h.stores.tasks.transition(task.id, { to: "ready" });
      const before = h.stores.reservations.capacity({ type: "plan_node", id: node.id });
      const worker = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id }, funding: { source: "task_transfer", taskReservationId: reservation.id } });
      expect(worker.invocation).toMatchObject({ patternPosition: { kind: "worker_task", taskId: task.id }, taskIds: [task.id], agentDefinitionRevisionId: s.worker.id });
      expect(h.stores.reservations.get(reservation.id)).toMatchObject({ status: "released", releaseReason: "transferred_to_invocation" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: worker.invocation.id })).toMatchObject({ transferredFromReservationId: reservation.id, reserved: { costUsd: 2, tokens: 20_000, attempts: 2 } });
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id })).toEqual(before);
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: worker.invocation.id });
      expect(worker.manifest.content.tasks).toEqual([{ taskId: task.id, subject: "write the flag" }]);
      // A task Invocation owns exactly the Task its position names, which must be ready; a step position cannot own a Task.
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: null, taskIds: [], patternPosition: { kind: "worker_task", taskId: task.id } })).toThrow(/owns exactly the operation's Tasks/);
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: worker.invocation.id, patternPosition: { kind: "worker_task", taskId: task.id } })).toThrow(/is running/);
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, taskIds: [task.id], patternPosition: { kind: "single" } })).toThrow(/has no single position/);
      // Final-reserve funding: only on the root, only for the two uses, reserved directly from the Run.
      await complete(h, s.invocation);
      const synthesis = h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "final_synthesis", continuedFromInvocationId: s.invocation.id, patternPosition: { kind: "orchestrator" }, funding: { source: "run_final_reserve", use: "final_synthesis" } });
      expect(synthesis.invocation).toMatchObject({ allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" });
      expect(synthesis.manifest.content).toMatchObject({ allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: synthesis.invocation.id })).toMatchObject({ parent: { type: "run", id: s.created.run.id }, capacitySource: "final_reserve" });
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "evaluator", purpose: "evaluate", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, patternPosition: null, funding: { source: "run_final_reserve", use: "run_completion" } })).toThrow(/root Plan Node/);
      // An allocation the node cannot cover is refused atomically.
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "coordinator", purpose: "decompose", continuedFromInvocationId: null, patternPosition: { kind: "coordinator_turn" }, allocation: { costUsd: 100, tokens: 1, attempts: 1 } })).toThrow(InsufficientCapacityError);
    } finally {
      h.close();
    }
  });

  it("keeps one active Orchestrator Invocation per Run and one active Coordinator Invocation per node, in logical sequence", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const node = coordinatorNode(h, s);
      const orchestrator = { runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator" as const, purpose: "node_result" as const, patternPosition: { kind: "orchestrator" as const } };
      // The first Invocation is still active: no second one, whatever its continuation claims.
      expect(() => h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: s.invocation.id })).toThrow(ConflictError);
      expect(() => h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: null })).toThrow(/records continuedFromInvocationId/);
      await complete(h, s.invocation);
      // A successor must continue from the latest Orchestrator Invocation, of the same role, on the same node, in the same Run.
      expect(() => h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: null })).toThrow(/records continuedFromInvocationId/);
      const other = seedPlanningRuntime(h);
      expect(() => h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: other.invocation.id })).toThrow(/belongs to Run/);
      const second = h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: s.invocation.id });
      expect(second.invocation.continuedFromInvocationId).toBe(s.invocation.id);
      await complete(h, second.invocation);
      expect(() => h.preparation.prepare({ ...orchestrator, continuedFromInvocationId: s.invocation.id })).toThrow(/not the latest orchestrator Invocation/);
      // Coordinators: one active per node, purposes in order, never on another Pattern.
      const coordinator = { runId: s.created.run.id, planNodeId: node.id, role: "coordinator" as const, patternPosition: { kind: "coordinator_turn" as const } };
      const decompose = h.preparation.prepare({ ...coordinator, purpose: "decompose", continuedFromInvocationId: null });
      expect(decompose.manifest.content.capabilities).toEqual({ tools: ["read", "write"], mcpServers: [] });
      expect(decompose.manifest.content.runtimeTools).toContain("propose_tasks");
      expect(() => h.preparation.prepare({ ...coordinator, purpose: "replan", continuedFromInvocationId: decompose.invocation.id })).toThrow(ConflictError);
      await complete(h, decompose.invocation);
      const replan = h.preparation.prepare({ ...coordinator, purpose: "replan", continuedFromInvocationId: decompose.invocation.id });
      expect(replan.invocation.continuedFromInvocationId).toBe(decompose.invocation.id);
      expect(() => h.preparation.prepare({ ...coordinator, planNodeId: s.created.root.id, purpose: "synthesize", continuedFromInvocationId: null })).toThrow(/root Plan Node holds Orchestrator/);
      // A worker continuing from an Invocation of another role or node is refused.
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: node.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      h.stores.tasks.transition(task.id, { to: "ready" });
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: decompose.invocation.id, patternPosition: { kind: "worker_task", taskId: task.id } })).toThrow(/holds the coordinator role/);
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: s.invocation.id, patternPosition: { kind: "worker_task", taskId: task.id } })).toThrow(/belongs to PlanNode/);
      // Routine progress never creates an Invocation: nothing above happened without an explicit preparation.
      expect(h.stores.invocations.listByRun(s.created.run.id).map((i) => i.purpose)).toEqual(["operator_input", "node_result", "decompose", "replan"]);
    } finally {
      h.close();
    }
  });

  it("rolls everything back and compensates the execution workspace when preparation fails after the worktree was prepared", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const node = coordinatorNode(h, s);
      const before = counts(h);
      const seq = h.ctx.journal.lastSeq();
      const base = { runId: s.created.run.id, planNodeId: node.id, role: "coordinator" as const, purpose: "decompose" as const, continuedFromInvocationId: null, patternPosition: { kind: "coordinator_turn" as const } };
      // The port itself fails: nothing is written and nothing is compensated.
      h.executionWorkspace.failWith = new Error("git worktree add failed");
      expect(() => h.preparation.prepare(base)).toThrow(/git worktree add failed/);
      expect(counts(h)).toEqual(before);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.executionWorkspace.discarded).toHaveLength(0);
      // Preparation succeeds but the manifest cannot be assembled (a foreign Artifact): the transaction rolls back and the worktree is discarded.
      const other = seedRuntime(h);
      const foreign = h.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, new TextEncoder().encode("x"));
      const afterForeign = counts(h);
      const seqAfterForeign = h.ctx.journal.lastSeq();
      expect(() => h.preparation.prepare({ ...base, artifactIds: [foreign.id] })).toThrow(/belongs to Run/);
      expect(counts(h)).toEqual(afterForeign);
      expect(h.ctx.journal.lastSeq()).toBe(seqAfterForeign);
      // The Run start prepared the Orchestrator's worktree; the failed preparation is the second and only discarded one.
      expect(h.executionWorkspace.prepared).toHaveLength(2);
      expect(h.executionWorkspace.discarded).toHaveLength(1);
      expect(h.executionWorkspace.discarded[0]!.invocationId).toBe(h.executionWorkspace.prepared[1]!.request.invocationId);
      expect(h.stores.invocations.listByPlanNode(node.id)).toEqual([]);
      // Nothing was ever executed: the provider received no request.
      expect(h.provider.requests).toHaveLength(0);
      // A later, valid preparation succeeds.
      expect(h.preparation.prepare(base).invocation.status).toBe("pending");
    } finally {
      h.close();
    }
  });

  it("refuses a non-running node, a join, a foreign or unexecutable definition, and an Orchestrator definition off the root", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const outcome = accepted(propose(h, s, [{ pattern: "parallel", items: [{ pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id } }, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id } }] }, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id } }] }]));
      const pending = outcome.graph.nodes.find((n) => n.kind === "pattern" && n.sourcePath !== "root")!;
      const join = outcome.graph.nodes.find((n) => n.kind === "join")!;
      const base = { runId: s.created.run.id, role: "worker" as const, purpose: "step" as const, continuedFromInvocationId: null, patternPosition: { kind: "chain_step" as const, index: 0, count: 2 } };
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id })).toThrow(/is pending/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: join.id })).toThrow(/join node/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: s.created.root.id })).toThrow(/root Plan Node holds Orchestrator/);
      h.stores.plans.transitionNode(pending.id, { to: "ready" });
      h.stores.plans.transitionNode(pending.id, { to: "running" });
      // The operation is resolved from the node shape at the typed position: a caller cannot substitute a revision, a position outside the shape, or one out of bounds.
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id, agentDefinitionRevisionId: "agdr_000000000000000000000000" })).toThrow(/runs Agent Definition revision/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id, patternPosition: { kind: "single" } })).toThrow(/has no single position/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id, patternPosition: { kind: "chain_step", index: 2, count: 2 } })).toThrow(/within bounds/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id, patternPosition: { kind: "chain_step", index: 0, count: 3 } })).toThrow(/has no chain step 1 of 3 position/);
      expect(() => h.preparation.prepare({ ...base, planNodeId: pending.id, role: "evaluator", purpose: "evaluate", patternPosition: null, agentDefinitionRevisionId: "agdr_000000000000000000000000" })).toThrow(/not executable by this Run/);
      const other = seedPlanningRuntime(h);
      expect(() => h.preparation.prepare({ ...base, planNodeId: other.created.root.id })).toThrow(/belongs to Run/);
      expect(() => h.preparation.prepare({ ...base, runId: other.created.run.id, planNodeId: other.created.root.id, role: "orchestrator", purpose: "operator_input", patternPosition: { kind: "orchestrator" }, agentDefinitionRevisionId: s.worker.id })).toThrow(/runs Agent Definition revision/);
      expect(h.provider.requests).toHaveLength(0);
      expect(COMPLETED_RESULT.status).toBe("completed");
    } finally {
      h.close();
    }
  });
});
