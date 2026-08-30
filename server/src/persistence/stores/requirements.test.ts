import { ConflictError, IllegalTransitionError, InvariantViolationError, ValidationError, type DecisionRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedRequirements, seedRun, seedSnapshot, seedWorkerNode, type Harness, type Seeded, seedRunCompletionGate } from "../test-support.ts";

function waiverRequest(s: Seeded, requirementId: string, overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    conversationId: s.conversation.id,
    runId: s.run.id,
    kind: "requirement_waiver",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "runtime" },
    question: "Waive?",
    options: [
      { id: "waive", label: "Waive", description: null },
      { id: "keep", label: "Keep", description: null },
    ],
    recommendedOptionId: "waive",
    rationale: "cannot be met",
    affects: { requirementIds: [requirementId as never], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
    ...overrides,
  };
}

function openGate(h: Harness, s: Seeded, acceptanceCriterionIds: string[] = []) {
  return seedRunCompletionGate(h, s, { acceptanceCriterionIds }).gate;
}

describe("requirement revisions", () => {
  it("creates numbered immutable revisions, opens new Requirements, and retires removed ones", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, rootId, leafIds } = seedRequirements(h, s, 2);
      expect(revision.number).toBe(1);
      expect(h.stores.requirements.listByConversation(s.conversation.id).map((r) => r.status)).toEqual(["open", "open", "open"]);
      const second = h.stores.requirements.createRevision({
        conversationId: s.conversation.id,
        approvedByDecisionId: null,
        tree: [
          { id: rootId, parentId: null, composition: "all", statement: "root", position: 0, acceptanceCriterionIds: [] },
          { id: leafIds[0]!, parentId: rootId, composition: null, statement: "leaf 1 reworded", position: 0, acceptanceCriterionIds: [] },
        ],
      });
      expect(second.number).toBe(2);
      const retired = h.stores.requirements.get(leafIds[1]!);
      expect(retired.status).toBe("retired");
      expect(retired.retiredInRevisionId).toBe(second.id);
      expect(h.stores.requirements.history(leafIds[1]!).map((c) => [c.from, c.to])).toEqual([["open", "retired"]]);
      expect(h.stores.requirements.currentRevision(s.conversation.id)?.id).toBe(second.id);
      expect(() => h.database.sqlite.prepare("UPDATE requirement_revisions SET number = 5 WHERE id = ?").run(revision.id)).toThrow(/immutable/);
      expect(() =>
        h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: leafIds[1]!, parentId: null, composition: null, statement: "back", position: 0, acceptanceCriterionIds: [] }] }),
      ).toThrow(/retired/);
      expect(() => h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: rootId, parentId: rootId, composition: "all", statement: "x", position: 0, acceptanceCriterionIds: [] }] })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });
});

describe("requirement status", () => {
  it("is never satisfied by Task completion or an agent claim", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { leafIds } = seedRequirements(h, s);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: null, origin: "orchestrator", subject: "do", requirementIds: [leafIds[0]!], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      h.stores.tasks.transition(task.id, { to: "ready" });
      const workers = seedWorkerNode(h, s, "coordinator_worker");
      const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: workers.id, role: "worker", purpose: "task", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id }, taskIds: [task.id], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      h.stores.tasks.transition(task.id, { to: "running", invocationId: invocation.id });
      h.stores.tasks.transition(task.id, { to: "completed", evidence: [{ kind: "url", url: "https://example.test" }], outputArtifactIds: [] });
      expect(h.stores.requirements.get(leafIds[0]!).status).toBe("open");
      expect(h.stores.requirements.history(leafIds[0]!)).toEqual([]);
      expect(() =>
        h.stores.requirements.recordStatusChange({ requirementId: leafIds[0]!, runId: s.run.id, to: "satisfied", actor: "orchestrator", evidence: [], gateId: null, decisionId: null, rationale: "I did it" }),
      ).toThrow(ValidationError);
      expect(h.stores.requirements.get(leafIds[0]!).status).toBe("open");
    } finally {
      h.close();
    }
  });

  it("becomes satisfied only from a Gate with Evaluation Evidence, keeping full history", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const gate = openGate(h, s, [criterion.id]);
      const evaluation = h.stores.evaluations.record({ context: null, snapshotId: gate.snapshotId, runId: s.run.id, planNodeId: null, gateId: gate.id, subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion.id }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] });
      const change = h.stores.requirements.recordStatusChange({ requirementId: leafIds[0]!, runId: s.run.id, to: "satisfied", actor: "runtime", evidence: [{ kind: "evaluation", evaluationId: evaluation.id }], gateId: gate.id, decisionId: null, rationale: null });
      expect(change.from).toBe("open");
      expect(h.stores.requirements.get(leafIds[0]!).status).toBe("satisfied");
      h.stores.requirements.recordStatusChange({ requirementId: leafIds[0]!, runId: s.run.id, to: "violated", actor: "runtime", evidence: [{ kind: "evaluation", evaluationId: evaluation.id }], gateId: gate.id, decisionId: null, rationale: null });
      expect(h.stores.requirements.history(leafIds[0]!).map((c) => c.to)).toEqual(["satisfied", "violated"]);
      expect(() => h.database.sqlite.prepare("DELETE FROM requirement_status_changes").run()).toThrow(/append-only/);
      expect(h.ctx.journal.read({ conversationId: s.conversation.id, type: "requirement.status_changed" })).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

describe("requirement waivers", () => {
  it("is reached only through an operator-resolved requirement_waiver Decision naming the Requirement", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { leafIds } = seedRequirements(h, s);
      const target = leafIds[0]!;
      const attempt = (decisionId: string | null, actor: "operator" | "runtime" | "orchestrator" = "operator") =>
        h.stores.requirements.recordStatusChange({ requirementId: target, runId: s.run.id, to: "waived", actor, evidence: [], gateId: null, decisionId: decisionId as never, rationale: "accepted" });

      expect(() => attempt(null)).toThrow(ValidationError);
      const openWaiver = h.stores.decisions.request(waiverRequest(s, target));
      expect(() => attempt(openWaiver.id)).toThrow(/not been resolved by the operator/);
      // A non-waiver Decision, even resolved by the operator, does not waive.
      const choice = h.stores.decisions.request(waiverRequest(s, target, { kind: "operator_choice", affects: { requirementIds: [], taskIds: [], planNodeIds: [] } }));
      h.stores.decisions.resolve(choice.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "x", artifactIds: [] });
      expect(() => attempt(choice.id)).toThrow(/not a requirement_waiver/);
      // A waiver for another Requirement does not waive this one.
      const otherWaiver = h.stores.decisions.request(waiverRequest(s, leafIds[1]!));
      h.stores.decisions.resolve(otherWaiver.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "x", artifactIds: [] });
      expect(() => attempt(otherWaiver.id)).toThrow(/does not name Requirement/);
      // No automatic or Orchestrator resolution of a waiver is possible.
      expect(() => h.stores.decisions.resolve(openWaiver.id, { resolvedBy: "orchestrator", chosenOptionId: "waive", rationale: "x", artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.decisions.resolve(openWaiver.id, { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "waive", rationale: "x", artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.stores.decisions.request(waiverRequest(s, target, { resolutionPolicy: "use_default_after_deadline", deadlineAt: "2026-02-01T00:00:00.000Z" }))).toThrow(ValidationError);
      expect(h.stores.requirements.get(target).status).toBe("open");
      // The operator resolves it; only then does the status change apply and link the Decision.
      h.stores.decisions.resolve(openWaiver.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "acceptable risk", artifactIds: [] });
      expect(() => attempt(openWaiver.id, "runtime")).toThrow(ValidationError);
      const change = attempt(openWaiver.id);
      expect(change.decisionId).toBe(openWaiver.id);
      expect(h.stores.requirements.get(target).status).toBe("waived");
      expect(h.ctx.journal.read({ conversationId: s.conversation.id, type: "decision.resolved" }).map((e) => e.actor)).toEqual(expect.arrayContaining([{ kind: "operator" }]));
    } finally {
      h.close();
    }
  });
});

describe("decisions", () => {
  it("records requests, resolutions with one decision.resolved Event each, and supersession by id", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const first = h.stores.decisions.request(waiverRequest(s, "req_000000000000000000000000" as never, { kind: "operator_choice", affects: { requirementIds: [], taskIds: [], planNodeIds: [s.root.id] }, resolutionPolicy: "use_default_after_deadline", deadlineAt: "2026-01-02T00:00:00.000Z" }));
      const resolved = h.stores.decisions.resolve(first.id, { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: "waive", rationale: null, artifactIds: [] });
      expect(resolved.status).toBe("resolved");
      expect(h.ctx.journal.read({ conversationId: s.conversation.id, type: "decision.resolved" })).toHaveLength(1);
      expect(() => h.stores.decisions.resolve(first.id, { resolvedBy: "operator", chosenOptionId: "keep", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      const second = h.stores.decisions.request(waiverRequest(s, "req_000000000000000000000000" as never, { kind: "operator_choice", affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, supersedesDecisionId: first.id }));
      expect(h.stores.decisions.get(first.id).status).toBe("superseded");
      expect(h.stores.decisions.get(first.id).supersededByDecisionId).toBe(second.id);
      expect(h.stores.decisions.get(second.id).supersedesDecisionId).toBe(first.id);
      expect(() => h.stores.decisions.request(waiverRequest(s, "req_000000000000000000000000" as never, { kind: "operator_choice", affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, supersedesDecisionId: first.id }))).toThrow(ConflictError);
      expect(h.stores.decisions.listOpen(s.conversation.id).map((d) => d.id)).toEqual([second.id]);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET question = 'edited' WHERE id = ?").run(first.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("rejects affected ids from another Conversation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const other = seedRun(h);
      const foreign = seedRequirements(h, other);
      expect(() => h.stores.decisions.request(waiverRequest(s, foreign.leafIds[0]!))).toThrow(InvariantViolationError);
      expect(() => h.stores.decisions.request(waiverRequest(s, "req_000000000000000000000000" as never, { kind: "operator_choice", affects: { requirementIds: [], taskIds: [], planNodeIds: [other.root.id] } }))).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });

  it("retired is terminal and requirement transitions follow the table", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { leafIds } = seedRequirements(h, s);
      h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: leafIds[0]!, parentId: null, composition: null, statement: "only", position: 0, acceptanceCriterionIds: [] }] });
      expect(() =>
        h.stores.requirements.recordStatusChange({ requirementId: leafIds[1]!, runId: null, to: "open", actor: "operator", evidence: [], gateId: null, decisionId: null, rationale: null }),
      ).toThrow(IllegalTransitionError);
      expect(() =>
        h.stores.requirements.recordStatusChange({ requirementId: leafIds[0]!, runId: null, to: "retired", actor: "operator", evidence: [], gateId: null, decisionId: null, rationale: null }),
      ).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });

  it("acceptance criteria attach to a pinned Requirement or a Task and are immutable", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      expect(h.stores.requirements.listAcceptanceCriteria({ requirementId: leafIds[0]! })).toEqual([criterion]);
      expect(() => h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: null, taskId: null, check: { kind: "evaluated", question: "ok?", rubric: null } })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE acceptance_criteria SET kind = 'evaluated' WHERE id = ?").run(criterion.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });
});
