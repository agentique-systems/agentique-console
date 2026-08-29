import { ConflictError, IllegalTransitionError, InvariantViolationError, ValidationError, type TaskInput } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, patternNode, seedArtifact, seedRequirements, seedRun, type Harness, type Seeded } from "../test-support.ts";

function taskInput(s: Seeded, overrides: Partial<TaskInput> = {}): TaskInput {
  return { runId: s.run.id, planNodeId: null, origin: "orchestrator", subject: "work", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null, ...overrides };
}

function runningTask(h: Harness, s: Seeded) {
  const task = h.stores.tasks.create(taskInput(s));
  h.stores.tasks.transition(task.id, { to: "ready" });
  const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, taskIds: [task.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
  return { task: h.stores.tasks.transition(task.id, { to: "running", invocationId: invocation.id }), invocation };
}

describe("tasks", () => {
  it("creates pending Tasks and dependencies, rejecting cycles and cross-Run edges", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const a = h.stores.tasks.create(taskInput(s, { subject: "a" }));
      const b = h.stores.tasks.create(taskInput(s, { subject: "b" }));
      const c = h.stores.tasks.create(taskInput(s, { subject: "c" }));
      expect(a.status).toBe("pending");
      h.stores.tasks.addDependency(b.id, a.id);
      h.stores.tasks.addDependency(c.id, b.id);
      expect(() => h.stores.tasks.addDependency(a.id, c.id)).toThrow(/cycle/);
      expect(() => h.stores.tasks.addDependency(a.id, a.id)).toThrow(ValidationError);
      expect(() => h.stores.tasks.addDependency(b.id, a.id)).toThrow(ConflictError);
      const other = seedRun(h);
      const foreign = h.stores.tasks.create(taskInput(other));
      expect(() => h.stores.tasks.addDependency(a.id, foreign.id)).toThrow(InvariantViolationError);
      expect(h.stores.tasks.dependencies(s.run.id)).toHaveLength(2);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "task.dependency_added" })).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("becomes ready only when every dependency is completed", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const a = h.stores.tasks.create(taskInput(s));
      const b = h.stores.tasks.create(taskInput(s));
      h.stores.tasks.addDependency(b.id, a.id);
      expect(() => h.stores.tasks.transition(b.id, { to: "ready" })).toThrow(/not completed/);
      h.stores.tasks.transition(a.id, { to: "ready" });
      const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, taskIds: [a.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      h.stores.tasks.transition(a.id, { to: "running", invocationId: invocation.id });
      expect(() => h.stores.tasks.transition(a.id, { to: "completed", evidence: [], outputArtifactIds: [] })).toThrow(ValidationError);
      h.stores.tasks.transition(a.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test/log" }], outputArtifactIds: [] });
      expect(h.stores.tasks.transition(b.id, { to: "ready" }).status).toBe("ready");
    } finally {
      h.close();
    }
  });

  it("blocks on a failed dependency instead of cancelling, and links replacements", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { task: a } = runningTask(h, s);
      const b = h.stores.tasks.create(taskInput(s));
      h.stores.tasks.addDependency(b.id, a.id);
      const failed = h.stores.tasks.transition(a.id, { to: "failed", failureReason: "attempts_exhausted" });
      expect(failed.endedAt).not.toBeNull();
      expect(() => h.stores.tasks.transition(a.id, { to: "cancelled" })).toThrow(IllegalTransitionError);
      expect(h.stores.tasks.get(a.id).status).toBe("failed");
      expect(h.stores.tasks.get(b.id).status).toBe("pending");
      const blocked = h.stores.tasks.transition(b.id, { to: "blocked", blockReason: { kind: "dependency_failed", taskId: a.id } });
      expect(blocked.blockReason).toEqual({ kind: "dependency_failed", taskId: a.id });
      expect(() => h.stores.tasks.transition(b.id, { to: "blocked", blockReason: { kind: "dependency_failed", taskId: b.id } })).toThrow(IllegalTransitionError);
      const replacement = h.stores.tasks.create(taskInput(s, { replacesTaskId: a.id }));
      expect(replacement.replacesTaskId).toBe(a.id);
      expect(() => h.stores.tasks.create(taskInput(s, { replacesTaskId: b.id }))).not.toThrow();
      const pending = h.stores.tasks.create(taskInput(s));
      expect(() => h.stores.tasks.create(taskInput(s, { replacesTaskId: pending.id }))).toThrow(ConflictError);
      h.stores.tasks.transition(b.id, { to: "cancelled" });
      expect(h.stores.tasks.get(b.id).status).toBe("cancelled");
    } finally {
      h.close();
    }
  });

  it("blocked returns to ready, and completed Tasks carry Evidence and outputs of their Run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { task } = runningTask(h, s);
      h.stores.tasks.transition(task.id, { to: "blocked", blockReason: { kind: "input", description: "needs data" } });
      const ready = h.stores.tasks.transition(task.id, { to: "ready" });
      expect(ready.invocationId).toBeNull();
      const other = seedRun(h);
      const foreignArtifact = seedArtifact(h, other);
      const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, taskIds: [task.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      h.stores.tasks.transition(task.id, { to: "running", invocationId: invocation.id });
      expect(() => h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "artifact", artifactId: foreignArtifact.id }], outputArtifactIds: [foreignArtifact.id] })).toThrow(InvariantViolationError);
      const artifact = seedArtifact(h, s);
      const completed = h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "artifact", artifactId: artifact.id }], outputArtifactIds: [artifact.id] });
      expect(completed.outputArtifactIds).toEqual([artifact.id]);
      expect(() => h.database.sqlite.prepare("UPDATE tasks SET subject = 'edited' WHERE id = ?").run(task.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("a Coordinator-proposed Task must reference a non-empty subset of its node's exact pinned scope", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s, 3);
      const node = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, pattern: "coordinator_worker", sourcePath: "1", agents: { coordinator: s.definition.id, worker: s.definition.id } });
      h.stores.plans.insertCompiledGraph({ runId: s.run.id, revisionNumber: 1, nodes: [node], edges: [], requirements: leafIds.slice(0, 2).map((requirementId) => ({ planNodeId: node.id, requirementId, requirementRevisionId: revision.id })) });
      const proposal = (requirementIds: string[], requirementRevisionId = revision.id) =>
        h.stores.tasks.create(taskInput(s, { origin: "coordinator", planNodeId: node.id, requirementIds: requirementIds as never, requirementRevisionId }));
      expect(proposal([leafIds[0]!]).planNodeId).toBe(node.id);
      expect(() => proposal([leafIds[2]!])).toThrow(/outside the scope/);
      expect(() => proposal([leafIds[0]!, leafIds[2]!])).toThrow(/outside the scope/);
      expect(() => proposal([])).toThrow(ValidationError);
      const later = h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: leafIds.map((id, i) => ({ id, parentId: null, composition: null, statement: `l${i}`, position: i, acceptanceCriterionIds: [] })) });
      expect(() => proposal([leafIds[0]!], later.id)).toThrow(/outside the scope/);
      expect(() => proposal([leafIds[0]!], "reqr_000000000000000000000000" as never)).toThrow(/outside the scope/);
    } finally {
      h.close();
    }
  });
});
