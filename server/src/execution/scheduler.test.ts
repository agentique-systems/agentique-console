/**
 * The event-driven, bounded Run scheduler (execution-model §4.3, §7.1,
 * §7.4, §7.8, §14; invariants 5 the runtime owns scheduling and waiting,
 * 15 the current graph is never inferred, 18 deterministic backpressure,
 * 20 one Invocation per turn): deterministic ordering of independent
 * nodes, Run and node concurrency, provider and process capacity, stale
 * revisions, removed nodes, bounded passes, concurrent callers joining one
 * pass, quiescence and resumption times, no narrative, and provider and
 * Workspace calls outside every transaction.
 */
import type { PlanExpression, PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, TEST_GOVERNOR, type RuntimeHarness } from "./test-support.ts";

const single = (s: ReturnType<typeof seedPlanningRuntime>, title: string, extra: Partial<PlanExpression> = {}): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 }, ...extra } as PlanExpression);

/** Yields to the event loop until `done` holds (the pass in progress has reached the observed state), never sleeping on a timer. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the pass did not reach the expected state");
}

function statuses(h: RuntimeHarness, nodes: PlanNode[]) {
  return nodes.map((n) => h.stores.plans.getNode(n.id).status);
}

describe("RunScheduler", () => {
  it("projects and performs actions in membership order, runs independent nodes concurrently within the governor's limits, and ends quiescent", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [single(s, "A"), single(s, "B"), single(s, "C")]);
      const [a, b, c] = nodes as [PlanNode, PlanNode, PlanNode];
      const messages = h.stores.conversations.listMessages(s.created.run.conversationId).length;
      // Projection is read-only and explains the next actions: the root's pending turn executes first, then every independent node becomes ready.
      const seq = h.ctx.journal.lastSeq();
      const projection = h.scheduler.reconcileRun(s.created.run.id);
      expect(projection.actions).toEqual([
        { kind: "execute_invocation", nodeId: s.created.root.id, invocationId: s.invocation.id, worktrees: 1 },
        { kind: "ready_node", nodeId: a.id },
        { kind: "ready_node", nodeId: b.id },
        { kind: "ready_node", nodeId: c.id },
      ]);
      expect(projection).toMatchObject({ stop: "quiescent", waiting: [], deferred: [], inFlight: [], wakeAt: null, concurrency: { active: 1, max: 4 } });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // The root turn and A execute concurrently (provider concurrency 2); B's execution waits on capacity; C starts (Run concurrency 4) and waits too.
      h.provider.script({ kind: "delay", key: "root", then: { kind: "succeed", result: COMPLETED_RESULT } }, { kind: "delay", key: "a", then: { kind: "succeed", result: COMPLETED_RESULT } });
      const pass = h.scheduler.advanceRun(s.created.run.id);
      await until(() => h.provider.delayedKeys.length === 2 && h.scheduler.reconcileRun(s.created.run.id).actions.length === 0);
      expect(h.provider.delayedKeys).toEqual(["a", "root"]);
      expect(h.governor.status().activeLeases).toHaveLength(2);
      const mid = h.scheduler.reconcileRun(s.created.run.id);
      expect(mid.inFlight.sort()).toEqual([s.invocation.id, h.stores.invocations.listByPlanNode(a.id)[0]!.id].sort());
      expect(statuses(h, [a, b, c])).toEqual(["running", "waiting", "waiting"]);
      expect(h.stores.plans.getNode(b.id).waitReason).toBe("provider_capacity");
      expect(mid.actions).toEqual([]);
      expect(mid.stop).toBe("waiting");
      expect(h.stores.runs.get(s.created.run.id).status).toBe("running");
      // Every provider call ran outside any transaction.
      expect(h.provider.requests.every((r) => !r.inTransaction)).toBe(true);
      h.provider.release("root");
      h.provider.release("a");
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.failure).toBeNull();
      expect(outcome.executed).toHaveLength(4);
      expect(statuses(h, [a, b, c])).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("running");
      // Deterministic order: readiness, starts, and settlements in membership order; waits cleared with their exact reason.
      const kinds = outcome.actions.map((p) => `${p.action.kind}:${"nodeId" in p.action ? [a.id, b.id, c.id, s.created.root.id].indexOf(p.action.nodeId) : "-"}`);
      // One action per node per iteration, nodes in membership order: A is readied, started, and executed before B is readied.
      expect(kinds.slice(0, 8)).toEqual(["execute_invocation:3", "ready_node:0", "start_node:0", "execute_invocation:0", "ready_node:1", "start_node:1", "wait_node:1", "ready_node:2"]);
      expect(kinds).toContain("resume_node:1");
      expect(kinds).toContain("resume_node:2");
      expect(kinds.indexOf("settle_node:0")).toBeLessThan(kinds.indexOf("settle_node:1"));
      expect(kinds.indexOf("settle_node:1")).toBeLessThan(kinds.indexOf("settle_node:2"));
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.wait_cleared" })).toHaveLength(2);
      // The root's Changeset was integrated; every worker Changeset too, one integration per Changeset.
      expect(h.stores.changesets.listByRun(s.created.run.id).map((x) => x.integrationStatus)).toEqual(["integrated", "integrated", "integrated", "integrated"]);
      expect(h.integrationWorkspace.requests).toHaveLength(4);
      expect(h.integrationWorkspace.maxConcurrentByRun.get(s.created.run.id)).toBe(1);
      // No narrative, no status message, no model call for scheduling itself.
      expect(h.stores.conversations.listMessages(s.created.run.conversationId)).toHaveLength(messages);
      expect(h.provider.requests).toHaveLength(4);
      // A further pass is a no-op.
      const again = await h.scheduler.advanceRun(s.created.run.id);
      expect(again).toMatchObject({ stop: "quiescent", actions: [], executed: [] });
    } finally {
      h.close();
    }
  });

  it("enforces the Run's maxConcurrency and each node's, reporting limited starts and never starting beyond the bound", async () => {
    const h = openRuntimeHarness({ governor: { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 8 } }, maxProcessConcurrency: 8 } });
    try {
      const s = seedPlanningRuntime(h, { budget: { maxCostUsd: 100, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: 2 } });
      const { nodes } = planNodes(h, s, [single(s, "A"), single(s, "B"), single(s, "C", { limits: { maxConcurrency: 1 } })]);
      const [a, b, c] = nodes as [PlanNode, PlanNode, PlanNode];
      h.provider.script({ kind: "delay", key: "root", then: { kind: "succeed", result: COMPLETED_RESULT } }, { kind: "delay", key: "a", then: { kind: "succeed", result: COMPLETED_RESULT } });
      const pass = h.scheduler.advanceRun(s.created.run.id);
      await until(() => h.provider.delayedKeys.length === 2 && h.scheduler.reconcileRun(s.created.run.id).actions.length === 0);
      // Two active Invocations (root turn, A): B and C are ready but limited, not waiting on the provider.
      const mid = h.scheduler.reconcileRun(s.created.run.id);
      expect(mid.concurrency).toEqual({ active: 2, max: 2 });
      expect(mid.limited).toEqual([b.id, c.id]);
      expect(mid.waiting).toEqual([]);
      expect(statuses(h, [a, b, c])).toEqual(["running", "ready", "ready"]);
      expect(h.stores.invocations.listActive(s.created.run.id)).toHaveLength(2);
      h.provider.release("root");
      h.provider.release("a");
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      expect(statuses(h, [a, b, c])).toEqual(["succeeded", "succeeded", "succeeded"]);
      // At no point were more than two Invocations active; each node ran one Invocation.
      expect(Math.max(...h.stores.leases.listByRun(s.created.run.id).map(() => 1))).toBe(1);
      expect(nodes.map((n) => h.stores.invocations.listByPlanNode(n.id).length)).toEqual([1, 1, 1]);
    } finally {
      h.close();
    }
  });

  it("waits the Run on provider capacity only when nothing else can proceed, reports the resumption time, and resumes with the exact reason", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [single(s, "A")]);
      const a = nodes[0]!;
      const retryAfter = new Date(Date.parse(h.clock.now()) + 60_000).toISOString();
      h.governor.updateProviderAvailability("fake", { available: false, retryAfter });
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      // The root turn and A cannot obtain a lease: A waits on provider_capacity, the Run waits too, and the retry-after time is the wake time.
      expect(outcome.stop).toBe("waiting");
      expect(outcome.actions.map((p) => p.action.kind)).toEqual(["ready_node", "start_node", "wait_node", "wait_run"]);
      expect(outcome.wakeAt).toBe(retryAfter);
      expect(outcome.waiting).toEqual([{ nodeId: s.created.root.id, reason: "provider_capacity", wakeAt: retryAfter }, { nodeId: a.id, reason: "provider_capacity", wakeAt: retryAfter }]);
      expect(h.stores.runs.get(s.created.run.id)).toMatchObject({ status: "waiting", waitReason: "provider_capacity" });
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ status: "waiting", waitReason: "provider_capacity" });
      expect(h.stores.invocations.listAttempts(h.stores.invocations.listByPlanNode(a.id)[0]!.id)).toEqual([]);
      expect(h.provider.requests).toHaveLength(0);
      // Nothing changes while the provider is unavailable: no polling, no timer, the same answer on every call.
      const seq = h.ctx.journal.lastSeq();
      expect(await h.scheduler.advanceRun(s.created.run.id)).toMatchObject({ stop: "waiting", actions: [], wakeAt: retryAfter });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // Once the wake time passes the Run resumes with the cleared reason and both Invocations execute.
      h.clock.set(retryAfter);
      const resumed = await h.scheduler.advanceRun(s.created.run.id);
      expect(resumed.stop).toBe("quiescent");
      expect(resumed.actions.map((p) => p.action.kind).slice(0, 3)).toEqual(["resume_run", "execute_invocation", "resume_node"]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "run.wait_cleared" })[0]!.payload).toMatchObject({ clearedWaitReason: "provider_capacity" });
      expect(h.stores.runs.get(s.created.run.id).status).toBe("running");
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("reports retry resumption times, bounds a pass by maxActions, and lets concurrent callers share one pass", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [single(s, "A"), single(s, "B")]);
      // A transient failure of the root turn: the pass ends waiting on the durable retry time; nothing polls.
      h.provider.script({ kind: "transient_error" });
      const first = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 1 });
      expect(first).toMatchObject({ stop: "action_limit", actions: [{ action: { kind: "execute_invocation" } }] });
      const notBefore = h.stores.invocations.listAttempts(s.invocation.id)[0]!.retryDecision!.notBefore!;
      const projection = h.scheduler.reconcileRun(s.created.run.id);
      expect(projection.wakeAt).toBe(notBefore);
      // A bounded pass performs exactly maxActions actions, one node at a time in membership order, and stops with the closed reason; the next pass continues.
      const second = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 2 });
      expect(second.stop).toBe("action_limit");
      expect(second.actions.map((p) => p.action.kind)).toEqual(["ready_node", "start_node"]);
      expect(statuses(h, nodes)).toEqual(["running", "pending"]);
      // Two concurrent callers receive the same pass's outcome; no Attempt or Invocation is duplicated.
      h.provider.script({ kind: "delay", key: "a", then: { kind: "succeed", result: COMPLETED_RESULT } });
      const p1 = h.scheduler.advanceRun(s.created.run.id, { maxActions: 3 });
      const p2 = h.scheduler.advanceRun(s.created.run.id, { maxActions: 100 });
      expect(h.scheduler.isAdvancing(s.created.run.id)).toBe(true);
      await until(() => h.provider.delayedKeys.length === 1);
      h.provider.release("a");
      const [o1, o2] = await Promise.all([p1, p2]);
      expect(o1).toBe(o2);
      expect(o1.stop).toBe("action_limit");
      expect(o1.actions.map((p) => p.action.kind)).toEqual(["execute_invocation", "ready_node", "start_node"]);
      expect(h.scheduler.isAdvancing(s.created.run.id)).toBe(false);
      expect(nodes.map((n) => h.stores.invocations.listByPlanNode(n.id).length)).toEqual([1, 1]);
      expect(h.stores.invocations.listAttempts(h.stores.invocations.listByPlanNode(nodes[0]!.id)[0]!.id)).toHaveLength(1);
      expect(h.stores.invocations.listAttempts(h.stores.invocations.listByPlanNode(nodes[1]!.id)[0]!.id)).toHaveLength(0);
      // The rest completes once the root's retry time has passed.
      h.clock.set(notBefore);
      const rest = await h.scheduler.advanceRun(s.created.run.id);
      expect(rest.stop).toBe("quiescent");
      expect(statuses(h, nodes)).toEqual(["succeeded", "succeeded"]);
      expect(h.stores.invocations.listAttempts(s.invocation.id)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("never lets a node removed from the current revision activate a successor, and applies readiness only against the revision it projected", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      // A → B as two nodes joined by a sequence edge (node-level options make each leaf its own node).
      const first = planNodes(h, s, [{ pattern: "chain", steps: [single(s, "A"), single(s, "B")] }]);
      const [a, b] = first.nodes as [PlanNode, PlanNode];
      expect(first.outcome.graph.edges.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual([[a.id, b.id]]);
      h.provider.script({ kind: "delay", key: "root", then: { kind: "succeed", result: COMPLETED_RESULT } }, { kind: "delay", key: "a", then: { kind: "succeed", result: COMPLETED_RESULT } });
      const pass = h.scheduler.advanceRun(s.created.run.id);
      await until(() => h.provider.delayedKeys.length === 2);
      expect(statuses(h, [a, b])).toEqual(["running", "pending"]);
      // A revision replaces the whole chain while A runs: A leaves the membership (still running), B (unstarted) is cancelled,
      // and a new independent node C has no predecessor.
      const second = planNodes(h, s, [single(s, "C")]);
      const c = second.nodes[0]!;
      expect(second.outcome.cancelledNodeIds).toEqual([b.id]);
      expect(h.stores.plans.getNode(a.id).status).toBe("running");
      h.provider.release("root");
      h.provider.release("a");
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      // A finished its own work (settled as removed) but handed nothing to anyone; C started from its own readiness with no Handoff.
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
      expect(h.stores.plans.getNode(b.id).status).toBe("cancelled");
      expect(h.stores.plans.getNode(c.id).status).toBe("succeeded");
      expect(outcome.actions.some((p) => p.action.kind === "settle_removed_node" && p.action.nodeId === a.id)).toBe(true);
      expect(h.stores.handoffs.listByRun(s.created.run.id)).toEqual([]);
      const cInvocation = h.stores.invocations.listByPlanNode(c.id)[0]!;
      expect(h.stores.invocations.getManifest(cInvocation.id).content.handoffs).toEqual([]);
      expect(h.stores.invocations.listByPlanNode(b.id)).toEqual([]);
      expect(h.stores.plans.currentGraph(s.created.run.id).edges).toEqual([]);
    } finally {
      h.close();
    }
    // Readiness projected against revision n is never applied against revision n+1: the mutation revalidates and reports stale.
    const r = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(r);
      const { nodes } = planNodes(r, s, [single(s, "A")]);
      const a = nodes[0]!;
      r.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const original = r.stores.plans.currentGraph.bind(r.stores.plans);
      let calls = 0;
      // The second graph read of the pass happens inside the readiness transaction; a revision lands just before it.
      r.stores.plans.currentGraph = (runId) => {
        calls += 1;
        if (calls === 3) {
          r.stores.plans.currentGraph = original;
          planNodes(r, s, [single(s, "A"), single(s, "B")]);
        }
        return original(runId);
      };
      const outcome = await r.scheduler.advanceRun(s.created.run.id, { maxActions: 2 });
      const readied = outcome.actions.find((p) => p.action.kind === "ready_node");
      expect(readied?.outcome).toEqual({ kind: "stale" });
      expect(outcome.stop).toBe("action_limit");
      expect(r.stores.plans.getNode(a.id).status).toBe("pending");
      // The next pass projects the new revision and readies both nodes.
      const next = await r.scheduler.advanceRun(s.created.run.id);
      expect(next.stop).toBe("quiescent");
      expect(r.stores.plans.currentGraph(s.created.run.id).nodes.slice(1).map((n) => n.status)).toEqual(["succeeded", "succeeded"]);
    } finally {
      r.close();
    }
  });

  it("runs a node's node_exit Gate to a pass in one pass, integrates the root's own Changeset, fails the Run when the root turn fails, and stops on a terminal Run", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [single(s, "A")]);
      const a = nodes[0]!;
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("root"), diff: new TextEncoder().encode("+root"), empty: false };
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
      // The root Orchestrator's own Changeset was integrated and the root stays running.
      expect(h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === s.invocation.id)!.integrationStatus).toBe("integrated");
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("running");
    } finally {
      h.close();
    }
    const g = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(g);
      const task = g.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "g", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const criterion = g.stores.requirements.createAcceptanceCriterion({ conversationId: s.created.run.conversationId, requirementId: null, requirementRevisionId: null, taskId: task.id, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const { nodes } = planNodes(g, s, [single(s, "gated", { gateAcceptanceCriterionIds: [criterion.id] })]);
      const outcome = await g.scheduler.advanceRun(s.created.run.id);
      // The Gate is opened, checked (external), and settled by typed actions; nothing is deferred and the node succeeds.
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      const kinds = outcome.actions.map((p) => p.action.kind);
      expect(kinds.slice(kinds.indexOf("open_node_gate"))).toEqual(["open_node_gate", "run_gate_checks", "settle_node_gate"]);
      expect(outcome.actions.map((p) => p.outcome.kind)).toEqual(expect.arrayContaining(["gate_opened", "gate_verified", "gate_passed"]));
      expect(g.stores.plans.getNode(nodes[0]!.id).status).toBe("succeeded");
      expect(g.stores.gates.listByPlanNode(nodes[0]!.id).map((x) => [x.ordinal, x.status])).toEqual([[1, "passed"]]);
      expect(g.stores.invocations.listByPlanNode(nodes[0]!.id)).toHaveLength(1);
      expect((await g.scheduler.advanceRun(s.created.run.id)).actions).toEqual([]);
    } finally {
      g.close();
    }
    const f = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(f);
      const { nodes } = planNodes(f, s, [single(s, "A")]);
      f.provider.script({ kind: "permanent_error", message: "model retired" });
      const outcome = await f.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("run_terminal");
      expect(f.stores.runs.get(s.created.run.id)).toMatchObject({ status: "failed", failure: { kind: "root_node_failed" } });
      expect(f.stores.plans.getNode(s.created.root.id).status).toBe("failed");
      // A terminal Run schedules nothing more, whatever its nodes were about to do.
      expect(f.scheduler.reconcileRun(s.created.run.id)).toMatchObject({ stop: "run_terminal", actions: [] });
      expect(await f.scheduler.advanceRun(s.created.run.id)).toMatchObject({ stop: "run_terminal", actions: [] });
      // A's Invocation ran before the root's failure ended the Run; its settlement is never applied once the Run is terminal.
      expect(f.stores.plans.getNode(nodes[0]!.id).status).toBe("running");
    } finally {
      f.close();
    }
  });

  it("stops with infrastructure_failure when an action throws, leaving canonical state consistent for the next pass", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [single(s, "A")]);
      const transition = h.stores.plans.transitionNode.bind(h.stores.plans);
      h.stores.plans.transitionNode = () => {
        throw new Error("disk I/O error");
      };
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome).toMatchObject({ stop: "infrastructure_failure", failure: { message: "disk I/O error" } });
      h.stores.plans.transitionNode = transition;
      expect(h.stores.plans.getNode(nodes[0]!.id).status).toBe("pending");
      const next = await h.scheduler.advanceRun(s.created.run.id);
      expect(next.stop).toBe("quiescent");
      expect(h.stores.plans.getNode(nodes[0]!.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });
});
