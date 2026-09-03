/**
 * The Run verification policy and Gate ownership at the schema (execution-model
 * §3, §4.4, §10; invariants 9 canonical objects by id, 11 verification
 * precedes completion, 22 atomic allocation): the immutable policy persisted
 * at Run creation, the Evaluator resolved through the executable-revision
 * resolver and never the Orchestrator, plan validation refusing evaluated
 * Gate criteria without an Evaluator, Gate identity and append-only closure,
 * the Gate Evaluator's ownership and revision, one Evaluation per Gate and
 * criterion, one remediation Task per failed Gate, and the cycle bound — each
 * enforced by the store and, where a constraint or trigger exists, by the
 * database itself.
 */
import { ConflictError, MAX_NODE_GATE_CYCLES, ValidationError, type PlanExpression } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedAgentRevision, seedArtifact, seedInvocation, seedRun, seedSnapshot, seedWorkerNode, type Harness, type Seeded } from "../persistence/test-support.ts";
import { seedCriteria } from "./gate-test-support.ts";
import { openRuntimeHarness, propose, rejected, seedPlanningRuntime, seedReadOnlyWorker, accepted } from "./test-support.ts";

/** One deterministic and one evaluated criterion of the seeded Conversation, and a single node gated on both (ids in canonical order). */
function gatedNode(h: Harness, s: Seeded) {
  const revision = h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: h.ctx.ids("requirement"), parentId: null, composition: null, statement: "works", position: 0, acceptanceCriterionIds: [] }] });
  const requirementId = revision.tree[0]!.id;
  const deterministic = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
  const evaluated = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "evaluated", question: "correct?", rubric: null } });
  const criteria = [deterministic.id, evaluated.id].sort();
  const node = seedWorkerNode(h, s, "single", { gateAcceptanceCriterionIds: criteria } as never);
  return { node, deterministic, evaluated, criteria };
}

/** Inserts a copy of a row with the given column overrides (SQL expressions), exercising the table's own constraints and triggers. */
function cloneRow(h: Harness, table: string, id: string, overrides: Record<string, string>) {
  const columns = (h.database.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const select = columns.map((c) => (c in overrides ? `${overrides[c]} AS ${c}` : c)).join(", ");
  return h.database.sqlite.prepare(`INSERT INTO ${table} (${columns.join(", ")}) SELECT ${select} FROM ${table} WHERE id = ?`).run(id);
}

describe("Run verification policy", () => {
  it("persists the immutable policy at Run creation with the default cycle bound, validating its shape", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      expect(s.run.verificationPolicy).toEqual({ evaluatorAgentDefinitionRevisionId: s.evaluator.id, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] });
      expect(h.stores.runs.get(s.run.id).verificationPolicy).toEqual(s.run.verificationPolicy);
      expect(() => h.database.sqlite.prepare("UPDATE runs SET verification_policy = '{\"evaluatorAgentDefinitionRevisionId\":null,\"maxNodeGateCycles\":1}' WHERE id = ?").run(s.run.id)).toThrow(/immutable/);
      const base = { conversationId: s.conversation.id, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: s.run.budget, finalReserve: s.run.finalReserve };
      expect(() => h.stores.runs.create({ ...base, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 0, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] } })).toThrow(ValidationError);
      expect(() => h.stores.runs.create({ ...base, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: MAX_NODE_GATE_CYCLES + 1, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] } })).toThrow(ValidationError);
      expect(() => h.stores.runs.create({ ...base, verificationPolicy: { evaluatorAgentDefinitionRevisionId: "agdr_000000000000000000000000" as never, maxNodeGateCycles: 2, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] } })).toThrow(/AgentDefinitionRevision/);
    } finally {
      h.close();
    }
  });

  it("resolves the Gate Evaluator through the executable-revision resolver and refuses a revision the Run cannot execute", () => {
    const h = openRuntimeHarness();
    try {
      expect(() => seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: "agdr_000000000000000000000000" } })).toThrow(/not executable by this Run/);
      const s = seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 5, maxRunCompletionCycles: 3 } });
      expect(h.stores.runs.get(s.created.run.id).verificationPolicy).toEqual({ evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 5, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [s.completion.criterionId] });
      const reader = seedReadOnlyWorker(h, "judge");
      const t = seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: reader.id } });
      expect(h.stores.runs.get(t.created.run.id).verificationPolicy).toEqual({ evaluatorAgentDefinitionRevisionId: reader.id, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [t.completion.criterionId] });
    } finally {
      h.close();
    }
  });

  it("refuses the Orchestrator definition as the Run's Gate Evaluator, at the service and at the store", () => {
    const h = openRuntimeHarness();
    try {
      const orchestrator = seedAgentRevision(h, "orchestrator");
      expect(() => seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: orchestrator.id } })).toThrow(/cannot be the Run's Gate Evaluator/);
      const s = seedRun(h);
      expect(() => h.stores.runs.create({ conversationId: s.conversation.id, kind: "code", target: { kind: "branch", branch: "main" }, budget: s.run.budget, finalReserve: s.run.finalReserve, verificationPolicy: { evaluatorAgentDefinitionRevisionId: s.definition.id, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] } })).toThrow(/orchestrator/);
    } finally {
      h.close();
    }
  });

  it("rejects a plan revision whose non-optimizer node gates on evaluated criteria when the Run names no Evaluator, accepting deterministic-only Gates and evaluator_optimizer nodes", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null } });
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const single = (gate: string[]): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" }, gateAcceptanceCriterionIds: gate as never });
      const outcome = rejected(propose(h, s, [single(criteria.all)]));
      expect(outcome.reasons.map((r) => [r.code, r.path])).toEqual([["gate_evaluator_unavailable", "e0"]]);
      expect(outcome.reasons[0]!.message).toContain(criteria.evaluated[0]);
      expect(h.stores.plans.currentGraph(s.created.run.id).nodes).toHaveLength(1);
      expect(accepted(propose(h, s, [single(criteria.deterministic)])).graph.nodes).toHaveLength(2);
      const judge = seedReadOnlyWorker(h, "judge");
      const optimizer: PlanExpression = { pattern: "evaluator_optimizer", producer: { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "draft" } }, evaluator: { agentDefinitionRevisionId: judge.id as never, title: "judge" }, maxRounds: 2, gateAcceptanceCriterionIds: criteria.all as never };
      expect(accepted(propose(h, s, [optimizer])).graph.nodes).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

describe("Gate ownership at the schema", () => {
  it("gives a node_exit Gate its identity — node, ordinal, exact Snapshot, exact criteria in canonical order — allows one open Gate per node, and never mutates or deletes a closed Gate", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node, criteria } = gatedNode(h, s);
      const snapshotId = seedSnapshot(h, s).id;
      const artifact = seedArtifact(h, s, "candidate");
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: [criteria[0]!], snapshotId, candidateArtifactIds: [artifact.id] })).toThrow(/criteria/);
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: [...criteria].reverse(), snapshotId, candidateArtifactIds: [artifact.id] })).toThrow(/canonical id order/);
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [artifact.id] });
      expect(gate).toMatchObject({ planNodeId: node.id, ordinal: 1, snapshotId, acceptanceCriterionIds: criteria, candidateArtifactIds: [artifact.id], status: "open", failure: null });
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [artifact.id] })).toThrow(ConflictError);
      expect(() => cloneRow(h, "gates", gate.id, { id: "'gate_000000000000000000000000'", ordinal: "2" })).toThrow(/UNIQUE constraint failed: gates\.plan_node_id/);
      const failed = h.stores.gates.close(gate.id, "failed", { kind: "criteria_failed", acceptanceCriterionIds: [criteria[0]!] });
      expect(failed).toMatchObject({ status: "failed", failure: { kind: "criteria_failed", acceptanceCriterionIds: [criteria[0]] } });
      expect(() => h.stores.gates.close(gate.id, "passed")).toThrow(/passed|failed|closed|transition/i);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET status = 'passed', failure = NULL WHERE id = ?").run(gate.id)).toThrow(/never changes again/);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET candidate_artifact_ids = '[]' WHERE id = ?").run(gate.id)).toThrow(/never changes again/);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET candidate_artifact_ids = '[]' WHERE id = ?").run(h.stores.gates.open({ runId: s.run.id, planNodeId: seedWorkerNode(h, s).id, kind: "node_exit", acceptanceCriterionIds: [], snapshotId, candidateArtifactIds: [] }).id)).toThrow(/immutable/);
      expect(() => h.database.sqlite.prepare("DELETE FROM gates WHERE id = ?").run(gate.id)).toThrow(/append-only/);
      const second = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [artifact.id] });
      expect(second.ordinal).toBe(2);
      expect(() => cloneRow(h, "gates", second.id, { id: "'gate_000000000000000000000001'", status: "'passed'", closed_at: "opened_at" })).toThrow(/UNIQUE constraint failed: gates\.plan_node_id, gates\.ordinal/);
      expect(h.stores.gates.listByPlanNode(node.id).map((g) => [g.ordinal, g.status])).toEqual([[1, "failed"], [2, "open"]]);
    } finally {
      h.close();
    }
  });

  it("binds a Gate Evaluator Invocation to one open Gate of its own node with the policy's revision: position null iff a Gate is named, evaluator role only, one active per Gate, never a Task", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node } = gatedNode(h, s);
      const snapshotId = seedSnapshot(h, s).id;
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: node.kind === "pattern" ? node.gateAcceptanceCriterionIds : [], snapshotId, candidateArtifactIds: [] });
      const other = seedWorkerNode(h, s);
      const otherRevision = seedAgentRevision(h, "worker");
      // Wrong node, wrong revision, wrong role, and a Task are refused before any row exists.
      expect(() => seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: other.id, patternPosition: null, gateId: gate.id })).toThrow(/PlanNode/);
      expect(() => seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: null, gateId: gate.id, agentDefinitionRevisionId: otherRevision.id })).toThrow(/verification policy|revision/i);
      expect(() => seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, patternPosition: null, gateId: gate.id })).toThrow(ValidationError);
      expect(() => seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: { kind: "single" }, gateId: gate.id })).toThrow(ValidationError);
      const evaluator = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: null, gateId: gate.id });
      expect(evaluator).toMatchObject({ gateId: gate.id, patternPosition: null, taskIds: [], role: "evaluator", agentDefinitionRevisionId: s.evaluator.id });
      // A second active Evaluator of the same Gate is refused by the store and by the partial unique index.
      expect(() => seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: null, gateId: gate.id })).toThrow(ConflictError);
      expect(() => cloneRow(h, "invocations", evaluator.id, { id: "'inv_000000000000000000000000'" })).toThrow(/UNIQUE constraint failed: invocations\.gate_id/);
      // The database itself refuses a positioned Invocation that names a Gate, a position-less one that names none, a Worker on a Gate, and a foreign revision.
      expect(() => cloneRow(h, "invocations", evaluator.id, { id: "'inv_000000000000000000000001'", gate_id: "NULL" })).toThrow(/invocations_gate_ownership/);
      expect(() => cloneRow(h, "invocations", evaluator.id, { id: "'inv_000000000000000000000002'", role: "'worker'", purpose: "'step'" })).toThrow(/invocations_pattern_position_present|invocations_gate_evaluator_role/);
      expect(() => cloneRow(h, "invocations", evaluator.id, { id: "'inv_000000000000000000000003'", agent_definition_revision_id: `'${otherRevision.id}'`, status: "'failed'" })).toThrow(/verification-policy evaluator revision|UNIQUE constraint failed: invocations\.gate_id/);
      // Once the Gate is closed no Evaluator can be created for it.
      h.stores.invocations.transition(evaluator.id, { to: "cancelled", cause: { kind: "run_cancelled" } } as never);
      h.stores.gates.close(gate.id, "failed", { kind: "evaluator_failed", invocationId: evaluator.id });
      expect(() => seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: null, gateId: gate.id })).toThrow(/open/);
    } finally {
      h.close();
    }
  });

  it("records one Evaluation per Gate and criterion on the Gate's own Snapshot and candidate, with no optimizer context, only while the Gate is open", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node, deterministic, evaluated, criteria } = gatedNode(h, s);
      const snapshotId = seedSnapshot(h, s).id;
      const otherSnapshotId = seedSnapshot(h, s, "integration").id;
      const worker = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, patternPosition: { kind: "single" } });
      const candidate = seedArtifact(h, s, "candidate", { invocationId: worker.id });
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [candidate.id] });
      const evaluator = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: null, gateId: gate.id });
      const runtime = { runId: s.run.id, planNodeId: node.id, gateId: gate.id, subject: { kind: "acceptance_criterion" as const, acceptanceCriterionId: deterministic.id }, context: null, snapshotId, verdict: "pass" as const, evidence: [{ kind: "snapshot" as const, snapshotId }], producedBy: { kind: "runtime" as const }, artifactIds: [candidate.id] };
      const recorded = h.stores.evaluations.record(runtime);
      expect(recorded).toMatchObject({ gateId: gate.id, context: null, snapshotId, artifactIds: [candidate.id] });
      expect(() => h.stores.evaluations.record(runtime)).toThrow(ConflictError);
      expect(() => cloneRow(h, "evaluations", recorded.id, { id: "'eval_000000000000000000000000'" })).toThrow(/UNIQUE constraint failed: evaluations\.gate_id, evaluations\.subject_criterion_id/);
      expect(() => cloneRow(h, "evaluations", recorded.id, { id: "'eval_000000000000000000000001'", subject_criterion_id: `'${evaluated.id}'`, context: `'{"kind":"optimizer_criterion","round":1,"maxRounds":2}'` })).toThrow(/evaluations_optimizer_shape|evaluations_gate_shape/);
      expect(() => h.stores.evaluations.record({ ...runtime, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, snapshotId: otherSnapshotId })).toThrow(/Snapshot/);
      expect(() => h.stores.evaluations.record({ ...runtime, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, artifactIds: [] })).toThrow(/candidate/);
      expect(() => h.stores.evaluations.record({ ...runtime, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 } })).toThrow(ValidationError);
      const foreignNode = gatedNode(h, s);
      const foreignGate = h.stores.gates.open({ runId: s.run.id, planNodeId: foreignNode.node.id, kind: "node_exit", acceptanceCriterionIds: foreignNode.criteria, snapshotId, candidateArtifactIds: [] });
      const foreign = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: foreignNode.node.id, patternPosition: null, gateId: foreignGate.id });
      expect(() => h.stores.evaluations.record({ ...runtime, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, producedBy: { kind: "evaluator", invocationId: foreign.id, agentDefinitionRevisionId: foreign.agentDefinitionRevisionId } })).toThrow(/Gate/);
      const verdict = h.stores.evaluations.record({ ...runtime, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, producedBy: { kind: "evaluator", invocationId: evaluator.id, agentDefinitionRevisionId: evaluator.agentDefinitionRevisionId } });
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => e.id).sort()).toEqual([recorded.id, verdict.id].sort());
      h.stores.gates.close(gate.id, "passed");
      expect(() => h.stores.evaluations.record({ ...runtime, subject: { kind: "rubric", rubric: "late" } })).toThrow(/is passed/);
    } finally {
      h.close();
    }
  });

  it("creates one runtime-owned remediation Task per failed Gate on the Gate's own node, never for an open or passed Gate", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node, criteria } = gatedNode(h, s);
      const snapshotId = seedSnapshot(h, s).id;
      const other = seedWorkerNode(h, s);
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [] });
      const task = (overrides: Record<string, unknown>) => h.stores.tasks.create({ runId: s.run.id, planNodeId: node.id, origin: "runtime", gateId: gate.id, subject: "Remediate", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null, ...overrides } as never);
      expect(() => task({})).toThrow(/failed/);
      h.stores.gates.close(gate.id, "failed", { kind: "criteria_failed", acceptanceCriterionIds: [criteria[0]!] });
      expect(() => task({ origin: "orchestrator" })).toThrow(ValidationError);
      expect(() => task({ planNodeId: other.id })).toThrow(/PlanNode|node/);
      expect(() => task({ planNodeId: null })).toThrow(ValidationError);
      const created = task({});
      expect(created).toMatchObject({ gateId: gate.id, origin: "runtime", planNodeId: node.id, status: "pending" });
      expect(h.stores.tasks.remediationTaskOf(gate.id)?.id).toBe(created.id);
      expect(() => task({})).toThrow(ConflictError);
      expect(() => cloneRow(h, "tasks", created.id, { id: "'task_000000000000000000000000'" })).toThrow(/UNIQUE constraint failed: tasks\.gate_id/);
      expect(() => cloneRow(h, "tasks", created.id, { id: "'task_000000000000000000000001'", plan_node_id: `'${other.id}'`, gate_id: `'${gate.id}'` })).toThrow(/addresses a failed gate of its own run/);
      expect(() => h.database.sqlite.prepare("UPDATE tasks SET gate_id = NULL WHERE id = ?").run(created.id)).toThrow(/immutable/);
      const passed = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [] });
      h.stores.gates.close(passed.id, "passed");
      expect(() => task({ gateId: passed.id })).toThrow(/failed/);
    } finally {
      h.close();
    }
  });

  it("bounds the Gate cycles of a node by the Run's policy at the store, and lets a Gate Evaluator hold no Task", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 1, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] } });
      const { node, criteria } = gatedNode(h, s);
      const snapshotId = seedSnapshot(h, s).id;
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [] });
      h.stores.gates.close(gate.id, "failed", { kind: "criteria_failed", acceptanceCriterionIds: [criteria[0]!] });
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: criteria, snapshotId, candidateArtifactIds: [] })).toThrow(/the Run permits 1/);
      expect(h.stores.gates.listByPlanNode(node.id)).toHaveLength(1);
      const t = seedRun(h);
      const gated = gatedNode(h, t);
      const open = h.stores.gates.open({ runId: t.run.id, planNodeId: gated.node.id, kind: "node_exit", acceptanceCriterionIds: gated.criteria, snapshotId: seedSnapshot(h, t).id, candidateArtifactIds: [] });
      const owned = h.stores.tasks.create({ runId: t.run.id, planNodeId: gated.node.id, origin: "orchestrator", subject: "work", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      expect(() => seedInvocation(h, t, { role: "evaluator", purpose: "evaluate", planNodeId: gated.node.id, patternPosition: null, gateId: open.id, taskIds: [owned.id] })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });
});
