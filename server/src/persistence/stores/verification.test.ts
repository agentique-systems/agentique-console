import { ConflictError, IllegalTransitionError, InvariantViolationError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedInvocation, seedRun, seedSnapshot } from "../test-support.ts";

describe("evaluations and gates", () => {
  it("opens node_exit Gates on pattern nodes only and closes them once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: s.root.id, kind: "node_exit", acceptanceCriterionIds: [], snapshotId: null });
      expect(gate.status).toBe("open");
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: null, kind: "node_exit", acceptanceCriterionIds: [], snapshotId: null })).toThrow(ValidationError);
      expect(() => h.stores.gates.open({ runId: s.run.id, planNodeId: s.root.id, kind: "run_completion", acceptanceCriterionIds: [], snapshotId: null })).toThrow(ValidationError);
      const passed = h.stores.gates.close(gate.id, "passed");
      expect(passed.closedAt).not.toBeNull();
      expect(() => h.stores.gates.close(gate.id, "failed")).toThrow(IllegalTransitionError);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET kind = 'run_completion', plan_node_id = NULL WHERE id = ?").run(gate.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("appends Evaluations from the runtime or an Evaluator that did not produce the judged Artifact", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const gate = h.stores.gates.open({ runId: s.run.id, planNodeId: null, kind: "run_completion", acceptanceCriterionIds: [], snapshotId: null });
      const worker = seedInvocation(h, s, { role: "worker", purpose: "step" });
      const evaluator = seedInvocation(h, s, { role: "evaluator", purpose: "evaluate" });
      const produced = seedArtifact(h, s, "judge me", { invocationId: worker.id });
      const selfProduced = seedArtifact(h, s, "mine", { invocationId: evaluator.id });
      const input = { runId: s.run.id, planNodeId: null, gateId: gate.id, subject: { kind: "rubric" as const, rubric: "quality" }, verdict: "pass" as const, evidence: [{ kind: "artifact" as const, artifactId: produced.id }], producedBy: { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: s.definition.id }, artifactIds: [produced.id] };
      const evaluation = h.stores.evaluations.record(input);
      expect(h.stores.evaluations.listByGate(gate.id)).toEqual([evaluation]);
      expect(() => h.stores.evaluations.record({ ...input, artifactIds: [selfProduced.id] })).toThrow(/cannot evaluate it/);
      expect(() => h.stores.evaluations.record({ ...input, producedBy: { kind: "evaluator", invocationId: worker.id, agentDefinitionRevisionId: s.definition.id } })).toThrow(/not an Evaluator/);
      expect(() => h.stores.evaluations.record({ ...input, verdict: "maybe" as never })).toThrow(ValidationError);
      h.stores.gates.close(gate.id, "failed");
      expect(() => h.stores.evaluations.record({ ...input, producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(InvariantViolationError);
      expect(() => h.database.sqlite.prepare("DELETE FROM evaluations").run()).toThrow(/append-only/);
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
