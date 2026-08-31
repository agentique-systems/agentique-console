/**
 * Completion Requests, Run Gates, and the signoff Decision at the store and
 * at the database (execution-model §10 `run_completion`, `operator_signoff`):
 * one non-terminal request per Run, the closed lifecycle with its facts,
 * append-only history; a `run_completion` Gate per request bounded by
 * `maxRunCompletionCycles`, an `operator_signoff` Gate on the exact verified
 * facts, one signoff Decision per Gate; Evaluations and remediation Tasks
 * of a Run Gate.
 */
import { ConflictError, FINAL_REPORT_MEDIA_TYPE, IllegalTransitionError, InvariantViolationError, SIGNOFF_OPTIONS, ValidationError, type Artifact, type Gate } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedCompletionRequest, seedInvocation, seedRequirements, seedRun, seedRunCompletionGate, seedSnapshot, seedWorkerNode, type Harness, type Seeded } from "../test-support.ts";

/** A final-report Artifact of the Run, as the runtime would store one. */
function report(h: Harness, s: Seeded): Artifact {
  return h.stores.artifacts.create({ runId: s.run.id, mediaType: FINAL_REPORT_MEDIA_TYPE, producer: { kind: "runtime", component: "final_report" }, taskId: null, title: "final report" }, new TextEncoder().encode('{"version":1}'));
}

/** Passes an open run_completion Gate with a report and moves its request to `passed`. */
function pass(h: Harness, s: Seeded, gate: Gate) {
  const artifact = report(h, s);
  return h.ctx.tx.write(() => {
    const passed = h.stores.gates.close(gate.id, "passed", null, { reportArtifactId: artifact.id });
    const request = h.stores.completionRequests.transition(gate.completionRequestId!, { to: "passed", reportArtifactId: artifact.id });
    return { gate: passed, request, artifact };
  });
}

function signoffRequest(h: Harness, s: Seeded, gate: Gate, subject: Record<string, unknown> = {}) {
  return h.stores.decisions.request({
    conversationId: s.conversation.id,
    runId: s.run.id,
    kind: "signoff",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "runtime" },
    question: "Accept?",
    options: SIGNOFF_OPTIONS.map((id) => ({ id, label: id, description: null })),
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: { kind: "signoff", runId: s.run.id, gateId: gate.id, completionGateId: gate.completionGateId!, completionRequestId: gate.completionRequestId!, snapshotId: gate.snapshotId!, reportArtifactId: gate.reportArtifactId!, ...subject } as never,
    supersedesDecisionId: null,
  });
}

describe("CompletionRequestStore", () => {
  it("creates one request per accepted call of a running root turn, at most one non-terminal per Run, journaled with the row", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const seq = h.ctx.journal.lastSeq();
      const { request, invocation, call } = seedCompletionRequest(h, s);
      expect(request).toMatchObject({ runId: s.run.id, invocationId: invocation.id, runtimeToolCallId: call.id, status: "requested", gateId: null, reportArtifactId: null, outcome: null, startedAt: null, endedAt: null });
      expect(h.stores.completionRequests.get(request.id)).toEqual(request);
      expect(h.stores.completionRequests.activeOf(s.run.id)).toEqual(request);
      expect(h.stores.completionRequests.byRuntimeToolCall(call.id)).toEqual(request);
      expect(h.stores.completionRequests.byInvocation(invocation.id)).toEqual(request);
      expect(h.stores.completionRequests.listByRun(s.run.id)).toEqual([request]);
      const created = h.ctx.journal.read({ runId: s.run.id, afterSeq: seq, type: "completion_request.created" });
      expect(created).toHaveLength(1);
      expect(created[0]!.actor).toEqual({ kind: "invocation", invocationId: invocation.id });
      expect(created[0]!.payload).toEqual(request);
      // A second non-terminal request of the Run is refused at the store (and the call row of another turn cannot even exist for one).
      expect(() => h.stores.completionRequests.create({ runId: s.run.id, invocationId: invocation.id, runtimeToolCallId: call.id })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("INSERT INTO completion_requests (id, run_id, invocation_id, runtime_tool_call_id, status, gate_id, report_artifact_id, outcome, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, 'requested', NULL, NULL, NULL, ?, NULL, NULL)").run(`crq_${"0".repeat(24)}`, s.run.id, invocation.id, call.id, "2026-01-01T00:00:00.000Z")).toThrow(/UNIQUE constraint failed/);
      // Rows are append-only history: identity never changes, nothing is deleted.
      expect(() => h.database.sqlite.prepare("UPDATE completion_requests SET run_id = ? WHERE id = ?").run(`run_${"0".repeat(24)}`, request.id)).toThrow(/immutable/);
      expect(() => h.database.sqlite.prepare("DELETE FROM completion_requests").run()).toThrow(/append-only/);
    } finally {
      h.close();
    }
  });

  it("refuses a request from a Run that is not running, a non-Orchestrator or final-synthesis turn, and a call that is not this turn's request_completion", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { request, invocation, call } = seedCompletionRequest(h, s);
      h.stores.completionRequests.transition(request.id, { to: "cancelled", outcome: { kind: "requesting_turn_failed", invocationId: invocation.id } });
      const worker = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: seedWorkerNode(h, s).id });
      expect(() => h.stores.completionRequests.create({ runId: s.run.id, invocationId: worker.id, runtimeToolCallId: call.id })).toThrow(/cannot request completion/);
      expect(() => h.stores.completionRequests.create({ runId: s.run.id, invocationId: invocation.id, runtimeToolCallId: call.id })).toThrow(/is succeeded/);
      h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "operator" });
      expect(() => seedCompletionRequest(h, s)).toThrow(/is waiting/);
    } finally {
      h.close();
    }
  });

  it("moves through verifying, passed, failed, and cancelled with their facts, refusing every other move and any change after a terminal state", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { request } = seedCompletionRequest(h, s);
      expect(() => h.stores.completionRequests.transition(request.id, { to: "passed", reportArtifactId: report(h, s).id })).toThrow(IllegalTransitionError);
      expect(() => h.stores.completionRequests.transition(request.id, { to: "verifying", gateId: `gate_${"0".repeat(24)}` })).toThrow(/Gate/);
      // Cancelled from requested: the outcome is a cancellation, never a verification failure.
      const cancelled = h.stores.completionRequests.transition(request.id, { to: "cancelled", outcome: { kind: "preconditions_changed", codes: ["node_active"] } });
      expect(cancelled).toMatchObject({ status: "cancelled", gateId: null, outcome: { kind: "preconditions_changed", codes: ["node_active"] } });
      expect(cancelled.endedAt).not.toBeNull();
      expect(h.stores.completionRequests.activeOf(s.run.id)).toBeNull();
      expect(() => h.stores.completionRequests.transition(request.id, { to: "verifying", gateId: `gate_${"0".repeat(24)}` })).toThrow(IllegalTransitionError);
      expect(() => h.database.sqlite.prepare("UPDATE completion_requests SET status = 'requested', ended_at = NULL, outcome = NULL WHERE id = ?").run(request.id)).toThrow(/never changes again/);
      // A later attempt is a new request; the historical one stays.
      const { gate, request: verifying } = seedRunCompletionGate(h, s);
      expect(verifying).toMatchObject({ status: "verifying", gateId: gate.id });
      expect(verifying.startedAt).not.toBeNull();
      expect(h.stores.completionRequests.listByRun(s.run.id).map((r) => r.status)).toEqual(["cancelled", "verifying"]);
      expect(() => h.database.sqlite.prepare("UPDATE completion_requests SET gate_id = ? WHERE id = ?").run(`gate_${"0".repeat(24)}`, verifying.id)).toThrow(/names its gate once/);
      expect(() => h.stores.completionRequests.transition(verifying.id, { to: "cancelled", outcome: { kind: "requesting_turn_failed", invocationId: verifying.invocationId } })).toThrow(IllegalTransitionError);
      // Failed only once its Gate closed failed, with a verification failure outcome.
      expect(() => h.stores.completionRequests.transition(verifying.id, { to: "failed", outcome: { kind: "evaluator_failed", invocationId: verifying.invocationId } })).toThrow(/closed failed/);
      h.stores.gates.close(gate.id, "failed", { kind: "conditions_unmet", conditions: [{ kind: "snapshot_moved", pinnedSnapshotId: gate.snapshotId!, currentSnapshotId: null }] });
      expect(() => h.stores.completionRequests.transition(verifying.id, { to: "failed", outcome: { kind: "preconditions_changed", codes: ["node_active"] } })).toThrow(ValidationError);
      const failed = h.stores.completionRequests.transition(verifying.id, { to: "failed", outcome: { kind: "conditions_unmet", conditions: [{ kind: "snapshot_moved", pinnedSnapshotId: gate.snapshotId!, currentSnapshotId: null }] } });
      expect(failed.status).toBe("failed");
      expect(h.ctx.journal.read({ runId: s.run.id, type: "completion_request.failed" }).map((e) => e.payload)).toEqual([failed]);
    } finally {
      h.close();
    }
  });

  it("passes only with the report its passed Gate recorded, and the Gate records the report exactly once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { gate, request } = seedRunCompletionGate(h, s);
      const other = report(h, s);
      expect(() => h.stores.completionRequests.transition(request.id, { to: "passed", reportArtifactId: other.id })).toThrow(/has not passed/);
      expect(() => h.stores.gates.close(gate.id, "passed")).toThrow(/passes with its final-report Artifact/);
      expect(() => h.stores.gates.close(gate.id, "failed", { kind: "evaluator_failed", invocationId: request.invocationId }, { reportArtifactId: other.id })).toThrow(/no other closure records one/);
      const passed = pass(h, s, gate);
      expect(passed.gate).toMatchObject({ status: "passed", reportArtifactId: passed.artifact.id });
      expect(passed.request).toMatchObject({ status: "passed", reportArtifactId: passed.artifact.id, gateId: gate.id });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "gate.passed" }).map((e) => e.payload)).toEqual([{ gateId: gate.id, reportArtifactId: passed.artifact.id }]);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET report_artifact_id = ? WHERE id = ?").run(other.id, gate.id)).toThrow(/records its final report once/);
    } finally {
      h.close();
    }
  });
});

describe("Run Gates", () => {
  it("opens one run_completion Gate per requested request with the pinned revision and leaf Requirements, bounded by maxRunCompletionCycles", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s, 2);
      const { gate, request } = seedRunCompletionGate(h, s);
      expect(gate).toMatchObject({ kind: "run_completion", planNodeId: null, ordinal: 1, status: "open", completionRequestId: request.id, requirementRevisionId: revision.id, requirementIds: [...leafIds].sort(), completionGateId: null, reportArtifactId: null });
      expect(gate.snapshotId).toBe(s.run.baseSnapshotId ?? gate.snapshotId);
      expect(h.stores.gates.openRunGateOf(s.run.id, "run_completion")?.id).toBe(gate.id);
      expect(h.stores.gates.listByCompletionRequest(request.id).map((g) => g.id)).toEqual([gate.id]);
      const input = { runId: s.run.id, planNodeId: null, kind: "run_completion" as const, acceptanceCriterionIds: [], snapshotId: gate.snapshotId, candidateArtifactIds: [], completionRequestId: request.id, requirementRevisionId: revision.id, requirementIds: [] };
      // A second Gate for the same request, an open Gate beside it, and a Gate beyond the cycle bound are refused.
      expect(() => h.stores.gates.open(input)).toThrow(ConflictError);
      h.stores.gates.close(gate.id, "failed", { kind: "final_reserve_exhausted", use: "final_synthesis" });
      h.stores.completionRequests.transition(request.id, { to: "failed", outcome: { kind: "final_reserve_exhausted", use: "final_synthesis" } });
      const next = seedCompletionRequest(h, s);
      // Its facts must belong to the Conversation: a foreign revision, a non-leaf Requirement, and a foreign criterion are refused.
      const other = seedRun(h);
      const foreign = seedRequirements(h, other, 1);
      expect(() => h.stores.gates.open({ ...input, completionRequestId: next.request.id, requirementRevisionId: foreign.revision.id })).toThrow(/another Conversation/);
      expect(() => h.stores.gates.open({ ...input, completionRequestId: next.request.id, requirementIds: [foreign.rootId] })).toThrow(/not a leaf/);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET completion_request_id = ? WHERE id = ?").run(next.request.id, gate.id)).toThrow(/never changes again/);
      const second = h.stores.gates.open({ ...input, completionRequestId: next.request.id });
      expect(second.ordinal).toBe(2);
      expect(() => h.database.sqlite.prepare("INSERT INTO gates SELECT 'gate_000000000000000000000000', run_id, plan_node_id, kind, ordinal, status, acceptance_criterion_ids, snapshot_id, candidate_artifact_ids, completion_request_id, requirement_revision_id, requirement_ids, completion_gate_id, report_artifact_id, failure, opened_at, closed_at FROM gates WHERE id = ?").run(second.id)).toThrow(/UNIQUE constraint failed/);
      // The cycle bound: a Run permitting one completion cycle refuses a second Gate after its first closed.
      const t = seedRun(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3, maxRunCompletionCycles: 1, runCompletionAcceptanceCriterionIds: [] } });
      seedRequirements(h, t, 1);
      const first = seedRunCompletionGate(h, t);
      h.stores.gates.close(first.gate.id, "failed", { kind: "final_reserve_exhausted", use: "final_synthesis" });
      h.stores.completionRequests.transition(first.request.id, { to: "failed", outcome: { kind: "final_reserve_exhausted", use: "final_synthesis" } });
      const again = seedCompletionRequest(h, t);
      expect(() => h.stores.gates.open({ ...input, runId: t.run.id, snapshotId: first.gate.snapshotId, completionRequestId: again.request.id, requirementRevisionId: first.gate.requirementRevisionId, requirementIds: first.gate.requirementIds })).toThrow(/permits 1/);
    } finally {
      h.close();
    }
  });

  it("records Evaluations of a run_completion Gate from no Plan Node, on the pinned Snapshot, for the Gate's criteria only", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s, 1);
      const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
      const stranger = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm lint", expectedExitCode: 0 } });
      const { gate } = seedRunCompletionGate(h, s, { acceptanceCriterionIds: [criterion.id] });
      const input = { runId: s.run.id, planNodeId: null, gateId: gate.id, subject: { kind: "acceptance_criterion" as const, acceptanceCriterionId: criterion.id }, context: null, snapshotId: gate.snapshotId, verdict: "pass" as const, evidence: [], producedBy: { kind: "runtime" as const }, artifactIds: [] };
      expect(() => h.stores.evaluations.record({ ...input, planNodeId: s.root.id })).toThrow(/no Plan Node/);
      expect(() => h.stores.evaluations.record({ ...input, snapshotId: seedSnapshot(h, s).id })).toThrow(/pinned Snapshot/);
      expect(() => h.stores.evaluations.record({ ...input, subject: { kind: "acceptance_criterion", acceptanceCriterionId: stranger.id } })).toThrow(/not a criterion of Gate/);
      const evaluation = h.stores.evaluations.record(input);
      expect(evaluation).toMatchObject({ gateId: gate.id, planNodeId: null, snapshotId: gate.snapshotId });
      expect(() => h.stores.evaluations.record(input)).toThrow(ConflictError);
      expect(h.stores.evaluations.gateCriterionEvaluationsOf(gate.id)).toEqual([evaluation]);
    } finally {
      h.close();
    }
  });

  it("creates the completion remediation Task on the root Plan Node for a failed run_completion Gate, once, and refuses any other node", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { gate } = seedRunCompletionGate(h, s);
      const worker = seedWorkerNode(h, s);
      const task = (overrides: Record<string, unknown>) => h.stores.tasks.create({ runId: s.run.id, planNodeId: s.root.id, origin: "runtime", gateId: gate.id, subject: "Remediate completion", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null, ...overrides } as never);
      expect(() => task({})).toThrow(/addresses a failed Gate/);
      h.stores.gates.close(gate.id, "failed", { kind: "conditions_unmet", conditions: [{ kind: "task_unfinished", taskId: `task_${"0".repeat(24)}`, status: "pending" }] });
      expect(() => task({ planNodeId: worker.id })).toThrow(/root Plan Node/);
      expect(() => task({ planNodeId: null })).toThrow(ValidationError);
      const created = task({});
      expect(created).toMatchObject({ gateId: gate.id, planNodeId: s.root.id, origin: "runtime", status: "pending" });
      expect(h.stores.tasks.remediationTaskOf(gate.id)?.id).toBe(created.id);
      expect(() => task({})).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("INSERT INTO tasks SELECT 'task_000000000000000000000000', run_id, ?, invocation_id, origin, gate_id, subject, requirement_ids, requirement_revision_id, input_artifact_ids, required_outputs, output_artifact_ids, evidence, status, block_reason, failure_reason, replaces_task_id, created_at, updated_at, ended_at FROM tasks WHERE id = ?").run(worker.id, created.id)).toThrow(/root plan node/);
    } finally {
      h.close();
    }
  });

  it("opens one operator_signoff Gate per passed request on the exact verified facts, with exactly one signoff Decision", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      seedRequirements(h, s, 1);
      const { gate, request } = seedRunCompletionGate(h, s);
      const base = { runId: s.run.id, planNodeId: null, kind: "operator_signoff" as const, acceptanceCriterionIds: [], snapshotId: gate.snapshotId, candidateArtifactIds: [], completionRequestId: request.id, requirementRevisionId: gate.requirementRevisionId, requirementIds: gate.requirementIds, completionGateId: gate.id, reportArtifactId: report(h, s).id };
      // Not before the completion Gate passed and the request passed.
      expect(() => h.stores.gates.open(base)).toThrow(/not the passed run_completion Gate/);
      const passed = pass(h, s, gate);
      expect(() => h.stores.gates.open(base)).toThrow(/presents the final-report Artifact/);
      expect(() => h.stores.gates.open({ ...base, reportArtifactId: passed.artifact.id, snapshotId: seedSnapshot(h, s).id })).toThrow(/verified Snapshot/);
      expect(() => h.stores.gates.open({ ...base, reportArtifactId: passed.artifact.id, requirementIds: [] })).toThrow(/exactly the Requirements/);
      expect(() => h.stores.gates.open({ ...base, reportArtifactId: passed.artifact.id, acceptanceCriterionIds: [] , kind: "operator_signoff", completionGateId: gate.id, requirementRevisionId: seedRequirements(h, seedRun(h), 1).revision.id })).toThrow(/another Conversation|Requirement revision/);
      const signoff = h.stores.gates.open({ ...base, reportArtifactId: passed.artifact.id });
      expect(signoff).toMatchObject({ kind: "operator_signoff", ordinal: 1, status: "open", completionGateId: gate.id, completionRequestId: request.id, snapshotId: gate.snapshotId, reportArtifactId: passed.artifact.id, requirementIds: gate.requirementIds });
      expect(() => h.stores.gates.open({ ...base, reportArtifactId: passed.artifact.id })).toThrow(ConflictError);
      expect(h.stores.gates.listByCompletionRequest(request.id).map((g) => g.kind)).toEqual(["run_completion", "operator_signoff"]);
      // The signoff Decision names exactly the Gate's facts, is operator_required, and exists once per Gate.
      expect(() => signoffRequest(h, s, signoff, { completionGateId: signoff.id })).toThrow(ValidationError);
      expect(() => signoffRequest(h, s, signoff, { snapshotId: seedSnapshot(h, s).id })).toThrow(/disagrees with the facts/);
      expect(() => signoffRequest(h, s, { ...signoff, id: gate.id, completionGateId: signoff.id })).toThrow(/not an operator_signoff Gate/);
      const decision = signoffRequest(h, s, signoff);
      expect(decision).toMatchObject({ kind: "signoff", status: "open", resolutionPolicy: "operator_required", subject: { kind: "signoff", gateId: signoff.id, completionGateId: gate.id, completionRequestId: request.id, snapshotId: gate.snapshotId, reportArtifactId: passed.artifact.id } });
      expect(decision.options.map((o) => o.id).sort()).toEqual(["accept", "request_changes"]);
      expect(h.stores.decisions.signoffOf(signoff.id)?.id).toBe(decision.id);
      expect(() => signoffRequest(h, s, signoff)).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("INSERT INTO decisions SELECT 'dec_000000000000000000000000', conversation_id, run_id, kind, resolution_policy, status, requested_by, question, options, recommended_option_id, rationale, affects, deadline_at, activation_condition, subject, resolved_by, chosen_option_id, resolution_rationale, resolution_artifact_ids, resolved_at, supersedes_decision_id, superseded_by_decision_id, supersession_reason, created_at FROM decisions WHERE id = ?").run(decision.id)).toThrow(/UNIQUE constraint failed: decisions\.subject_gate_id/);
      // Only the operator resolves it; nothing here resolves anything.
      expect(() => h.stores.decisions.resolve(decision.id, { resolvedBy: "orchestrator", chosenOptionId: "accept", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(h.stores.decisions.get(decision.id).status).toBe("open");
    } finally {
      h.close();
    }
  });
});
