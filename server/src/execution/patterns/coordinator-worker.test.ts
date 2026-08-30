/**
 * The `coordinator_worker` Pattern runner (execution-model §5.5, §5.5.1,
 * §6.4, §7.3, §7.7, §7.9, §9.2; invariants 5 the runtime owns scheduling,
 * dependencies, and fan-in, 7 Workers do not communicate, 8 minimal
 * Handoffs, 14 coordination depth one, 20 one Invocation per logical turn,
 * 21 exact pinned scope, 22 atomic allocation, 23 runtime-owned Task
 * states): the decompose → Workers → synthesize lifecycle, bounded
 * concurrent Workers, per-Task manifests, deterministic integration and
 * Handoff order, coalesced replanning, replacement of failed Tasks,
 * cancellation, no-progress and bound failures, and Gate deferral.
 */
import { coordinatorBlockerKey, type ArtifactId, type RuntimeToolCallRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../provider/fake.ts";
import { cancel, coordinatorNode, finishRoot, proposal, propose, seedApprovalCoordinator, synthesisStep, tasksOf, turn, turnsOf, until, WIDE_GOVERNOR as WIDE, workersOf, workerStep } from "../coordinator-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "../test-support.ts";

describe("CoordinatorWorkerPatternRunner", () => {
  it("runs decompose → Workers → synthesize: one accepted proposal, one Worker per Task funded by its Task reservation, integrated results handed off once, and the synthesis output as the node's output", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = coordinatorNode(h, s);
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const final: { artifactId?: ArtifactId } = {};
      h.provider.script(
        turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!], dependsOnKeys: ["a"] })])]),
        workerStep(h, { summary: "a done", diff: "+a" }),
        workerStep(h, { summary: "b done", diff: "+b" }),
        synthesisStep(h, runId, final),
      );
      const messages = h.stores.conversations.listMessages(s.created.run.conversationId).length;
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.failure).toBeNull();
      // Exactly three logical Coordinator turns in order, at one position, each continuing from the previous one.
      const turns = turnsOf(h, node);
      expect(turns.map((t) => [t.purpose, t.status, t.continuedFromInvocationId])).toEqual([
        ["decompose", "succeeded", null],
        ["synthesize", "succeeded", turns[0]!.id],
      ]);
      // The proposal: one accepted batch, recorded once with its digest and the key → Task mapping, Tasks tagged with the node and pinned revision.
      const calls = h.stores.runtimeToolCalls.listByInvocation(turns[0]!.id);
      expect(calls.map((c) => c.tool)).toEqual(["propose_tasks"]);
      const tasks = tasksOf(h, node);
      expect(tasks).toHaveLength(2);
      const [a, b] = tasks as [(typeof tasks)[number], (typeof tasks)[number]];
      expect(calls[0]!.result).toEqual({ tool: "propose_tasks", taskIds: [a.id, b.id], taskIdsByKey: { a: a.id, b: b.id } });
      expect(a).toMatchObject({ origin: "coordinator", planNodeId: node.id, requirementIds: [leafIds[0]], requirementRevisionId: node.kind === "pattern" ? node.scope!.requirementRevisionId : null, status: "completed", requiredOutputs: ["report"] });
      expect(h.stores.tasks.dependencies(runId)).toEqual([{ runId, taskId: b.id, dependsOnTaskId: a.id }]);
      // Every accepted Task held a Task reservation from the node that was transferred to its Worker; nothing was reserved lazily.
      for (const task of tasks) {
        const reservations = h.stores.reservations.listByChild({ type: "task", id: task.id });
        expect(reservations.map((r) => [r.parent, r.status, r.releaseReason])).toEqual([[{ type: "plan_node", id: node.id }, "released", "transferred_to_invocation"]]);
      }
      // One Worker per Task, in canonical order (b waited for a), each owning exactly its Task, funded by transfer.
      const workers = workersOf(h, node);
      expect(workers.map((w) => [w.purpose, w.role, w.patternPosition, w.taskIds, w.status])).toEqual([
        ["task", "worker", { kind: "worker_task", taskId: a.id }, [a.id], "succeeded"],
        ["task", "worker", { kind: "worker_task", taskId: b.id }, [b.id], "succeeded"],
      ]);
      expect(h.stores.reservations.listByChild({ type: "invocation", id: workers[0]!.id })[0]!.transferredFromReservationId).not.toBeNull();
      // Worker manifests: exactly the Task, its Requirements, no Handoffs, no peer narrative, the effective runtime tools without propose_tasks.
      const manifestA = h.stores.invocations.getManifest(workers[0]!.id).content;
      expect(manifestA.tasks).toEqual([{ taskId: a.id, subject: "task a" }]);
      expect(manifestA.requirements.map((r) => r.requirementId)).toEqual([leafIds[0]]);
      expect(manifestA.handoffs).toEqual([]);
      expect(manifestA.inputs).toEqual([]);
      expect(manifestA.runtimeTools).not.toContain("propose_tasks");
      expect(h.provider.requests.find((r) => r.attemptId === h.stores.invocations.listAttempts(workers[0]!.id)[0]!.id)!.runtimeTools).toEqual([]);
      // Integration in canonical Task order; each integrated result handed off exactly once to the node under its stable key.
      const byChangeset = new Map(h.stores.changesets.listByRun(runId).map((c) => [c.id, c.invocationId] as const));
      expect(h.integrationWorkspace.requests.map((r) => byChangeset.get(r.changesetId))).toEqual([s.invocation.id, turns[0]!.id, workers[0]!.id, workers[1]!.id, turns[1]!.id]);
      const handoffs = h.stores.handoffs.listByRun(runId);
      expect(handoffs.map((x) => [x.handoffKey, x.source, x.taskIds, x.artifactIds, x.summary, x.status])).toEqual([
        [`worker_result:${node.id}:${a.id}`, { kind: "invocation", invocationId: workers[0]!.id }, [a.id], [h.stores.tasks.get(a.id).outputArtifactIds[0]], "a done", "delivered"],
        [`worker_result:${node.id}:${b.id}`, { kind: "invocation", invocationId: workers[1]!.id }, [b.id], [h.stores.tasks.get(b.id).outputArtifactIds[0]], "b done", "delivered"],
      ]);
      // The synthesis turn received exactly those Handoffs, the ledger, and no propose_tasks; the node's output is its Artifact.
      const synthesis = h.stores.invocations.getManifest(turns[1]!.id).content;
      expect(synthesis.handoffs.map((x) => x.handoffId)).toEqual(handoffs.map((x) => x.id).sort());
      expect(synthesis.inputs).toMatchObject([{ kind: "coordinator_turn", purpose: "synthesize", turnsUsed: 2, blockerKeys: [], tasks: [{ taskId: a.id, status: "completed" }, { taskId: b.id, status: "completed" }].sort((x, y) => (x.taskId < y.taskId ? -1 : 1)) }]);
      expect(synthesis.runtimeTools).not.toContain("propose_tasks");
      expect(synthesis.runtimeTools).not.toContain("update_task");
      expect(h.provider.requests.find((r) => r.attemptId === h.stores.invocations.listAttempts(turns[1]!.id)[0]!.id)!.runtimeTools).toEqual([]);
      expect(h.provider.requests.find((r) => r.attemptId === h.stores.invocations.listAttempts(turns[0]!.id)[0]!.id)!.runtimeTools).toEqual(["propose_tasks", "update_task"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      expect(h.stores.changesets.listByRun(runId).every((c) => c.integrationStatus === "integrated")).toBe(true);
      // No narrative anywhere, and routine Task progress created no Coordinator turn.
      expect(h.stores.conversations.listMessages(s.created.run.conversationId)).toHaveLength(messages);
      expect(h.provider.requests).toHaveLength(5);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });
  it("fails a decompose that completes without an accepted proposal with coordinator_no_progress, cancelling nothing and creating no Worker", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { node } = coordinatorNode(h, s);
      await finishRoot(h, s);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "coordinator_no_progress" });
      expect(turnsOf(h, node).map((t) => [t.purpose, t.status])).toEqual([["decompose", "succeeded"]]);
      expect(tasksOf(h, node)).toEqual([]);
      expect(workersOf(h, node)).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByPlanNode(node.id)).toEqual([]);
      // Settling again changes nothing.
      expect(await h.scheduler.advanceRun(s.created.run.id)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });

  it("runs independent Workers concurrently within maxConcurrentWorkers, never starting a Worker while a Coordinator turn is active, and integrates in canonical order whatever the completion order", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = coordinatorNode(h, s, { bounds: { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      // Three independent Tasks; the first two Workers hold until released, so at most two run at once under maxConcurrentWorkers.
      const delayed = (key: string, diff: string): FakeStep => ({ kind: "delay", key, then: workerStep(h, { summary: key, diff }) });
      const final: { artifactId?: ArtifactId } = {};
      h.provider.script(
        turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!] }), proposal({ key: "c", requirementIds: [leafIds[0]!] })])]),
        delayed("w0", "+a"),
        delayed("w1", "+b"),
        workerStep(h, { summary: "c", diff: "+c" }),
        synthesisStep(h, runId, final),
      );
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.provider.delayedKeys.length === 2 && h.scheduler.reconcileRun(runId).actions.length === 0);
      const tasks = tasksOf(h, node);
      expect(tasks.map((t) => t.status)).toEqual(["running", "running", "ready"]);
      expect(workersOf(h, node)).toHaveLength(2);
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      // The third Task is ready but held by the node's Worker bound, not by the Run (max 4) or the provider (max 8).
      expect(h.scheduler.reconcileRun(runId).limited).toEqual([]);
      // The second Worker finishes first; its Changeset is not integrated until the first Task (earlier in canonical order) is determined.
      h.provider.release("w1");
      await until(() => h.stores.tasks.get(tasks[1]!.id).status === "completed");
      await until(() => h.provider.delayedKeys.length === 1 && workersOf(h, node).length === 3);
      expect(h.integrationWorkspace.requests.map((r) => h.stores.changesets.get(r.changesetId).invocationId)).toEqual([s.invocation.id, turnsOf(h, node)[0]!.id]);
      expect(h.stores.handoffs.listByRun(runId)).toEqual([]);
      h.provider.release("w0");
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      const workers = workersOf(h, node);
      const byChangeset = new Map(h.stores.changesets.listByRun(runId).map((c) => [c.id, c.invocationId] as const));
      // Integration order: a, b, c — the canonical Task order — never b first.
      expect(h.integrationWorkspace.requests.map((r) => byChangeset.get(r.changesetId))).toEqual([s.invocation.id, turnsOf(h, node)[0]!.id, workers[0]!.id, workers[1]!.id, workers[2]!.id, turnsOf(h, node)[1]!.id]);
      expect(h.stores.handoffs.listByRun(runId).map((x) => x.handoffKey)).toEqual(tasks.map((t) => `worker_result:${node.id}:${t.id}`));
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      // Only two Coordinator turns ever existed: no turn was spent on routine completion.
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "synthesize"]);
    } finally {
      h.close();
    }
  });

  it("gives a Worker no runtime handler for propose_tasks, keeps the runtime-tool boundary apart from capability authorization, and hands a Worker result off only after its Changeset is integrated", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = coordinatorNode(h, s);
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const final: { artifactId?: ArtifactId } = {};
      // The Worker tries to propose a Task through the runtime-tool port and to call propose_tasks as a provider-native capability; neither is executable.
      const attempt: RuntimeToolCallRequest = propose([proposal({ key: "x", requirementIds: [leafIds[0]!] })]);
      h.provider.script(
        turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]),
        { kind: "runtime_tool_calls", calls: [attempt], then: { kind: "tool_calls", calls: [{ tool: "propose_tasks", input: { tasks: [] } }], then: workerStep(h, { summary: "a", diff: "+a" }) } },
        workerStep(h, { summary: "a", diff: "+a" }),
        synthesisStep(h, runId, final),
      );
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const worker = workersOf(h, node)[0]!;
      const recorded = h.provider.requests.find((r) => r.attemptId === h.stores.invocations.listAttempts(worker.id)[0]!.id)!;
      expect(recorded.runtimeTools).toEqual([]);
      expect(recorded.runtimeToolCalls.map((c) => c.outcome)).toEqual([{ kind: "not_callable", tool: "propose_tasks" }]);
      // The capability port answered by Tool Policy alone (an undeclared tool is denied) and recorded no approval or use.
      expect(recorded.authorizations.map((a) => a.authorization.kind)).toEqual(["denied"]);
      expect(h.stores.approvedToolCallUses.listByRun(runId)).toEqual([]);
      expect(tasksOf(h, node)).toHaveLength(1);
      expect(h.stores.runtimeToolCalls.listByPlanNode(node.id).map((c) => c.invocationId)).toEqual([turnsOf(h, node)[0]!.id]);
      // The Worker's denied capability call ended its first Attempt as a tool failure; the retry completed the Task.
      expect(h.stores.invocations.listAttempts(worker.id).map((a) => [a.status, a.failureClass])).toEqual([["failed", "tool_failure"], ["succeeded", null]]);
      // The result Handoff appeared only once the Worker's Changeset was integrated: integration precedes the Handoff in the journal.
      const changeset = h.stores.changesets.listByRun(runId).find((c) => c.invocationId === worker.id)!;
      const events = h.ctx.journal.read({ runId });
      const integrated = events.findIndex((e) => e.type === "changeset.integrated" && (e.payload as { changesetId: string }).changesetId === changeset.id);
      const handoff = events.findIndex((e) => e.type === "handoff.created");
      expect(integrated).toBeGreaterThan(-1);
      expect(handoff).toBeGreaterThan(integrated);
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("integrated");
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
    } finally {
      h.close();
    }
  });

  it("coalesces every unresolved blocker into one replan that replaces failed Tasks and cancels a blocked one, after which historical failed Tasks no longer block and synthesis runs once", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = coordinatorNode(h, s, { bounds: { maxTasks: 8, maxConcurrentWorkers: 3, maxCoordinatorInvocations: 4 } });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      // a fails, b reports blocked, c depends on a, d completes: the frontier is {a failed, b blocked, c blocked by a}; one replan receives it all.
      h.provider.script(
        turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!] }), proposal({ key: "c", requirementIds: [leafIds[1]!], dependsOnKeys: ["a"] }), proposal({ key: "d", requirementIds: [leafIds[0]!] })])]),
        workerStep(h, { status: "failed" }),
        workerStep(h, { status: "blocked" }),
        workerStep(h, { summary: "d", diff: "+d" }),
      );
      const first = await h.scheduler.advanceRun(runId);
      // The pass stops once the replan turn is prepared and executed with the default (empty) result... unless we script it: it is scripted below, so stop after preparation.
      expect(first.stop).toBe("quiescent");
      const tasks = tasksOf(h, node);
      const [a, b, c, d] = tasks as [(typeof tasks)[number], (typeof tasks)[number], (typeof tasks)[number], (typeof tasks)[number]];
      // c was blocked by a's failure (the exact dependency reason), never cancelled silently; b by its Worker's report.
      expect(h.ctx.journal.read({ runId, type: "task.blocked" }).map((e) => [e.subjectId, (e.payload as { blockReason: unknown }).blockReason])).toEqual([
        [b.id, { kind: "input", description: "the spec is ambiguous" }],
        [c.id, { kind: "dependency_failed", taskId: a.id }],
      ]);
      // One replan turn, prepared only once nothing else could proceed, carrying every blocker once and d's result Handoff; the default result made no progress.
      const turns = turnsOf(h, node);
      expect(turns.map((t) => [t.purpose, t.status, t.continuedFromInvocationId])).toEqual([["decompose", "succeeded", null], ["replan", "succeeded", turns[0]!.id]]);
      const replan = h.stores.invocations.getManifest(turns[1]!.id).content;
      expect(replan.inputs.filter((i) => i.kind === "coordinator_blocker").map((i) => (i.kind === "coordinator_blocker" ? coordinatorBlockerKey(i.blocker) : ""))).toEqual([`task_failed:${a.id}`, `task_blocked:${b.id}:input`, `task_blocked:${c.id}:dependency_failed`]);
      expect(replan.inputs[0]).toMatchObject({ kind: "coordinator_turn", purpose: "replan", turnsUsed: 2, blockerKeys: [`task_blocked:${b.id}:input`, `task_blocked:${c.id}:dependency_failed`, `task_failed:${a.id}`].sort() });
      expect(replan.handoffs.map((x) => x.taskIds)).toEqual([[d.id]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(h.ctx.journal.read({ runId, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "coordinator_no_progress" });
      // Failing the node cancelled the unstarted current Tasks and released their reservations; the failed Task stays failed.
      expect(tasksOf(h, node).map((t) => t.status)).toEqual(["failed", "cancelled", "cancelled", "completed"]);
      expect(h.stores.reservations.listByChild({ type: "task", id: c.id })[0]).toMatchObject({ status: "released", releaseReason: "task_cancelled" });
    } finally {
      h.close();
    }
    const g = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(g);
      const { node, leafIds } = coordinatorNode(g, s, { bounds: { maxTasks: 8, maxConcurrentWorkers: 3, maxCoordinatorInvocations: 4 } });
      const runId = s.created.run.id;
      await finishRoot(g, s);
      const final: { artifactId?: ArtifactId } = {};
      g.provider.script(
        turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!] }), proposal({ key: "c", requirementIds: [leafIds[1]!], dependsOnKeys: ["a"] })])]),
        workerStep(g, { status: "failed" }),
        workerStep(g, { status: "blocked" }),
        // The replan: replace a, cancel b (c keeps waiting and follows a's replacement); a rejected cancellation of the completed Task changes nothing.
        {
          kind: "derived",
          step: () => {
            const [a, b] = tasksOf(g, node);
            return turn([propose([proposal({ key: "a2", requirementIds: [leafIds[0]!], replacesTaskId: a!.id })]), cancel(b!.id), cancel(a!.id, "already replaced")]);
          },
        },
        workerStep(g, { summary: "a2", diff: "+a2" }),
        workerStep(g, { summary: "c", diff: "+c" }),
        synthesisStep(g, runId, final),
      );
      const outcome = await g.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.failure).toBeNull();
      const tasks = tasksOf(g, node);
      const [a, b, c, a2] = tasks as [(typeof tasks)[number], (typeof tasks)[number], (typeof tasks)[number], (typeof tasks)[number]];
      // The historical failed Task stays failed and superseded; its replacement is the current Task; c waited on the replacement and completed.
      expect(tasks.map((t) => [t.status, t.replacesTaskId])).toEqual([["failed", null], ["cancelled", null], ["completed", null], ["completed", a.id]]);
      expect(g.stores.tasks.replacementOf(a.id)!.id).toBe(a2.id);
      expect(g.stores.tasks.dependencies(runId).map((d) => [d.taskId, d.dependsOnTaskId])).toEqual([[c.id, a.id], [c.id, a2.id]]);
      const replanTurn = turnsOf(g, node)[1]!;
      const calls = g.stores.runtimeToolCalls.listByInvocation(replanTurn.id);
      expect(calls.map((x) => [x.tool, x.result])).toEqual([
        ["propose_tasks", { tool: "propose_tasks", taskIds: [a2.id], taskIdsByKey: { a2: a2.id } }],
        ["update_task", { tool: "update_task", taskId: b.id, status: "cancelled" }],
      ]);
      expect(g.provider.runtimeToolCalls.filter((x) => x.outcome.kind === "rejected").map((x) => x.outcome.kind === "rejected" && x.outcome.reasons[0]!.code)).toEqual(["task_not_cancellable"]);
      // Exactly three logical turns, synthesis once, receiving the two integrated results and the full ledger.
      const turns = turnsOf(g, node);
      expect(turns.map((t) => t.purpose)).toEqual(["decompose", "replan", "synthesize"]);
      const synthesis = g.stores.invocations.getManifest(turns[2]!.id).content;
      expect(synthesis.handoffs.map((x) => x.taskIds).sort()).toEqual([[a2.id], [c.id]].sort());
      expect(synthesis.inputs.filter((i) => i.kind === "coordinator_blocker")).toEqual([]);
      expect((synthesis.inputs[0] as { tasks: { taskId: string; supersededByTaskId: string | null }[] }).tasks.find((t) => t.taskId === a.id)!.supersededByTaskId).toBe(a2.id);
      expect(g.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      expect(g.stores.handoffs.listByRun(runId)).toHaveLength(2);
    } finally {
      g.close();
    }
  });

  it("fails with coordinator_invocations_exhausted when blockers remain at the bound, counting approval successors as the same logical turn and never duplicating their accepted proposal", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const coordinator = seedApprovalCoordinator(h);
      const { node, leafIds } = coordinatorNode(h, s, { bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 2 }, coordinator: coordinator.id });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const WRITE = { tool: "write", input: { path: "notes.md", content: "plan" } };
      // The decompose blocks on an approval after accepting its proposal; the successor continues the same turn without a second proposal.
      const batch = propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })]);
      h.provider.script({ kind: "runtime_tool_calls", calls: [batch], then: { kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } } });
      const blocked = await h.scheduler.advanceRun(runId);
      expect(blocked).toMatchObject({ stop: "waiting", waiting: [{ nodeId: node.id, reason: "decision" }] });
      const decompose = turnsOf(h, node)[0]!;
      expect(decompose.status).toBe("blocked");
      expect(tasksOf(h, node)).toHaveLength(1);
      expect(workersOf(h, node)).toEqual([]);
      h.stores.decisions.resolve(decompose.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      // The successor re-submits the same proposal (a replay), a different one (refused), runs the approved call, and completes.
      // The Worker fails; the replan replaces the Task (progress); the replacement's Worker fails too; the bound is spent.
      h.provider.script(
        { kind: "runtime_tool_calls", calls: [batch, propose([proposal({ key: "z", requirementIds: [leafIds[1]!] })])], then: { kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } } },
        { kind: "permanent_error" },
        { kind: "derived", step: () => turn([propose([proposal({ key: "a2", requirementIds: [leafIds[0]!], replacesTaskId: tasksOf(h, node)[0]!.id })])]) },
        { kind: "permanent_error" },
      );
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const turns = turnsOf(h, node);
      expect(turns.map((t) => [t.purpose, t.status, t.continuedFromInvocationId])).toEqual([["decompose", "blocked", null], ["decompose", "succeeded", decompose.id], ["replan", "succeeded", turns[1]!.id]]);
      const successorCalls = h.provider.requests.find((r) => r.attemptId === h.stores.invocations.listAttempts(turns[1]!.id)[0]!.id)!.runtimeToolCalls.map((c) => c.outcome);
      expect(successorCalls[0]).toMatchObject({ kind: "accepted", replayed: true, callId: h.stores.runtimeToolCalls.listByInvocation(decompose.id)[0]!.id });
      expect(successorCalls[1]).toMatchObject({ kind: "rejected", reasons: [{ code: "proposal_already_accepted" }] });
      expect(h.stores.runtimeToolCalls.listByPlanNode(node.id).map((c) => c.invocationId)).toEqual([decompose.id, turns[2]!.id]);
      expect(h.provider.executed.map((e) => e.authorization.kind)).toEqual(["approved_once"]);
      // Two logical turns used (the approval successor consumed none); the replacement failed; no turn remains for another replan or synthesis.
      expect(tasksOf(h, node).map((t) => [t.status, t.replacesTaskId !== null])).toEqual([["failed", false], ["failed", true]]);
      expect((h.stores.invocations.getManifest(turns[2]!.id).content.inputs[0] as { turnsUsed: number }).turnsUsed).toBe(2);
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(h.ctx.journal.read({ runId, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "coordinator_invocations_exhausted" });
      expect(turnsOf(h, node)).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("gates the integrated synthesis output through its node_exit Gate and succeeds the node on a pass", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.created.run.conversationId, requirementId: null, requirementRevisionId: null, taskId: h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "gate", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }).id, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const { node, leafIds } = coordinatorNode(h, s, { gate: [criterion.id] });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const final: { artifactId?: ArtifactId } = {};
      h.provider.script(turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]), workerStep(h, { summary: "a", diff: "+a" }), synthesisStep(h, runId, final));
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      expect(outcome.actions.map((p) => p.action.kind).filter((k) => k.includes("gate"))).toEqual(["open_node_gate", "run_gate_checks", "settle_node_gate"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      expect(h.stores.changesets.listByRun(runId).every((c) => c.integrationStatus === "integrated")).toBe(true);
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "synthesize"]);
      const [gate] = h.stores.gates.listByPlanNode(node.id);
      expect(gate).toMatchObject({ status: "passed", ordinal: 1, candidateArtifactIds: [final.artifactId], snapshotId: h.stores.runs.get(runId).integrationSnapshotId });
      expect(h.criterionExecution.observed.map((o) => [o.acceptanceCriterionId, o.gateId])).toEqual([[criterion.id, gate!.id]]);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
      expect(h.provider.requests).toHaveLength(4);
    } finally {
      h.close();
    }
  });
  it("treats an unresolved integration conflict as a blocker: delivers it to a replan whose cancellation of the conflict Task fails the node, or re-integrates once the conflict Task completes without spending a turn", async () => {
    const conflicted = async (h: RuntimeHarness, maxActions: number | undefined, afterWorker: FakeStep[]) => {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = coordinatorNode(h, s, { bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      // Hold the Integration Workspace from the moment the Worker runs so its Changeset can be declared conflicting before it is applied.
      let open!: () => void;
      let seen = -1;
      const worker = workerStep(h, { summary: "a", diff: "+a" });
      h.provider.script(turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]), {
        kind: "derived",
        step: (request) => {
          seen = h.integrationWorkspace.requests.length;
          h.integrationWorkspace.gate = new Promise<void>((resolve) => {
            open = resolve;
          });
          return worker.kind === "derived" ? worker.step(request) : worker;
        },
      }, ...afterWorker);
      const pass = h.scheduler.advanceRun(runId, maxActions === undefined ? {} : { maxActions });
      await until(() => seen >= 0 && h.integrationWorkspace.requests.length > seen);
      const changeset = h.stores.changesets.get(h.integrationWorkspace.requests.at(-1)!.changesetId);
      expect(changeset.invocationId).toBe(workersOf(h, node)[0]!.id);
      h.integrationWorkspace.conflictNext.add(changeset.id);
      h.integrationWorkspace.gate = null;
      open();
      const outcome = await pass;
      const recorded = h.stores.changesets.get(changeset.id);
      expect(recorded.integrationStatus).toBe("conflict");
      const conflictTask = h.stores.tasks.get(recorded.conflictTaskId!);
      expect(conflictTask).toMatchObject({ origin: "runtime", planNodeId: node.id });
      return { s, node, runId, changeset: recorded, conflictTask, outcome };
    };
    // Delivery to a replan: the conflict is the one blocker; the Coordinator cancels the conflict Task, which leaves the conflict unresolved and fails the node.
    const g = openRuntimeHarness({ governor: WIDE });
    let conflictedAt = -1;
    try {
      const replanStep: FakeStep = { kind: "derived", step: (request) => turn([cancel(g.stores.tasks.listByRun(g.stores.invocations.get(request.invocationId).runId).find((t) => t.origin === "runtime")!.id, "cannot be merged")]) };
      const { node, runId, changeset, conflictTask, outcome } = await conflicted(g, undefined, [replanStep]);
      expect(outcome.stop).toBe("quiescent");
      conflictedAt = outcome.actions.findIndex((p) => p.outcome.kind === "conflicted");
      expect(conflictedAt).toBeGreaterThan(0);
      const turns = turnsOf(g, node);
      expect(turns.map((t) => [t.purpose, t.status])).toEqual([["decompose", "succeeded"], ["replan", "succeeded"]]);
      const replan = g.stores.invocations.getManifest(turns[1]!.id).content;
      expect(replan.inputs.filter((i) => i.kind === "coordinator_blocker").map((i) => i.kind === "coordinator_blocker" && i.blocker)).toEqual([{ kind: "integration_conflict", taskId: tasksOf(g, node)[0]!.id, invocationId: workersOf(g, node)[0]!.id, changesetId: changeset.id, conflictTaskId: conflictTask.id, reportArtifactId: conflictTask.inputArtifactIds[0] }]);
      expect(replan.handoffs).toEqual([]);
      expect(g.stores.handoffs.listByRun(runId)).toEqual([]);
      expect(g.stores.tasks.get(conflictTask.id).status).toBe("cancelled");
      expect(g.stores.changesets.get(changeset.id).integrationStatus).toBe("conflict");
      expect(g.stores.plans.getNode(node.id).status).toBe("failed");
      expect(g.ctx.journal.read({ runId, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "integration_conflict" });
    } finally {
      g.close();
    }
    // Resolution through the existing conflict lifecycle: the pass stops right after the conflict is recorded; the conflict Task completes; the next pass
    // re-applies the Changeset, records the Handoff, and synthesizes — no replan turn is spent.
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const { node, runId, changeset, conflictTask, outcome } = await conflicted(h, conflictedAt + 1, []);
      expect(outcome.actions.at(-1)).toMatchObject({ action: { kind: "settle_node" }, outcome: { kind: "conflicted" } });
      expect(conflictTask.status).toBe("pending");
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose"]);
      expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "start_position", nodeId: node.id, position: { kind: "coordinator_turn" }, turn: "replan" }]);
      h.stores.tasks.transition(conflictTask.id, { to: "ready" });
      h.stores.tasks.transition(conflictTask.id, { to: "running", invocationId: turnsOf(h, node)[0]!.id });
      h.stores.tasks.transition(conflictTask.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test/resolved" }], outputArtifactIds: [] });
      const final: { artifactId?: ArtifactId } = {};
      h.provider.script(synthesisStep(h, runId, final));
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("integrated");
      expect(h.stores.handoffs.listByRun(runId).map((x) => x.handoffKey)).toEqual([`worker_result:${node.id}:${tasksOf(h, node)[0]!.id}`]);
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "synthesize"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
    } finally {
      h.close();
    }
  });
});
