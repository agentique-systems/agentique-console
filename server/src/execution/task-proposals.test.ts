/**
 * Coordinator Task proposals (execution-model §5.5.1; invariants 5 the
 * runtime owns Task creation and dependencies, 21 exact pinned scope, 22
 * atomic allocation, 23 runtime-owned Task states): atomic validation of the
 * whole batch, proposal-local dependency keys, scope and ownership rules,
 * cycles, the cumulative `maxTasks` bound, atomic reservation, and the
 * one-proposal-per-turn rule.
 */
import { describe, expect, it } from "vitest";
import { cancel, decomposePort, portFor, proposal, propose, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, seedRuntime } from "./test-support.ts";

describe("Task proposals", () => {
  it("accepts a valid batch atomically: runtime-owned facts, resolved local dependencies, one reservation per Task, and the key → id mapping", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const input = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "spec" }, new TextEncoder().encode("spec"));
      const before = h.stores.reservations.capacity({ type: "plan_node", id: d.node.id });
      const outcome = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!], inputArtifactIds: [input.id] }), proposal({ key: "b", requirementIds: [d.leafIds[0]!, d.leafIds[1]!], dependsOnKeys: ["a"] }), proposal({ key: "c", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a", "b"] })]));
      expect(outcome).toMatchObject({ kind: "accepted", replayed: false, tool: "propose_tasks" });
      if (outcome.kind !== "accepted" || outcome.result.tool !== "propose_tasks") return;
      const tasks = h.stores.tasks.listByPlanNode(d.node.id);
      expect(tasks.map((t) => t.id)).toEqual(outcome.result.taskIds);
      expect(outcome.result.taskIdsByKey).toEqual({ a: tasks[0]!.id, b: tasks[1]!.id, c: tasks[2]!.id });
      // The runtime supplied the Run, node, origin, pinned revision, ids, and timestamps; the proposal supplied the rest.
      for (const task of tasks) expect(task).toMatchObject({ runId: s.created.run.id, planNodeId: d.node.id, origin: "coordinator", requirementRevisionId: d.revision.id, status: "pending", invocationId: null, replacesTaskId: null });
      expect(tasks[0]!.inputArtifactIds).toEqual([input.id]);
      expect(h.stores.tasks.dependencies(s.created.run.id).map((e) => [e.taskId, e.dependsOnTaskId]).sort()).toEqual([[tasks[1]!.id, tasks[0]!.id], [tasks[2]!.id, tasks[0]!.id], [tasks[2]!.id, tasks[1]!.id]].sort());
      // Every Task holds an active reservation of the Worker's default allocation from the node; the node's capacity fell by exactly the batch.
      const allocation = h.stores.agents.getRevision(s.worker.id).defaultLimits.allocation;
      for (const task of tasks) expect(h.stores.reservations.activeForChild({ type: "task", id: task.id })).toMatchObject({ parent: { type: "plan_node", id: d.node.id }, reserved: allocation, capacitySource: "ordinary" });
      const after = h.stores.reservations.capacity({ type: "plan_node", id: d.node.id });
      expect(after.available).toEqual({ costUsd: before.available.costUsd - 3 * allocation.costUsd, tokens: before.available.tokens - 3 * allocation.tokens, attempts: before.available.attempts - 3 * allocation.attempts });
      // Proposal-local keys are not persisted identifiers: no Task carries one.
      expect(Object.keys(tasks[0]!)).not.toContain("key");
    } finally {
      h.close();
    }
  });

  it("rejects the whole batch on any invalid Task: out-of-scope, retired, or foreign Requirements, foreign or unknown Artifacts, unknown keys, foreign dependencies, invalid replacements, cycles", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s, { leaves: 3 });
      const other = seedRuntime(h);
      const foreignArtifact = h.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "x" }, new TextEncoder().encode("x"));
      const foreignTask = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "orchestrator task", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const valid = proposal({ key: "ok", requirementIds: [d.leafIds[0]!] });
      const cases: [string, ReturnType<typeof proposal>, string][] = [
        ["requirement_out_of_scope", proposal({ key: "x", requirementIds: [d.leafIds[0]!, d.rootId] }), "tasks.1.requirementIds"],
        ["requirement_out_of_scope", proposal({ key: "x", requirementIds: [h.ctx.ids("requirement")] }), "tasks.1.requirementIds"],
        ["unknown_artifact", proposal({ key: "x", requirementIds: [d.leafIds[1]!], inputArtifactIds: [h.ctx.ids("artifact")] }), "tasks.1.inputArtifactIds"],
        ["foreign_artifact", proposal({ key: "x", requirementIds: [d.leafIds[1]!], inputArtifactIds: [foreignArtifact.id] }), "tasks.1.inputArtifactIds"],
        ["unknown_dependency_key", proposal({ key: "x", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["nope"] }), "tasks.1.dependsOnKeys"],
        ["foreign_dependency", proposal({ key: "x", requirementIds: [d.leafIds[1]!], dependsOnTaskIds: [foreignTask.id] }), "tasks.1.dependsOnTaskIds"],
        ["invalid_replacement", proposal({ key: "x", requirementIds: [d.leafIds[1]!], replacesTaskId: foreignTask.id }), "tasks.1.replacesTaskId"],
        ["dependency_cycle", proposal({ key: "x", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["x"] }), "tasks.1.dependsOnKeys"],
      ];
      // A later Requirement revision retires the third leaf; the node's scope stays pinned, but a retired Requirement can no longer be worked against.
      h.stores.requirements.createRevision({ conversationId: s.created.run.conversationId, approvedByDecisionId: null, tree: d.revision.tree.filter((e) => e.id !== d.leafIds[2]) });
      const seq = h.ctx.journal.lastSeq();
      for (const [code, bad, path] of cases) {
        const outcome = await d.port.call(propose([valid, bad]));
        expect(outcome, code).toMatchObject({ kind: "rejected", reasons: [{ code, path }] });
      }
      // A cycle through several keys, and a retired Requirement in scope.
      expect(await d.port.call(propose([proposal({ key: "p", requirementIds: [d.leafIds[0]!], dependsOnKeys: ["q"] }), proposal({ key: "q", requirementIds: [d.leafIds[0]!], dependsOnKeys: ["p"] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "dependency_cycle" }] });
      expect(await d.port.call(propose([proposal({ key: "r", requirementIds: [d.leafIds[2]!] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_retired" }] });
      // Nothing was created by any rejected batch: no Task, dependency, reservation, record, or Event.
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.tasks.listByPlanNode(d.node.id)).toEqual([]);
      expect(h.stores.reservations.listByParent({ type: "plan_node", id: d.node.id }).filter((r) => r.child.type === "task")).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByInvocation(d.invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("enforces maxTasks cumulatively across turns (superseded Tasks included) and refuses a batch the node's remaining allocation cannot fund, creating nothing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s, { bounds: { maxTasks: 3, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } });
      expect(await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[0]!] }), proposal({ key: "c", requirementIds: [d.leafIds[0]!] }), proposal({ key: "d", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "max_tasks_exceeded" }] });
      expect(await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "accepted" });
      // The decompose turn ends; a replan turn is prepared for the same node and counts the two existing Tasks.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(d.attempt.id);
      const replan = h.preparation.prepare({ runId: s.created.run.id, planNodeId: d.node.id, role: "coordinator", purpose: "replan", continuedFromInvocationId: d.invocation.id, patternPosition: { kind: "coordinator_turn" } });
      const prepared = await h.executor.prepareNextAttempt(replan.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      expect(await port.call(propose([proposal({ key: "c", requirementIds: [d.leafIds[0]!] }), proposal({ key: "d", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "max_tasks_exceeded" }] });
      expect(await port.call(propose([proposal({ key: "c", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "accepted" });
      expect(h.stores.tasks.listByPlanNode(d.node.id)).toHaveLength(3);
    } finally {
      h.close();
    }
    const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // A node whose allocation covers its decompose turn and two Workers, but not three.
      const s = seedPlanningRuntime(g);
      const d = await decomposePort(g, s, { allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } });
      const seq = g.ctx.journal.lastSeq();
      const capacity = g.stores.reservations.capacity({ type: "plan_node", id: d.node.id });
      expect(await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[0]!] }), proposal({ key: "c", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "allocation_insufficient" }] });
      expect(g.ctx.journal.lastSeq()).toBe(seq);
      expect(g.stores.reservations.capacity({ type: "plan_node", id: d.node.id })).toEqual(capacity);
      expect(g.stores.tasks.listByPlanNode(d.node.id)).toEqual([]);
      expect(await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[0]!] })]))).toMatchObject({ kind: "accepted" });
      expect(g.stores.reservations.capacity({ type: "plan_node", id: d.node.id }).available.attempts).toBe(0);
    } finally {
      g.close();
    }
  });

  it("refuses to propose from a synthesize turn or a Worker, and refuses a cancellation of a running, completed, foreign, or superseded Task", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error(accepted.kind);
      const [a, b] = accepted.result.taskIds;
      const foreign = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "elsewhere", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      expect(await d.port.call(cancel(foreign.id))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_cancellable", path: "taskId" }] });
      expect(await d.port.call(cancel(h.ctx.ids("task")))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_cancellable" }] });
      // A pending Task of the node cancels, releasing its reservation; cancelling it again is refused.
      const cancelled = await d.port.call(cancel(b!));
      expect(cancelled).toMatchObject({ kind: "accepted", result: { tool: "update_task", taskId: b, status: "cancelled" } });
      expect(h.stores.reservations.listByChild({ type: "task", id: b! })[0]).toMatchObject({ status: "released", releaseReason: "task_cancelled" });
      // The identical call replays; a new cancellation of the cancelled Task is refused.
      expect(await d.port.call(cancel(b!))).toMatchObject({ kind: "accepted", replayed: true });
      expect(await d.port.call(cancel(b!, "once more"))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_cancellable" }] });
      // A running Task cannot be cancelled by the Coordinator.
      h.stores.tasks.transition(a!, { to: "ready" });
      const worker = h.preparation.prepare({ runId: s.created.run.id, planNodeId: d.node.id, role: "worker", purpose: "task", continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: a! }, funding: { source: "task_transfer", taskReservationId: h.stores.reservations.activeForChild({ type: "task", id: a! })!.id } });
      expect(h.stores.tasks.get(a!).status).toBe("running");
      expect(await d.port.call(cancel(a!))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_cancellable" }] });
      // The Worker's own port exposes nothing executable.
      const prepared = await h.executor.prepareNextAttempt(worker.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const workerPort = portFor(h, prepared.invocation, prepared.attempt);
      expect(workerPort.tools).toEqual(["request_decision"]);
      expect(await workerPort.call(propose([proposal({ key: "z", requirementIds: [d.leafIds[0]!] })]))).toEqual({ kind: "not_callable", tool: "propose_tasks" });
      expect(await workerPort.call(cancel(b!))).toEqual({ kind: "not_callable", tool: "update_task" });
      expect(h.stores.runtimeToolCalls.listByInvocation(worker.invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
