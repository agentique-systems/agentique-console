/**
 * The `parallel` Pattern runner (execution-model §5.4, §7.7, §9.2;
 * invariants 5 the runtime owns fan-in, 7 Workers receive only their
 * manifest, 8 minimal Handoffs, 20 one Invocation per turn): items start
 * concurrently within the Run's, the node's, and the governor's limits,
 * Changesets integrate in item-index order whatever the completion order,
 * items never see each other's outputs, `requireAll` semantics, the
 * canonical index Artifact and its delivery to exactly one aggregation
 * Invocation, an approval-blocked item continuing at its position, a
 * conflict holding later items back, and restart without duplicates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalParallelIndex, PARALLEL_INDEX_MEDIA_TYPE, parseParallelIndex, type ArtifactId, type InvocationId, type PlanExpression, type PlanNode, type PlanNodeId, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../../persistence/test-support.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, TEST_GOVERNOR, type RuntimeHarness } from "../test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };
const ALLOCATION = { costUsd: 12, tokens: 120_000, attempts: 12 };
const WIDE = { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 8 } }, maxProcessConcurrency: 8 };

function leaf(s: ReturnType<typeof seedPlanningRuntime>, title: string, input?: { artifactIds?: string[] }): PlanExpression {
  return { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title, ...(input ? { input: { taskIds: [], decisionIds: [], artifactIds: [], ...input } as never } : {}) } };
}

function parallel(s: ReturnType<typeof seedPlanningRuntime>, count: number, options: { aggregate?: boolean; requireAll?: boolean; maxConcurrency?: number } = {}): PlanExpression {
  return {
    pattern: "parallel",
    items: Array.from({ length: count }, (_, i) => leaf(s, `item ${i}`)),
    ...(options.aggregate ? { aggregate: { agentDefinitionRevisionId: s.worker.id, title: "aggregate" } } : {}),
    ...(options.requireAll === undefined ? {} : { requireAll: options.requireAll }),
    ...(options.maxConcurrency === undefined ? {} : { limits: { maxConcurrency: options.maxConcurrency } }),
    allocation: ALLOCATION,
  };
}

/** Yields to the event loop until `done` holds, never sleeping on a timer. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the pass did not reach the expected state");
}

/** The item index of an Invocation's position. */
const indexOf = (h: RuntimeHarness, invocationId: string) => {
  const position = h.stores.invocations.get(invocationId as InvocationId).patternPosition;
  return position?.kind === "parallel_item" ? position.index : position?.kind ?? null;
};

/** Registers a content Artifact for `invocationId` and a delayed completed result naming it, so completion can be released in any order. */
function delayedItem(h: RuntimeHarness, runId: RunId, key: string) {
  const artifact = h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: key }, new TextEncoder().encode(key));
  h.provider.script({ kind: "delay", key, then: { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], summary: key } } });
  return artifact;
}

/** Finishes the root Orchestrator turn so the pass starts with the plan. */
async function finishRoot(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) {
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  await h.executor.advanceInvocation(s.invocation.id);
}

function indexArtifact(h: RuntimeHarness, node: PlanNode) {
  const artifact = h.stores.artifacts.listByRun(node.runId).find((a) => a.mediaType === PARALLEL_INDEX_MEDIA_TYPE && a.producer.kind === "runtime" && a.producer.component === "parallel_index");
  if (!artifact) throw new Error("no index Artifact");
  return { artifact, index: parseParallelIndex(new TextDecoder().decode(h.stores.artifacts.read(artifact.id).bytes)) };
}

describe("ParallelPatternRunner", () => {
  it("starts items concurrently, integrates in item order whatever the completion order, isolates items, writes one canonical index, and delivers it once to the aggregation", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [parallel(s, 3, { aggregate: true })]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      const runId = s.created.run.id;
      // Every item writes: each collected Changeset carries content so integration order is observable at the fake Workspace.
      const outputs = ["i0", "i1", "i2"].map((key) => delayedItem(h, runId, key));
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.provider.delayedKeys.length === 3);
      // Three item Invocations, one per position, all executing; no aggregation yet.
      const items = h.stores.invocations.listByPlanNode(node.id);
      expect(items.map((i) => i.patternPosition)).toEqual([0, 1, 2].map((index) => ({ kind: "parallel_item", index, count: 3 })));
      expect(items.every((i) => i.role === "worker" && i.purpose === "step" && i.status === "running")).toBe(true);
      expect(h.scheduler.reconcileRun(runId)).toMatchObject({ stop: "waiting", actions: [] });
      expect(h.scheduler.reconcileRun(runId).inFlight.sort()).toEqual(items.map((i) => i.id).sort());
      // Each item's manifest is its own: the same node context, no other item's Artifacts or Handoffs.
      for (const item of items) {
        const manifest = h.stores.invocations.getManifest(item.id).content;
        expect(manifest.handoffs).toEqual([]);
        expect(manifest.artifacts).toEqual([]);
        expect(manifest.inputs).toEqual([]);
      }
      // Items finish in reverse order; the Changesets are integrated by item index, never by completion.
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("i2"), diff: new TextEncoder().encode("+i2"), empty: false };
      h.provider.release("i2");
      await until(() => h.stores.invocations.get(items[2]!.id).status === "succeeded");
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId !== s.invocation.id).map((c) => c.integrationStatus)).toEqual(["pending"]);
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("i1"), diff: new TextEncoder().encode("+i1"), empty: false };
      h.provider.release("i1");
      await until(() => h.stores.invocations.get(items[1]!.id).status === "succeeded");
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("i0"), diff: new TextEncoder().encode("+i0"), empty: false };
      const aggregationArtifact = h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "report" }, new TextEncoder().encode("report"));
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [aggregationArtifact.id], summary: "aggregated" } });
      h.provider.release("i0");
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      // Integration order is item order: i0, i1, i2, then the aggregation's Changeset.
      const byChangeset = new Map(h.stores.changesets.listByRun(runId).map((c) => [c.id, c.invocationId] as const));
      expect(h.integrationWorkspace.requests.map((r) => byChangeset.get(r.changesetId)).map((id) => (id === s.invocation.id ? "root" : indexOf(h, id!)))).toEqual(["root", 0, 1, 2, "parallel_aggregation"]);
      expect(h.stores.changesets.listByRun(runId).every((c) => c.integrationStatus === "integrated")).toBe(true);
      // One canonical index: ordered by index, structured facts only, canonical bytes.
      const { artifact, index } = indexArtifact(h, node);
      expect(index).toEqual({ version: 1, planNodeId: node.id, items: items.map((i, n) => ({ index: n, invocationId: i.id, outcome: "succeeded", outputArtifactIds: [outputs[n]!.id], failure: null })) });
      expect(artifact.digest).toBe(sha256Hex(new TextEncoder().encode(canonicalParallelIndex(index))));
      expect(h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === PARALLEL_INDEX_MEDIA_TYPE)).toHaveLength(1);
      const text = new TextDecoder().decode(h.stores.artifacts.read(artifact.id).bytes);
      expect(text).not.toMatch(/summary|transcript|worktree|prompt|i0|i1/);
      // Exactly one index Handoff, delivered to exactly one aggregation Invocation whose manifest carries the index and nothing of the items.
      const handoffs = h.stores.handoffs.listByRun(runId);
      expect(handoffs.map((x) => x.handoffKey)).toEqual([`parallel_index:${node.id}`]);
      expect(handoffs[0]).toMatchObject({ artifactIds: [artifact.id], status: "delivered" });
      const aggregation = h.stores.invocations.listAtPosition(node.id, "parallel_aggregation");
      expect(aggregation).toHaveLength(1);
      const manifest = h.stores.invocations.getManifest(aggregation[0]!.id).content;
      expect(manifest.handoffs.map((x) => [x.handoffId, x.artifactIds])).toEqual([[handoffs[0]!.id, [artifact.id]]]);
      expect(manifest.artifacts.map((a) => [a.artifactId, a.mediaType])).toEqual([[artifact.id, PARALLEL_INDEX_MEDIA_TYPE]]);
      expect(manifest.artifacts.map((a) => a.artifactId)).not.toContain(outputs[0]!.id);
      // The node's output is the aggregation's Artifacts.
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [aggregationArtifact.id] });
      expect(h.provider.requests).toHaveLength(5);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });

  it("enforces the node's and the Run's maxConcurrency independently when starting items", async () => {
    const n = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(n);
      const { nodes } = planNodes(n, s, [parallel(s, 3, { maxConcurrency: 2 })]);
      await finishRoot(n, s);
      for (const key of ["i0", "i1", "i2"]) delayedItem(n, s.created.run.id, key);
      const pass = n.scheduler.advanceRun(s.created.run.id);
      await until(() => n.provider.delayedKeys.length === 2 && n.scheduler.reconcileRun(s.created.run.id).actions.length === 0);
      // The node limit holds the third item back while the Run (max 4) would allow it.
      expect(n.provider.delayedKeys).toEqual(["i0", "i1"]);
      expect(n.stores.invocations.listByPlanNode(nodes[0]!.id)).toHaveLength(2);
      expect(n.scheduler.reconcileRun(s.created.run.id).limited).toEqual([]);
      n.provider.release("i0");
      await until(() => n.provider.delayedKeys.includes("i2"));
      n.provider.release("i1");
      n.provider.release("i2");
      expect((await pass).stop).toBe("quiescent");
      expect(n.stores.plans.getNode(nodes[0]!.id).status).toBe("succeeded");
    } finally {
      n.close();
    }
    const r = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(r, { budget: { maxCostUsd: 100, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: 2 } });
      const { nodes } = planNodes(r, s, [parallel(s, 3)]);
      await finishRoot(r, s);
      for (const key of ["i0", "i1", "i2"]) delayedItem(r, s.created.run.id, key);
      const pass = r.scheduler.advanceRun(s.created.run.id);
      await until(() => r.provider.delayedKeys.length === 2 && r.scheduler.reconcileRun(s.created.run.id).actions.length === 0);
      // The Run limit holds the third item back although the node has no limit; the projection reports the node as limited.
      expect(r.provider.delayedKeys).toEqual(["i0", "i1"]);
      expect(r.scheduler.reconcileRun(s.created.run.id)).toMatchObject({ limited: [nodes[0]!.id], concurrency: { active: 2, max: 2 } });
      r.provider.release("i0");
      await until(() => r.provider.delayedKeys.includes("i2"));
      r.provider.release("i1");
      r.provider.release("i2");
      expect((await pass).stop).toBe("quiescent");
      expect(r.stores.invocations.listByPlanNode(nodes[0]!.id)).toHaveLength(3);
    } finally {
      r.close();
    }
  });

  it("applies requireAll exactly: one failure fails the node under requireAll, one success suffices otherwise, no success fails it, and failed items stay in the index", async () => {
    const fail = async (requireAll: boolean, steps: ("ok" | "fail")[]) => {
      const h = openRuntimeHarness({ governor: WIDE });
      try {
        const s = seedPlanningRuntime(h);
        const { nodes } = planNodes(h, s, [parallel(s, steps.length, { requireAll })]);
        const node = nodes[0]!;
        await finishRoot(h, s);
        for (const step of steps) h.provider.script(step === "ok" ? { kind: "succeed", result: COMPLETED_RESULT } : { kind: "permanent_error", message: "model refused" });
        const outcome = await h.scheduler.advanceRun(s.created.run.id);
        expect(outcome.stop).toBe("quiescent");
        const { artifact, index } = indexArtifact(h, node);
        expect(index.items.map((i) => i.outcome)).toEqual(steps.map((step) => (step === "ok" ? "succeeded" : "failed")));
        expect(index.items.filter((i) => i.outcome === "failed").map((i) => i.failure)).toEqual(steps.filter((x) => x === "fail").map(() => ({ kind: "invocation_failed", invocationFailureReason: "provider_permanent" })));
        return { h, node, artifact, s };
      } catch (error) {
        h.close();
        throw error;
      }
    };
    {
      const { h, node, artifact } = await fail(true, ["ok", "fail", "ok"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "failed", outputArtifactIds: null });
      const failed = h.ctx.journal.read({ runId: node.runId, type: "plan_node.failed" });
      expect(failed.map((e) => e.payload)).toEqual([{ from: "running", to: "failed", reason: "parallel_items_failed", artifactIds: [artifact.id] }]);
      // Every item ran; the succeeded items' Changesets were integrated; the index exists once.
      expect(h.stores.invocations.listByPlanNode(node.id).map((i) => i.status)).toEqual(["succeeded", "failed", "succeeded"]);
      expect(h.stores.artifacts.listByRun(node.runId).filter((a) => a.mediaType === PARALLEL_INDEX_MEDIA_TYPE)).toHaveLength(1);
      h.close();
    }
    {
      const { h, node, artifact } = await fail(false, ["fail", "ok", "fail"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id] });
      h.close();
    }
    {
      const { h, node } = await fail(false, ["fail", "fail"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "failed" });
      expect(h.ctx.journal.read({ runId: node.runId, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "parallel_items_failed" });
      h.close();
    }
    {
      // Without an aggregation the index is the node's output, delivered to the successor by the ordinary sequence Handoff.
      const { h, node, artifact, s } = await fail(true, ["ok", "ok"]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id] });
      expect(h.stores.handoffs.listByRun(s.created.run.id)).toEqual([]);
      h.close();
    }
  });

  it("continues an approval-blocked item at the same position after the Decision resolves, waiting the node only while nothing else can proceed", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [parallel(s, 3)]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      const runId = s.created.run.id;
      delayedItem(h, runId, "i0");
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      delayedItem(h, runId, "i2");
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.provider.delayedKeys.length === 2 && h.stores.invocations.listAtPosition(node.id, "parallel_item:1").some((i) => i.status === "blocked"));
      // Item 1 is blocked while items 0 and 2 still run: the node keeps running.
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      h.provider.release("i0");
      h.provider.release("i2");
      const waiting = await pass;
      expect(waiting).toMatchObject({ stop: "waiting", waiting: [{ nodeId: node.id, reason: "decision" }] });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === PARALLEL_INDEX_MEDIA_TYPE)).toEqual([]);
      const blocked = h.stores.invocations.listAtPosition(node.id, "parallel_item:1")[0]!;
      h.stores.decisions.resolve(blocked.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(resumed.actions.map((p) => p.action.kind).slice(0, 2)).toEqual(["resume_run", "resume_node"]);
      expect(resumed.actions[1]!.outcome).toMatchObject({ kind: "successor_prepared", position: { kind: "parallel_item", index: 1, count: 3 } });
      const successor = h.stores.invocations.listAtPosition(node.id, "parallel_item:1");
      expect(successor.map((i) => [i.status, i.continuedFromInvocationId])).toEqual([["blocked", null], ["succeeded", blocked.id]]);
      expect(h.provider.executed.map((e) => e.authorization.kind)).toEqual(["approved_once"]);
      const { index } = indexArtifact(h, node);
      expect(index.items.map((i) => [i.index, i.invocationId, i.outcome])).toEqual([[0, h.stores.invocations.listAtPosition(node.id, "parallel_item:0")[0]!.id, "succeeded"], [1, successor[1]!.id, "succeeded"], [2, h.stores.invocations.listAtPosition(node.id, "parallel_item:2")[0]!.id, "succeeded"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("holds a later item's Changeset behind an earlier item's conflict and integrates in order once the conflict Task completes", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [parallel(s, 2)]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      const runId = s.created.run.id;
      delayedItem(h, runId, "i0");
      delayedItem(h, runId, "i1");
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.provider.delayedKeys.length === 2);
      const items = h.stores.invocations.listByPlanNode(node.id);
      // Item 1 finishes first with content; item 0 then finishes with content that conflicts.
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("i1"), diff: new TextEncoder().encode("+i1"), empty: false };
      h.provider.release("i1");
      await until(() => h.stores.invocations.get(items[1]!.id).status === "succeeded");
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("i0"), diff: new TextEncoder().encode("+i0"), empty: false };
      // Hold the Integration Workspace so the conflict can be declared for exactly item 0's Changeset before it is applied.
      let open!: () => void;
      h.integrationWorkspace.gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      h.provider.release("i0");
      await until(() => h.integrationWorkspace.requests.some((r) => h.stores.changesets.get(r.changesetId).invocationId === items[0]!.id));
      h.integrationWorkspace.conflictNext.add(h.stores.changesets.listByRun(runId).find((x) => x.invocationId === items[0]!.id)!.id);
      h.integrationWorkspace.gate = null;
      open();
      const outcome = await pass;
      expect(outcome).toMatchObject({ stop: "waiting", waiting: [{ nodeId: node.id, reason: "integration_conflict" }] });
      const changesets = () => h.stores.changesets.listByRun(runId).filter((c) => c.invocationId !== s.invocation.id).map((c) => [indexOf(h, c.invocationId!), c.integrationStatus]);
      expect(changesets()).toEqual([[1, "pending"], [0, "conflict"]]);
      expect(h.integrationWorkspace.requests.map((r) => h.stores.changesets.get(r.changesetId).invocationId).map((id) => (id === s.invocation.id ? "root" : indexOf(h, id!)))).toEqual(["root", 0]);
      // The conflict Task completes; the resumed pass integrates item 0 first, then item 1, and finishes the node.
      const conflicted = h.stores.changesets.listByRun(runId).find((c) => c.integrationStatus === "conflict")!;
      const task = h.stores.tasks.get(conflicted.conflictTaskId!);
      h.stores.tasks.transition(task.id, { to: "ready" });
      h.stores.tasks.transition(task.id, { to: "running", invocationId: s.invocation.id });
      h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test/resolved" }], outputArtifactIds: [] });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.stop).toBe("quiescent");
      expect(h.integrationWorkspace.requests.map((r) => h.stores.changesets.get(r.changesetId).invocationId).map((id) => (id === s.invocation.id ? "root" : indexOf(h, id!)))).toEqual(["root", 0, 0, 1]);
      expect(changesets()).toEqual([[1, "integrated"], [0, "integrated"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("converges across restarts at every durable boundary without a duplicate item, index, integration, or aggregation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-parallel-"));
    try {
      const file = path.join(dir, "console.db");
      let clock: TestClock;
      let blobs: MemoryBlobStore;
      let runId: RunId;
      let nodeId: PlanNodeId;
      let outputs: ArtifactId[];
      const work = (h: RuntimeHarness) => ({
        items: h.stores.invocations.listByPlanNode(nodeId).filter((i) => i.patternPosition?.kind === "parallel_item").length,
        aggregations: h.stores.invocations.listAtPosition(nodeId, "parallel_aggregation").length,
        indexes: h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === PARALLEL_INDEX_MEDIA_TYPE).length,
        handoffs: h.stores.handoffs.listByRun(runId).length,
        integrated: h.stores.changesets.listByRun(runId).filter((c) => c.integrationStatus === "integrated").length,
      });
      // Process 1: two items are started; the process dies while both Attempts run.
      {
        const h = openRuntimeHarness({ base: openHarness(file), governor: WIDE });
        try {
        clock = h.clock;
        blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        runId = s.created.run.id;
        const { nodes } = planNodes(h, s, [parallel(s, 2, { aggregate: true })]);
        nodeId = nodes[0]!.id;
        await finishRoot(h, s);
        h.provider.script({ kind: "hang" }, { kind: "hang" });
        const pass = h.scheduler.advanceRun(runId);
        void pass.catch(() => undefined);
        await until(() => h.provider.requests.length === 3);
        expect(work(h)).toEqual({ items: 2, aggregations: 0, indexes: 0, handoffs: 0, integrated: 1 });
        } finally {
          h.close();
        }
      }
      // Process 2: recovery interrupts both Attempts; the retries run the same two Invocations; the process dies after both succeeded, before integration.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        try {
        expect(h.recovery.recover().retryEligible).toHaveLength(2);
        outputs = ["a", "b"].map((key) => h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: key }, new TextEncoder().encode(key)).id);
        h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [outputs[0]!] } }, { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [outputs[1]!] } });
        const settle = h.runners.parallel.settle.bind(h.runners.parallel);
        h.runners.parallel.settle = async () => {
          throw new Error("process died before integrating");
        };
        const outcome = await h.scheduler.advanceRun(runId);
        h.runners.parallel.settle = settle;
        expect(outcome.stop).toBe("infrastructure_failure");
        expect(h.stores.invocations.listByPlanNode(nodeId).map((i) => [i.status, h.stores.invocations.listAttempts(i.id).map((a) => a.status)])).toEqual([["succeeded", ["interrupted", "succeeded"]], ["succeeded", ["interrupted", "succeeded"]]]);
        expect(work(h)).toEqual({ items: 2, aggregations: 0, indexes: 0, handoffs: 0, integrated: 1 });
        } finally {
          h.close();
        }
      }
      // Process 3: integration and the index; the process dies right after the aggregation is prepared.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        try {
        h.recovery.recover();
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 3 });
        expect(pass.actions.map((p) => [p.action.kind, p.outcome.kind])).toEqual([["settle_node", "integrated"], ["settle_node", "integrated"], ["settle_node", "step_prepared"]]);
        expect(work(h)).toEqual({ items: 2, aggregations: 1, indexes: 1, handoffs: 1, integrated: 3 });
        expect(h.provider.requests).toHaveLength(0);
        } finally {
          h.close();
        }
      }
      // Process 4: the aggregation runs; nothing earlier is repeated; a further restart changes nothing.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        try {
        h.recovery.recover();
        expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "execute_invocation", nodeId, invocationId: h.stores.invocations.listAtPosition(nodeId, "parallel_aggregation")[0]!.id, worktrees: 1 }]);
        const outcome = await h.scheduler.advanceRun(runId);
        expect(outcome.stop).toBe("quiescent");
        expect(h.provider.requests).toHaveLength(1);
        expect(work(h)).toEqual({ items: 2, aggregations: 1, indexes: 1, handoffs: 1, integrated: 4 });
        expect(h.stores.plans.getNode(nodeId).status).toBe("succeeded");
        expect(indexArtifact(h, h.stores.plans.getNode(nodeId)).index.items.map((i) => i.outputArtifactIds)).toEqual([[outputs[0]!], [outputs[1]!]]);
        } finally {
          h.close();
        }
        const r = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        try {
          r.recovery.recover();
          const before = r.ctx.journal.lastSeq();
          expect(await r.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
          expect(r.ctx.journal.lastSeq()).toBe(before);
          expect(work(r)).toEqual({ items: 2, aggregations: 1, indexes: 1, handoffs: 1, integrated: 4 });
        } finally {
          r.close();
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
