/**
 * The `node_exit` Gate lifecycle and its Pattern integration (execution-model
 * §5, §7.1, §10; invariants 5 runtime-owned scheduling, 6 no transcript
 * decides anything, 9 canonical objects by id, 11 verification precedes
 * completion, 20 one Invocation per logical turn, 22 atomic allocation):
 * opening with a pinned Snapshot and candidate, deterministic checks first
 * and fail-fast, one read-only Evaluator per Gate over every evaluated
 * criterion, Evaluations on the Gate's own rows, settlement in one
 * transaction, failure without an invented verdict, raw command output only
 * in the Artifact Store, idempotent and revision-safe operations — and the
 * Gate phase of `single`, `chain`, `route`, `parallel`, and
 * `coordinator_worker`, while `evaluator_optimizer` never opens a Gate.
 */
import type { ArtifactId, DecisionId, PlanExpression, PlanNode, PlanNodeId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { chainExpression, criterionVerdictsOf, evaluatorsOf, finishRoot, gateEvaluatorStep, gatesOf, GATE_NODE_ALLOCATION, parallelExpression, remediationOf, rootTurnsOf, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { evaluatorStep, optimizerNodes, producerStep } from "./optimizer-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const failureReasonOf = (h: RuntimeHarness, runId: string, nodeId: PlanNodeId) => h.ctx.journal.read({ runId: runId as never, type: "plan_node.failed" }).find((e) => e.subjectId === nodeId)?.payload as { reason?: string } | undefined;

/** Performs one canonical action at a time until `done` holds, returning the kinds performed. */
async function stepUntil(h: RuntimeHarness, runId: string, done: () => boolean): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 200 && !done(); i += 1) {
    const pass = await h.scheduler.advanceRun(runId as never, { maxActions: 1 });
    if (pass.failure) throw new Error(pass.failure.message);
    kinds.push(...pass.actions.map((p) => p.action.kind));
    if (pass.actions.length === 0 && pass.stop !== "waiting") break;
  }
  if (!done()) throw new Error(`the Run did not reach the expected state after ${kinds.length} actions`);
  return kinds;
}

/** A gated single node whose Worker has completed and been integrated: the node is running with its candidate ready. */
async function integratedSingle(h: RuntimeHarness, counts: { deterministic?: number; evaluated?: number }, options: { allocation?: { costUsd: number; tokens: number; attempts: number }; policy?: "fail" | "wait" | "extend"; maxNodeGateCycles?: number } = {}) {
  const s = seedPlanningRuntime(h, options.maxNodeGateCycles === undefined ? {} : { verificationPolicy: { evaluatorAgentDefinitionRevisionId: undefined as never, maxNodeGateCycles: options.maxNodeGateCycles } });
  const criteria = seedCriteria(h, s, counts);
  const expression = { ...singleExpression(s, "A", { gate: criteria.all, allocation: options.allocation }), ...(options.policy ? { onAllocationExhausted: options.policy } : {}) } as PlanExpression;
  const { nodes, revisionNumber } = planNodes(h, s, [expression]);
  const node = nodes[0]!;
  await finishRoot(h, s);
  scriptByRole(h, { worker: [workerStep(h, "a")] });
  const runId = s.created.run.id;
  await stepUntil(h, runId, () => h.scheduler.reconcileRun(runId).actions[0]?.kind === "open_node_gate");
  const worker = h.stores.invocations.listByPlanNode(node.id)[0]!;
  return { s, criteria, node, revisionNumber, runId, worker, candidate: worker.result!.artifactIds };
}

describe("node_exit Gate lifecycle", () => {
  it("opens the first Gate with the next ordinal, the exact integration Snapshot, the exact candidate, and the criteria in id order; opening again changes nothing", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, revisionNumber, runId, candidate } = await integratedSingle(h, { deterministic: 2, evaluated: 1 });
      const runner = h.runners.single;
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "running", outputArtifactIds: null });
      const seq = h.ctx.journal.lastSeq();
      const opened = runner.openGate(node.id, revisionNumber);
      const run = h.stores.runs.get(runId);
      expect(opened).toEqual({ kind: "gate_opened", gateId: expect.any(String), ordinal: 1, snapshotId: run.integrationSnapshotId, candidateArtifactIds: candidate });
      if (opened.kind !== "gate_opened") throw new Error(opened.kind);
      const gate = h.stores.gates.get(opened.gateId);
      expect(gate).toMatchObject({ runId, planNodeId: node.id, kind: "node_exit", ordinal: 1, status: "open", snapshotId: run.integrationSnapshotId, candidateArtifactIds: candidate, acceptanceCriterionIds: criteria.all, failure: null, closedAt: null });
      expect(gate.acceptanceCriterionIds).toEqual([...gate.acceptanceCriterionIds].sort());
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type)).toEqual(["gate.opened"]);
      expect(runner.openGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.stores.gates.listByPlanNode(node.id)).toHaveLength(1);
      expect(h.stores.gates.openGateOf(node.id)?.id).toBe(gate.id);
      expect(runner.inspect(node.id)).toEqual({ kind: "verify_gate", gateId: gate.id });
      // Nothing about the Gate is deferred to a later phase.
      const projection = h.scheduler.reconcileRun(runId);
      expect(projection.deferred).toEqual([]);
      expect(projection.actions).toEqual([{ kind: "run_gate_checks", nodeId: node.id, gateId: gate.id }]);
    } finally {
      h.close();
    }
  });

  it("runs deterministic criteria first in id order and stops at the first failure: no further check, no Evaluator, a Gate closed on the failed criterion, and one remediation Task with the candidate and command output as inputs", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, revisionNumber, runId, candidate } = await integratedSingle(h, { deterministic: 2, evaluated: 1 });
      const runner = h.runners.single;
      const [first, second] = criteria.deterministic as [string, string];
      h.criterionExecution.script(first, { kind: "exit", exitCode: 1, output: "1 test failed\n" });
      const opened = runner.openGate(node.id, revisionNumber);
      if (opened.kind !== "gate_opened") throw new Error(opened.kind);
      const verified = await runner.verifyGate(node.id, revisionNumber);
      expect(verified).toMatchObject({ kind: "gate_verified", gateId: opened.gateId, verdict: "fail" });
      expect(h.criterionExecution.observed.map((o) => [o.acceptanceCriterionId, o.gateId, o.inTransaction])).toEqual([[first, opened.gateId, false]]);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(opened.gateId).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.verdict, e.producedBy.kind, e.gateId, e.context])).toEqual([[first, "fail", "runtime", opened.gateId, null]]);
      expect(runner.inspect(node.id)).toEqual({ kind: "settle_gate", gateId: opened.gateId });
      const settled = runner.settleGate(node.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "gate_failed", gateId: opened.gateId, remediationTaskId: expect.any(String) });
      const gate = h.stores.gates.get(opened.gateId);
      expect(gate).toMatchObject({ status: "failed", failure: { kind: "criteria_failed", acceptanceCriterionIds: [first] } });
      expect(gate.closedAt).not.toBeNull();
      const task = remediationOf(h, gate.id)!;
      const output = h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)[0]!.evidence.find((e) => e.kind === "command");
      expect(output?.kind).toBe("command");
      expect(task).toMatchObject({ origin: "runtime", planNodeId: node.id, gateId: gate.id, status: "pending", inputArtifactIds: [...new Set([...candidate, (output as { outputArtifactId: ArtifactId }).outputArtifactId])].sort() });
      expect(task.subject).toContain("1 of 3 Acceptance Criteria");
      // The second deterministic criterion never ran and no Evaluator exists; the node stays running under remediation.
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).not.toContain(second);
      expect(evaluatorsOf(h, gate.id)).toEqual([]);
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      expect(runner.inspect(node.id)).toEqual({ kind: "awaiting_remediation", gateId: gate.id, taskId: task.id });
      expect(runner.settleGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
    } finally {
      h.close();
    }
  });

  it("records nothing when a check cannot be carried out, and a later pass runs that check again exactly once", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, runId } = await integratedSingle(h, { deterministic: 1 });
      const [criterion] = criteria.deterministic as [string];
      h.criterionExecution.script(criterion, { kind: "fail", failure: "timed_out", message: "the command did not finish" }, { kind: "exit", exitCode: 0, output: "ok\n" });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const gate = gatesOf(h, node.id)[0]!;
      expect(outcome.actions.filter((p) => p.action.kind === "run_gate_checks").map((p) => p.outcome)).toEqual([
        { kind: "gate_verification_failed", gateId: gate.id, acceptanceCriterionId: criterion, failure: "timed_out", message: "the command did not finish" },
        { kind: "gate_verified", gateId: gate.id, verdict: "pass", evaluationIds: [expect.any(String)] },
      ]);
      expect(h.criterionExecution.observed.map((o) => o.outcome)).toEqual(["failed", "exited"]);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)).toHaveLength(1);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      expect(gate.status).toBe("passed");
    } finally {
      h.close();
    }
  });

  it("prepares exactly one read-only Evaluator Invocation of the policy revision per Gate, owned by the Gate and funded from the node, with one typed gate_candidate input naming every evaluated criterion and no transcript", async () => {
    const h = openRuntimeHarness();
    try {
      const { s, criteria, node, revisionNumber, runId, candidate } = await integratedSingle(h, { deterministic: 1, evaluated: 2 });
      const runner = h.runners.single;
      const opened = runner.openGate(node.id, revisionNumber);
      if (opened.kind !== "gate_opened") throw new Error(opened.kind);
      await runner.verifyGate(node.id, revisionNumber);
      expect(runner.inspect(node.id)).toEqual({ kind: "prepare_gate_evaluator", gateId: opened.gateId });
      const prepared = runner.prepareGateEvaluator(node.id, revisionNumber);
      expect(prepared).toMatchObject({ kind: "gate_evaluator_prepared", gateId: opened.gateId });
      if (prepared.kind !== "gate_evaluator_prepared") throw new Error(prepared.kind);
      const evaluator = h.stores.invocations.get(prepared.invocationId);
      expect(evaluator).toMatchObject({ role: "evaluator", purpose: "evaluate", gateId: opened.gateId, patternPosition: null, planNodeId: node.id, agentDefinitionRevisionId: s.evaluator.id, taskIds: [], allocationSource: "plan_node", continuedFromInvocationId: null, status: "pending" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: evaluator.id })?.parent).toEqual({ type: "plan_node", id: node.id });
      const manifest = h.stores.invocations.getManifest(evaluator.id).content;
      expect(manifest.inputs).toEqual([{ kind: "gate_candidate", gateId: opened.gateId, gateKind: "node_exit", snapshotId: h.stores.runs.get(runId).integrationSnapshotId, artifactIds: candidate, acceptanceCriterionIds: criteria.evaluated, completionRequestId: null, requirementRevisionId: null, tasks: [] }]);
      expect(manifest.capabilities).toEqual({ tools: ["read"], mcpServers: [] });
      expect(manifest.toolPolicy).toEqual({ read: "allowed" });
      expect(manifest.handoffs).toEqual([]);
      expect(manifest.tasks).toEqual([]);
      expect(manifest.artifacts.map((a) => a.artifactId)).toEqual(candidate);
      expect(manifest.acceptanceCriteria.map((c) => c.acceptanceCriterionId)).toEqual(expect.arrayContaining(criteria.evaluated));
      // One Evaluator per Gate: preparing again creates nothing, and the scheduler executes the one that exists.
      expect(runner.prepareGateEvaluator(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(evaluatorsOf(h, opened.gateId)).toHaveLength(1);
      expect(runner.inspect(node.id)).toEqual({ kind: "execute", invocationId: evaluator.id });
      expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "execute_invocation", nodeId: node.id, invocationId: evaluator.id, worktrees: 0 }]);
    } finally {
      h.close();
    }
  });

  it("records the Evaluator's verdicts as one Evaluation per evaluated criterion on the Gate's Snapshot and candidate, closes the Gate passed, and settles the node with its Handoffs and reservation in one transaction; repeating settles nothing twice", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 2 });
      const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [singleExpression(s, "A", { gate: criteria.all }), singleExpression(s, "B")] }]);
      expect(nodes).toHaveLength(2);
      const [a, b] = nodes as [PlanNode, PlanNode];
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [workerStep(h, "a")], evaluator: [gateEvaluatorStep(h, "pass")] });
      await stepUntil(h, runId, () => gatesOf(h, a.id)[0]?.status === "open" && (evaluatorsOf(h, gatesOf(h, a.id)[0]!.id)[0]?.status ?? "") === "succeeded");
      const gate = gatesOf(h, a.id)[0]!;
      const evaluator = evaluatorsOf(h, gate.id)[0]!;
      expect(h.runners.single.inspect(a.id)).toEqual({ kind: "settle_gate", gateId: gate.id });
      expect(h.stores.plans.getNode(b.id).status).toBe("pending");
      const seq = h.ctx.journal.lastSeq();
      const settled = h.runners.single.settleGate(a.id, h.stores.plans.latestRevisionNumber(runId));
      expect(settled).toMatchObject({ kind: "gate_passed", gateId: gate.id, outputArtifactIds: gate.candidateArtifactIds, handoffIds: [expect.any(String)] });
      const evaluations = h.stores.evaluations.gateCriterionEvaluationsOf(gate.id);
      expect(evaluations.map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.verdict, e.producedBy, e.gateId, e.context, e.snapshotId, e.artifactIds])).toEqual(
        criteria.all.map((id) => [id, "pass", criteria.deterministic.includes(id) ? { kind: "runtime" } : { kind: "evaluator", invocationId: evaluator.id, agentDefinitionRevisionId: s.evaluator.id }, gate.id, null, gate.snapshotId, gate.candidateArtifactIds]),
      );
      expect(h.stores.gates.get(gate.id)).toMatchObject({ status: "passed", failure: null });
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ status: "succeeded", outputArtifactIds: gate.candidateArtifactIds });
      expect(h.stores.reservations.activeForChild({ type: "plan_node", id: a.id })).toBeNull();
      const events = h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual(expect.arrayContaining(["evaluation.recorded", "gate.passed", "plan_node.succeeded", "handoff.created"]));
      expect(events.indexOf("gate.passed")).toBeLessThan(events.indexOf("plan_node.succeeded"));
      // The successor's Handoff carries the candidate by id; repeated settlement is a no-op and the successor now becomes ready.
      const handoff = h.stores.handoffs.get(settled.kind === "gate_passed" ? settled.handoffIds[0]! : ("" as never));
      expect(handoff).toMatchObject({ source: { kind: "plan_node", planNodeId: a.id }, target: { kind: "plan_node", planNodeId: b.id }, artifactIds: gate.candidateArtifactIds });
      expect(h.runners.single.settleGate(a.id, h.stores.plans.latestRevisionNumber(runId))).toEqual({ kind: "no_change" });
      expect(h.scheduler.reconcileRun(runId).actions[0]).toEqual({ kind: "ready_node", nodeId: b.id });
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("treats an invalid Evaluator result as an ordinary Attempt retry of the same Invocation, then records the valid verdicts", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, runId } = await integratedSingle(h, { evaluated: 2 });
      scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "pass", { reportIds: [criteria.evaluated[0]!] }), gateEvaluatorStep(h, "pass")] });
      let pass = await h.scheduler.advanceRun(runId);
      const gate = gatesOf(h, node.id)[0]!;
      const evaluator = evaluatorsOf(h, gate.id)[0]!;
      if (pass.stop === "waiting") {
        // The invalid result was recorded as a failed Attempt; the same Invocation retries from its durable retry time.
        expect(h.stores.invocations.listAttempts(evaluator.id).map((a) => [a.status, a.failureClass])).toEqual([["failed", "result_invalid"]]);
        expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)).toEqual([]);
        expect(h.stores.gates.get(gate.id).status).toBe("open");
        h.clock.advance(10_000);
        pass = await h.scheduler.advanceRun(runId);
      }
      expect(pass.stop).toBe("quiescent");
      expect(evaluatorsOf(h, gate.id)).toHaveLength(1);
      expect(h.stores.invocations.listAttempts(evaluator.id).map((a) => [a.status, a.failureClass])).toEqual([["failed", "result_invalid"], ["succeeded", null]]);
      expect(criterionVerdictsOf(h, gate.id)).toEqual(Object.fromEntries(criteria.evaluated.map((id) => [id, "pass"])));
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("closes the Gate with the evaluator_failed fact and fails the node with gate_evaluator_failed when the Evaluator fails permanently: no verdict is invented, no Task is created", async () => {
    const h = openRuntimeHarness();
    try {
      const { node, runId } = await integratedSingle(h, { deterministic: 1, evaluated: 1 });
      scriptByRole(h, { evaluator: [{ kind: "permanent_error", message: "model retired" }] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const gate = gatesOf(h, node.id)[0]!;
      const evaluator = evaluatorsOf(h, gate.id)[0]!;
      expect(evaluator.status).toBe("failed");
      expect(gate).toMatchObject({ status: "failed", failure: { kind: "evaluator_failed", invocationId: evaluator.id } });
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => e.producedBy.kind)).toEqual(["runtime"]);
      expect(remediationOf(h, gate.id)).toBeNull();
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(failureReasonOf(h, runId, node.id)).toMatchObject({ reason: "gate_evaluator_failed" });
      expect(rootTurnsOf(h, runId)).toHaveLength(1);
      expect(h.scheduler.reconcileRun(runId)).toMatchObject({ actions: [], remediating: [], deferred: [] });
    } finally {
      h.close();
    }
  });

  it("closes the Gate failed on exactly the criteria the Evaluator did not pass, keeping every verdict, and creates the remediation Task", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, runId } = await integratedSingle(h, { deterministic: 1, evaluated: 2 });
      const [c0, c1] = criteria.evaluated as [string, string];
      scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "fail", { criteria: { [c0]: "pass", [c1]: "inconclusive" } })] });
      await stepUntil(h, runId, () => gatesOf(h, node.id)[0]?.status === "failed");
      const gate = gatesOf(h, node.id)[0]!;
      expect(gate.failure).toEqual({ kind: "criteria_failed", acceptanceCriterionIds: [c1] });
      expect(criterionVerdictsOf(h, gate.id)).toEqual({ [criteria.deterministic[0]!]: "pass", [c0]: "pass", [c1]: "inconclusive" });
      const task = remediationOf(h, gate.id)!;
      expect(task).toMatchObject({ status: "pending", gateId: gate.id, planNodeId: node.id });
      expect(h.stores.plans.getNode(node.id).status).toBe("running");
      expect(h.scheduler.reconcileRun(runId).remediating).toEqual([{ nodeId: node.id, gateId: gate.id, taskId: task.id }]);
    } finally {
      h.close();
    }
  });

  it("keeps raw command output in the Artifact Store only: Evaluations, Tasks, Events, and manifests reference it by Artifact id", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, runId } = await integratedSingle(h, { deterministic: 1 });
      const secret = "SECRET-OUTPUT-7f3a";
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1, output: `${secret}\n` });
      await stepUntil(h, runId, () => rootTurnsOf(h, runId).length === 2);
      const gate = gatesOf(h, node.id)[0]!;
      const evaluation = h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)[0]!;
      const command = evaluation.evidence.find((e) => e.kind === "command") as { outputArtifactId: ArtifactId } | undefined;
      expect(command).toBeDefined();
      const artifact = h.stores.artifacts.get(command!.outputArtifactId);
      expect(artifact.producer).toEqual({ kind: "runtime", component: "command" });
      expect(new TextDecoder().decode(h.blobs.get(artifact.digest))).toContain(secret);
      const task = remediationOf(h, gate.id)!;
      const turn = rootTurnsOf(h, runId)[1]!;
      const surfaces = [JSON.stringify(evaluation), JSON.stringify(gate), JSON.stringify(task), JSON.stringify(h.ctx.journal.read({ runId })), JSON.stringify(h.stores.invocations.getManifest(turn.id).content), JSON.stringify(artifact)];
      for (const surface of surfaces) expect(surface).not.toContain(secret);
      expect(task.inputArtifactIds).toContain(artifact.id);
    } finally {
      h.close();
    }
  });

  it("performs every Gate operation once and refuses a stale revision: repeated verify, prepare, and settle change nothing", async () => {
    const h = openRuntimeHarness();
    try {
      const { node, revisionNumber, runId } = await integratedSingle(h, { deterministic: 1, evaluated: 1 });
      const runner = h.runners.single;
      for (const stale of [runner.openGate(node.id, revisionNumber + 1), await runner.verifyGate(node.id, revisionNumber + 1), runner.prepareGateEvaluator(node.id, revisionNumber + 1), runner.settleGate(node.id, revisionNumber + 1)]) {
        expect(stale).toEqual({ kind: "stale", expectedRevisionNumber: revisionNumber + 1, currentRevisionNumber: revisionNumber });
      }
      expect(gatesOf(h, node.id)).toEqual([]);
      const opened = runner.openGate(node.id, revisionNumber);
      if (opened.kind !== "gate_opened") throw new Error(opened.kind);
      expect(await runner.verifyGate(node.id, revisionNumber)).toMatchObject({ kind: "gate_verified" });
      expect(await runner.verifyGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.criterionExecution.observed).toHaveLength(1);
      expect(runner.settleGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.prepareGateEvaluator(node.id, revisionNumber)).toMatchObject({ kind: "gate_evaluator_prepared" });
      expect(runner.prepareGateEvaluator(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.openGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "pass")] });
      await h.executor.advanceInvocation(evaluatorsOf(h, opened.gateId)[0]!.id);
      expect(runner.settleGate(node.id, revisionNumber)).toMatchObject({ kind: "gate_passed" });
      const seq = h.ctx.journal.lastSeq();
      expect(runner.settleGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(await runner.verifyGate(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.prepareGateEvaluator(node.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(evaluatorsOf(h, opened.gateId)).toHaveLength(1);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });

  it("projects the Gate phase as typed scheduler actions and never as deferred work: open, check, prepare, execute, settle", async () => {
    const h = openRuntimeHarness();
    try {
      const { node, runId } = await integratedSingle(h, { deterministic: 1, evaluated: 1 });
      scriptByRole(h, { evaluator: [gateEvaluatorStep(h, "pass")] });
      const kinds: string[] = [];
      const deferred: unknown[] = [];
      for (let i = 0; i < 20 && h.stores.plans.getNode(node.id).status !== "succeeded"; i += 1) {
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
        kinds.push(...pass.actions.map((p) => p.action.kind));
        deferred.push(...pass.deferred);
      }
      expect(kinds).toEqual(["open_node_gate", "run_gate_checks", "prepare_gate_evaluator", "execute_invocation", "settle_node_gate"]);
      expect(deferred).toEqual([]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("funds the Gate Evaluator from the node's allocation and applies the node's allocation policy when it does not fit", async () => {
    for (const policy of ["fail", "wait"] as const) {
      const h = openRuntimeHarness();
      try {
        // The Worker consumed one of the node's two Attempts; the Evaluator's own two no longer fit.
        const { node, runId } = await integratedSingle(h, { evaluated: 1 }, { allocation: { costUsd: 4, tokens: 40_000, attempts: 2 }, policy });
        const outcome = await h.scheduler.advanceRun(runId);
        const gate = gatesOf(h, node.id)[0]!;
        expect(gate.status).toBe("open");
        expect(evaluatorsOf(h, gate.id)).toEqual([]);
        if (policy === "fail") {
          expect(outcome.stop).toBe("quiescent");
          expect(h.stores.plans.getNode(node.id).status).toBe("failed");
          expect(failureReasonOf(h, runId, node.id)).toMatchObject({ reason: "allocation_exhausted" });
        } else {
          expect(outcome.stop).toBe("waiting");
          expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "budget" });
          expect(outcome.waiting).toEqual([{ nodeId: node.id, reason: "budget", wakeAt: null }]);
        }
      } finally {
        h.close();
      }
    }
  });
});

describe("node_exit Gates across Patterns", () => {
  function requestDecision(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, optionIds: string[]) {
    return h.stores.decisions.request({
      conversationId: s.created.run.conversationId,
      runId: s.created.run.id,
      kind: "operator_choice",
      resolutionPolicy: "operator_required",
      requestedBy: { kind: "operator" },
      question: "Which path?",
      options: optionIds.map((id) => ({ id, label: id, description: null })),
      recommendedOptionId: null,
      rationale: null,
      affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
      deadlineAt: null,
      activationCondition: null,
      subject: null,
      supersedesDecisionId: null,
    });
  }

  it("gates a chain node once, after its final step, on the final step's integrated output", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { nodes } = planNodes(h, s, [chainExpression(s, ["first", "second"], { gate: criteria.all })]);
      expect(nodes).toHaveLength(1);
      const node = nodes[0]!;
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [workerStep(h, "first"), workerStep(h, "second")], evaluator: [gateEvaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      const steps = h.stores.invocations.listByPlanNode(node.id).filter((i) => i.role === "worker");
      expect(steps.map((i) => i.patternPosition?.kind)).toEqual(["chain_step", "chain_step"]);
      const [gate] = gatesOf(h, node.id);
      expect(gatesOf(h, node.id)).toHaveLength(1);
      expect(gate).toMatchObject({ status: "passed", ordinal: 1, candidateArtifactIds: steps[1]!.result!.artifactIds });
      expect(h.criterionExecution.observed).toHaveLength(1);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: steps[1]!.result!.artifactIds });
    } finally {
      h.close();
    }
  });

  it("gates a route node's inline branch output after the selection", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const decision = requestDecision(h, s, ["fast", "slow"]);
      h.stores.decisions.resolve(decision.id as DecisionId, { resolvedBy: "operator", chosenOptionId: "fast", rationale: null, artifactIds: [] });
      const leaf = (title: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } });
      const { nodes } = planNodes(h, s, [{ pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { fast: "quick", slow: "careful" } }, branches: { quick: leaf("quick"), careful: leaf("careful") }, allocation: GATE_NODE_ALLOCATION, gateAcceptanceCriterionIds: criteria.all as never }]);
      const node = nodes[0]!;
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [workerStep(h, "quick")], evaluator: [gateEvaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      const branch = h.stores.invocations.listByPlanNode(node.id).find((i) => i.role === "worker")!;
      expect(branch.patternPosition).toEqual({ kind: "route_branch", label: "quick" });
      const [gate] = gatesOf(h, node.id);
      expect(gate).toMatchObject({ status: "passed", ordinal: 1, candidateArtifactIds: branch.result!.artifactIds });
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: branch.result!.artifactIds });
      expect(h.stores.evaluations.listByRun(runId).filter((e) => e.gateId === gate!.id)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("gates a parallel node on its runtime index Artifact when it has no aggregate, and on the aggregate's output when it has one", async () => {
    for (const aggregate of [false, true]) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedPlanningRuntime(h);
        const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
        const { nodes } = planNodes(h, s, [parallelExpression(s, 2, { gate: criteria.all, aggregate })]);
        const node = nodes[0]!;
        const runId = s.created.run.id;
        await finishRoot(h, s);
        scriptByRole(h, { worker: [workerStep(h, "item0"), workerStep(h, "item1"), ...(aggregate ? [workerStep(h, "aggregate")] : [])], evaluator: [gateEvaluatorStep(h, "pass")] });
        const outcome = await h.scheduler.advanceRun(runId);
        expect(outcome.stop).toBe("quiescent");
        expect(outcome.deferred).toEqual([]);
        const workers = h.stores.invocations.listByPlanNode(node.id).filter((i) => i.role === "worker");
        expect(workers.map((i) => i.patternPosition?.kind).sort()).toEqual(aggregate ? ["parallel_aggregation", "parallel_item", "parallel_item"] : ["parallel_item", "parallel_item"]);
        const [gate] = gatesOf(h, node.id);
        expect(gatesOf(h, node.id)).toHaveLength(1);
        expect(gate!.status).toBe("passed");
        expect(gate!.candidateArtifactIds).toHaveLength(1);
        const candidate = h.stores.artifacts.get(gate!.candidateArtifactIds[0]!);
        if (aggregate) expect(candidate.producer).toMatchObject({ kind: "invocation", invocationId: workers.find((w) => w.patternPosition?.kind === "parallel_aggregation")!.id });
        else expect(candidate.producer).toMatchObject({ kind: "runtime" });
        expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: gate!.candidateArtifactIds });
      } finally {
        h.close();
      }
    }
  });

  it("never opens a Gate for an evaluator_optimizer node: its rounds consume the criteria through its own Evaluator", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
      const node = byPath["e0"]!;
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [producerStep(h, "v1")], evaluator: [evaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.actions.map((p) => p.action.kind).filter((k) => k.includes("gate"))).toEqual([]);
      expect(h.stores.gates.listByRun(runId)).toEqual([]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(node.id, 1).map((e) => [e.gateId, e.context?.kind])).toEqual([[null, "optimizer_criterion"], [null, "optimizer_criterion"]]);
      expect(h.stores.invocations.listByPlanNode(node.id).filter((i) => i.role === "evaluator").map((i) => [i.gateId, i.patternPosition?.kind])).toEqual([[null, "evaluator_round"]]);
    } finally {
      h.close();
    }
  });

  it("opens no Gate, runs no check, and prepares no Evaluator for nodes without Gate criteria", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { nodes } = planNodes(h, s, [singleExpression(s, "A"), chainExpression(s, ["x", "y"]), parallelExpression(s, 2)]);
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: Array.from({ length: 5 }, (_, i) => workerStep(h, `w${i}`)) });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.actions.map((p) => p.action.kind).filter((k) => k.includes("gate"))).toEqual([]);
      expect(nodes.map((n) => h.stores.plans.getNode(n.id).status)).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(h.stores.gates.listByRun(runId)).toEqual([]);
      expect(h.criterionExecution.requests).toEqual([]);
      expect(h.stores.invocations.listByRun(runId).filter((i) => i.role === "evaluator")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("counts a Gate Evaluator against the Run's concurrency like any other Invocation, holding other nodes back while it is active", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h, { budget: { ...DEFAULT_BUDGET, maxConcurrency: 1 } });
      const criteria = seedCriteria(h, s, { evaluated: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all }), singleExpression(s, "B", { gate: criteria.all })]);
      const [a, b] = nodes as [PlanNode, PlanNode];
      const runId = s.created.run.id;
      await finishRoot(h, s);
      // A's Evaluator stays active across a transient failure (its retry is due later); B is ready but held back meanwhile.
      scriptByRole(h, { worker: [workerStep(h, "a"), workerStep(h, "b")], evaluator: [{ kind: "transient_error" }, gateEvaluatorStep(h, "pass"), gateEvaluatorStep(h, "pass")] });
      await stepUntil(h, runId, () => (gatesOf(h, a.id)[0] === undefined ? false : evaluatorsOf(h, gatesOf(h, a.id)[0]!.id).some((e) => h.stores.invocations.listAttempts(e.id).length === 1)) && h.stores.plans.getNode(b.id).status === "ready");
      const projection = h.scheduler.reconcileRun(runId);
      expect(projection.concurrency).toEqual({ active: 1, max: 1 });
      expect(projection.limited).toEqual([b.id]);
      expect(projection.actions).toEqual([]);
      expect(projection.nodes.find((n) => n.nodeId === a.id)?.advice).toMatchObject({ kind: "retry_not_before" });
      h.clock.advance(10_000);
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect([a, b].map((n) => h.stores.plans.getNode(n.id).status)).toEqual(["succeeded", "succeeded"]);
    } finally {
      h.close();
    }
  });

  it("carries a passed Gate's candidate to successors by Handoff and starts them only after the pass", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [singleExpression(s, "A", { gate: criteria.all }), singleExpression(s, "B")] }]);
      const [a, b] = nodes as [PlanNode, PlanNode];
      const runId = s.created.run.id;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [workerStep(h, "a"), { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "b done" } }] });
      const statusesOfB: string[] = [];
      for (let i = 0; i < 30 && h.stores.plans.getNode(b.id).status !== "succeeded"; i += 1) {
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
        if (pass.actions.length === 0 && pass.stop !== "waiting") break;
        statusesOfB.push(`${pass.actions[0]?.action.kind}:${h.stores.plans.getNode(b.id).status}`);
      }
      const gatePass = statusesOfB.findIndex((x) => x.startsWith("settle_node_gate:"));
      expect(gatePass).toBeGreaterThan(-1);
      expect(statusesOfB.slice(0, gatePass + 1).every((x) => x.endsWith(":pending"))).toBe(true);
      const handoff = h.stores.handoffs.listByRun(runId).find((x) => x.target.kind === "plan_node" && x.target.planNodeId === b.id)!;
      expect(handoff.artifactIds).toEqual(gatesOf(h, a.id)[0]!.candidateArtifactIds);
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(b.id)[0]!.id).content.handoffs.map((x) => x.handoffId)).toEqual([handoff.id]);
      expect(h.stores.plans.getNode(b.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("gates a coordinator_worker node on its integrated synthesis and never on a Worker's output", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { coordinatorNode, proposal, propose, synthesisStep, turn, workerStep: coordinatorWorkerStep } = await import("./coordinator-test-support.ts");
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { node, leafIds } = coordinatorNode(h, s, { gate: criteria.all });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const final: { artifactId?: ArtifactId } = {};
      scriptByRole(h, {
        coordinator: [turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!] })])]), synthesisStep(h, runId, final)],
        worker: [coordinatorWorkerStep(h, { summary: "a", diff: "+a" }), coordinatorWorkerStep(h, { summary: "b", diff: "+b" })],
        evaluator: [gateEvaluatorStep(h, "pass")],
      });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.deferred).toEqual([]);
      const [gate] = gatesOf(h, node.id);
      expect(gatesOf(h, node.id)).toHaveLength(1);
      expect(gate).toMatchObject({ status: "passed", candidateArtifactIds: [final.artifactId] });
      expect(h.criterionExecution.observed.map((o) => o.gateId)).toEqual([gate!.id]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      expect(evaluatorsOf(h, gate!.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});
