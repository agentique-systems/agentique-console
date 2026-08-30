/**
 * Evaluate-only `evaluator_optimizer` nodes and `retry(round)` edges
 * (execution-model §4.3, §4.4 rule 5, §5.6; invariants 6 no transcript
 * decides anything, 11 deterministic verification precedes LLM evaluation,
 * 15 the current graph is never inferred): a pass activates the sequence
 * edges and skips every later round, a failure or inconclusive verdict
 * activates exactly the next retry edge (a control-node success that is not
 * candidate acceptance), a final failure activates nothing and fails, a
 * missing or contradictory verdict fact is an infrastructure failure, an
 * inactive retry path is skipped, the candidate follows canonical incoming
 * edges, and nothing reads a transcript or an Event.
 */
import type { PlanNode, PlanNodeId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { criterionEvaluationsOf, evaluatorsOf, evaluatorStep, finishRoot, optimizerNodes, producerStep, seedCriteria, verdictsOf } from "./optimizer-test-support.ts";
import { openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const statusOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId) => h.stores.plans.getNode(typeof node === "string" ? node : node.id).status;

/** An optimizer over a two-step chain producer, unrolled to `maxRounds`, followed by one successor. */
function unrolled(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, counts: { deterministic?: number; evaluated?: number }, maxRounds: number) {
  const criteria = seedCriteria(h, s, counts);
  const { byPath, graph } = optimizerNodes(h, s, criteria, { maxRounds, producerSteps: ["a", "b"], after: ["next"] });
  const producer = (round: number) => byPath[`e0/steps/0/rounds/${round}/producer`]!;
  const evaluate = (round: number) => byPath[`e0/steps/0/rounds/${round}/evaluate`]!;
  return { criteria, byPath, graph, producer, evaluate, next: byPath["e0/steps/1"]! };
}

describe("evaluate-only evaluator_optimizer nodes and retry edges", () => {
  it("passes round one: the candidate is the producer subgraph's output in edge order, the sequence edge delivers, the retry edge is inactive, and every later round is skipped", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { criteria, producer, evaluate, next } = unrolled(h, s, { deterministic: 1, evaluated: 1 }, 3);
      await finishRoot(h, s);
      // Chain steps a and b, then the Evaluator of round 1.
      h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "pass"));
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      const e1 = evaluate(1);
      expect([statusOf(h, producer(1)), statusOf(h, e1), statusOf(h, producer(2)), statusOf(h, evaluate(2)), statusOf(h, producer(3)), statusOf(h, evaluate(3)), statusOf(h, next)]).toEqual(["succeeded", "succeeded", "skipped", "skipped", "skipped", "skipped", "succeeded"]);
      // The evaluate-only node held exactly one Evaluator Invocation and no producer; its candidate is the chain's output, in incoming-edge order.
      const chainOutput = h.stores.plans.getNode(producer(1).id).outputArtifactIds!;
      expect(h.stores.invocations.listByPlanNode(e1.id).map((i) => i.patternPosition)).toEqual([{ kind: "evaluator_round", round: 1, maxRounds: 3 }]);
      const evaluator = evaluatorsOf(h, e1)[0]!;
      const manifest = h.stores.invocations.getManifest(evaluator.id).content;
      // The round's Snapshot is the integration Snapshot that held both chain Changesets; the successor's later integration does not move it.
      const snapshotId = verdictsOf(h, e1)[0]!.snapshotId!;
      expect(h.stores.snapshots.get(snapshotId).identity).toEqual(h.integrationWorkspace.applied.get(h.stores.changesets.listByRun(s.created.run.id)[2]!.id));
      expect(manifest.inputs).toEqual([{ kind: "optimizer_candidate", round: 1, maxRounds: 3, snapshotId, artifactIds: chainOutput, acceptanceCriterionIds: criteria.evaluated }]);
      expect(manifest.handoffs.map((x) => x.source)).toEqual([{ kind: "plan_node", planNodeId: producer(1).id }]);
      // Deterministic checks ran on the Snapshot that holds every producer Changeset (both chain steps integrated first).
      expect(h.criterionExecution.observed.map((o) => [o.round, o.snapshot])).toEqual([[1, h.stores.snapshots.get(snapshotId).identity]]);
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.integrationStatus)).toEqual(["integrated", "integrated", "integrated", "integrated"]);
      const verdict = verdictsOf(h, e1);
      expect(verdict).toHaveLength(1);
      expect(verdict[0]).toMatchObject({ context: { kind: "optimizer_verdict", round: 1, maxRounds: 3 }, verdict: "pass", artifactIds: chainOutput, snapshotId });
      expect(criterionEvaluationsOf(h, e1, 1).map((e) => e.verdict)).toEqual(["pass", "pass"]);
      expect(h.stores.plans.getNode(e1.id).outputArtifactIds).toEqual(chainOutput);
      // Handoffs: the chain's sequence into E1, E1's sequence to the successor; no retry Handoff exists.
      const keys = h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey);
      expect(keys).toContain(`sequence:${producer(1).id}:${e1.id}`);
      expect(keys).toContain(`sequence:${e1.id}:${next.id}`);
      expect(keys.some((k) => k.startsWith("retry:"))).toBe(false);
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(next.id)[0]!.id).content.handoffs.map((x) => x.artifactIds)).toEqual([chainOutput]);
      // Nothing ran for the skipped rounds; nothing was evaluated twice; no Gate exists.
      expect(h.stores.invocations.listByPlanNode(producer(2).id)).toEqual([]);
      expect(h.stores.gates.listByRun(s.created.run.id)).toEqual([]);
      expect(h.provider.requests).toHaveLength(5);
    } finally {
      h.close();
    }
  });

  it("activates exactly the next retry edge on a failed or inconclusive round, delivers the judged candidate and verdict to the next producer round, and succeeds on the round that passes", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { criteria, producer, evaluate, next, graph } = unrolled(h, s, { deterministic: 1, evaluated: 1 }, 3);
      await finishRoot(h, s);
      // Round 1 fails at the Evaluator; round 2 fails deterministically (inconclusive is a failure too, covered below); round 3 passes.
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 0 }, { kind: "exit", exitCode: 3, output: "typecheck failed\n" }, { kind: "exit", exitCode: 0 });
      h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "inconclusive"), producerStep(h, "a2"), producerStep(h, "b2"), producerStep(h, "a3"), producerStep(h, "b3"), evaluatorStep(h, "pass"));
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      const [e1, e2, e3] = [evaluate(1), evaluate(2), evaluate(3)];
      expect([statusOf(h, e1), statusOf(h, producer(2)), statusOf(h, e2), statusOf(h, producer(3)), statusOf(h, e3), statusOf(h, next)]).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
      // Control-node success is not candidate acceptance: the recorded verdicts say what passed.
      expect(verdictsOf(h, e1).map((v) => [v.verdict, v.producedBy.kind])).toEqual([["inconclusive", "evaluator"]]);
      expect(verdictsOf(h, e2).map((v) => [v.verdict, v.producedBy.kind])).toEqual([["fail", "runtime"]]);
      expect(verdictsOf(h, e3).map((v) => [v.verdict, v.producedBy.kind])).toEqual([["pass", "evaluator"]]);
      expect(evaluatorsOf(h, e2)).toEqual([]);
      // Exactly the retry Handoffs of the failed rounds exist, each carrying the judged candidate; only round 3's sequence edge delivered to the successor.
      const keys = h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey);
      const retry2 = h.stores.handoffs.getByKey(s.created.run.id, `retry:${e1.id}:${producer(2).id}`)!;
      const retry3 = h.stores.handoffs.getByKey(s.created.run.id, `retry:${e2.id}:${producer(3).id}`)!;
      expect(retry2.artifactIds).toEqual(verdictsOf(h, e1)[0]!.artifactIds);
      expect(retry3.artifactIds).toEqual(verdictsOf(h, e2)[0]!.artifactIds);
      expect(keys.filter((k) => k.startsWith("retry:"))).toHaveLength(2);
      expect(keys).toContain(`sequence:${e3.id}:${next.id}`);
      expect(keys).not.toContain(`sequence:${e1.id}:${next.id}`);
      expect(keys).not.toContain(`sequence:${e2.id}:${next.id}`);
      expect(graph.edges.filter((e) => e.type === "retry").map((e) => e.round)).toEqual([2, 3]);
      // The entry of producer round 2 received the retry Handoff and the typed feedback of round 1; round 3's entry that of round 2, with the deterministic Evidence.
      const entry2 = h.stores.invocations.listByPlanNode(producer(2).id)[0]!;
      const m2 = h.stores.invocations.getManifest(entry2.id).content;
      expect(m2.handoffs.map((x) => x.handoffId)).toEqual([retry2.id]);
      expect(m2.inputs).toEqual([{ kind: "optimizer_feedback", evaluationId: verdictsOf(h, e1)[0]!.id, round: 1, verdict: "inconclusive", evidence: verdictsOf(h, e1)[0]!.evidence }]);
      const entry3 = h.stores.invocations.listByPlanNode(producer(3).id)[0]!;
      const m3 = h.stores.invocations.getManifest(entry3.id).content;
      const failed = criterionEvaluationsOf(h, e2, 2)[0]!;
      expect(m3.inputs).toEqual([{ kind: "optimizer_feedback", evaluationId: verdictsOf(h, e2)[0]!.id, round: 2, verdict: "fail", evidence: [{ kind: "evaluation", evaluationId: failed.id }, ...failed.evidence] }]);
      expect(m3.artifacts.map((a) => a.artifactId)).toContain(failed.evidence[0]!.kind === "command" ? failed.evidence[0]!.outputArtifactId : "");
      // The second chain step of each round received only its chain Handoff (no feedback input); the successor received round 3's candidate.
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(producer(2).id)[1]!.id).content.inputs).toEqual([]);
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(next.id)[0]!.id).content.handoffs.map((x) => x.artifactIds)).toEqual([h.stores.plans.getNode(producer(3).id).outputArtifactIds]);
      // No Attempt-level retry happened for any round: every Invocation has one Attempt.
      for (const i of h.stores.invocations.listByRun(s.created.run.id)) expect(h.stores.invocations.listAttempts(i.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("fails the final round with optimizer_rounds_exhausted, activating nothing, and skips the successor", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { producer, evaluate, next } = unrolled(h, s, { evaluated: 1 }, 2);
      await finishRoot(h, s);
      h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "fail"), producerStep(h, "a2"), producerStep(h, "b2"), evaluatorStep(h, "fail"));
      expect((await h.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect([statusOf(h, evaluate(1)), statusOf(h, producer(2)), statusOf(h, evaluate(2)), statusOf(h, next)]).toEqual(["succeeded", "succeeded", "failed", "skipped"]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" }).map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "optimizer_rounds_exhausted", artifactIds: verdictsOf(h, evaluate(2))[0]!.artifactIds })]);
      const keys = h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey);
      expect(keys.filter((k) => k.startsWith("retry:"))).toEqual([`retry:${evaluate(1).id}:${producer(2).id}`]);
      expect(keys.some((k) => k.endsWith(`:${next.id}`))).toBe(false);
      expect(h.stores.invocations.listByPlanNode(next.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("stops with a typed infrastructure failure when a succeeded evaluate-only node has no verdict fact, and refuses a contradictory or historical one", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { producer, evaluate, next } = unrolled(h, s, { evaluated: 1 }, 2);
      const e1 = evaluate(1);
      // E1 ends succeeded without its verdict (a contradiction the runtime never produces itself): nothing activates.
      h.stores.plans.transitionNode(producer(1).id, { to: "ready" });
      h.stores.plans.transitionNode(producer(1).id, { to: "running" });
      h.stores.plans.transitionNode(producer(1).id, { to: "succeeded", outputArtifactIds: [] });
      h.stores.plans.transitionNode(e1.id, { to: "ready" });
      h.stores.plans.transitionNode(e1.id, { to: "running" });
      h.stores.plans.transitionNode(e1.id, { to: "succeeded", outputArtifactIds: [] });
      expect(() => h.scheduler.reconcileRun(s.created.run.id)).toThrow(/without a recorded round verdict/);
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome).toMatchObject({ stop: "infrastructure_failure", actions: [], failure: { message: expect.stringContaining("round verdict") } });
      expect([statusOf(h, producer(2)), statusOf(h, next)]).toEqual(["pending", "pending"]);
      expect(h.stores.handoffs.listByRun(s.created.run.id).filter((x) => x.handoffKey.startsWith("retry:") || x.handoffKey.startsWith(`sequence:${e1.id}`))).toEqual([]);
      // A verdict of the wrong round is refused by the store; the database refuses a second verdict for a round.
      const snapshotId = s.created.run.baseSnapshotId!;
      expect(() => h.stores.evaluations.record({ runId: s.created.run.id, planNodeId: e1.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 2, maxRounds: 2 }, verdict: "fail", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [], snapshotId })).toThrow(/evaluates round 1, not 2/);
      expect(() => h.stores.evaluations.record({ runId: s.created.run.id, planNodeId: e1.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 3 }, verdict: "fail", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [], snapshotId })).toThrow(/has 2 rounds, not 3/);
      h.stores.evaluations.record({ runId: s.created.run.id, planNodeId: e1.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 2 }, verdict: "fail", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [], snapshotId });
      expect(() => h.stores.evaluations.record({ runId: s.created.run.id, planNodeId: e1.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 2 }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [], snapshotId })).toThrow(/already recorded the verdict of round 1/);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO evaluations (id, run_id, plan_node_id, gate_id, subject, context, verdict, evidence, produced_by, artifact_ids, snapshot_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'pass', '[]', ?, '[]', ?, ?)")
          .run("eval_" + "0".repeat(24), s.created.run.id, e1.id, JSON.stringify({ kind: "optimizer_round" }), JSON.stringify({ kind: "optimizer_verdict", round: 1, maxRounds: 2 }), JSON.stringify({ kind: "runtime" }), snapshotId, "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: evaluations.plan_node_id, evaluations.context_round/);
      // With the verdict recorded, the retry edge activates from the fact alone and nothing else changes.
      const readied = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 4 });
      expect(readied.actions.map((p) => [p.action.kind, p.action.kind === "ready_node" || p.action.kind === "start_node" ? p.action.nodeId : null])).toEqual(expect.arrayContaining([["ready_node", producer(2).id], ["start_node", producer(2).id]]));
      expect(h.stores.handoffs.getByKey(s.created.run.id, `retry:${e1.id}:${producer(2).id}`)).not.toBeNull();
    } finally {
      h.close();
    }
    // A historical fact never activates a current edge: the node of the fact left the membership; the current graph decides alone.
    const g = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(g);
      const { evaluate, producer } = unrolled(g, s, { evaluated: 1 }, 2);
      const e1 = evaluate(1);
      g.stores.plans.transitionNode(producer(1).id, { to: "ready" });
      g.stores.plans.transitionNode(producer(1).id, { to: "running" });
      g.stores.plans.transitionNode(producer(1).id, { to: "succeeded", outputArtifactIds: [] });
      g.stores.plans.transitionNode(e1.id, { to: "ready" });
      g.stores.plans.transitionNode(e1.id, { to: "running" });
      g.stores.evaluations.record({ runId: s.created.run.id, planNodeId: e1.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 2 }, verdict: "fail", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [], snapshotId: s.created.run.baseSnapshotId! });
      g.stores.plans.transitionNode(e1.id, { to: "succeeded", outputArtifactIds: [] });
      // A new revision replaces the whole expression: E1's fact is keyed by E1 and inert for the new nodes.
      const replaced = g.planRevisions.propose({ runId: s.created.run.id, proposedByInvocationId: s.invocation.id, source: { version: 1, expressions: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "fresh" }, allocation: { costUsd: 4, tokens: 40_000, attempts: 4 } }] }, correlationId: null, causationSeq: null });
      expect(replaced.accepted).toBe(true);
      const projection = g.scheduler.reconcileRun(s.created.run.id);
      expect(projection.actions.filter((a) => a.kind === "ready_node").map((a) => a.kind === "ready_node" && g.stores.plans.getNode(a.nodeId).sourcePath)).toEqual(["e0"]);
      expect(g.stores.handoffs.listByRun(s.created.run.id)).toEqual([]);
    } finally {
      g.close();
    }
  });

  it("orders the candidate by canonical incoming edges when several producer exits enter the evaluate-only node", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { evaluated: 1 });
      const leaf = (title: string) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } });
      // A route producer with two composite branches: the route's own sequence edge and both branch exits enter E1; the selected branch's exit delivers.
      const decision = h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId: s.created.run.id, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "which?", options: [{ id: "y", label: "y", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "y", rationale: null, artifactIds: [] });
      const { byPath, graph } = optimizerNodes(h, s, criteria, { maxRounds: 1, producerSteps: undefined, evaluator: undefined, gate: criteria.all, after: [] });
      void byPath;
      void graph;
      void leaf;
      // The compiled shape for a route producer is exercised through a direct plan proposal.
      const proposal = h.planRevisions.propose({
        runId: s.created.run.id,
        proposedByInvocationId: s.invocation.id,
        source: {
          version: 1,
          expressions: [
            {
              pattern: "evaluator_optimizer",
              producer: { pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { y: "y" } }, branches: { x: { pattern: "chain", steps: [leaf("x0"), leaf("x1")], allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } }, y: { pattern: "chain", steps: [leaf("y0"), leaf("y1")], allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } } }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } },
              evaluator: { agentDefinitionRevisionId: h.stores.agents.listRevisions(h.stores.agents.ensureDefinition("evaluator").id)[0]!.id },
              maxRounds: 1,
              allocation: { costUsd: 6, tokens: 60_000, attempts: 6 },
              gateAcceptanceCriterionIds: criteria.all,
            },
          ],
        },
        correlationId: null,
        causationSeq: null,
      });
      if (!proposal.accepted) throw new Error(proposal.reasons.map((r) => r.message).join("; "));
      const nodes = Object.fromEntries(proposal.graph.nodes.map((n) => [n.sourcePath, n]));
      // Each branch is a chain of two own nodes (the leaves declare an allocation); the branch's exit is its second step.
      const e1 = nodes["e0/rounds/1/evaluate"]!;
      const y = nodes["e0/rounds/1/producer/branches/y/steps/1"]!;
      await finishRoot(h, s);
      h.provider.script(producerStep(h, "y0"), producerStep(h, "y1"), evaluatorStep(h, "pass"));
      expect(await h.scheduler.advanceRun(s.created.run.id)).toMatchObject({ stop: "quiescent", failure: null });
      expect([statusOf(h, nodes["e0/rounds/1/producer"]!), statusOf(h, nodes["e0/rounds/1/producer/branches/x/steps/0"]!), statusOf(h, nodes["e0/rounds/1/producer/branches/x/steps/1"]!), statusOf(h, nodes["e0/rounds/1/producer/branches/y/steps/0"]!), statusOf(h, y), statusOf(h, e1)]).toEqual(["succeeded", "skipped", "skipped", "succeeded", "succeeded", "succeeded"]);
      // The candidate is the delivering exit's output, in the edge order of the current revision; the skipped and route edges carried nothing.
      const evaluator = evaluatorsOf(h, e1)[0]!;
      const candidate = h.stores.invocations.getManifest(evaluator.id).content.inputs.find((i) => i.kind === "optimizer_candidate");
      expect(candidate).toMatchObject({ artifactIds: h.stores.plans.getNode(y.id).outputArtifactIds });
      expect(h.stores.handoffs.listByRun(s.created.run.id).filter((x) => x.handoffKey.endsWith(`:${e1.id}`)).map((x) => x.handoffKey)).toEqual([`sequence:${y.id}:${e1.id}`]);
      expect(verdictsOf(h, e1)[0]!.artifactIds).toEqual(h.stores.plans.getNode(y.id).outputArtifactIds);
    } finally {
      h.close();
    }
  });

  it("decides every activation from Evaluation rows: deleting the transcripts and reading no Event leaves the projection identical", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { producer, evaluate, next } = unrolled(h, s, { deterministic: 1, evaluated: 1 }, 2);
      await finishRoot(h, s);
      h.provider.script(producerStep(h, "a1"), producerStep(h, "b1"), evaluatorStep(h, "fail", { summary: "verdict: pass" }));
      const first = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 14 });
      expect(first.actions.map((p) => p.action.kind)).toContain("verify_node");
      // Round 1's verdict is recorded fail although the summary says otherwise; the retry edge follows the row.
      expect(verdictsOf(h, evaluate(1)).map((v) => v.verdict)).toEqual(["fail"]);
      const projection = h.scheduler.reconcileRun(s.created.run.id);
      const before = JSON.stringify(projection.actions);
      expect(projection.actions.some((a) => a.kind === "ready_node" && a.nodeId === producer(2).id) || statusOf(h, producer(2)) !== "pending").toBe(true);
      // Every transcript blob is gone; the projection is byte-identical.
      for (const artifact of h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === "application/x-agent-transcript")) h.blobs.remove(artifact.digest);
      expect(JSON.stringify(h.scheduler.reconcileRun(s.created.run.id).actions)).toBe(before);
      h.provider.script(producerStep(h, "a2"), producerStep(h, "b2"), evaluatorStep(h, "pass"));
      expect((await h.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect([statusOf(h, evaluate(2)), statusOf(h, next)]).toEqual(["succeeded", "succeeded"]);
    } finally {
      h.close();
    }
  });
});
