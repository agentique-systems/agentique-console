/**
 * Result validation beyond shape (execution-model §6.3; invariant 9
 * canonical objects by id).
 */
import type { InvocationResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, operation, seedArtifact, seedInvocation, seedManifest, seedRun, seedSnapshot, seedWorkerNode, type Harness, type Seeded } from "../persistence/test-support.ts";
import { InvocationResultValidator, type ResultValidationContext } from "./result-validator.ts";

const base: InvocationResult = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null };

function context(h: Harness, s: Seeded, overrides: Partial<{ role: "orchestrator" | "worker" | "evaluator" | "coordinator"; purpose: "operator_input" | "step" | "task" | "evaluate" | "decompose"; taskIds: string[]; writes: boolean; changeset: ResultValidationContext["changeset"] }> = {}): ResultValidationContext {
  const role = overrides.role ?? "worker";
  const purpose = overrides.purpose ?? (role === "worker" ? "step" : role === "orchestrator" ? "operator_input" : role === "evaluator" ? "evaluate" : "decompose");
  const taskIds = (overrides.taskIds ?? []) as never[];
  // Each role sits at a position its node's shape defines: the Orchestrator and a Gate Evaluator on the root, a step on a single node, a Task or Coordinator turn on a coordinator_worker node.
  const node = role === "orchestrator" || role === "evaluator" ? s.root : role === "coordinator" || purpose === "task" ? seedWorkerNode(h, s, "coordinator_worker") : seedWorkerNode(h, s);
  const patternPosition = role === "orchestrator" ? { kind: "orchestrator" as const } : role === "evaluator" ? null : role === "coordinator" ? { kind: "coordinator_turn" as const } : purpose === "task" ? { kind: "worker_task" as const, taskId: taskIds[0]! } : { kind: "single" as const };
  const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: node.id, role, purpose, agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition, taskIds, allocation: { costUsd: 0.1, tokens: 100, attempts: 1 } });
  const manifest = seedManifest(h, s, invocation);
  return { run: h.stores.runs.get(s.run.id), invocation, manifest, writes: overrides.writes ?? false, changeset: overrides.changeset ?? null };
}

function codes(validator: InvocationResultValidator, candidate: unknown, ctx: ResultValidationContext): string[] {
  const outcome = validator.validate(candidate, ctx);
  return outcome.ok ? [] : outcome.violations.map((v) => `${v.code}${v.path === null ? "" : `@${v.path}`}`);
}

describe("InvocationResultValidator", () => {
  it("rejects malformed and missing results with bounded violations and accepts a well-formed one", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const validator = new InvocationResultValidator(h.stores);
      const ctx = context(h, s);
      expect(codes(validator, null, ctx)).toEqual(["malformed"]);
      expect(codes(validator, { status: "done" }, ctx)[0]).toMatch(/^malformed/);
      expect(codes(validator, { ...base, summary: "x".repeat(501) }, ctx)).toEqual(["malformed@summary"]);
      expect(codes(validator, { ...base, openItems: Array.from({ length: 11 }, () => "i") }, ctx)).toEqual(["malformed@openItems"]);
      expect(codes(validator, { ...base, status: "blocked" }, ctx)).toEqual(["malformed@blocker"]);
      expect(codes(validator, { ...base, blocker: "need a decision" }, ctx)).toEqual(["malformed@blocker"]);
      expect(codes(validator, { ...base, transcript: [] }, ctx)[0]).toMatch(/^malformed/);
      const outcome = validator.validate(base, ctx);
      expect(outcome).toEqual({ ok: true, result: base });
      // Violation lists are bounded.
      const many = { ...base, artifactIds: Array.from({ length: 30 }, (_, i) => `art_${i.toString(16).padStart(24, "0")}`) };
      const violations = validator.validate(many, ctx);
      expect(violations.ok).toBe(false);
      if (!violations.ok) expect(violations.violations).toHaveLength(20);
    } finally {
      h.close();
    }
  });

  it("checks every referenced Artifact, Task, Evidence, and Snapshot exists in this Run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const other = seedRun(h);
      const validator = new InvocationResultValidator(h.stores);
      const own = seedArtifact(h, s, "own");
      const foreign = seedArtifact(h, other, "foreign");
      const snapshot = seedSnapshot(h, s);
      const foreignSnapshot = seedSnapshot(h, other);
      const ctx = context(h, s);
      expect(codes(validator, { ...base, artifactIds: [own.id] }, ctx)).toEqual([]);
      expect(codes(validator, { ...base, artifactIds: [foreign.id, "art_000000000000000000000000"] }, ctx)).toEqual(["foreign_artifact@artifactIds.0", "unknown_artifact@artifactIds.1"]);
      expect(codes(validator, { ...base, evidence: [{ kind: "artifact", artifactId: foreign.id }, { kind: "command", command: "npm test", exitCode: 0, outputArtifactId: "art_000000000000000000000000" }, { kind: "evaluation", evaluationId: "eval_000000000000000000000000" }, { kind: "snapshot", snapshotId: foreignSnapshot.id }, { kind: "file", path: "README.md", snapshotId: snapshot.id }, { kind: "url", url: "https://example.test" }] }, ctx)).toEqual([
        "foreign_evidence_reference@evidence.0",
        "unknown_evidence_reference@evidence.1",
        "unknown_evidence_reference@evidence.2",
        "foreign_evidence_reference@evidence.3",
      ]);
      const foreignTask = h.stores.tasks.create({ runId: other.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      expect(codes(validator, { ...base, tasks: [{ taskId: foreignTask.id, status: "failed", evidence: [], blocker: null }, { taskId: "task_000000000000000000000000", status: "failed", evidence: [], blocker: null }] }, ctx)).toEqual(["foreign_task@tasks.0", "unknown_task@tasks.1"]);
    } finally {
      h.close();
    }
  });

  it("enforces role rules: assignment, Evidence and outputs on completed Tasks, no Task changes by Evaluators, runOutcome only for the Orchestrator", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const validator = new InvocationResultValidator(h.stores);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: s.root.id, origin: "orchestrator", subject: "implement", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: ["patch"], replacesTaskId: null });
      const otherTask = h.stores.tasks.create({ runId: s.run.id, planNodeId: s.root.id, origin: "orchestrator", subject: "other", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const evidence = [{ kind: "artifact" as const, artifactId: seedArtifact(h, s, "evidence").id }];
      const worker = context(h, s, { role: "worker", purpose: "task", taskIds: [task.id] });
      // A Worker cannot report another Task, a completed Task needs Evidence and its required outputs, and a completed task Invocation reports its Task.
      expect(codes(validator, { ...base, tasks: [{ taskId: otherTask.id, status: "completed", evidence, blocker: null }] }, worker)).toEqual(["task_not_assigned@tasks.0", "status_incompatible@tasks"]);
      expect(codes(validator, { ...base, tasks: [{ taskId: task.id, status: "completed", evidence, blocker: null }] }, worker)).toEqual(["task_missing_outputs@tasks.0.taskId"]);
      const output = h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/x-diff", producer: { kind: "invocation", invocationId: worker.invocation.id, attemptId: null }, taskId: task.id, title: "patch" }, new TextEncoder().encode("diff"));
      expect(codes(validator, { ...base, artifactIds: [output.id], tasks: [{ taskId: task.id, status: "completed", evidence, blocker: null }] }, worker)).toEqual([]);
      expect(codes(validator, { ...base, tasks: [{ taskId: task.id, status: "completed", evidence: [], blocker: null }] }, worker)[0]).toMatch(/^malformed@tasks\.0\.evidence/);
      expect(codes(validator, { ...base, status: "blocked", blocker: "need input", tasks: [{ taskId: task.id, status: "blocked", evidence: [], blocker: "need input" }] }, worker)).toEqual([]);
      // Evaluators change no Task state and cannot be blocked; only the Orchestrator returns a runOutcome, always with valid Evidence.
      const evaluator = context(h, s, { role: "evaluator" });
      expect(codes(validator, { ...base, tasks: [{ taskId: task.id, status: "failed", evidence: [], blocker: null }] }, evaluator)).toEqual(["task_report_not_permitted@tasks", "evaluation_missing@evaluation"]);
      expect(codes(validator, { ...base, status: "blocked", blocker: "?" }, evaluator)).toEqual(["status_incompatible@status"]);
      expect(codes(validator, { ...base, runOutcome: { kind: "infeasible", evidence } }, worker)).toEqual(["status_incompatible@tasks", "run_outcome_not_permitted@runOutcome"]);
      const orchestrator = context(h, s, { role: "orchestrator" });
      expect(codes(validator, { ...base, runOutcome: { kind: "infeasible", evidence } }, orchestrator)).toEqual([]);
      expect(codes(validator, { ...base, runOutcome: { kind: "infeasible", evidence: [{ kind: "artifact", artifactId: "art_000000000000000000000000" }] } }, orchestrator)).toEqual(["unknown_evidence_reference@runOutcome.evidence.0"]);
      expect(codes(validator, { ...base, runOutcome: { kind: "infeasible", evidence: [] } }, orchestrator)[0]).toMatch(/^malformed@runOutcome/);
      // The Orchestrator may report any Task of the Run; a Coordinator only its node's.
      expect(codes(validator, { ...base, tasks: [{ taskId: otherTask.id, status: "failed", evidence: [], blocker: null }] }, orchestrator)).toEqual([]);
      // Validation mutates nothing.
      expect(h.stores.tasks.get(task.id).status).toBe("pending");
    } finally {
      h.close();
    }
  });

  it("admits an Evaluator payload only from an evaluate Invocation, exclusive with a route selection, covering exactly the evaluated criteria it was given", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const validator = new InvocationResultValidator(h.stores);
      const revision = h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: h.ctx.ids("requirement"), parentId: null, composition: null, statement: "works", position: 0, acceptanceCriterionIds: [] }] });
      const requirementId = revision.tree[0]!.id;
      const criterion = (check: { kind: "deterministic"; command: string; expectedExitCode: number } | { kind: "evaluated"; question: string; rubric: null }) => h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check });
      const deterministic = criterion({ kind: "deterministic", command: "npm test", expectedExitCode: 0 });
      const first = criterion({ kind: "evaluated", question: "correct?", rubric: null });
      const second = criterion({ kind: "evaluated", question: "complete?", rubric: null });
      const foreignRun = seedRun(h);
      const other = h.stores.requirements.createAcceptanceCriterion({ conversationId: foreignRun.conversation.id, requirementId: null, requirementRevisionId: null, taskId: h.stores.tasks.create({ runId: foreignRun.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null }).id, check: { kind: "evaluated", question: "foreign", rubric: null } });
      const node = seedWorkerNode(h, s, "single", { gateAcceptanceCriterionIds: [deterministic.id, first.id, second.id], shape: { pattern: "evaluator_optimizer", producer: operation(s.definition.id, "producer"), evaluator: operation(s.definition.id, "judge", "evaluator"), maxRounds: 2, round: null }, pattern: "evaluator_optimizer" } as never);
      const snapshot = seedSnapshot(h, s);
      const producer = h.stores.invocations.create({ runId: s.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "producer_round", round: 1, maxRounds: 2 }, taskIds: [], allocation: { costUsd: 0.1, tokens: 100, attempts: 1 } });
      const candidate = seedArtifact(h, s, "candidate", { invocationId: producer.id });
      const evaluator = h.stores.invocations.create({ runId: s.run.id, planNodeId: node.id, role: "evaluator", purpose: "evaluate", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, patternPosition: { kind: "evaluator_round", round: 1, maxRounds: 2 }, taskIds: [], allocation: { costUsd: 0.1, tokens: 100, attempts: 1 } });
      const manifest = seedManifest(h, s, evaluator);
      // The manifest the runtime assembled names the candidate and exactly the evaluated criteria (and lists the deterministic one as such).
      const content = { ...manifest.content, inputs: [{ kind: "optimizer_candidate" as const, round: 1, maxRounds: 2, snapshotId: snapshot.id, artifactIds: [candidate.id], acceptanceCriterionIds: [first.id, second.id].sort() }], acceptanceCriteria: [deterministic, first, second].map((c) => ({ acceptanceCriterionId: c.id, requirementId: c.requirementId, taskId: c.taskId, check: c.check })).sort((a, b) => (a.acceptanceCriterionId < b.acceptanceCriterionId ? -1 : 1)) };
      const ctx: ResultValidationContext = { run: h.stores.runs.get(s.run.id), invocation: evaluator, manifest: { ...manifest, content }, writes: false, changeset: null };
      const evidence = [{ kind: "artifact" as const, artifactId: candidate.id }];
      const good = { verdict: "pass" as const, criteria: [{ acceptanceCriterionId: first.id, verdict: "pass" as const, evidence }, { acceptanceCriterionId: second.id, verdict: "pass" as const, evidence: [] }], evidence };
      expect(codes(validator, { ...base, evaluation: good }, ctx)).toEqual([]);
      // Missing, duplicate, extra, foreign, and deterministic criteria; an inconsistent pass; missing overall Evidence; a command claim.
      expect(codes(validator, base, ctx)).toEqual(["evaluation_missing@evaluation"]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [good.criteria[0]] } }, ctx)).toEqual(["evaluation_criteria_mismatch@evaluation.criteria"]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [...good.criteria, good.criteria[0]] } }, ctx)).toEqual(["evaluation_criteria_mismatch@evaluation.criteria.2"]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [...good.criteria, { acceptanceCriterionId: other.id, verdict: "pass", evidence: [] }] } }, ctx)).toEqual(["evaluation_criteria_mismatch@evaluation.criteria.2"]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [...good.criteria, { acceptanceCriterionId: deterministic.id, verdict: "pass", evidence: [] }] } }, ctx)).toEqual(["evaluation_criteria_mismatch@evaluation.criteria.2"]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [good.criteria[0], { acceptanceCriterionId: second.id, verdict: "fail", evidence: [] }] } }, ctx)).toEqual(["evaluation_verdict_inconsistent@evaluation.verdict"]);
      expect(codes(validator, { ...base, evaluation: { ...good, verdict: "fail", criteria: [good.criteria[0], { acceptanceCriterionId: second.id, verdict: "inconclusive", evidence: [] }] } }, ctx)).toEqual([]);
      expect(codes(validator, { ...base, evaluation: { ...good, evidence: [] } }, ctx)).toEqual(["evaluation_evidence_missing@evaluation.evidence"]);
      expect(codes(validator, { ...base, evaluation: { ...good, evidence: [{ kind: "command", command: "npm test", exitCode: 0, outputArtifactId: candidate.id }] } }, ctx)).toEqual(["evidence_not_permitted@evaluation.evidence.0"]);
      expect(codes(validator, { ...base, evidence: [{ kind: "command", command: "npm test", exitCode: 0, outputArtifactId: candidate.id }], evaluation: good }, ctx)).toEqual(["evidence_not_permitted@evidence.0"]);
      // Evidence references are checked like every other: a foreign Artifact is refused.
      const foreign = seedArtifact(h, seedRun(h), "foreign");
      expect(codes(validator, { ...base, evaluation: { ...good, evidence: [{ kind: "artifact", artifactId: foreign.id }] } }, ctx)).toEqual(["foreign_evidence_reference@evaluation.evidence.0"]);
      // No other Invocation returns an evaluation; a selector and an Evaluator payload are exclusive; an Evaluator records no Changeset.
      expect(codes(validator, { ...base, evaluation: good }, context(h, s))).toEqual(["evaluation_not_permitted@evaluation"]);
      expect(codes(validator, { ...base, evaluation: good }, context(h, s, { role: "orchestrator" }))).toEqual(["evaluation_not_permitted@evaluation"]);
      expect(codes(validator, { ...base, evaluation: good, routeSelection: { selectedLabel: "x" } }, ctx)[0]).toMatch(/^malformed@evaluation/);
      expect(codes(validator, { ...base, evaluation: good }, { ...ctx, changeset: { afterSnapshot: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) }, diff: new Uint8Array(), empty: true } })).toEqual(["status_incompatible"]);
      // A Gate Evaluator without a candidate input covers the manifest's evaluated criteria.
      const gate = context(h, s, { role: "evaluator" });
      const gateContent = { ...gate.manifest.content, acceptanceCriteria: content.acceptanceCriteria };
      expect(codes(validator, { ...base, evaluation: good }, { ...gate, manifest: { ...gate.manifest, content: gateContent } })).toEqual([]);
      expect(codes(validator, { ...base, evaluation: { ...good, criteria: [] } }, { ...gate, manifest: { ...gate.manifest, content: gateContent } })).toEqual(["evaluation_criteria_mismatch@evaluation.criteria", "evaluation_criteria_mismatch@evaluation.criteria"]);
    } finally {
      h.close();
    }
  });

  it("requires a Changeset record for a writing Invocation, an explicitly empty one included", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const validator = new InvocationResultValidator(h.stores);
      expect(codes(validator, base, context(h, s, { writes: true, changeset: null }))).toEqual(["changeset_missing"]);
      expect(codes(validator, base, context(h, s, { writes: true, changeset: { afterSnapshot: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) }, diff: new Uint8Array(), empty: true } }))).toEqual([]);
      expect(codes(validator, base, context(h, s, { writes: false, changeset: null }))).toEqual([]);
    } finally {
      h.close();
    }
  });
});
