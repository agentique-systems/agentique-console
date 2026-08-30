/**
 * Result validation beyond shape (execution-model §6.3; invariant 9
 * canonical objects by id).
 */
import type { InvocationResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedInvocation, seedManifest, seedRun, seedSnapshot, type Harness, type Seeded } from "../persistence/test-support.ts";
import { InvocationResultValidator, type ResultValidationContext } from "./result-validator.ts";

const base: InvocationResult = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null };

function context(h: Harness, s: Seeded, overrides: Partial<{ role: "orchestrator" | "worker" | "evaluator" | "coordinator"; purpose: "operator_input" | "step" | "task" | "evaluate" | "decompose"; taskIds: string[]; writes: boolean; changeset: ResultValidationContext["changeset"] }> = {}): ResultValidationContext {
  const role = overrides.role ?? "worker";
  const purpose = overrides.purpose ?? (role === "worker" ? "step" : role === "orchestrator" ? "operator_input" : role === "evaluator" ? "evaluate" : "decompose");
  const invocation = h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role, purpose, agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, taskIds: (overrides.taskIds ?? []) as never, allocation: { costUsd: 0.1, tokens: 100, attempts: 1 } });
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
      expect(codes(validator, { ...base, tasks: [{ taskId: task.id, status: "failed", evidence: [], blocker: null }] }, evaluator)).toEqual(["task_report_not_permitted@tasks"]);
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
