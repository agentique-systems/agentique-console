/**
 * Run completion verification (execution-model §10 `run_completion`;
 * invariants 11, 12, 13): an accepted Completion Request becomes exactly one
 * `run_completion` Gate that pins the integration Snapshot, the Requirement
 * revision, the canonical criterion set, and the bounded candidate; its
 * deterministic criteria run in id order through the shared check service;
 * its evaluated criteria are judged by one read-only Evaluator funded from
 * the final reserve; every verdict is an Evaluation of the Gate; the
 * Requirement statuses are derived from those Evaluations; and the Run
 * reaches `awaiting_signoff` only through a passed Gate, a typed final
 * report, and one signoff boundary — or returns to `running` with one
 * remediation Task, never retrying by itself.
 */
import type { AcceptanceCriterionId, RequirementId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { CompletionFacts } from "./completion-requests.ts";
import { advanceUntil, completionEvaluatorStep, completionEvaluatorsOf, completionGatesOf, prepareOperatorTurn, remediationsOf, reportsOf, requestingStep, requestsOf, signoffGatesOf, synthesesOf, synthesisStep } from "./completion-test-support.ts";
import { orchestratorStep, rootTurnsOf, scriptByRole, seedCriteria } from "./gate-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

/** A final reserve that funds one Evaluator and one synthesis (two Attempts each) with room for a retry. */
const WIDE_RESERVE = { costUsd: 20, tokens: 200_000, attempts: 8 };

describe("run_completion Gate", () => {
  it("verifies a coding Run with one deterministic criterion: Gate pinned, check recorded once, Requirement satisfied, report produced, signoff opened", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)] });
      const kinds = await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      expect(kinds).toEqual(["execute_invocation", "settle_root", "begin_run_completion", "run_completion_checks", "derive_requirement_statuses", "prepare_final_synthesis", "execute_invocation", "settle_final_synthesis"]);
      const [request] = requestsOf(h, runId);
      const [gate] = completionGatesOf(h, runId);
      const run = h.stores.runs.get(runId);
      expect(request).toMatchObject({ status: "passed", gateId: gate!.id, outcome: null });
      expect(gate).toMatchObject({ planNodeId: null, kind: "run_completion", ordinal: 1, status: "passed", completionRequestId: request!.id, snapshotId: run.integrationSnapshotId, requirementRevisionId: s.completion.revision.id, requirementIds: [s.completion.requirementId], acceptanceCriterionIds: [s.completion.criterionId], candidateArtifactIds: [], reportArtifactId: request!.reportArtifactId });
      // The one check ran in an isolated view of the pinned Snapshot, outside any transaction, and recorded one Evaluation of the Gate.
      expect(h.criterionExecution.observed.map((o) => [o.acceptanceCriterionId, o.gateId, o.inTransaction, o.outcome])).toEqual([[s.completion.criterionId, gate!.id, false, "exited"]]);
      const evaluations = h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id);
      expect(evaluations.map((e) => [e.verdict, e.planNodeId, e.context, e.snapshotId, e.producedBy.kind])).toEqual([["pass", null, null, gate!.snapshotId, "runtime"]]);
      // The leaf Requirement is satisfied by the Gate's Evaluation, once.
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("satisfied");
      expect(h.stores.requirements.history(s.completion.requirementId).map((c) => [c.to, c.actor, c.gateId, c.evidence])).toEqual([["satisfied", "runtime", gate!.id, [{ kind: "evaluation", evaluationId: evaluations[0]!.id }]]]);
      // One read-only synthesis from the final reserve; one canonical report Artifact.
      const [synthesis] = synthesesOf(h, runId);
      expect(synthesis).toMatchObject({ status: "succeeded", role: "orchestrator", purpose: "final_synthesis", gateId: gate!.id, planNodeId: s.created.root.id, taskIds: [], allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" });
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === synthesis!.id)).toEqual([]);
      const [report] = reportsOf(h, runId);
      expect(report?.id).toBe(request!.reportArtifactId);
      expect(JSON.parse(new TextDecoder().decode(h.blobs.get(report!.digest)))).toMatchObject({ version: 1, runId, completionRequestId: request!.id, gateId: gate!.id, snapshotId: gate!.snapshotId, requirementRevisionId: s.completion.revision.id, report: { summary: "The CLI reports its version." } });
      // The signoff boundary: one open operator_signoff Gate, one operator-required signoff Decision, the Run awaiting signoff.
      const [signoff] = signoffGatesOf(h, runId);
      expect(signoff).toMatchObject({ status: "open", snapshotId: gate!.snapshotId, completionGateId: gate!.id, completionRequestId: request!.id, reportArtifactId: report!.id, acceptanceCriterionIds: [] });
      const decision = h.stores.decisions.signoffOf(signoff!.id);
      expect(decision).toMatchObject({ kind: "signoff", status: "open", resolutionPolicy: "operator_required", subject: { kind: "signoff", runId, gateId: signoff!.id, completionGateId: gate!.id, completionRequestId: request!.id, snapshotId: gate!.snapshotId, reportArtifactId: report!.id } });
      expect(decision!.options.map((o) => o.id)).toEqual(["accept", "request_changes"]);
      expect(run.status).toBe("awaiting_signoff");
      // Nothing more happens while awaiting signoff, and the Events tell the whole story once each.
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
      const types = h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
      expect(types.filter((t) => t.startsWith("completion_request") || t.startsWith("gate.") || t.startsWith("run."))).toEqual(["completion_request.created", "run.integrated", "run.verifying", "gate.opened", "completion_request.verifying", "gate.passed", "completion_request.passed", "gate.opened", "run.awaiting_signoff"]);
    } finally {
      h.close();
    }
  });

  it("judges evaluated criteria with exactly one read-only Evaluator from the final reserve, after every deterministic check, over one typed gate_candidate", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
      const runId = s.created.run.id;
      // The new revision retires the declared criterion's leaf: the set is exactly the current leaf's criteria.
      const criteria = seedCriteria(h, s, { deterministic: 2, evaluated: 2 });
      const deterministic = criteria.deterministic;
      let observedBeforeEvaluator = -1;
      const judge = completionEvaluatorStep(h, "pass");
      scriptByRole(h, {
        orchestrator: [requestingStep(), synthesisStep(h)],
        evaluator: [
          {
            kind: "derived",
            step: (request) => {
              observedBeforeEvaluator = h.criterionExecution.observed.length;
              return judge.kind === "derived" ? judge.step(request) : judge;
            },
          },
        ],
      });
      const kinds = await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      expect(kinds).toEqual(["execute_invocation", "settle_root", "begin_run_completion", "run_completion_checks", "prepare_run_completion_evaluator", "execute_invocation", "settle_run_completion_evaluator", "derive_requirement_statuses", "prepare_final_synthesis", "execute_invocation", "settle_final_synthesis"]);
      const [gate] = completionGatesOf(h, runId);
      // The criterion set is the canonical union of the declared (retired, so excluded) and the pinned leaf's criteria, in id order; checks ran in that order, all before the Evaluator.
      expect(gate).toMatchObject({ requirementRevisionId: criteria.revisionId, requirementIds: [criteria.rootId], acceptanceCriterionIds: criteria.all });
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).toEqual(deterministic);
      expect(observedBeforeEvaluator).toBe(deterministic.length);
      // Exactly one Evaluator: role evaluator, purpose evaluate, position-less, no Tasks, the Gate, the final reserve, root attribution.
      const [evaluator, ...more] = completionEvaluatorsOf(h, runId);
      expect(more).toEqual([]);
      expect(evaluator).toMatchObject({ role: "evaluator", purpose: "evaluate", patternPosition: null, gateId: gate!.id, taskIds: [], planNodeId: s.created.root.id, agentDefinitionRevisionId: s.evaluator.id, allocationSource: "run_final_reserve", finalReserveUse: "run_completion", status: "succeeded" });
      const manifest = h.stores.invocations.getManifest(evaluator!.id).content;
      const candidates = manifest.inputs.filter((i) => i.kind === "gate_candidate");
      expect(candidates).toEqual([{ kind: "gate_candidate", gateId: gate!.id, gateKind: "run_completion", snapshotId: gate!.snapshotId, artifactIds: [], acceptanceCriterionIds: criteria.evaluated, completionRequestId: gate!.completionRequestId, requirementRevisionId: criteria.revisionId, tasks: [] }]);
      expect(manifest.requirementRevisionId).toBe(criteria.revisionId);
      expect(manifest.requirements.map((r) => r.requirementId)).toEqual([criteria.rootId]);
      expect(JSON.stringify(manifest)).not.toMatch(/transcript|continuation/i);
      // One Evaluation per criterion of the Gate, the Evaluator's over exactly the evaluated ones.
      const evaluations = h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id);
      expect(evaluations.map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.producedBy.kind, e.verdict, e.gateId, e.planNodeId]).sort()).toEqual([...deterministic.map((id) => [id, "runtime", "pass", gate!.id, null]), ...criteria.evaluated.map((id) => [id, "evaluator", "pass", gate!.id, null])].sort());
      // The pinned leaf's status rests on exactly its criteria's Evaluations; the retired leaf is untouched.
      expect(h.stores.requirements.get(criteria.rootId).status).toBe("satisfied");
      expect(h.stores.requirements.history(criteria.rootId).at(-1)!.evidence).toEqual(evaluations.map((e) => ({ kind: "evaluation", evaluationId: e.id })));
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("retired");
      expect(h.stores.requirements.history(s.completion.requirementId).at(-1)!.to).toBe("retired");
      // The final reserve funded both completion Invocations and nothing else.
      const capacity = h.stores.reservations.runCapacity(runId);
      expect(capacity.final.committed.attempts).toBe(h.stores.invocations.listAttempts(evaluator!.id).length + h.stores.invocations.listAttempts(synthesesOf(h, runId)[0]!.id).length);
    } finally {
      h.close();
    }
  });

  it("stops at the first failed deterministic check, prepares no Evaluator, and fails the request with one root remediation Task; a later turn's request opens cycle 2, which passes", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
      const runId = s.created.run.id;
      const criteria = seedCriteria(h, s, { deterministic: 2, evaluated: 1 });
      const deterministic = criteria.deterministic;
      h.criterionExecution.script(deterministic[0]!, { kind: "exit", exitCode: 1, output: "1 failing\n" });
      scriptByRole(h, { orchestrator: [requestingStep()] });
      const seq = h.ctx.journal.lastSeq();
      const kinds = await advanceUntil(h, runId, () => completionGatesOf(h, runId)[0]?.status === "failed", { maxActions: 1 });
      expect(kinds).toEqual(["execute_invocation", "settle_root", "begin_run_completion", "run_completion_checks", "complete_run_verification"]);
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).toEqual([deterministic[0]]);
      expect(completionEvaluatorsOf(h, runId)).toEqual([]);
      const [gate] = completionGatesOf(h, runId);
      const [request] = requestsOf(h, runId);
      expect(gate).toMatchObject({ status: "failed", failure: { kind: "criteria_failed", acceptanceCriterionIds: [deterministic[0]] }, reportArtifactId: null });
      expect(request).toMatchObject({ status: "failed", outcome: { kind: "criteria_failed", acceptanceCriterionIds: [deterministic[0]] }, reportArtifactId: null });
      expect(h.stores.runs.get(runId).status).toBe("running");
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id)).toHaveLength(1);
      // One runtime-owned remediation Task on the root, linked to the Gate, the failed criterion's Requirement, the pinned revision, and the Evidence Artifacts.
      const [task] = remediationsOf(h, runId);
      const owner = h.stores.requirements.getAcceptanceCriterion(deterministic[0]!).requirementId!;
      const evidence = h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id).flatMap((e) => e.evidence.flatMap((v) => (v.kind === "command" ? [v.outputArtifactId] : [])));
      expect(task).toMatchObject({ planNodeId: s.created.root.id, origin: "runtime", gateId: gate!.id, status: "pending", requirementIds: [owner], requirementRevisionId: criteria.revisionId, inputArtifactIds: evidence });
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type).filter((t) => t.startsWith("run.") || t.startsWith("gate.") || t.startsWith("completion_request"))).toEqual(["completion_request.created", "run.integrated", "run.verifying", "gate.opened", "completion_request.verifying", "gate.failed", "completion_request.failed", "run.verification_failed"]);
      // The root's batched gate_result turn remediates; completion is not retried by the runtime.
      scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+fix" })] });
      await advanceUntil(h, runId, () => remediationsOf(h, runId)[0]?.status === "completed");
      const remediation = rootTurnsOf(h, runId).at(-1)!;
      expect(remediation.purpose).toBe("gate_result");
      expect(h.stores.invocations.getManifest(remediation.id).content.inputs.filter((i) => i.kind === "gate_result")).toEqual([expect.objectContaining({ gateId: gate!.id, gateKind: "run_completion", planNodeId: null, ordinal: 1, passed: false, remediationTaskId: task!.id, failedAcceptanceCriterionIds: [deterministic[0]] })]);
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
      expect(requestsOf(h, runId)).toHaveLength(1);
      expect(completionGatesOf(h, runId)).toHaveLength(1);
      expect(h.stores.runs.get(runId).status).toBe("running");
      // A later turn requests completion again: a new request, cycle 2 on the new Snapshot, every check re-run, the Evaluator judging, the Run awaiting signoff.
      prepareOperatorTurn(h, runId);
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)], evaluator: [completionEvaluatorStep(h, "pass")] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      const gates = completionGatesOf(h, runId);
      expect(gates.map((g) => [g.ordinal, g.status])).toEqual([[1, "failed"], [2, "passed"]]);
      expect(gates[1]!.snapshotId).not.toBe(gates[0]!.snapshotId);
      expect(gates[1]!.snapshotId).toBe(h.stores.runs.get(runId).integrationSnapshotId);
      expect(requestsOf(h, runId).map((r) => [r.status, r.gateId])).toEqual([["failed", gates[0]!.id], ["passed", gates[1]!.id]]);
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).toEqual([deterministic[0], ...deterministic]);
      expect(completionEvaluatorsOf(h, runId).map((e) => e.gateId)).toEqual([gates[1]!.id]);
      expect(signoffGatesOf(h, runId).map((g) => g.completionGateId)).toEqual([gates[1]!.id]);
    } finally {
      h.close();
    }
  });

  it("fails on an Evaluator's failing verdict and on a permanently failed Evaluator, each with one remediation Task, and refuses a request beyond the cycle bound", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE, verificationPolicy: { maxRunCompletionCycles: 2 } });
      const runId = s.created.run.id;
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      scriptByRole(h, { orchestrator: [requestingStep()], evaluator: [completionEvaluatorStep(h, "fail")] });
      await advanceUntil(h, runId, () => completionGatesOf(h, runId)[0]?.status === "failed", { maxActions: 1 });
      const [gate1] = completionGatesOf(h, runId);
      expect(gate1).toMatchObject({ failure: { kind: "criteria_failed", acceptanceCriterionIds: criteria.evaluated } });
      expect(h.stores.requirements.get(criteria.rootId).status).toBe("open");
      expect(remediationsOf(h, runId).map((t) => [t.gateId, t.status, t.requirementIds])).toEqual([[gate1!.id, "pending", [criteria.rootId]]]);
      // The remediation turn ends its Task; a later turn's request opens cycle 2, whose Evaluator fails permanently.
      scriptByRole(h, { orchestrator: [orchestratorStep(h, {})] });
      await advanceUntil(h, runId, () => remediationsOf(h, runId)[0]?.status === "completed");
      prepareOperatorTurn(h, runId);
      scriptByRole(h, { orchestrator: [requestingStep()], evaluator: [{ kind: "permanent_error", message: "model refused" }, { kind: "permanent_error", message: "model refused" }] });
      await advanceUntil(h, runId, () => completionGatesOf(h, runId)[1]?.status === "failed", { maxActions: 1 });
      const [, gate2] = completionGatesOf(h, runId);
      const [evaluator] = completionEvaluatorsOf(h, runId).filter((e) => e.gateId === gate2!.id);
      expect(evaluator!.status).toBe("failed");
      expect(gate2).toMatchObject({ ordinal: 2, failure: { kind: "evaluator_failed", invocationId: evaluator!.id } });
      expect(requestsOf(h, runId).map((r) => [r.status, r.outcome?.kind])).toEqual([["failed", "criteria_failed"], ["failed", "evaluator_failed"]]);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate2!.id).map((e) => e.producedBy.kind)).toEqual(["runtime"]);
      expect(remediationsOf(h, runId).map((t) => [t.gateId, t.status])).toEqual([[gate1!.id, "completed"], [gate2!.id, "pending"]]);
      expect(h.stores.runs.get(runId).status).toBe("running");
      // A Run bounded to one cycle: after its failed cycle, a later request is refused at the call with no row, and the Run stays running.
      const u = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE, verificationPolicy: { maxRunCompletionCycles: 1 } });
      const boundedRunId = u.created.run.id;
      const bounded = seedCriteria(h, u, { deterministic: 1 });
      h.criterionExecution.script(bounded.deterministic[0]!, { kind: "exit", exitCode: 1 });
      scriptByRole(h, { orchestrator: [requestingStep(), orchestratorStep(h, {})] });
      await advanceUntil(h, boundedRunId, () => remediationsOf(h, boundedRunId)[0]?.status === "completed");
      prepareOperatorTurn(h, boundedRunId);
      scriptByRole(h, { orchestrator: [requestingStep()] });
      await advanceUntil(h, boundedRunId, () => rootTurnsOf(h, boundedRunId).at(-1)!.status === "succeeded");
      expect(h.provider.runtimeToolCalls.at(-1)!.outcome).toMatchObject({ kind: "rejected", reasons: [{ code: "run_completion_cycles_exhausted" }] });
      expect(requestsOf(h, boundedRunId)).toHaveLength(1);
      expect(completionGatesOf(h, boundedRunId)).toHaveLength(1);
      expect(await h.scheduler.advanceRun(boundedRunId)).toMatchObject({ stop: "quiescent" });
      expect(h.stores.runs.get(boundedRunId).status).toBe("running");
      expect(h.stores.runs.get(runId).status).toBe("running");
    } finally {
      h.close();
    }
  });

  it("records nothing on an infrastructure failure of a check and re-runs it; a leaf without criteria keeps the Gate from passing with the exact condition", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      // A new revision keeps the declared leaf and adds a leaf without criteria and a waived leaf (excluded from the set, retained).
      const bare = h.ctx.ids("requirement");
      const waived = h.ctx.ids("requirement");
      const revision = h.stores.requirements.createRevision({
        conversationId,
        approvedByDecisionId: null,
        tree: [
          { id: s.completion.requirementId, parentId: null, composition: null, statement: "builds", position: 0, acceptanceCriterionIds: [s.completion.criterionId] },
          { id: bare, parentId: null, composition: null, statement: "documented", position: 1, acceptanceCriterionIds: [] },
          { id: waived, parentId: null, composition: null, statement: "styled", position: 2, acceptanceCriterionIds: [] },
        ],
      });
      const waiver = h.stores.decisions.request({ conversationId, runId, kind: "requirement_waiver", resolutionPolicy: "operator_required", requestedBy: { kind: "runtime" }, question: "waive?", options: [{ id: "waive", label: "waive", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [waived], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      h.stores.decisions.resolve(waiver.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "not needed", artifactIds: [] });
      h.stores.requirements.recordStatusChange({ requirementId: waived, runId, to: "waived", actor: "operator", evidence: [], gateId: null, decisionId: waiver.id, rationale: "not needed" });
      h.criterionExecution.script(s.completion.criterionId, { kind: "fail", failure: "workspace_unavailable", message: "no disk" });
      scriptByRole(h, { orchestrator: [requestingStep()] });
      const kinds = await advanceUntil(h, runId, () => completionGatesOf(h, runId)[0]?.status === "failed", { maxActions: 1 });
      // The failed infrastructure recorded no Evaluation and the same action ran again from the rows.
      expect(kinds).toEqual(["execute_invocation", "settle_root", "begin_run_completion", "run_completion_checks", "run_completion_checks", "derive_requirement_statuses", "complete_run_verification"]);
      expect(h.criterionExecution.observed.map((o) => o.outcome)).toEqual(["failed", "exited"]);
      const [gate] = completionGatesOf(h, runId);
      expect(gate).toMatchObject({ requirementRevisionId: revision.id, requirementIds: [s.completion.requirementId, bare, waived].sort(), acceptanceCriterionIds: [s.completion.criterionId] });
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id)).toHaveLength(1);
      expect(gate!.failure).toEqual({ kind: "conditions_unmet", conditions: [{ kind: "requirement_unsatisfied", requirementId: bare, status: "open" }] });
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("satisfied");
      expect(h.stores.requirements.get(bare).status).toBe("open");
      expect(h.stores.requirements.get(waived).status).toBe("waived");
      expect(h.stores.requirements.history(waived)).toHaveLength(1);
      expect(remediationsOf(h, runId)[0]).toMatchObject({ requirementIds: [bare], status: "pending" });
      expect(synthesesOf(h, runId)).toEqual([]);
      expect(h.stores.runs.get(runId).status).toBe("running");
    } finally {
      h.close();
    }
  });

  it("retries an invalid synthesis result, fails the request on a permanently failed synthesis, and never prepares a synthesis before every criterion passed", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
      const runId = s.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h, undefined, "invalid"), synthesisStep(h)] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      const [synthesis, ...more] = synthesesOf(h, runId);
      expect(more).toEqual([]);
      expect(h.stores.invocations.listAttempts(synthesis!.id).map((a) => [a.status, a.failureClass])).toEqual([["failed", "result_invalid"], ["succeeded", null]]);
      expect(reportsOf(h, runId)).toHaveLength(1);
      // A second Run: the synthesis fails permanently; the request fails with final_synthesis_failed and no report exists.
      const t = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
      const otherRunId = t.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h, undefined, "failed")] });
      await advanceUntil(h, otherRunId, () => completionGatesOf(h, otherRunId)[0]?.status === "failed", { maxActions: 1 });
      const [gate] = completionGatesOf(h, otherRunId);
      const [failed] = synthesesOf(h, otherRunId);
      expect(gate).toMatchObject({ failure: { kind: "final_synthesis_failed", invocationId: failed!.id }, reportArtifactId: null });
      expect(requestsOf(h, otherRunId)[0]).toMatchObject({ status: "failed", outcome: { kind: "final_synthesis_failed", invocationId: failed!.id }, reportArtifactId: null });
      expect(reportsOf(h, otherRunId)).toEqual([]);
      expect(signoffGatesOf(h, otherRunId)).toEqual([]);
      expect(h.stores.runs.get(otherRunId).status).toBe("running");
      expect(remediationsOf(h, otherRunId)).toHaveLength(1);
      // The synthesis was prepared only after the derived statuses were recorded; its manifest is bounded to canonical facts.
      const manifest = h.stores.invocations.getManifest(failed!.id).content;
      const input = manifest.inputs.find((i) => i.kind === "final_synthesis");
      expect(input).toMatchObject({ completionRequestId: gate!.completionRequestId, gateId: gate!.id, snapshotId: gate!.snapshotId, requirementRevisionId: t.completion.revision.id, requirements: [{ requirementId: t.completion.requirementId, status: "satisfied", waiverDecisionId: null }], tasks: [], artifactIds: [], unresolved: [] });
      expect(JSON.stringify(manifest)).not.toMatch(/transcript|continuation|message/i);
      for (const tool of ["request_completion", "propose_tasks", "update_task", "create_tasks", "request_decision", "record_decision", "propose_requirements", "revise_execution_plan"]) expect(manifest.runtimeTools).not.toContain(tool);
    } finally {
      h.close();
    }
  });

  it("cancels the request of a requesting turn that did not complete — a failed result before the Run continues, a failed Invocation before the Run fails", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep({ kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "gave up" } })] });
      await advanceUntil(h, runId, () => requestsOf(h, runId)[0]?.status === "cancelled");
      const turn = rootTurnsOf(h, runId)[0]!;
      expect(requestsOf(h, runId)[0]).toMatchObject({ status: "cancelled", gateId: null, outcome: { kind: "requesting_turn_failed", invocationId: turn.id } });
      expect(completionGatesOf(h, runId)).toEqual([]);
      expect(h.stores.runs.get(runId).status).toBe("running");
      // A second Run: the requesting turn's Invocation fails; the request is cancelled in the same transaction that fails the Run.
      const t = seedPlanningRuntime(h);
      const otherRunId = t.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      scriptByRole(h, { orchestrator: [requestingStep({ kind: "permanent_error", message: "boom" })] });
      await advanceUntil(h, otherRunId, () => h.stores.runs.get(otherRunId).status === "failed");
      expect(requestsOf(h, otherRunId)[0]).toMatchObject({ status: "cancelled", outcome: { kind: "requesting_turn_failed" } });
      const types = h.ctx.journal.read({ runId: otherRunId, afterSeq: seq }).map((e) => e.type);
      expect(types.indexOf("completion_request.cancelled")).toBeLessThan(types.indexOf("run.failed"));
    } finally {
      h.close();
    }
  });

  it("excludes historical revisions, retired Requirements, and other Conversations from the criterion set, and pins the exact current leaves", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      // A historical criterion (on the first revision's leaf, not listed by the new tree entry) and a foreign Conversation's are never included.
      const historical = h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: s.completion.requirementId, requirementRevisionId: s.completion.revision.id, taskId: null, check: { kind: "deterministic", command: "npm run old", expectedExitCode: 0 } });
      const parent = h.ctx.ids("requirement");
      const child = h.ctx.ids("requirement");
      const gone = h.ctx.ids("requirement");
      h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: parent, parentId: null, composition: "all", statement: "parent", position: 0, acceptanceCriterionIds: [] }, { id: child, parentId: parent, composition: null, statement: "child", position: 0, acceptanceCriterionIds: [] }, { id: gone, parentId: null, composition: null, statement: "gone", position: 1, acceptanceCriterionIds: [] }] });
      const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: parent, parentId: null, composition: "all", statement: "parent", position: 0, acceptanceCriterionIds: [] }, { id: child, parentId: parent, composition: null, statement: "child", position: 0, acceptanceCriterionIds: [] }] });
      const current = h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: child, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm run child", expectedExitCode: 0 } });
      expect(h.stores.requirements.get(gone).status).toBe("retired");
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("retired");
      const facts = new CompletionFacts(h.stores);
      const run = h.stores.runs.get(runId);
      const set = facts.criteriaOf(run, facts.pinnedRevision(run));
      // The declared criterion's Requirement is retired: only the current leaf's criterion remains; the historical one is absent.
      expect(set.all).toEqual([current.id]);
      expect(set.all).not.toContain(historical.id as AcceptanceCriterionId);
      expect(facts.leafIds(facts.pinnedRevision(run))).toEqual([child as RequirementId]);
      expect(facts.preflight(run, s.invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
