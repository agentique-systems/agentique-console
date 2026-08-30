/**
 * Canonical Pattern positions on Invocations and exact per-operation
 * manifest selection (execution-model §5.2, §6.1, §6.2; invariants 9
 * canonical objects by id, 20 one Invocation per logical turn): a chain
 * step receives only its own operation's Task, Decision, and Artifact
 * references plus the Handoff from the previous step, never the node's
 * union; positions are persisted, agree with the node shape, and admit one
 * active Invocation each.
 */
import { ConflictError, InvariantViolationError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { accepted, openRuntimeHarness, propose, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

function chainOfThree(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) {
  const runId = s.created.run.id;
  const tasks = ["one", "two", "three"].map((subject) => h.stores.tasks.create({ runId, planNodeId: null, origin: "orchestrator", subject, requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }));
  for (const task of tasks) h.stores.tasks.transition(task.id, { to: "ready" });
  const artifacts = ["a0", "a1", "a2"].map((title) => h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title }, new TextEncoder().encode(`content of ${title}`)));
  const decisions = ["d0", "d1", "d2"].map((question) =>
    h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question, options: [{ id: "a", label: "A", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null }),
  );
  const step = (i: number) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: `step ${i}`, input: { taskIds: [tasks[i]!.id], decisionIds: [decisions[i]!.id], artifactIds: [artifacts[i]!.id] } } });
  const plan = accepted(propose(h, s, [{ pattern: "chain", steps: [step(0), step(1), step(2)], allocation: { costUsd: 12, tokens: 120_000, attempts: 9 } }]));
  const node = plan.graph.nodes[1]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  return { node, tasks, artifacts, decisions };
}

describe("pattern positions and exact operation inputs", () => {
  it("gives each chain step exactly its own operation input and the previous step's Handoff, never the node's union", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, tasks, artifacts, decisions } = chainOfThree(h, s);
      if (node.kind !== "pattern") throw new Error("pattern node expected");
      // The node's compiled input is the union, for validation and authorization only.
      expect(node.input).toEqual({ taskIds: tasks.map((t) => t.id).sort(), decisionIds: decisions.map((d) => d.id).sort(), artifactIds: artifacts.map((a) => a.id).sort() });
      const position = (index: number) => ({ kind: "chain_step" as const, index, count: 3 });
      const step0 = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: position(0) });
      expect(step0.invocation).toMatchObject({ patternPosition: position(0), taskIds: [tasks[0]!.id], agentDefinitionRevisionId: s.worker.id });
      const c0 = step0.manifest.content;
      expect(c0.patternPosition).toEqual(position(0));
      expect(c0.tasks).toEqual([{ taskId: tasks[0]!.id, subject: "one" }]);
      expect(c0.artifacts.map((a) => a.artifactId)).toEqual([artifacts[0]!.id]);
      expect(c0.decisions.map((d) => d.decisionId)).toEqual([decisions[0]!.id]);
      expect(c0.handoffs).toEqual([]);
      expect(h.stores.tasks.get(tasks[0]!.id)).toMatchObject({ status: "running", invocationId: step0.invocation.id });
      expect(h.stores.tasks.get(tasks[1]!.id).status).toBe("ready");
      // Step 1 receives its own input plus the Handoff from step 0 (whose Artifacts become readable by id), and nothing of step 2.
      const produced = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: step0.invocation.id, attemptId: null }, taskId: null, title: "step 0 output" }, new TextEncoder().encode("out"));
      const handoff = h.stores.handoffs.create({ runId: s.created.run.id, route: { kind: "chain_step", planNodeId: node.id, fromStep: 0 }, source: { kind: "invocation", invocationId: step0.invocation.id }, target: { kind: "plan_node", planNodeId: node.id }, taskIds: [tasks[0]!.id], artifactIds: [produced.id], summary: "step 0 done" });
      const step1 = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: position(1), handoffIds: [handoff.id] });
      const c1 = step1.manifest.content;
      expect(c1.patternPosition).toEqual(position(1));
      expect(c1.tasks).toEqual([{ taskId: tasks[1]!.id, subject: "two" }]);
      expect(c1.artifacts.map((a) => a.artifactId).sort()).toEqual([artifacts[1]!.id, produced.id].sort());
      expect(c1.decisions.map((d) => d.decisionId)).toEqual([decisions[1]!.id]);
      expect(c1.handoffs).toEqual([{ handoffId: handoff.id, source: { kind: "invocation", invocationId: step0.invocation.id }, taskIds: [tasks[0]!.id], artifactIds: [produced.id], summary: "step 0 done" }]);
      expect(h.stores.handoffs.get(handoff.id).status).toBe("delivered");
      // Nothing of another step is duplicated: no step-0 or step-2 Decision or Artifact reference, no step-2 Task, and no Artifact
      // content anywhere; step 0's Task appears only as the Handoff's routing metadata, never as an owned Task.
      const text = JSON.stringify(c1);
      for (const foreign of [tasks[2]!.id, decisions[0]!.id, decisions[2]!.id, artifacts[0]!.id, artifacts[2]!.id, "content of"]) expect(text).not.toContain(foreign);
      expect(JSON.stringify({ ...c1, handoffs: [] })).not.toContain(tasks[0]!.id);
      expect(JSON.stringify(c0)).not.toContain("content of");
      // The rendered projection names the position concisely; the record is the typed value.
      expect(h.provider.requests).toHaveLength(0);
      expect(step1.manifest.content.patternPosition).toEqual({ kind: "chain_step", index: 1, count: 3 });
    } finally {
      h.close();
    }
  });

  it("persists the position, keeps one active Invocation per position, and requires a successor to continue from the prior terminal one", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, tasks } = chainOfThree(h, s);
      const position = { kind: "chain_step" as const, index: 0, count: 3 };
      const first = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: position });
      expect(h.stores.invocations.get(first.invocation.id).patternPosition).toEqual(position);
      expect((h.database.sqlite.prepare("SELECT pattern_position_key FROM invocations WHERE id = ?").get(first.invocation.id) as { pattern_position_key: string }).pattern_position_key).toBe("chain_step:0");
      expect(h.stores.invocations.listAtPosition(node.id, "chain_step:0").map((i) => i.id)).toEqual([first.invocation.id]);
      // A second Invocation at the same position while the first is active is refused at the store and at the database.
      expect(() => h.stores.invocations.create({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, patternPosition: position, taskIds: [tasks[0]!.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET status = 'running', started_at = created_at WHERE id = ?").run(first.invocation.id)).not.toThrow();
      const other = h.stores.invocations.create({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, patternPosition: { kind: "chain_step", index: 1, count: 3 }, taskIds: [tasks[1]!.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET pattern_position = ?, pattern_position_key = ? WHERE id = ?").run('{"kind":"chain_step","index":0,"count":3}', "chain_step:0", other.id)).toThrow(/immutable|UNIQUE constraint failed: invocations.plan_node_id/);
      // After the first ends, a successor at the same position must name it; a fresh start at that position is refused.
      h.stores.invocations.transition(first.invocation.id, { to: "cancelled" });
      h.stores.tasks.transition(tasks[0]!.id, { to: "blocked", blockReason: { kind: "input", description: "cancelled" } });
      h.stores.tasks.transition(tasks[0]!.id, { to: "ready" });
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: position })).toThrow(/records continuedFromInvocationId/);
      const successor = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: first.invocation.id, patternPosition: position });
      expect(successor.invocation).toMatchObject({ continuedFromInvocationId: first.invocation.id, patternPosition: position });
      expect(h.stores.invocations.latestAtPosition(node.id, "chain_step:0")?.id).toBe(successor.invocation.id);
      // The manifest must agree with the Invocation's position; a position outside the shape or with the wrong role is refused at the store.
      expect(() => h.stores.invocations.putManifest(successor.invocation.id, { ...successor.manifest.content, patternPosition: { kind: "chain_step", index: 1, count: 3 } })).toThrow(/already has its Context Manifest|Pattern position/);
      expect(() => h.stores.invocations.create({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, patternPosition: { kind: "single" }, taskIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 } })).toThrow(InvariantViolationError);
      expect(() => h.stores.invocations.create({ runId: s.created.run.id, planNodeId: node.id, role: "evaluator", purpose: "evaluate", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, patternPosition: { kind: "chain_step", index: 2, count: 3 }, taskIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 } })).toThrow(ValidationError);
      // The root is never an ordinary worker single; the orchestrator position is the root's alone.
      expect(() => h.stores.invocations.create({ runId: s.created.run.id, planNodeId: node.id, role: "orchestrator", purpose: "node_result", agentDefinitionRevisionId: s.orchestrator.id, continuedFromInvocationId: s.invocation.id, patternPosition: { kind: "orchestrator" }, taskIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 } })).toThrow(InvariantViolationError);
      expect(h.stores.invocations.get(s.invocation.id).patternPosition).toEqual({ kind: "orchestrator" });
    } finally {
      h.close();
    }
  });
});
