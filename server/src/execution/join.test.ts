/**
 * Deterministic `join` settlement (execution-model §4.2, §4.3, §7.7;
 * invariants 5 the runtime owns fan-in and 15 the persisted plan is flat):
 * `require_all` and `require_any` success and failure over the non-skipped
 * predecessors, all-skipped joins skipping, the index ordered by fan-in
 * edge position (never completion time), no Invocation, Attempt, lease, or
 * Usage, the index as output delivered to a compiled aggregation through
 * the ordinary sequence Handoff, idempotent repeated settlement, and
 * convergence across a restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJoinIndex, JOIN_INDEX_MEDIA_TYPE, parseJoinIndex, type PlanExpression, type PlanNode, type PlanNodeId, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { JoinNodeSettler } from "./join.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, TEST_GOVERNOR, type RuntimeHarness } from "./test-support.ts";

const ALLOCATION = { costUsd: 6, tokens: 60_000, attempts: 6 };
const WIDE = { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 8 } }, maxProcessConcurrency: 8 };

/** A composite parallel: every item is its own node (node-level allocation), fanning into a compiler-emitted join. */
function composite(s: ReturnType<typeof seedPlanningRuntime>, titles: string[], options: { requireAll?: boolean; aggregate?: boolean } = {}): PlanExpression {
  return {
    pattern: "parallel",
    items: titles.map((title) => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: ALLOCATION })),
    ...(options.aggregate ? { aggregate: { agentDefinitionRevisionId: s.worker.id, title: "aggregate" } } : {}),
    ...(options.requireAll === undefined ? {} : { requireAll: options.requireAll }),
    allocation: ALLOCATION,
  };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the pass did not reach the expected state");
}

async function finishRoot(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) {
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  await h.executor.advanceInvocation(s.invocation.id);
}

function joinIndex(h: RuntimeHarness, runId: RunId) {
  const artifacts = h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === JOIN_INDEX_MEDIA_TYPE);
  expect(artifacts).toHaveLength(1);
  const artifact = artifacts[0]!;
  return { artifact, index: parseJoinIndex(new TextDecoder().decode(h.stores.artifacts.read(artifact.id).bytes)) };
}

const byPath = (nodes: PlanNode[]) => Object.fromEntries(nodes.map((n) => [n.sourcePath, n]));

describe("join settlement", () => {
  it("succeeds under require_all when every non-skipped source succeeded, writes the index in edge order whatever the completion order, creates no Invocation, Attempt, lease, or Usage, and delivers the index to the aggregation", async () => {
    const h = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(h);
      const { nodes, outcome: compiled } = planNodes(h, s, [composite(s, ["A", "B", "C"], { aggregate: true })]);
      const n = byPath(nodes);
      const [a, b, c, join, aggregate] = [n["e0/items/0"]!, n["e0/items/1"]!, n["e0/items/2"]!, n["e0/join"]!, n["e0/aggregate"]!];
      expect(join.kind).toBe("join");
      const fanIn = compiled.graph.edges.filter((e) => e.type === "fan_in");
      expect(fanIn.map((e) => [e.sourceNodeId, e.position])).toEqual([[a.id, 0], [b.id, 1], [c.id, 2]]);
      await finishRoot(h, s);
      const runId = s.created.run.id;
      const outputs = ["a", "b", "c"].map((key) => h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: key }, new TextEncoder().encode(key)));
      for (const [i, key] of ["a", "b", "c"].entries()) h.provider.script({ kind: "delay", key, then: { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [outputs[i]!.id] } } });
      const usageBefore = h.stores.usage.totalsForRun(runId).rows;
      const leasesBefore = h.stores.leases.listByRun(runId).length;
      const pass = h.scheduler.advanceRun(runId);
      await until(() => h.provider.delayedKeys.length === 3);
      expect(h.stores.plans.getNode(join.id).status).toBe("pending");
      // Sources complete in reverse order; the join waits for the last, then settles once.
      h.provider.release("c");
      h.provider.release("b");
      await until(() => [b, c].every((x) => h.stores.plans.getNode(x.id).status === "succeeded"));
      expect(h.stores.plans.getNode(join.id).status).toBe("pending");
      expect(h.scheduler.reconcileRun(runId).nodes.find((x) => x.nodeId === join.id)!.readiness).toEqual({ kind: "remain_pending", nodeId: join.id, awaiting: [a.id] });
      h.provider.release("a");
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await pass;
      expect(outcome.stop).toBe("quiescent");
      const kinds = outcome.actions.map((p) => p.action.kind);
      expect(kinds.filter((k) => k === "settle_join")).toEqual(["settle_join"]);
      // The join settles exactly once, after the last source settled, and readies the aggregation only then.
      const settledSources = outcome.actions.map((p, i) => (p.action.kind === "settle_node" && [a.id, b.id, c.id].includes(p.action.nodeId) && p.outcome.kind === "succeeded" ? i : -1)).filter((i) => i >= 0);
      expect(settledSources).toHaveLength(3);
      expect(kinds.indexOf("settle_join")).toBeGreaterThan(Math.max(...settledSources));
      expect(outcome.actions.findIndex((p) => p.action.kind === "start_node" && p.action.nodeId === aggregate.id)).toBeGreaterThan(kinds.indexOf("settle_join"));
      expect(outcome.actions.find((p) => p.action.kind === "settle_join")!.outcome).toMatchObject({ kind: "succeeded" });
      // The index: edge order, structured facts, canonical bytes; the join's output; no Invocation, Attempt, lease, or Usage for the join.
      const { artifact, index } = joinIndex(h, runId);
      expect(index).toEqual({ version: 1, planNodeId: join.id, sources: fanIn.map((e, i) => ({ position: e.position, edgeId: e.id, sourceNodeId: e.sourceNodeId, status: "succeeded", outputArtifactIds: [outputs[i]!.id] })) });
      expect(artifact.digest).toBe(sha256Hex(new TextEncoder().encode(canonicalJoinIndex(index))));
      expect(artifact.producer).toEqual({ kind: "runtime", component: "join" });
      expect(h.stores.plans.getNode(join.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id], startedAt: null });
      expect(h.stores.invocations.listByPlanNode(join.id)).toEqual([]);
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.planNodeId === join.id)).toEqual([]);
      expect(h.stores.usage.totalsForPlanNode(join.id).rows).toBe(0);
      // Four source steps and the ended node's result reaches the Orchestrator as one node_result turn (execution-model §4.6); the join itself consumed nothing.
      expect(h.stores.usage.totalsForRun(runId).rows).toBe(usageBefore + 5);
      expect(h.stores.leases.listByRun(runId)).toHaveLength(leasesBefore + 5);
      expect(h.stores.reservations.activeForChild({ type: "plan_node", id: join.id })).toBeNull();
      expect(h.ctx.journal.read({ runId, type: "plan_node.started" }).some((e) => e.scope.planNodeId === join.id)).toBe(false);
      // The compiled aggregation received the index through the ordinary sequence Handoff and is the expression's exit.
      const handoff = h.stores.handoffs.getByKey(runId, `sequence:${join.id}:${aggregate.id}`)!;
      expect(handoff).toMatchObject({ artifactIds: [artifact.id], status: "delivered" });
      const aggregation = h.stores.invocations.listByPlanNode(aggregate.id)[0]!;
      expect(h.stores.invocations.getManifest(aggregation.id).content.handoffs.map((x) => [x.handoffId, x.artifactIds])).toEqual([[handoff.id, [artifact.id]]]);
      expect(h.stores.plans.getNode(aggregate.id).status).toBe("succeeded");
      expect(h.stores.handoffs.listByRun(runId)).toHaveLength(1);
      expect(h.stores.artifacts.listByRun(runId).filter((x) => x.mediaType === JOIN_INDEX_MEDIA_TYPE)).toHaveLength(1);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });

  it("applies the fan-in policy over non-skipped sources: require_all fails on one failure, require_any succeeds on one success and fails on none, and an all-skipped join is skipped", async () => {
    const run = async (requireAll: boolean, steps: ("ok" | "fail")[]) => {
      const h = openRuntimeHarness({ governor: WIDE });
      try {
        const s = seedPlanningRuntime(h);
        const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [composite(s, steps.map((_, i) => `I${i}`), { requireAll }), { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "after" }, allocation: ALLOCATION }] }]);
        const n = byPath(nodes);
        const join = n["e0/steps/0/join"]!;
        const after = n["e0/steps/1"]!;
        await finishRoot(h, s);
        for (const step of steps) h.provider.script(step === "ok" ? { kind: "succeed", result: COMPLETED_RESULT } : { kind: "permanent_error", message: "model refused" });
        const outcome = await h.scheduler.advanceRun(s.created.run.id);
        expect(outcome.stop).toBe("quiescent");
        const { artifact, index } = joinIndex(h, s.created.run.id);
        expect(index.sources.map((x) => x.status)).toEqual(steps.map((step) => (step === "ok" ? "succeeded" : "failed")));
        return { h, join, after, artifact, runId: s.created.run.id };
      } catch (error) {
        h.close();
        throw error;
      }
    };
    {
      const { h, join, after, artifact, runId } = await run(true, ["ok", "fail", "ok"]);
      expect(h.stores.plans.getNode(join.id)).toMatchObject({ status: "failed", outputArtifactIds: null });
      expect(h.ctx.journal.read({ runId, type: "plan_node.failed" }).find((e) => e.scope.planNodeId === join.id)!.payload).toEqual({ from: "ready", to: "failed", reason: "join_fan_in_failed", artifactIds: [artifact.id] });
      expect(h.stores.plans.getNode(after.id).status).toBe("skipped");
      expect(h.stores.handoffs.listByRun(runId)).toEqual([]);
      h.close();
    }
    {
      const { h, join, after, artifact } = await run(false, ["fail", "ok", "fail"]);
      expect(h.stores.plans.getNode(join.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id] });
      expect(h.stores.plans.getNode(after.id).status).toBe("succeeded");
      h.close();
    }
    {
      const { h, join, after } = await run(false, ["fail", "fail"]);
      expect(h.stores.plans.getNode(join.id).status).toBe("failed");
      expect(h.stores.plans.getNode(after.id).status).toBe("skipped");
      h.close();
    }
    // Every source skipped (behind a failed predecessor): the join is skipped, never failed, and writes no index.
    const k = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(k);
      const { nodes } = planNodes(k, s, [{ pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "first" }, allocation: ALLOCATION }, composite(s, ["A", "B"])] }]);
      const n = byPath(nodes);
      await finishRoot(k, s);
      k.provider.script({ kind: "permanent_error", message: "model refused" });
      const outcome = await k.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect([n["e0/steps/0"]!, n["e0/steps/1/items/0"]!, n["e0/steps/1/items/1"]!, n["e0/steps/1/join"]!].map((x) => k.stores.plans.getNode(x.id).status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
      expect(k.stores.artifacts.listByRun(s.created.run.id).filter((x) => x.mediaType === JOIN_INDEX_MEDIA_TYPE)).toEqual([]);
      // A mix of skipped and succeeded sources counts only the non-skipped ones.
    } finally {
      k.close();
    }
    const m = openRuntimeHarness({ governor: WIDE });
    try {
      const s = seedPlanningRuntime(m);
      // parallel(chain(first, X), Y): X is skipped when `first` fails; Y succeeds; require_all over the non-skipped sources passes.
      const { nodes } = planNodes(m, s, [
        {
          pattern: "parallel",
          items: [
            { pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "first" }, allocation: ALLOCATION }, { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "X" }, allocation: ALLOCATION }] },
            { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "Y" }, allocation: ALLOCATION },
          ],
          allocation: ALLOCATION,
        },
      ]);
      const n = byPath(nodes);
      await finishRoot(m, s);
      m.provider.script({ kind: "permanent_error", message: "model refused" }, { kind: "succeed", result: COMPLETED_RESULT });
      expect((await m.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect([n["e0/items/0/steps/0"]!, n["e0/items/0/steps/1"]!, n["e0/items/1"]!, n["e0/join"]!].map((x) => m.stores.plans.getNode(x.id).status)).toEqual(["failed", "skipped", "succeeded", "succeeded"]);
      expect(joinIndex(m, s.created.run.id).index.sources.map((x) => x.status)).toEqual(["skipped", "succeeded"]);
    } finally {
      m.close();
    }
  });

  it("settles idempotently and converges across a restart between readiness and settlement with one index and one Handoff", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-join-"));
    try {
      const file = path.join(dir, "console.db");
      let clock: TestClock;
      let blobs: MemoryBlobStore;
      let runId: RunId;
      let joinId: PlanNodeId;
      let revisionNumber: number;
      {
        const h = openRuntimeHarness({ base: openHarness(file), governor: WIDE });
        clock = h.clock;
        blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        runId = s.created.run.id;
        const { nodes, revisionNumber: revision } = planNodes(h, s, [{ pattern: "chain", steps: [composite(s, ["A", "B"]), { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "after" }, allocation: ALLOCATION }] }]);
        revisionNumber = revision;
        joinId = byPath(nodes)["e0/steps/0/join"]!.id;
        await finishRoot(h, s);
        // Run until the join has been readied but not settled: the process dies there.
        let stopAtReady = false;
        for (let i = 0; i < 40 && !stopAtReady; i += 1) {
          const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
          stopAtReady = pass.actions.some((p) => p.action.kind === "ready_node" && p.action.nodeId === joinId);
        }
        expect(h.stores.plans.getNode(joinId).status).toBe("ready");
        expect(h.stores.artifacts.listByRun(runId).filter((x) => x.mediaType === JOIN_INDEX_MEDIA_TYPE)).toEqual([]);
        h.close();
      }
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        h.recovery.recover();
        expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "settle_join", nodeId: joinId }]);
        const settler = new JoinNodeSettler(h.ctx, h.stores);
        const first = settler.settle(joinId, revisionNumber);
        expect(first).toMatchObject({ kind: "succeeded" });
        if (first.kind !== "succeeded") throw new Error(first.kind);
        const seq = h.ctx.journal.lastSeq();
        // Repeated settlement writes nothing; a stale revision writes nothing; the index and the Handoff exist once.
        expect(settler.settle(joinId, revisionNumber)).toEqual({ kind: "no_change" });
        expect(settler.settle(joinId, revisionNumber + 1)).toMatchObject({ kind: "stale" });
        expect(h.ctx.journal.lastSeq()).toBe(seq);
        expect(h.stores.artifacts.listByRun(runId).filter((x) => x.mediaType === JOIN_INDEX_MEDIA_TYPE)).toHaveLength(1);
        expect(h.stores.handoffs.listByRun(runId)).toHaveLength(1);
        h.close();
      }
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), governor: WIDE });
        h.recovery.recover();
        const outcome = await h.scheduler.advanceRun(runId);
        expect(outcome.stop).toBe("quiescent");
        expect(outcome.actions.map((p) => p.action.kind)).not.toContain("settle_join");
        expect(h.stores.artifacts.listByRun(runId).filter((x) => x.mediaType === JOIN_INDEX_MEDIA_TYPE)).toHaveLength(1);
        expect(h.stores.handoffs.listByRun(runId)).toHaveLength(1);
        expect(h.stores.plans.listNodes(runId).filter((x) => x.sourcePath !== "root").map((x) => x.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
        // The aggregation step and the node_result turn of the ended graph; the join repeats nothing.
        expect(h.provider.requests).toHaveLength(2);
        h.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
