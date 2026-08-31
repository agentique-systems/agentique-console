/**
 * Remediation of failed `node_exit` Gates (execution-model §10; invariants
 * 5 runtime-owned scheduling, 6 no transcript decides anything, 9 canonical
 * objects by id, 11 verification precedes completion, 20 one Invocation per
 * logical turn, 23 runtime-owned Task states): the root Orchestrator
 * remediates every non-Coordinator node's failed Gate in one batched
 * `gate_result` turn once nothing else can proceed; a Coordinator
 * remediates its own node's failed Gate from its blocker frontier; a
 * completed remediation reopens the next Gate cycle on the persisted
 * candidate; a remediation that ends otherwise fails the node, never the
 * Run; the cycle bound fails the node without a waiver.
 */
import type { ArtifactId, PlanNode, PlanNodeId, Task } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { coordinatorNode, proposal, propose, synthesisStep, turn, turnsOf, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import { criterionVerdictsOf, finishRoot, gateEvaluatorStep, gatesOf, orchestratorStep, remediationOf, rootTurnsOf, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { DEFAULT_BUDGET, seedBudgetIncrease } from "../persistence/test-support.ts";
import { asSeeded, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const failingGate = (h: RuntimeHarness, evaluated: string[]) => gateEvaluatorStep(h, "fail", { criteria: Object.fromEntries(evaluated.map((id) => [id, "fail" as const])) });

/** The canonical failure reason of a failed node, from its `plan_node.failed` Event. */
const failureReasonOf = (h: RuntimeHarness, runId: string, nodeId: PlanNodeId) => h.ctx.journal.read({ runId: runId as never, type: "plan_node.failed" }).find((e) => e.subjectId === nodeId)?.payload as { reason?: string } | undefined;

const taskOf = (tasks: Task[], nodeId: PlanNodeId) => tasks.find((t) => t.planNodeId === nodeId)!;

/** Performs one canonical action at a time until `done` holds, returning the kinds performed. */
async function stepUntil(h: RuntimeHarness, runId: string, done: () => boolean): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 200 && !done(); i += 1) {
    const pass = await h.scheduler.advanceRun(runId as never, { maxActions: 1 });
    if (pass.failure) throw new Error(pass.failure.message);
    kinds.push(...pass.actions.map((p) => p.action.kind));
    if (pass.actions.length === 0) break;
  }
  if (!done()) throw new Error(`the Run did not reach the expected state after ${kinds.length} actions`);
  return kinds;
}

/** Two independent gated single nodes whose first Gates fail on the evaluated criterion, stepped until the root's one remediation turn exists (not yet executed). */
async function twoFailedGates(h: RuntimeHarness) {
  const s = seedPlanningRuntime(h);
  const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
  const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all }), singleExpression(s, "B", { gate: criteria.all })]);
  const [a, b] = nodes as [PlanNode, PlanNode];
  await finishRoot(h, s);
  scriptByRole(h, { worker: [workerStep(h, "a"), workerStep(h, "b")], evaluator: [failingGate(h, criteria.evaluated), failingGate(h, criteria.evaluated)] });
  const runId = s.created.run.id;
  const kinds = await stepUntil(h, runId, () => rootTurnsOf(h, runId).length === 2);
  return { s, criteria, a, b, runId, kinds };
}

describe("node_exit Gate remediation", () => {
  it("batches every failed non-Coordinator Gate into one root gate_result turn only once nothing else can proceed: one typed gate_result input per Gate, continued from the previous turn, funded from the root, its Tasks running under it", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { criteria, a, b, runId, kinds } = await twoFailedGates(h);
      // Both Gates fail (their Tasks exist) before the one remediation turn is prepared: it is the last action, after both settlements.
      expect(kinds.at(-1)).toBe("prepare_gate_remediation");
      expect(kinds.filter((k) => k === "settle_node_gate")).toHaveLength(2);
      expect(kinds.filter((k) => k === "prepare_gate_remediation")).toHaveLength(1);
      const [gateA] = gatesOf(h, a.id);
      const [gateB] = gatesOf(h, b.id);
      expect([gateA!.status, gateB!.status]).toEqual(["failed", "failed"]);
      expect(gateA!.failure).toEqual({ kind: "criteria_failed", acceptanceCriterionIds: criteria.evaluated });
      const taskA = remediationOf(h, gateA!.id)!;
      const taskB = remediationOf(h, gateB!.id)!;
      const turns = rootTurnsOf(h, runId);
      expect(turns.map((t) => t.purpose)).toEqual(["operator_input", "gate_result"]);
      const remediation = turns[1]!;
      expect(remediation).toMatchObject({ role: "orchestrator", purpose: "gate_result", continuedFromInvocationId: turns[0]!.id, patternPosition: { kind: "orchestrator" }, gateId: null, taskIds: [], allocationSource: "plan_node", status: "pending" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: remediation.id })?.parent).toEqual({ type: "plan_node", id: h.stores.plans.rootNode(runId).id });
      expect([taskA, taskB].map((t) => [t.status, t.invocationId, t.origin, t.planNodeId])).toEqual([["running", remediation.id, "runtime", a.id], ["running", remediation.id, "runtime", b.id]]);
      const manifest = h.stores.invocations.getManifest(remediation.id).content;
      const inputs = manifest.inputs.filter((i) => i.kind === "gate_result");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toEqual({ kind: "gate_result", gateId: gateA!.id, gateKind: "node_exit", planNodeId: a.id, ordinal: 1, passed: false, snapshotId: gateA!.snapshotId, artifactIds: gateA!.candidateArtifactIds, failedAcceptanceCriterionIds: criteria.evaluated, evaluationIds: h.stores.evaluations.listByGate(gateA!.id).map((e) => e.id).sort(), remediationTaskId: taskA.id });
      // The judged candidates and the command outputs are readable by id; no transcript is delivered.
      expect(manifest.artifacts.map((x) => x.artifactId)).toEqual(expect.arrayContaining([...gateA!.candidateArtifactIds, ...gateB!.candidateArtifactIds, ...taskA.inputArtifactIds]));
      expect(taskA.inputArtifactIds.length).toBeGreaterThan(gateA!.candidateArtifactIds.length);
      expect(manifest.inputs.map((i) => i.kind).every((k) => k === "gate_result")).toBe(true);
      // Nothing is deferred and the gated nodes stay running while remediation is pending; the projection names them and executes the turn next.
      const projection = h.scheduler.reconcileRun(runId);
      expect(projection.remediating.map((r) => r.nodeId).sort()).toEqual([a.id, b.id].sort());
      expect(projection.actions.map((x) => x.kind)).toEqual(["execute_invocation"]);
      expect([a, b].map((n) => h.stores.plans.getNode(n.id).status)).toEqual(["running", "running"]);
    } finally {
      h.close();
    }
  });

  it("integrates the completed turn's Changeset, marks every Task addressed, and reopens each node's next Gate on the new Snapshot with the persisted candidate: the Task's outputs when the remediation replaced the output, the previous candidate otherwise", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { a, b, runId } = await twoFailedGates(h);
      const [gateA] = gatesOf(h, a.id);
      const [gateB] = gatesOf(h, b.id);
      const taskA = remediationOf(h, gateA!.id)!;
      const taskB = remediationOf(h, gateB!.id)!;
      // The Orchestrator replaces A's output (an Artifact attributed to A's Task), works directly (a Changeset), and reports nothing about B.
      scriptByRole(h, { orchestrator: [orchestratorStep(h, (tasks) => ({ outputsFor: [taskOf(tasks, a.id).id], diff: "+fix", reports: [{ taskId: taskOf(tasks, a.id).id, status: "completed" }] }))], evaluator: [gateEvaluatorStep(h, "pass"), gateEvaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const kinds = outcome.actions.map((p) => p.action.kind);
      expect(kinds.filter((k) => k === "settle_gate_remediation")).toEqual(["settle_gate_remediation", "settle_gate_remediation"]);
      expect(outcome.actions.map((p) => p.outcome.kind)).toEqual(expect.arrayContaining(["integrated", "remediation_settled"]));
      const remediation = rootTurnsOf(h, runId)[1]!;
      expect(h.stores.changesets.listByRun(runId).find((c) => c.invocationId === remediation.id)!.integrationStatus).toBe("integrated");
      const doneA = h.stores.tasks.get(taskA.id);
      const doneB = h.stores.tasks.get(taskB.id);
      expect(doneA.status).toBe("completed");
      expect(doneA.outputArtifactIds).toHaveLength(1);
      expect(doneB).toMatchObject({ status: "completed", outputArtifactIds: [], evidence: [{ kind: "snapshot", snapshotId: h.stores.runs.get(runId).integrationSnapshotId }] });
      // Cycle 2 on the new integration Snapshot: A judges the Task's output, B judges its previous candidate; both pass and the nodes succeed.
      const [, secondA] = gatesOf(h, a.id);
      const [, secondB] = gatesOf(h, b.id);
      expect(secondA).toMatchObject({ ordinal: 2, status: "passed", snapshotId: h.stores.runs.get(runId).integrationSnapshotId, candidateArtifactIds: doneA.outputArtifactIds });
      expect(secondB).toMatchObject({ ordinal: 2, status: "passed", snapshotId: h.stores.runs.get(runId).integrationSnapshotId, candidateArtifactIds: gateB!.candidateArtifactIds });
      expect(secondA!.snapshotId).not.toBe(gateA!.snapshotId);
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ status: "succeeded", outputArtifactIds: doneA.outputArtifactIds });
      expect(h.stores.plans.getNode(b.id)).toMatchObject({ status: "succeeded", outputArtifactIds: gateB!.candidateArtifactIds });
      // No Worker ran again, no Task or turn was duplicated, and every Gate's deterministic check ran exactly once per cycle.
      expect(h.stores.invocations.listByPlanNode(a.id).filter((i) => i.role === "worker")).toHaveLength(1);
      expect(rootTurnsOf(h, runId).map((t) => t.purpose)).toEqual(["operator_input", "gate_result"]);
      expect(h.stores.tasks.listRemediationTasks(runId)).toHaveLength(2);
      expect(h.criterionExecution.observed.map((o) => o.gateId).sort()).toEqual([gateA!.id, gateB!.id, secondA!.id, secondB!.id].sort());
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
    } finally {
      h.close();
    }
  });

  it("fails the affected nodes with gate_remediation_failed when the gate_result turn fails permanently, and keeps the Run and the root alive", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { a, b, runId } = await twoFailedGates(h);
      scriptByRole(h, { orchestrator: [{ kind: "permanent_error", message: "model retired" }] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const remediation = rootTurnsOf(h, runId)[1]!;
      expect(remediation.status).toBe("failed");
      for (const node of [a, b]) {
        const [gate] = gatesOf(h, node.id);
        expect(remediationOf(h, gate!.id)).toMatchObject({ status: "failed", failureReason: "permanent_failure" });
        expect(h.stores.plans.getNode(node.id).status).toBe("failed");
        expect(failureReasonOf(h, runId, node.id)).toMatchObject({ reason: "gate_remediation_failed" });
        expect(gatesOf(h, node.id)).toHaveLength(1);
      }
      expect(h.stores.runs.get(runId).status).toBe("running");
      expect(h.stores.plans.getNode(h.stores.plans.rootNode(runId).id).status).toBe("running");
      expect(h.scheduler.reconcileRun(runId)).toMatchObject({ actions: [], remediating: [], stop: "quiescent" });
    } finally {
      h.close();
    }
  });

  it("ends a Task the Orchestrator reported blocked, failing that node only, while the other Task is addressed", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { a, b, runId } = await twoFailedGates(h);
      const taskA = remediationOf(h, gatesOf(h, a.id)[0]!.id)!;
      scriptByRole(h, { orchestrator: [orchestratorStep(h, (tasks) => ({ reports: [{ taskId: taskOf(tasks, a.id).id, status: "blocked" }] }))], evaluator: [gateEvaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(h.stores.tasks.get(taskA.id).status).toBe("cancelled");
      expect(h.stores.plans.getNode(a.id).status).toBe("failed");
      expect(failureReasonOf(h, runId, a.id)).toMatchObject({ reason: "gate_remediation_failed" });
      expect(remediationOf(h, gatesOf(h, b.id)[0]!.id)!.status).toBe("completed");
      expect(h.stores.plans.getNode(b.id).status).toBe("succeeded");
      expect(gatesOf(h, b.id).map((g) => [g.ordinal, g.status])).toEqual([[1, "failed"], [2, "passed"]]);
    } finally {
      h.close();
    }
  });

  it("continues a gate_result turn blocked on a resolved approval in a successor that carries the same gate_result inputs and takes over its Tasks, consuming no second remediation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { a, runId } = await twoFailedGates(h);
      const blocked = rootTurnsOf(h, runId)[1]!;
      const taskA = remediationOf(h, gatesOf(h, a.id)[0]!.id)!;
      expect(taskA.invocationId).toBe(blocked.id);
      // The Orchestrator proposes a shell call: approval required, the turn blocks; the root waits on the Decision.
      scriptByRole(h, { orchestrator: [{ kind: "tool_calls", calls: [{ tool: "shell", input: { command: "npm test" } }], then: orchestratorStep(h) }] });
      const waiting = await h.scheduler.advanceRun(runId);
      expect(waiting.stop).toBe("waiting");
      expect(h.stores.invocations.get(blocked.id).status).toBe("blocked");
      expect(h.stores.tasks.get(taskA.id)).toMatchObject({ status: "running", invocationId: blocked.id });
      const decision = h.stores.decisions.listOpen(h.stores.runs.get(runId).conversationId).find((d) => d.kind === "side_effect_approval")!;
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      scriptByRole(h, { orchestrator: [orchestratorStep(h)], evaluator: [gateEvaluatorStep(h, "pass"), gateEvaluatorStep(h, "pass")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      const turns = rootTurnsOf(h, runId);
      expect(turns.map((t) => [t.purpose, t.continuedFromInvocationId])).toEqual([["operator_input", null], ["gate_result", turns[0]!.id], ["gate_result", blocked.id]]);
      const successor = h.stores.invocations.getManifest(turns[2]!.id).content;
      expect(successor.inputs.filter((i) => i.kind === "gate_result")).toEqual(h.stores.invocations.getManifest(blocked.id).content.inputs.filter((i) => i.kind === "gate_result"));
      expect(successor.inputs.at(-1)).toMatchObject({ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: blocked.id, outcome: "approve_once" });
      expect(h.stores.tasks.get(taskA.id)).toMatchObject({ status: "completed", invocationId: turns[2]!.id });
      expect(h.stores.tasks.listRemediationTasks(runId)).toHaveLength(2);
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("fails the node with gate_cycles_exhausted, without a further Task or waiver, when the last permitted Gate cycle fails", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 2, maxRunCompletionCycles: 3 } });
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1, output: "1 failing\n" }, { kind: "exit", exitCode: 1, output: "still failing\n" });
      scriptByRole(h, { worker: [workerStep(h, "a")], orchestrator: [orchestratorStep(h)] });
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(gatesOf(h, node.id).map((g) => [g.ordinal, g.status, g.failure?.kind])).toEqual([[1, "failed", "criteria_failed"], [2, "failed", "criteria_failed"]]);
      expect(h.stores.tasks.listRemediationTasks(s.created.run.id)).toHaveLength(1);
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(failureReasonOf(h, s.created.run.id, node.id)).toMatchObject({ reason: "gate_cycles_exhausted" });
      expect(rootTurnsOf(h, s.created.run.id).map((t) => t.purpose)).toEqual(["operator_input", "gate_result"]);
      expect(h.scheduler.reconcileRun(s.created.run.id)).toMatchObject({ actions: [], remediating: [] });
    } finally {
      h.close();
    }
  });

  it("extends the root's allocation by exactly the remediation turn's shortfall from the Run's ordinary capacity, atomically with the turn", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // The root can fund exactly one Orchestrator turn: the operator_input turn consumed an Attempt of the two; the Run has ordinary capacity to spare.
      const s = seedPlanningRuntime(h, { orchestratorAllocation: { costUsd: 4, tokens: 40_000, attempts: 2 } });
      const runId = s.created.run.id;
      const rootId = h.stores.plans.rootNode(runId).id;
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
      await finishRoot(h, s);
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1 });
      scriptByRole(h, { worker: [workerStep(h, "a")] });
      const shortfall = h.capacity.admits(h.stores.plans.rootNode(runId) as never, s.orchestrator.defaultLimits.allocation);
      const kinds = await stepUntil(h, runId, () => rootTurnsOf(h, runId).length === 2);
      expect(kinds.at(-1)).toBe("prepare_gate_remediation");
      expect(remediationOf(h, gatesOf(h, nodes[0]!.id)[0]!.id)!.status).toBe("running");
      // One extension, exactly the component-wise shortfall, in the transaction that prepared the turn; nothing rounded up.
      const extensions = h.stores.allocationExtensions.listByRun(runId);
      expect(extensions).toHaveLength(1);
      expect(extensions[0]).toMatchObject({ planNodeId: rootId, trigger: "gate_remediation", added: shortfall.shortfall });
      expect(shortfall.shortfall.attempts).toBe(1);
      expect(h.stores.reservations.planNodeAllocation(rootId).extended).toEqual(shortfall.shortfall);
      const events = h.ctx.journal.read({ runId, type: "allocation_extension.created" });
      expect(events).toHaveLength(1);
      const created = h.ctx.journal.read({ runId, type: "invocation.created" }).find((e) => e.subjectId === rootTurnsOf(h, runId)[1]!.id)!;
      expect(events[0]!.seq).toBeLessThan(created.seq);
      expect(events[0]!.correlationId).toBe(created.correlationId);
      expect(h.stores.usage.totalsForRun(runId).rows).toBe(h.stores.usage.totalsForRun(runId).rows);
    } finally {
      h.close();
    }
  });

  it("waits the Run on budget when the root cannot fund the remediation turn and no extension fits, then resumes it after an approved ordinary Budget Increase with exactly one extension and one turn", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // Ordinary capacity is exactly reserved (root 2 + gated node 12 + reserve 3 = 17 Attempts): the root's extend policy finds nothing to draw from.
      const s = seedPlanningRuntime(h, { orchestratorAllocation: { costUsd: 4, tokens: 40_000, attempts: 2 }, budget: { ...DEFAULT_BUDGET, maxAttempts: 17 } });
      const runId = s.created.run.id;
      const rootId = h.stores.plans.rootNode(runId).id;
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
      await finishRoot(h, s);
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1 });
      scriptByRole(h, { worker: [workerStep(h, "a")] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("waiting");
      expect(outcome.waiting).toEqual([{ nodeId: rootId, reason: "budget", wakeAt: null }]);
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
      expect(rootTurnsOf(h, runId)).toHaveLength(1);
      expect(remediationOf(h, gatesOf(h, nodes[0]!.id)[0]!.id)!.status).toBe("pending");
      expect(h.stores.allocationExtensions.listByRun(runId)).toEqual([]);
      expect(h.scheduler.reconcileRun(runId).nodes[0]!.advice).toMatchObject({ kind: "remediate", funded: false });
      // Nothing changes on a repeated pass, and no agent turn exists merely to report the shortfall.
      const again = await h.scheduler.advanceRun(runId);
      expect(again.actions).toEqual([]);
      expect(rootTurnsOf(h, runId)).toHaveLength(1);
      // An approved ordinary increase of exactly one Attempt: the next pass resumes the Run through the ordinary transition, extends the root by exactly its
      // shortfall, and prepares the one turn — and nothing but the scheduler pass acted on the increase.
      seedBudgetIncrease(h, asSeeded(s), "ordinary", { costUsd: 0, tokens: 0, attempts: 1 });
      expect(h.stores.runs.get(runId).status).toBe("waiting");
      expect(h.scheduler.reconcileRun(runId).actions.map((a) => a.kind)).toEqual(["resume_run", "prepare_gate_remediation"]);
      scriptByRole(h, { orchestrator: [orchestratorStep(h)] });
      const resumed = await h.scheduler.advanceRun(runId);
      expect(resumed.actions.map((a) => a.action.kind).slice(0, 2)).toEqual(["resume_run", "prepare_gate_remediation"]);
      expect(h.ctx.journal.read({ runId, type: "run.wait_cleared" }).map((e) => e.payload)).toEqual([{ from: "waiting", to: "running", clearedWaitReason: "budget" }]);
      expect(h.stores.allocationExtensions.listByRun(runId)).toMatchObject([{ planNodeId: rootId, trigger: "gate_remediation", added: { costUsd: 0, tokens: 0, attempts: 1 } }]);
      expect(rootTurnsOf(h, runId).map((t) => t.purpose)).toEqual(["operator_input", "gate_result"]);
      expect(h.stores.reservations.runCapacity(runId).increases.ordinary).toEqual({ costUsd: 0, tokens: 0, attempts: 1 });
      expect(h.stores.runs.get(runId).budget.maxAttempts).toBe(17);
    } finally {
      h.close();
    }
  });

  it("lets a Coordinator remediate its own failed Gate from its frontier: the replan turn gets the gate_failed blocker with the typed gate_result facts, its progress addresses the Task, and the next synthesis is the next Gate's candidate", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { node, leafIds } = coordinatorNode(h, s, { gate: criteria.all, bounds: { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 6 } });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      const first: { artifactId?: ArtifactId } = {};
      const second: { artifactId?: ArtifactId } = {};
      scriptByRole(h, {
        // decompose, synthesize, replan (a fix Task: canonical progress on the failed Gate), synthesize again.
        coordinator: [turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]), synthesisStep(h, runId, first), turn([propose([proposal({ key: "fix", requirementIds: [leafIds[1]!] })])]), synthesisStep(h, runId, second)],
        worker: [coordinatorWorkerStep(h, { summary: "a", diff: "+a" }), coordinatorWorkerStep(h, { summary: "fix", diff: "+fix" })],
        evaluator: [failingGate(h, criteria.evaluated), gateEvaluatorStep(h, "pass")],
      });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(outcome.actions.map((p) => p.action.kind)).not.toContain("prepare_gate_remediation");
      expect(outcome.actions.map((p) => p.outcome.kind)).toContain("gate_remediation_addressed");
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "synthesize", "replan", "synthesize"]);
      const [gate1, gate2] = gatesOf(h, node.id);
      expect(gate1).toMatchObject({ ordinal: 1, status: "failed", candidateArtifactIds: [first.artifactId] });
      expect(gate2).toMatchObject({ ordinal: 2, status: "passed", candidateArtifactIds: [second.artifactId] });
      const task = remediationOf(h, gate1!.id)!;
      const replan = turnsOf(h, node)[2]!;
      expect(task).toMatchObject({ status: "completed", invocationId: replan.id, evidence: [{ kind: "snapshot", snapshotId: expect.any(String) }] });
      const inputs = h.stores.invocations.getManifest(replan.id).content.inputs;
      expect(inputs.find((i) => i.kind === "coordinator_blocker")).toEqual({ kind: "coordinator_blocker", blocker: { kind: "gate_failed", taskId: task.id, gateId: gate1!.id } });
      expect(inputs.find((i) => i.kind === "gate_result")).toMatchObject({ kind: "gate_result", gateId: gate1!.id, passed: false, failedAcceptanceCriterionIds: criteria.evaluated, remediationTaskId: task.id });
      expect(inputs.find((i) => i.kind === "coordinator_turn")).toMatchObject({ purpose: "replan", blockerKeys: [`gate_failed:${gate1!.id}`] });
      expect(criterionVerdictsOf(h, gate2!.id)).toEqual(Object.fromEntries(criteria.all.map((id) => [id, "pass"])));
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [second.artifactId] });
      // The root never remediated a Coordinator's Gate.
      expect(rootTurnsOf(h, runId).map((t) => t.purpose)).toEqual(["operator_input"]);
    } finally {
      h.close();
    }
  });

  it("fails a Coordinator node with coordinator_no_progress when its replan makes no progress on the delivered failed Gate, leaving the Task unaddressed and opening no further Gate", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const criteria = seedCriteria(h, s, { deterministic: 1 });
      const { node, leafIds } = coordinatorNode(h, s, { gate: criteria.all });
      const runId = s.created.run.id;
      await finishRoot(h, s);
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 1, output: "failing\n" });
      scriptByRole(h, { coordinator: [turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })])]), synthesisStep(h, runId, {}), turn([])], worker: [coordinatorWorkerStep(h, { summary: "a", diff: "+a" })] });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(turnsOf(h, node).map((t) => t.purpose)).toEqual(["decompose", "synthesize", "replan"]);
      expect(h.stores.plans.getNode(node.id).status).toBe("failed");
      expect(failureReasonOf(h, runId, node.id)).toMatchObject({ reason: "coordinator_no_progress" });
      const [gate] = gatesOf(h, node.id);
      expect(gatesOf(h, node.id)).toHaveLength(1);
      expect(remediationOf(h, gate!.id)!.status).not.toBe("completed");
      expect(rootTurnsOf(h, runId)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("applies remediation settlement once: repeated passes over settled rows change nothing, and a stale revision performs nothing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const { a, runId } = await twoFailedGates(h);
      scriptByRole(h, { orchestrator: [orchestratorStep(h)], evaluator: [gateEvaluatorStep(h, "pass"), gateEvaluatorStep(h, "pass")] });
      expect((await h.scheduler.advanceRun(runId)).stop).toBe("quiescent");
      const before = { turns: rootTurnsOf(h, runId).length, tasks: h.stores.tasks.listRemediationTasks(runId).map((t) => t.status), gates: gatesOf(h, a.id).length, seq: h.ctx.journal.lastSeq() };
      expect(await h.runners.root.settleRemediation(runId)).toEqual({ kind: "no_change" });
      expect(h.runners.root.prepareRemediation(runId)).toEqual({ kind: "no_change" });
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
      expect(h.runners.single.openGate(a.id, 999)).toMatchObject({ kind: "stale" });
      expect(h.runners.single.settleGate(a.id, 999)).toMatchObject({ kind: "stale" });
      expect({ turns: rootTurnsOf(h, runId).length, tasks: h.stores.tasks.listRemediationTasks(runId).map((t) => t.status), gates: gatesOf(h, a.id).length, seq: h.ctx.journal.lastSeq() }).toEqual(before);
    } finally {
      h.close();
    }
  });
});
