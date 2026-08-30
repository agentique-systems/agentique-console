/**
 * Canonical, idempotent Handoffs (execution-model §4.3, §5.2; invariant 8
 * minimal routing metadata): one row per logical transfer, keyed by the
 * transfer, enforced by the database, created the same way by repeated
 * reconciliation, a later revision, or a restart; sequence transfers carry
 * outputs or a dependency failure; chain-step transfers carry a completed
 * step's result to the next step.
 */
import { InvariantViolationError, type InvocationResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { extendPlan, nodeInput, openHarness, patternDefinition, seedArtifact, seedInvocation, seedManifest, seedRun, type Harness, type Seeded } from "../persistence/test-support.ts";
import { HandoffRouter, boundedHandoffSummary } from "./handoff-routing.ts";

const result = (summary: string, artifactIds: string[] = []): InvocationResult => ({ status: "completed", artifactIds: artifactIds as never, tasks: [], evidence: [], summary, openItems: [], blocker: null, runOutcome: null });

/** A → B (and A → C with runOnDependencyFailure) in one revision; A running. */
function sequenced(h: Harness, s: Seeded) {
  const a = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0", title: "A" }));
  const b = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", title: "B" }));
  const c = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2", title: "C", runOnDependencyFailure: true }));
  const graph = extendPlan(h, s, [a, b, c], [
    { type: "sequence", sourceNodeId: a.id, targetNodeId: b.id, position: 0 },
    { type: "sequence", sourceNodeId: a.id, targetNodeId: c.id, position: 0 },
  ]);
  h.stores.plans.transitionNode(a.id, { to: "ready" });
  h.stores.plans.transitionNode(a.id, { to: "running" });
  return { graph, a, b, c };
}

describe("HandoffRouter", () => {
  it("creates one sequence Handoff per current edge from a succeeded source, carrying its outputs, and never a second one for the same transfer", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { a, b, c } = sequenced(h, s);
      const router = new HandoffRouter(h.stores);
      const invocation = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: a.id });
      seedManifest(h, s, invocation);
      const output = seedArtifact(h, s, "output", { invocationId: invocation.id });
      h.stores.invocations.transition(invocation.id, { to: "running" });
      h.stores.invocations.transition(invocation.id, { to: "succeeded", result: result("A finished the flag", [output.id]) });
      h.stores.plans.transitionNode(a.id, { to: "succeeded", outputArtifactIds: [output.id] });
      const graph = h.stores.plans.currentGraph(s.run.id);
      const seq = h.ctx.journal.lastSeq();
      const first = router.ensureSequenceHandoffsFrom(graph, a.id);
      expect(first.map((e) => [e.created, e.handoff.handoffKey, e.handoff.target])).toEqual([
        [true, `sequence:${a.id}:${b.id}`, { kind: "plan_node", planNodeId: b.id }],
        [true, `sequence:${a.id}:${c.id}`, { kind: "plan_node", planNodeId: c.id }],
      ]);
      expect(first[0]!.handoff).toMatchObject({ source: { kind: "plan_node", planNodeId: a.id }, taskIds: [], artifactIds: [output.id], summary: "A finished the flag", status: "pending" });
      // Invariant 8: routing metadata only.
      expect(Object.keys(first[0]!.handoff).sort()).toEqual(["artifactIds", "createdAt", "deliveredAt", "handoffKey", "id", "runId", "source", "status", "summary", "target", "taskIds"]);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["handoff.created", "handoff.created"]);
      // Repeated reconciliation, from either end of the edge, finds the same rows and writes nothing.
      const again = router.ensureSequenceHandoffsFrom(graph, a.id);
      expect(again.map((e) => [e.created, e.handoff.id])).toEqual(first.map((e) => [false, e.handoff.id]));
      expect(router.ensureSequenceHandoffsInto(graph, b.id).map((e) => [e.created, e.handoff.id])).toEqual([[false, first[0]!.handoff.id]]);
      expect(h.ctx.journal.lastSeq()).toBe(seq + 2);
      expect(router.pendingHandoffsFor(s.run.id, b.id).map((x) => x.id)).toEqual([first[0]!.handoff.id]);
      // The database, not a check-then-insert, holds the rule: a second row with the same key is refused outright.
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO handoffs (id, run_id, handoff_key, source, target, task_ids, artifact_ids, summary, status, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, '[]', '[]', 'dup', 'pending', ?, NULL)")
          .run("ho_" + "0".repeat(24), s.run.id, `sequence:${a.id}:${b.id}`, JSON.stringify({ kind: "plan_node", planNodeId: a.id }), JSON.stringify({ kind: "plan_node", planNodeId: b.id }), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: handoffs.run_id, handoffs.handoff_key/);
      // The same key with different routing is an invariant violation, never a silent overwrite.
      expect(() => h.stores.handoffs.ensure({ runId: s.run.id, route: { kind: "sequence", sourceNodeId: a.id, targetNodeId: b.id }, source: { kind: "plan_node", planNodeId: a.id }, target: { kind: "plan_node", planNodeId: b.id }, taskIds: [], artifactIds: [], summary: "other" })).toThrow(InvariantViolationError);
      expect(() => h.stores.handoffs.ensure({ runId: s.run.id, route: { kind: "sequence", sourceNodeId: a.id, targetNodeId: b.id }, source: { kind: "plan_node", planNodeId: b.id }, target: { kind: "plan_node", planNodeId: a.id }, taskIds: [], artifactIds: [output.id], summary: "x" })).toThrow(InvariantViolationError);
      // The summary is bounded and single-line.
      expect(boundedHandoffSummary(`${"x".repeat(600)}\nsecond line`)).toHaveLength(500);
      expect(boundedHandoffSummary("  short  ")).toBe("short");
    } finally {
      h.close();
    }
  });

  it("carries a dependency failure only to a target that runs on it, nothing from a skipped source, and delivers to the first Invocation of the target", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { a, b, c } = sequenced(h, s);
      const router = new HandoffRouter(h.stores);
      h.stores.plans.transitionNode(a.id, { to: "failed", reason: "invocation_failed" });
      const graph = h.stores.plans.currentGraph(s.run.id);
      const ensured = router.ensureSequenceHandoffsFrom(graph, a.id);
      // B (no opt-in) receives nothing; C receives the failure with no Artifacts and no Tasks.
      expect(ensured.map((e) => e.handoff.target)).toEqual([{ kind: "plan_node", planNodeId: c.id }]);
      expect(ensured[0]!.handoff).toMatchObject({ handoffKey: `sequence:${a.id}:${c.id}`, artifactIds: [], taskIds: [], summary: "A failed" });
      expect(router.pendingHandoffsFor(s.run.id, b.id)).toEqual([]);
      expect(router.ensureSequenceHandoffsInto(graph, c.id).map((e) => [e.created, e.handoff.id])).toEqual([[false, ensured[0]!.handoff.id]]);
      // A skipped source hands nothing off; a non-terminal source cannot be a Handoff source.
      const d = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e3", title: "D" }));
      const e = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e4", title: "E", runOnDependencyFailure: true }));
      extendPlan(h, s, [d, e], [{ type: "sequence", sourceNodeId: d.id, targetNodeId: e.id, position: 0 }]);
      h.stores.plans.transitionNode(d.id, { to: "skipped" });
      const later = h.stores.plans.currentGraph(s.run.id);
      expect(router.ensureSequenceHandoffsFrom(later, d.id)).toEqual([]);
      expect(router.ensureSequenceHandoffsInto(later, e.id)).toEqual([]);
      expect(() => router.ensureSequenceHandoffsFrom(later, b.id)).toThrow(/pending/);
      // Delivery: preparing C's first Invocation with the pending Handoff marks it delivered and lists it in the manifest.
      h.stores.plans.transitionNode(c.id, { to: "ready" });
      h.stores.plans.transitionNode(c.id, { to: "running" });
      const invocation = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: c.id });
      h.stores.handoffs.transition(ensured[0]!.handoff.id, "delivered");
      seedManifest(h, s, invocation);
      expect(router.pendingHandoffsFor(s.run.id, c.id)).toEqual([]);
      expect(h.stores.handoffs.get(ensured[0]!.handoff.id).status).toBe("delivered");
    } finally {
      h.close();
    }
  });

  it("creates exactly one internal chain-step Handoff from a completed step, keyed by the step, and refuses incomplete or final steps", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const operation = { agentDefinitionRevisionId: s.definition.id, title: "step", input: { taskIds: [], decisionIds: [], artifactIds: [] }, role: "worker" as const, readOnly: false };
      const chain = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0", title: "chain", shape: { pattern: "chain", steps: [operation, operation, operation] } }));
      extendPlan(h, s, [chain]);
      h.stores.plans.transitionNode(chain.id, { to: "ready" });
      const node = h.stores.plans.transitionNode(chain.id, { to: "running" });
      if (node.kind !== "pattern") throw new Error("pattern node expected");
      const router = new HandoffRouter(h.stores);
      const step0 = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, patternPosition: { kind: "chain_step", index: 0, count: 3 } });
      seedManifest(h, s, step0);
      // Not yet completed: no Handoff.
      expect(() => router.ensureChainStepHandoff(node, h.stores.invocations.get(step0.id))).toThrow(/did not complete/);
      const output = seedArtifact(h, s, "step 0 output", { invocationId: step0.id });
      h.stores.invocations.transition(step0.id, { to: "running" });
      const done = h.stores.invocations.transition(step0.id, { to: "succeeded", result: result("wrote the parser", [output.id]) });
      const seq = h.ctx.journal.lastSeq();
      const first = router.ensureChainStepHandoff(node, done);
      expect(first.created).toBe(true);
      expect(first.handoff).toMatchObject({ handoffKey: `chain_step:${node.id}:0`, source: { kind: "invocation", invocationId: step0.id }, target: { kind: "plan_node", planNodeId: node.id }, taskIds: [], artifactIds: [output.id], summary: "wrote the parser", status: "pending" });
      expect(router.ensureChainStepHandoff(node, done)).toEqual({ handoff: first.handoff, created: false });
      expect(router.chainStepHandoff(s.run.id, node.id, 0)?.id).toBe(first.handoff.id);
      expect(router.chainStepHandoff(s.run.id, node.id, 1)).toBeNull();
      expect(h.ctx.journal.lastSeq()).toBe(seq + 1);
      // A final step hands off to nothing; a step of another node or a non-chain node is refused.
      const last = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, patternPosition: { kind: "chain_step", index: 2, count: 3 } });
      seedManifest(h, s, last);
      h.stores.invocations.transition(last.id, { to: "running" });
      const ended = h.stores.invocations.transition(last.id, { to: "succeeded", result: result("done") });
      expect(() => router.ensureChainStepHandoff(node, ended)).toThrow(/final step/);
      const single = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", title: "single" }));
      extendPlan(h, s, [single]);
      const singleNode = h.stores.plans.getNode(single.id);
      if (singleNode.kind !== "pattern") throw new Error("pattern node expected");
      expect(() => router.ensureChainStepHandoff(singleNode, done)).toThrow(/only a chain/);
      // The store itself refuses a chain-step route whose source is not that step of that node.
      expect(() => h.stores.handoffs.create({ runId: s.run.id, route: { kind: "chain_step", planNodeId: node.id, fromStep: 1 }, source: { kind: "invocation", invocationId: step0.id }, target: { kind: "plan_node", planNodeId: node.id }, taskIds: [], artifactIds: [], summary: "" })).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });
});
