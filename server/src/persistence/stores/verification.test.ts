import { ConflictError, IllegalTransitionError, InvariantViolationError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, operation, seedArtifact, seedInvocation, seedRun, seedSnapshot, seedWorkerNode, seedRunCompletionGate, seedRequirements } from "../test-support.ts";

describe("evaluations and gates", () => {
  it("opens node_exit Gates on pattern nodes only and closes them once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const snapshotId = seedSnapshot(h, s).id;
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: s.root.id, kind: "node_exit", acceptanceCriterionIds: [], snapshotId, candidateArtifactIds: [] });
      expect(gate).toMatchObject({ status: "open", ordinal: 1, snapshotId, candidateArtifactIds: [], failure: null });
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: null, kind: "node_exit", acceptanceCriterionIds: [], snapshotId, candidateArtifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: s.root.id, kind: "node_exit", acceptanceCriterionIds: [], snapshotId: null, candidateArtifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: s.root.id, kind: "run_completion", acceptanceCriterionIds: [], snapshotId: null, candidateArtifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.gates.close(gate.id, "failed")).toThrow(InvariantViolationError);
      const passed = h.stores.gates.close(gate.id, "passed");
      expect(passed.closedAt).not.toBeNull();
      expect(() => h.stores.gates.close(gate.id, "failed")).toThrow(IllegalTransitionError);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET kind = 'run_completion', plan_node_id = NULL WHERE id = ?").run(gate.id)).toThrow(/never changes again/);
    } finally {
      h.close();
    }
  });

  it("appends Evaluations from the runtime or an Evaluator that did not produce the judged Artifact", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const worker = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: seedWorkerNode(h, s).id });
      const produced = seedArtifact(h, s, "judge me", { invocationId: worker.id });
      const { revision, leafIds } = seedRequirements(h, s, 1);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "evaluated", question: "Is it good?", rubric: null } });
      // A run_completion Gate judges exactly its criteria on its pinned Snapshot and candidate; the Evaluator judges the candidate.
      const gate = seedRunCompletionGate(h, s, { acceptanceCriterionIds: [criterion.id], candidateArtifactIds: [produced.id] }).gate;
      const evaluator = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", gateId: gate.id });
      const selfProduced = seedArtifact(h, s, "mine", { invocationId: evaluator.id });
      const input = { runId: s.run.id, planNodeId: null, gateId: gate.id, subject: { kind: "acceptance_criterion" as const, acceptanceCriterionId: criterion.id }, context: null, snapshotId: gate.snapshotId, verdict: "pass" as const, evidence: [{ kind: "artifact" as const, artifactId: produced.id }], producedBy: { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: evaluator.agentDefinitionRevisionId }, artifactIds: [produced.id] };
      const evaluation = h.stores.evaluations.record(input);
      expect(h.stores.evaluations.listByGate(gate.id)).toEqual([evaluation]);
      expect(() => h.stores.evaluations.record({ ...input, artifactIds: [selfProduced.id] })).toThrow(/cannot evaluate it/);
      expect(() => h.stores.evaluations.record({ ...input, producedBy: { kind: "evaluator", invocationId: worker.id, agentDefinitionRevisionId: s.definition.id } })).toThrow(/not an Evaluator/);
      expect(() => h.stores.evaluations.record({ ...input, verdict: "maybe" as never })).toThrow(ValidationError);
      h.stores.gates.close(gate.id, "failed", { kind: "evaluator_failed", invocationId: evaluator.id });
      expect(h.stores.gates.get(gate.id)).toMatchObject({ status: "failed", failure: { kind: "evaluator_failed", invocationId: evaluator.id } });
      expect(() => h.stores.evaluations.record({ ...input, producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(InvariantViolationError);
      expect(() => h.database.sqlite.prepare("DELETE FROM evaluations").run()).toThrow(/append-only/);
    } finally {
      h.close();
    }
  });
});

describe("optimizer round Evaluations", () => {
  /** An inline evaluator_optimizer node of the seeded Run with one deterministic and one evaluated Gate criterion. */
  function optimizer(h: ReturnType<typeof openHarness>, s: ReturnType<typeof seedRun>) {
    const revision = h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: h.ctx.ids("requirement"), parentId: null, composition: null, statement: "works", position: 0, acceptanceCriterionIds: [] }] });
    const requirementId = revision.tree[0]!.id;
    const deterministic = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
    const evaluated = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "evaluated", question: "correct?", rubric: null } });
    const node = seedWorkerNode(h, s, "single", {
      gateAcceptanceCriterionIds: [deterministic.id, evaluated.id],
      shape: { pattern: "evaluator_optimizer", producer: operation(s.definition.id, "producer"), evaluator: operation(s.definition.id, "judge", "evaluator"), maxRounds: 2, round: null },
      pattern: "evaluator_optimizer",
    } as never);
    const snapshot = seedSnapshot(h, s);
    const worker = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id, patternPosition: { kind: "producer_round", round: 1, maxRounds: 2 } });
    const evaluator = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate", planNodeId: node.id, patternPosition: { kind: "evaluator_round", round: 1, maxRounds: 2 } });
    const candidate = seedArtifact(h, s, "candidate", { invocationId: worker.id });
    return { node, deterministic, evaluated, snapshot, worker, evaluator, candidate };
  }
  const verdict = (round: number) => ({ subject: { kind: "optimizer_round" as const }, context: { kind: "optimizer_verdict" as const, round, maxRounds: 2 } });

  it("records one verdict per node and round and one Evaluation per node, round, and criterion, at the store and at the database, persisting the Snapshot and judged Artifacts exactly", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node, deterministic, evaluated, snapshot, evaluator, candidate } = optimizer(h, s);
      const common = { runId: s.run.id, planNodeId: node.id, gateId: null, evidence: [], artifactIds: [candidate.id], snapshotId: snapshot.id };
      const check = h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: deterministic.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "pass", producedBy: { kind: "runtime" } });
      expect(h.stores.evaluations.get(check.id)).toEqual(check);
      expect(check).toMatchObject({ snapshotId: snapshot.id, artifactIds: [candidate.id], context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 } });
      // The same criterion in the same round is refused; the next round accepts it; another criterion of the round is fine.
      expect(() => h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: deterministic.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "fail", producedBy: { kind: "runtime" } })).toThrow(/already evaluated/);
      h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "pass", producedBy: { kind: "evaluator", invocationId: evaluator.id, agentDefinitionRevisionId: s.definition.id } });
      h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: deterministic.id }, context: { kind: "optimizer_criterion", round: 2, maxRounds: 2 }, verdict: "pass", producedBy: { kind: "runtime" } });
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(node.id, 1).map((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId)).toEqual([deterministic.id, evaluated.id].sort());
      // One overall verdict per round; a second is a conflict at the store and a unique-index violation at the database.
      const first = h.stores.evaluations.record({ ...common, ...verdict(1), verdict: "fail", producedBy: { kind: "runtime" } });
      expect(h.stores.evaluations.optimizerVerdictOf(node.id, 1)).toEqual(first);
      expect(() => h.stores.evaluations.record({ ...common, ...verdict(1), verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(ConflictError);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO evaluations (id, run_id, plan_node_id, gate_id, subject, context, verdict, evidence, produced_by, artifact_ids, snapshot_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'pass', '[]', ?, '[]', ?, ?)")
          .run("eval_" + "1".repeat(24), s.run.id, node.id, JSON.stringify({ kind: "optimizer_round" }), JSON.stringify({ kind: "optimizer_verdict", round: 1, maxRounds: 2 }), JSON.stringify({ kind: "runtime" }), snapshot.id, "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: evaluations.plan_node_id, evaluations.context_round/);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO evaluations (id, run_id, plan_node_id, gate_id, subject, context, verdict, evidence, produced_by, artifact_ids, snapshot_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'pass', '[]', ?, '[]', ?, ?)")
          .run("eval_" + "2".repeat(24), s.run.id, node.id, JSON.stringify({ kind: "acceptance_criterion", acceptanceCriterionId: deterministic.id }), JSON.stringify({ kind: "optimizer_criterion", round: 1, maxRounds: 2 }), JSON.stringify({ kind: "runtime" }), snapshot.id, "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: evaluations.plan_node_id, evaluations.context_round, evaluations.subject_criterion_id/);
      // The database also refuses an optimizer row without a Snapshot or with a mismatched subject.
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO evaluations (id, run_id, plan_node_id, gate_id, subject, context, verdict, evidence, produced_by, artifact_ids, snapshot_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'pass', '[]', ?, '[]', NULL, ?)")
          .run("eval_" + "3".repeat(24), s.run.id, node.id, JSON.stringify({ kind: "optimizer_round" }), JSON.stringify({ kind: "optimizer_verdict", round: 2, maxRounds: 2 }), JSON.stringify({ kind: "runtime" }), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/CHECK constraint failed: evaluations_optimizer_shape/);
      const second = h.stores.evaluations.record({ ...common, ...verdict(2), verdict: "pass", producedBy: { kind: "evaluator", invocationId: evaluator.id, agentDefinitionRevisionId: s.definition.id } });
      expect(h.stores.evaluations.optimizerVerdictsOfNode(node.id).map((e) => [e.context!.round, e.verdict])).toEqual([[1, "fail"], [2, "pass"]]);
      expect([...h.stores.evaluations.optimizerVerdictsOf(s.run.id).entries()]).toEqual([[node.id, [first, second]]]);
      // Reads return exactly the domain object: the generated index columns never surface.
      expect(Object.keys(h.stores.evaluations.get(second.id)).sort()).toEqual(["artifactIds", "context", "createdAt", "evidence", "gateId", "id", "planNodeId", "producedBy", "runId", "snapshotId", "subject", "verdict"]);
    } finally {
      h.close();
    }
  });

  it("refuses an optimizer Evaluation on the wrong node or round, a foreign Snapshot, a criterion the node does not gate, a deterministic criterion from an Evaluator, and an evaluated one from the runtime", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { node, deterministic, evaluated, snapshot, evaluator } = optimizer(h, s);
      const other = seedRun(h);
      const common = { runId: s.run.id, planNodeId: node.id, gateId: null, evidence: [], artifactIds: [], snapshotId: snapshot.id };
      const byEvaluator = { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: s.definition.id };
      expect(() => h.stores.evaluations.record({ ...common, planNodeId: seedWorkerNode(h, s).id, ...verdict(1), verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/not an evaluator_optimizer node/);
      expect(() => h.stores.evaluations.record({ ...common, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", round: 1, maxRounds: 3 }, verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/has 2 rounds, not 3/);
      expect(() => h.stores.evaluations.record({ ...common, ...verdict(1), snapshotId: seedSnapshot(h, other).id, verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/another Workspace/);
      const foreign = h.stores.requirements.createAcceptanceCriterion({ conversationId: other.conversation.id, requirementId: null, requirementRevisionId: null, taskId: h.stores.tasks.create({ runId: other.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }).id, check: { kind: "deterministic", command: "x", expectedExitCode: 0 } });
      expect(() => h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: foreign.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/not a Gate criterion/);
      expect(() => h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: deterministic.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "pass", producedBy: byEvaluator })).toThrow(/checked by the runtime/);
      expect(() => h.stores.evaluations.record({ ...common, subject: { kind: "acceptance_criterion", acceptanceCriterionId: evaluated.id }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/judged by an Evaluator/);
      // A context without a Plan Node, and an evaluate-only node's fixed round, are enforced too.
      expect(() => h.stores.evaluations.record({ ...common, planNodeId: null, ...verdict(1), verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(ValidationError);
      const evaluateOnly = seedWorkerNode(h, s, "single", { shape: { pattern: "evaluator_optimizer", producer: null, evaluator: operation(s.definition.id, "judge", "evaluator"), maxRounds: 2, round: 2 }, pattern: "evaluator_optimizer" } as never);
      expect(() => h.stores.evaluations.record({ ...common, planNodeId: evaluateOnly.id, ...verdict(1), verdict: "pass", producedBy: { kind: "runtime" } })).toThrow(/evaluates round 2, not 1/);
      expect(h.stores.evaluations.record({ ...common, planNodeId: evaluateOnly.id, ...verdict(2), verdict: "pass", producedBy: { kind: "runtime" } }).context).toEqual({ kind: "optimizer_verdict", round: 2, maxRounds: 2 });
      expect(h.stores.evaluations.listByPlanNode(node.id)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("snapshots, changesets, publications", () => {
  it("records immutable Snapshots matching the Workspace kind", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const snapshot = seedSnapshot(h, s);
      expect(h.stores.snapshots.get(snapshot.id).identity).toEqual({ kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) });
      expect(() => h.stores.snapshots.record({ workspaceId: s.workspace.id, runId: s.run.id, identity: { kind: "directory", contentDigest: "c".repeat(64) }, reason: "run_start" })).toThrow(InvariantViolationError);
      expect(() => h.database.sqlite.prepare("UPDATE snapshots SET commit_id = ? WHERE id = ?").run("f".repeat(40), snapshot.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("records Changesets between Snapshots with a diff Artifact and integrates or conflicts them", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = seedSnapshot(h, s);
      const after = seedSnapshot(h, s, "integration");
      const diff = seedArtifact(h, s, "diff --git");
      const changeset = h.stores.changesets.record({ runId: s.run.id, invocationId: null, beforeSnapshotId: before.id, afterSnapshotId: after.id, diffArtifactId: diff.id });
      expect(changeset.integrationStatus).toBe("pending");
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: null, origin: "runtime", subject: "resolve conflict", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const conflicted = h.stores.changesets.transition(changeset.id, { to: "conflict", conflictTaskId: task.id });
      expect(conflicted.conflictTaskId).toBe(task.id);
      const integrated = h.stores.changesets.transition(changeset.id, { to: "integrated", integratedSnapshotId: after.id });
      expect(integrated.conflictTaskId).toBeNull();
      expect(integrated.integratedAt).not.toBeNull();
      expect(() => h.stores.changesets.transition(changeset.id, { to: "conflict", conflictTaskId: task.id })).toThrow(IllegalTransitionError);
      const other = seedRun(h);
      const foreignDiff = seedArtifact(h, other);
      expect(() => h.stores.changesets.record({ runId: s.run.id, invocationId: null, beforeSnapshotId: before.id, afterSnapshotId: after.id, diffArtifactId: foreignDiff.id })).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });

  it("publishes only a completed Run under an operator-resolved publish Decision", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = seedSnapshot(h, s);
      const final = seedSnapshot(h, s, "run_completion");
      const diff = seedArtifact(h, s, "final diff");
      const changeset = h.stores.changesets.record({ runId: s.run.id, invocationId: null, beforeSnapshotId: before.id, afterSnapshotId: final.id, diffArtifactId: diff.id });
      const decision = h.stores.decisions.request({ conversationId: s.conversation.id, runId: s.run.id, kind: "publish", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "Publish?", options: [{ id: "yes", label: "Yes", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      const input = { runId: s.run.id, decisionId: decision.id, changesetId: changeset.id, targetBeforeSnapshotId: before.id, targetAfterSnapshotId: final.id, strategy: { kind: "fast_forward" as const }, outcome: "succeeded" as const, failureReason: null, artifactId: null };
      expect(() => h.stores.publications.record(input)).toThrow(ConflictError);
      h.stores.runs.transition(s.run.id, { to: "verifying" });
      h.stores.runs.transition(s.run.id, { to: "awaiting_signoff" });
      h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: final.id });
      expect(() => h.stores.publications.record(input)).toThrow(/not resolved by the operator/);
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "yes", rationale: null, artifactIds: [] });
      const publication = h.stores.publications.record(input);
      expect(publication.outcome).toBe("succeeded");
      expect(h.ctx.journal.read({ runId: s.run.id, type: "run.published" })).toHaveLength(1);
      const failed = h.stores.publications.record({ ...input, outcome: "failed", failureReason: "target moved", targetAfterSnapshotId: null, strategy: { kind: "merge" } });
      expect(failed.targetAfterSnapshotId).toBeNull();
      expect(h.ctx.journal.read({ runId: s.run.id, type: "run.publish_failed" })).toHaveLength(1);
      expect(() => h.stores.publications.record({ ...input, outcome: "failed", failureReason: null })).toThrow(ValidationError);
      expect(h.stores.runs.get(s.run.id).status).toBe("completed");
    } finally {
      h.close();
    }
  });
});

describe("agent definitions", () => {
  it("keeps one revision per content hash under a stable logical id and never edits it", () => {
    const h = openHarness();
    try {
      const definition = h.stores.agents.ensureDefinition("worker");
      expect(h.stores.agents.ensureDefinition("worker").id).toBe(definition.id);
      const content = {
        provenance: { kind: "builtin" as const },
        modelPolicy: { model: "claude-fable-5", effort: "high" as const, maxContextOccupancy: 0.7 },
        instructions: "Do work.",
        capabilities: { tools: ["read", "write"], mcpServers: [] },
        toolPolicy: { read: "allowed" as const, write: "approval_required" as const },
        defaultLimits: { allocation: { costUsd: 1, tokens: 10_000, attempts: 2 }, maxWallClockMs: null },
      };
      const r1 = h.stores.agents.appendRevision(definition.id, content);
      const same = h.stores.agents.appendRevision(definition.id, { ...content, toolPolicy: { write: "approval_required", read: "allowed" } });
      expect(same.id).toBe(r1.id);
      const r2 = h.stores.agents.appendRevision(definition.id, { ...content, instructions: "Do work carefully." });
      expect(r2.id).not.toBe(r1.id);
      expect(r2.contentHash).not.toBe(r1.contentHash);
      expect(h.stores.agents.listRevisions(definition.id).map((r) => r.id)).toEqual([r1.id, r2.id]);
      expect(() => h.stores.agents.appendRevision(definition.id, { ...content, toolPolicy: { shell: "allowed" } })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE agent_definition_revisions SET instructions = 'x' WHERE id = ?").run(r1.id)).toThrow(/immutable/);
      const columns = (h.database.sqlite.prepare("PRAGMA table_info(agent_definition_revisions)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain("trusted");
    } finally {
      h.close();
    }
  });
});
