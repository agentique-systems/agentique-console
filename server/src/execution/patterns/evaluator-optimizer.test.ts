/**
 * The inline `evaluator_optimizer` Pattern runner (execution-model §5.6,
 * §10; invariants 6 no transcript decides anything, 11 deterministic
 * verification precedes LLM evaluation, 20 one Invocation per turn, 22
 * atomic allocation): a round-one pass, a deterministic failure followed by
 * a passing second round, an Evaluator failure followed by a passing second
 * round, inconclusive continuing like failure, rounds exhausted, a producer
 * failure failing at once, an invalid Evaluator result retrying as an
 * Attempt, the next producer's exact inputs, `continuedFromInvocationId`
 * across rounds, an approval continuation consuming no round, and one active
 * position at a time.
 */
import type { PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { criterionEvaluationsOf, evaluatorsOf, evaluatorStep, finishRoot, optimizerNodes, producersOf, producerStep, seedCriteria, verdictsOf } from "../optimizer-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "../test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };
const statusOf = (h: RuntimeHarness, node: PlanNode) => h.stores.plans.getNode(node.id).status;
const positions = (h: RuntimeHarness, node: PlanNode) => h.stores.invocations.listByPlanNode(node.id).map((i) => [`${i.patternPosition!.kind}:${(i.patternPosition as { round: number }).round}`, i.status]);

describe("EvaluatorOptimizerPatternRunner (inline)", () => {
  it("passes in round one: producer, integration, deterministic checks in id order, one Evaluator, canonical Evaluations, success with the candidate, and no second round", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 2, evaluated: 1 });
      const { byPath, revisionNumber } = optimizerNodes(h, s, criteria, { maxRounds: 3, after: ["next"] });
      const node = byPath["e0/steps/0"]!;
      const next = byPath["e0/steps/1"]!;
      const runner = h.runners.evaluatorOptimizer;
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      expect(runner.inspect(node.id)).toEqual({ kind: "start" });
      const started = runner.start(node.id, revisionNumber);
      expect(started).toMatchObject({ kind: "started", position: { kind: "producer_round", round: 1, maxRounds: 3 } });
      if (started.kind !== "started") throw new Error(started.kind);
      const producer = h.stores.invocations.get(started.invocationId);
      expect(producer).toMatchObject({ role: "worker", purpose: "step", continuedFromInvocationId: null, workspaceCleanup: "pending" });
      expect(h.stores.invocations.getManifest(producer.id).content.inputs).toEqual([]);
      expect(runner.start(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      // The producer completes with a candidate and a Changeset; the runner integrates it before anything is verified.
      h.provider.script(producerStep(h, "v1"));
      await h.executor.advanceInvocation(producer.id);
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: producer.id });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "integrated", invocationId: producer.id });
      const candidate = h.stores.invocations.get(producer.id).result!.artifactIds;
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
      const snapshotId = h.stores.runs.get(s.created.run.id).integrationSnapshotId!;
      // Deterministic checks are pending: the runner asks for verification, not for an Evaluator.
      expect(runner.inspect(node.id)).toEqual({ kind: "verify", round: 1 });
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(evaluatorsOf(h, node)).toEqual([]);
      const verified = await runner.verify(node.id, revisionNumber);
      expect(verified).toMatchObject({ kind: "verified", round: 1, verdict: "pass" });
      // Both commands ran in criterion id order, outside any transaction, in isolated views of the exact Snapshot; nothing was recorded twice.
      expect(h.criterionExecution.observed.map((o) => [o.acceptanceCriterionId, o.round, o.inTransaction, o.outcome])).toEqual(criteria.deterministic.map((id) => [id, 1, false, "exited"]));
      expect(h.criterionExecution.observed.every((o) => o.viewPath !== h.stores.runs.get(s.created.run.id).integrationWorkspacePath)).toBe(true);
      expect(h.criterionExecution.liveViews.size).toBe(0);
      const checks = criterionEvaluationsOf(h, node, 1);
      expect(checks.map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.verdict, e.context, e.snapshotId, e.artifactIds, e.producedBy])).toEqual(criteria.deterministic.map((id) => [id, "pass", { kind: "optimizer_criterion", round: 1, maxRounds: 3 }, snapshotId, candidate, { kind: "runtime" }]));
      expect(checks[0]!.evidence).toEqual([{ kind: "command", command: expect.stringMatching(/^npm run check-[01]$/), exitCode: 0, outputArtifactId: expect.any(String), outputTruncated: false }, { kind: "snapshot", snapshotId }]);
      // Repeated verification runs nothing again.
      expect(await runner.verify(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.criterionExecution.requests).toHaveLength(2);
      // The Evaluator is prepared with the candidate Handoff and the typed candidate input; it is read-only and owns no worktree.
      expect(runner.inspect(node.id)).toEqual({ kind: "settle", invocationId: null });
      const prepared = await runner.settle(node.id, revisionNumber);
      expect(prepared).toMatchObject({ kind: "started", position: { kind: "evaluator_round", round: 1, maxRounds: 3 } });
      if (prepared.kind !== "started") throw new Error(prepared.kind);
      const evaluator = h.stores.invocations.get(prepared.invocationId);
      expect(evaluator).toMatchObject({ role: "evaluator", purpose: "evaluate", workspaceCleanup: "none", continuedFromInvocationId: null });
      const manifest = h.stores.invocations.getManifest(evaluator.id).content;
      expect(manifest.inputs).toEqual([{ kind: "optimizer_candidate", round: 1, maxRounds: 3, snapshotId, artifactIds: candidate, acceptanceCriterionIds: criteria.evaluated }]);
      expect(manifest.handoffs.map((x) => [x.artifactIds, x.source])).toEqual([[candidate, { kind: "invocation", invocationId: producer.id }]]);
      // The unscoped node lists the current revision's criteria; the candidate input names exactly the evaluated ones the Evaluator must cover.
      expect(manifest.acceptanceCriteria.map((c) => c.acceptanceCriterionId)).toEqual(criteria.all);
      expect(manifest.capabilities.tools).toEqual(["read"]);
      expect(JSON.stringify(manifest)).not.toContain("transcript");
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey)).toEqual([`optimizer_candidate:${node.id}:1`]);
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      // The Evaluator passes; its result becomes one criterion Evaluation and the round verdict, and the node succeeds with the candidate.
      h.provider.script(evaluatorStep(h, "pass"));
      await h.executor.advanceInvocation(evaluator.id);
      expect(h.stores.changesets.listByRun(s.created.run.id)).toHaveLength(1);
      const settled = await runner.settle(node.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "succeeded", outputArtifactIds: candidate });
      const verdicts = verdictsOf(h, node);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({ subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 3 }, verdict: "pass", snapshotId, artifactIds: candidate, producedBy: { kind: "evaluator", invocationId: evaluator.id } });
      expect(Object.fromEntries(criterionEvaluationsOf(h, node, 1).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", [e.verdict, e.producedBy.kind]]))).toEqual({ ...Object.fromEntries(criteria.deterministic.map((id) => [id, ["pass", "runtime"]])), ...Object.fromEntries(criteria.evaluated.map((id) => [id, ["pass", "evaluator"]])) });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: candidate });
      expect(h.stores.gates.listByRun(s.created.run.id)).toEqual([]);
      expect(positions(h, node)).toEqual([["producer_round:1", "succeeded"], ["evaluator_round:1", "succeeded"]]);
      expect(await runner.settle(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      // The successor receives exactly the passing candidate.
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(statusOf(h, next)).toBe("succeeded");
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(next.id)[0]!.id).content.handoffs.map((x) => x.artifactIds)).toEqual([candidate]);
    } finally {
      h.close();
    }
  });

  it("fails round one deterministically without invoking the Evaluator, then passes round two through the scheduler with exact feedback", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 2, evaluated: 1 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      // Round 1: the first command fails; the second is never run; no Evaluator; the runtime records the round's fail verdict.
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1, output: "1 test failed\n" });
      h.provider.script(producerStep(h, "v1"), producerStep(h, "v2"), evaluatorStep(h, "pass"));
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.actions.map((p) => [p.action.kind, p.outcome.kind])).toContainEqual(["verify_node", "verified"]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      // Round 1 ran exactly one command; round 2 ran both.
      expect(h.criterionExecution.observed.map((o) => [o.round, o.acceptanceCriterionId])).toEqual([[1, criteria.deterministic[0]], [2, criteria.deterministic[0]], [2, criteria.deterministic[1]]]);
      const round1 = criterionEvaluationsOf(h, node, 1);
      expect(round1.map((e) => e.verdict)).toEqual(["fail"]);
      expect(round1[0]!.evidence[0]).toMatchObject({ kind: "command", exitCode: 1, outputTruncated: false });
      const verdicts = verdictsOf(h, node);
      expect(verdicts.map((v) => [v.context!.round, v.verdict, v.producedBy.kind])).toEqual([[1, "fail", "runtime"], [2, "pass", "evaluator"]]);
      expect(verdicts[0]!.evidence).toEqual([{ kind: "evaluation", evaluationId: round1[0]!.id }, ...round1[0]!.evidence]);
      // Raw output lives only in the Artifact; the Event carries ids and metadata.
      const output = h.stores.artifacts.get(round1[0]!.evidence[0]!.kind === "command" ? round1[0]!.evidence[0]!.outputArtifactId : ("" as never));
      expect(new TextDecoder().decode(h.stores.artifacts.read(output.id).bytes)).toBe("1 test failed\n");
      expect(h.ctx.journal.read({ runId: s.created.run.id }).map((e) => JSON.stringify(e.payload)).join("\n")).not.toContain("1 test failed");
      expect(JSON.stringify(outcome)).not.toContain("1 test failed");
      // Exactly one Evaluator (round 2); round 1 never had one. The producers are linked and the second one received the exact feedback.
      expect(positions(h, node)).toEqual([["producer_round:1", "succeeded"], ["producer_round:2", "succeeded"], ["evaluator_round:2", "succeeded"]]);
      const [p1, p2] = producersOf(h, node);
      expect(p2!.continuedFromInvocationId).toBe(p1!.id);
      const manifest = h.stores.invocations.getManifest(p2!.id).content;
      expect(manifest.inputs).toEqual([{ kind: "optimizer_feedback", evaluationId: verdicts[0]!.id, round: 1, verdict: "fail", evidence: verdicts[0]!.evidence }]);
      expect(manifest.handoffs).toEqual([expect.objectContaining({ source: { kind: "plan_node", planNodeId: node.id }, artifactIds: p1!.result!.artifactIds })]);
      expect(manifest.artifacts.map((a) => a.artifactId).sort()).toEqual([...p1!.result!.artifactIds, output.id].sort());
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey).sort()).toEqual([`optimizer_candidate:${node.id}:2`, `optimizer_feedback:${node.id}:1`].sort());
      // The node's output is round 2's candidate; every Changeset was integrated in round order; no Gate row exists.
      expect(h.stores.plans.getNode(node.id).outputArtifactIds).toEqual(p2!.result!.artifactIds);
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => [c.invocationId, c.integrationStatus])).toEqual([[s.invocation.id, "integrated"], [p1!.id, "integrated"], [p2!.id, "integrated"]]);
      expect(h.stores.gates.listByRun(s.created.run.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("continues after an Evaluator fail or inconclusive verdict, delivers the previous verdict to the next producer and Evaluator, and exhausts at maxRounds with the last Evaluation retained", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 2 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 3 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      const [c0, c1] = criteria.evaluated as [string, string];
      h.provider.script(producerStep(h, "v1"), evaluatorStep(h, "fail", { criteria: { [c0]: "pass", [c1]: "fail" } }), producerStep(h, "v2"), evaluatorStep(h, "inconclusive", { criteria: { [c0]: "inconclusive", [c1]: "pass" } }), producerStep(h, "v3"), evaluatorStep(h, "fail"));
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" }).map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "optimizer_rounds_exhausted" })]);
      const verdicts = verdictsOf(h, node);
      expect(verdicts.map((v) => [v.context!.round, v.verdict])).toEqual([[1, "fail"], [2, "inconclusive"], [3, "fail"]]);
      const byId = (round: number) => Object.fromEntries(criterionEvaluationsOf(h, node, round).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.verdict]));
      expect(byId(1)).toEqual({ [criteria.deterministic[0]!]: "pass", [c0]: "pass", [c1]: "fail" });
      expect(byId(2)).toEqual({ [criteria.deterministic[0]!]: "pass", [c0]: "inconclusive", [c1]: "pass" });
      expect(criterionEvaluationsOf(h, node, 1).map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : ""))).toEqual(criteria.all);
      expect(positions(h, node)).toEqual([["producer_round:1", "succeeded"], ["evaluator_round:1", "succeeded"], ["producer_round:2", "succeeded"], ["evaluator_round:2", "succeeded"], ["producer_round:3", "succeeded"], ["evaluator_round:3", "succeeded"]]);
      // The last verdict's Artifacts are the failure Event's diagnostic references.
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ artifactIds: verdicts[2]!.artifactIds });
      // Round 2's producer and Evaluator both received round 1's verdict and candidate; round 3's received round 2's.
      const producers = producersOf(h, node);
      const evaluators = evaluatorsOf(h, node);
      for (const round of [2, 3]) {
        const previous = verdicts[round - 2]!;
        const feedback = { kind: "optimizer_feedback", evaluationId: previous.id, round: round - 1, verdict: previous.verdict, evidence: previous.evidence };
        expect(h.stores.invocations.getManifest(producers[round - 1]!.id).content.inputs).toEqual([feedback]);
        const evaluatorManifest = h.stores.invocations.getManifest(evaluators[round - 1]!.id).content;
        expect(evaluatorManifest.inputs).toEqual([expect.objectContaining({ kind: "optimizer_candidate", round, artifactIds: producers[round - 1]!.result!.artifactIds }), feedback]);
        expect(evaluatorManifest.handoffs.map((x) => x.handoffId).length).toBe(2);
        expect(producers[round - 1]!.continuedFromInvocationId).toBe(producers[round - 2]!.id);
      }
      expect(evaluators.map((e) => e.continuedFromInvocationId)).toEqual([null, null, null]);
      // Every Invocation was funded from the node and released; no Usage was fabricated for the checks.
      expect(h.stores.reservations.listByParent({ type: "plan_node", id: node.id }).map((r) => r.status)).toEqual(Array(6).fill("released"));
      expect(h.stores.invocations.listByPlanNode(node.id).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0)).toBe(6);
      expect(h.stores.usage.totalsForPlanNode(node.id).costUsd).toBeCloseTo(0.06);
    } finally {
      h.close();
    }
  });

  it("fails the node at once when the producer fails after its Attempts, manufacturing no verdict", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 3 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      h.provider.script({ kind: "permanent_error", message: "model retired" });
      expect((await h.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "invocation_failed" });
      expect(verdictsOf(h, node)).toEqual([]);
      expect(h.criterionExecution.requests).toEqual([]);
      expect(positions(h, node)).toEqual([["producer_round:1", "failed"]]);
    } finally {
      h.close();
    }
  });

  it("retries an invalid Evaluator result as an Attempt of the same Invocation, never as another round, and fails the node when the Evaluator fails permanently", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { evaluated: 1 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      // No deterministic criteria: the Evaluator is prepared right after integration, with no verify action.
      h.provider.script(producerStep(h, "v1"), { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "looks good" } }, evaluatorStep(h, "pass"));
      const first = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 7 });
      expect(first.actions.map((p) => p.action.kind)).not.toContain("verify_node");
      const evaluator = evaluatorsOf(h, node)[0]!;
      const attempts = h.stores.invocations.listAttempts(evaluator.id);
      expect(attempts[0]).toMatchObject({ number: 1, status: "failed", failureClass: "result_invalid", failureDetail: { violations: [{ code: "evaluation_missing" }] } });
      expect(verdictsOf(h, node)).toEqual([]);
      const rest = await h.scheduler.advanceRun(s.created.run.id);
      expect(rest.stop).toBe("quiescent");
      expect(h.stores.invocations.listAttempts(evaluator.id).map((a) => [a.number, a.kind, a.status])).toEqual([[1, "initial", "failed"], [2, "retry", "succeeded"]]);
      expect(h.provider.requests[3]!.request.input.text).toContain("evaluation_missing");
      expect(positions(h, node)).toEqual([["producer_round:1", "succeeded"], ["evaluator_round:1", "succeeded"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
    const f = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(f);
      const criteria = seedCriteria(f, s, { evaluated: 1 });
      const { byPath } = optimizerNodes(f, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      await finishRoot(f, s);
      f.provider.script(producerStep(f, "v1"), { kind: "permanent_error", message: "judge unavailable" });
      expect((await f.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect(f.stores.plans.getNode(node.id).status).toBe("failed");
      expect(f.ctx.journal.read({ runId: s.created.run.id, type: "plan_node.failed" })[0]!.payload).toMatchObject({ reason: "invocation_failed" });
      expect(verdictsOf(f, node)).toEqual([]);
      expect(positions(f, node)).toEqual([["producer_round:1", "succeeded"], ["evaluator_round:1", "failed"]]);
    } finally {
      f.close();
    }
  });

  it("continues an approval-blocked producer at the same round position with its feedback re-delivered, consuming no round, and never holds two active positions", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { byPath, revisionNumber } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      // Round 1 fails at the Evaluator; round 2's producer blocks on an approval.
      h.provider.script(producerStep(h, "v1"), evaluatorStep(h, "fail"), { kind: "tool_calls", calls: [CALL], then: producerStep(h, "v2") });
      const blocked = await h.scheduler.advanceRun(s.created.run.id);
      expect(blocked.stop).toBe("waiting");
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      const p2 = producersOf(h, node)[1]!;
      expect(p2.status).toBe("blocked");
      // At most one non-terminal Invocation ever existed per node at a time.
      const all = h.stores.invocations.listByPlanNode(node.id);
      for (const a of all) for (const b of all) if (a.id < b.id) expect(!(a.startedAt !== null && b.startedAt !== null && a.endedAt !== null && b.endedAt !== null && a.startedAt < b.endedAt && b.startedAt < a.endedAt) || a.status === "blocked").toBe(true);
      h.stores.decisions.resolve(p2.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const resumed = h.runners.evaluatorOptimizer.resume(node.id, revisionNumber);
      expect(resumed).toMatchObject({ kind: "successor_prepared", position: { kind: "producer_round", round: 2, maxRounds: 2 } });
      if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
      const successor = h.stores.invocations.getManifest(resumed.invocationId).content;
      expect(successor.continuedFromInvocationId).toBe(p2.id);
      expect(successor.inputs.map((i) => i.kind)).toEqual(["optimizer_feedback", "side_effect_approval_resolution"]);
      expect(successor.inputs[0]).toEqual({ kind: "optimizer_feedback", evaluationId: verdictsOf(h, node)[0]!.id, round: 1, verdict: "fail", evidence: verdictsOf(h, node)[0]!.evidence });
      expect(successor.handoffs.map((x) => x.handoffId)).toEqual(h.stores.invocations.getManifest(p2.id).content.handoffs.map((x) => x.handoffId));
      // The successor completes the round; no third producer round exists (maxRounds 2), and the round passes.
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: producerStep(h, "v2b") }, evaluatorStep(h, "pass"));
      expect((await h.scheduler.advanceRun(s.created.run.id)).stop).toBe("quiescent");
      expect(positions(h, node)).toEqual([["producer_round:1", "succeeded"], ["evaluator_round:1", "succeeded"], ["producer_round:2", "blocked"], ["producer_round:2", "succeeded"], ["evaluator_round:2", "succeeded"]]);
      expect(verdictsOf(h, node).map((v) => [v.context!.round, v.verdict])).toEqual([[1, "fail"], [2, "pass"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("reports an infrastructure failure of a check without recording anything, and verifies on the next pass", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 2 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 1 });
      const node = byPath["e0"]!;
      await finishRoot(h, s);
      h.criterionExecution.script(criteria.deterministic[1]!, { kind: "fail", failure: "workspace_unavailable", message: "no disk" });
      h.provider.script(producerStep(h, "v1"), evaluatorStep(h, "pass"));
      const first = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 6 });
      const failed = first.actions.find((p) => p.outcome.kind === "verification_failed");
      expect(failed?.outcome).toMatchObject({ kind: "verification_failed", round: 1, acceptanceCriterionId: criteria.deterministic[1], failure: "workspace_unavailable", message: "no disk" });
      // The first check is recorded, the second is not; no verdict, no Evaluator; the node keeps asking for verification.
      expect(criterionEvaluationsOf(h, node, 1).map((e) => e.verdict)).toEqual(["pass"]);
      expect(verdictsOf(h, node)).toEqual([]);
      expect(evaluatorsOf(h, node)).toEqual([]);
      expect(h.runners.evaluatorOptimizer.inspect(node.id)).toEqual({ kind: "verify", round: 1 });
      const rest = await h.scheduler.advanceRun(s.created.run.id);
      expect(rest.stop).toBe("quiescent");
      // Only the second check ran again; the first was never repeated.
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).toEqual([criteria.deterministic[0], criteria.deterministic[1], criteria.deterministic[1]]);
      expect(criterionEvaluationsOf(h, node, 1)).toHaveLength(2);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });
});
