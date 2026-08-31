/**
 * The Run completion engine (execution-model §3, §10 `run_completion` and
 * `operator_signoff`; invariants 12 and 13): the one runtime component that
 * begins an accepted Completion Request, opens and drives the Run's
 * `run_completion` Gate, derives Requirement statuses from the Gate's
 * Evaluations, produces the read-only final synthesis and its canonical
 * report Artifact, and opens the operator-signoff boundary — or, on any
 * failure, closes the Gate, ends the request, creates the one completion
 * remediation Task, and returns the Run to `running`. No agent schedules,
 * waits for, retries, or closes any of it, and nothing here reads a
 * transcript, an Event, or process memory: every phase is derived from the
 * Completion Request, Gate, Evaluation, Requirement, Invocation, and Task
 * rows, so a repeated pass repeats nothing.
 *
 * The lifecycle, from rows alone:
 *
 * 1. `running`, request `requested`: the requesting root turn settles through
 *    the root support (execution, integration of its Changeset). Once it
 *    succeeded and is integrated, `begin` revalidates every precondition and,
 *    in one transaction, pins the integration Snapshot, the current
 *    Requirement revision, its leaf Requirements, the criterion set, and the
 *    candidate Artifacts; moves the Run `running → verifying`; opens the
 *    `run_completion` Gate; and moves the request `requested → verifying`.
 *    A requesting turn that did not complete cancels the request; drifted
 *    preconditions cancel it with the exact codes.
 * 2. `verifying`: deterministic criteria run in id order through the shared
 *    check service (external, recorded once each); the first failure ends
 *    them. Evaluated criteria are judged by one read-only Gate Evaluator
 *    funded from the final reserve. Every verdict recorded, the Requirement
 *    statuses are derived and recorded; the structural completion conditions
 *    are evaluated; one read-only `final_synthesis` turn, funded from the
 *    final reserve, produces the typed report; and one transaction stores
 *    the report Artifact, closes the Gate `passed`, ends the request
 *    `passed`, opens the `operator_signoff` Gate with its one `signoff`
 *    Decision, and moves the Run `verifying → awaiting_signoff`.
 * 3. Any failure — criteria, Evaluator, conditions, synthesis, final reserve
 *    — closes the Gate `failed` with the closed fact, ends the request
 *    `failed`, creates the one remediation Task on the root, and returns the
 *    Run to `running`; the root's batched `gate_result` turn remediates.
 *    Completion is never retried automatically.
 */
import {
  approvalSubjectOf,
  decisionResolutionInputOf,
  canonicalFinalReport,
  FINAL_REPORT_MEDIA_TYPE,
  INVOCATION_MACHINE,
  InvariantViolationError,
  operationAt,
  ROOT_SOURCE_PATH,
  SIGNOFF_OPTIONS,
  TASK_MACHINE,
  type AcceptanceCriterion,
  type AcceptanceCriterionId,
  type ArtifactId,
  type CompletionCondition,
  type CompletionRequest,
  type CompletionRequestOutcome,
  type Decision,
  type Evaluation,
  type EvaluatorResult,
  type Evidence,
  type FinalReport,
  type Gate,
  type GateFailure,
  type Invocation,
  type ManifestInput,
  type PatternPlanNode,
  type RequirementId,
  type RequirementRevision,
  type RequirementStatus,
  type Run,
  type RunId,
  type Task,
  type Timestamp,
} from "@agentique-console/core";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { AcceptanceCriterionExecutionFailure } from "./ports/acceptance-criterion-execution.ts";
import { CompletionFacts, type CompletionCriteria } from "./completion-requests.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf } from "./invocation-facts.ts";
import type { PatternRunnerDependencies } from "./patterns/support.ts";
import { deriveRequirementStatuses, type DerivedStatusChange } from "./requirement-derivation.ts";

/** Where a Run's completion stands, from rows alone. */
export type CompletionPhase =
  | { kind: "idle" }
  /** The requesting root turn is still executing, blocked on an open Decision, or awaiting integration; the root support drives it. */
  | { kind: "turn_pending"; request: CompletionRequest }
  | { kind: "ready_to_begin"; request: CompletionRequest }
  /** The requesting turn ended without completing: the request is cancelled. */
  | { kind: "cancel"; request: CompletionRequest; outcome: CompletionRequestOutcome }
  | { kind: "checks_pending"; request: CompletionRequest; gate: Gate }
  | { kind: "checks_failed"; request: CompletionRequest; gate: Gate; failed: Evaluation }
  | { kind: "evaluator_pending"; request: CompletionRequest; gate: Gate }
  | { kind: "evaluator_active"; request: CompletionRequest; gate: Gate; invocation: Invocation }
  | { kind: "evaluator_blocked"; request: CompletionRequest; gate: Gate; invocation: Invocation; decision: Decision }
  | { kind: "evaluator_terminal"; request: CompletionRequest; gate: Gate; invocation: Invocation }
  | { kind: "judged_failed"; request: CompletionRequest; gate: Gate; failedIds: AcceptanceCriterionId[] }
  /** Every criterion passed; the derived Requirement statuses are not yet recorded. */
  | { kind: "derive_pending"; request: CompletionRequest; gate: Gate; changes: DerivedStatusChange[] }
  | { kind: "conditions_unmet"; request: CompletionRequest; gate: Gate; conditions: CompletionCondition[] }
  | { kind: "synthesis_pending"; request: CompletionRequest; gate: Gate }
  | { kind: "synthesis_active"; request: CompletionRequest; gate: Gate; invocation: Invocation }
  | { kind: "synthesis_blocked"; request: CompletionRequest; gate: Gate; invocation: Invocation; decision: Decision }
  | { kind: "synthesis_terminal"; request: CompletionRequest; gate: Gate; invocation: Invocation };

/** The scheduler-facing advice of the engine. */
export type CompletionAdvice =
  | { kind: "none" }
  | { kind: "begin"; completionRequestId: CompletionRequest["id"] }
  | { kind: "complete"; completionRequestId: CompletionRequest["id"] }
  | { kind: "checks"; gateId: Gate["id"] }
  | { kind: "prepare_evaluator"; gateId: Gate["id"] }
  | { kind: "execute"; invocationId: Invocation["id"] }
  | { kind: "attempt_in_flight"; invocationId: Invocation["id"] }
  | { kind: "retry_not_before"; invocationId: Invocation["id"]; notBefore: Timestamp }
  | { kind: "settle_evaluator"; gateId: Gate["id"]; invocationId: Invocation["id"] }
  /** A completion Invocation ended blocked on an open Decision; the Run waits (it cannot leave `verifying` for `waiting`). */
  | { kind: "blocked"; invocationId: Invocation["id"]; decisionId: Decision["id"] }
  | { kind: "derive"; gateId: Gate["id"] }
  | { kind: "prepare_synthesis"; gateId: Gate["id"] }
  | { kind: "settle_synthesis"; gateId: Gate["id"]; invocationId: Invocation["id"] };

/** The failures a `run_completion` Gate records; `changes_requested` belongs to the `operator_signoff` Gate alone. */
type CompletionGateFailure = Exclude<GateFailure, { kind: "changes_requested" }>;

export type CompletionOutcome =
  | { kind: "completion_begun"; completionRequestId: CompletionRequest["id"]; gateId: Gate["id"]; ordinal: number; snapshotId: string }
  | { kind: "completion_cancelled"; completionRequestId: CompletionRequest["id"]; outcome: CompletionRequestOutcome }
  | { kind: "completion_verified"; gateId: Gate["id"]; verdict: "pass" | "fail"; evaluationIds: Evaluation["id"][] }
  | { kind: "completion_verification_failed"; gateId: Gate["id"]; acceptanceCriterionId: AcceptanceCriterionId; failure: AcceptanceCriterionExecutionFailure; message: string }
  | { kind: "completion_evaluator_prepared"; gateId: Gate["id"]; invocationId: Invocation["id"] }
  | { kind: "completion_evaluations_recorded"; gateId: Gate["id"]; evaluationIds: Evaluation["id"][] }
  | { kind: "requirement_statuses_derived"; gateId: Gate["id"]; changes: { requirementId: RequirementId; from: RequirementStatus; to: RequirementStatus }[] }
  | { kind: "final_synthesis_prepared"; gateId: Gate["id"]; invocationId: Invocation["id"] }
  | { kind: "completion_passed"; completionRequestId: CompletionRequest["id"]; gateId: Gate["id"]; reportArtifactId: ArtifactId; signoffGateId: Gate["id"]; decisionId: Decision["id"] }
  | { kind: "completion_failed"; completionRequestId: CompletionRequest["id"]; gateId: Gate["id"]; remediationTaskId: string; outcome: CompletionRequestOutcome }
  | { kind: "successor_prepared"; invocationId: Invocation["id"]; decisionId: Decision["id"] }
  | { kind: "no_change" };

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class RunCompletionEngine {
  private readonly facts: CompletionFacts;

  constructor(private readonly deps: PatternRunnerDependencies) {
    this.facts = new CompletionFacts(deps.stores);
  }

  private get stores() {
    return this.deps.stores;
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  private root(run: Run): PatternPlanNode {
    return this.facts.root(run);
  }

  /** The Gate's criteria by kind, in canonical id order. */
  criteriaOfGate(gate: Gate): CompletionCriteria {
    const criteria = [...gate.acceptanceCriterionIds].sort().map((id) => this.stores.requirements.getAcceptanceCriterion(id));
    return { deterministic: criteria.filter((c) => c.check.kind === "deterministic"), evaluated: criteria.filter((c) => c.check.kind === "evaluated").map((c) => c.id), all: criteria.map((c) => c.id) };
  }

  /**
   * The head of the requesting logical turn: the requesting Invocation, or
   * the latest successor that continues (through blocked predecessors) from
   * it at the root position.
   */
  private requestingTurnOf(request: CompletionRequest): Invocation {
    let current = this.stores.invocations.get(request.invocationId);
    const turns = this.stores.invocations.listAtPosition(current.planNodeId, "orchestrator");
    for (;;) {
      if (current.status !== "blocked") return current;
      const successor = turns.find((t) => t.continuedFromInvocationId === current.id);
      if (successor === undefined) return current;
      current = successor;
    }
  }

  /** The Run's completion phase from rows alone. */
  phaseOf(runId: RunId): CompletionPhase {
    const run = this.stores.runs.get(runId);
    const request = this.stores.completionRequests.activeOf(runId);
    if (request === null) {
      if (run.status === "verifying") throw new InvariantViolationError(`Run ${runId} is verifying without an active Completion Request`, { runId });
      return { kind: "idle" };
    }
    if (request.status === "requested") {
      const turn = this.requestingTurnOf(request);
      if (!INVOCATION_MACHINE.isTerminal(turn.status)) return { kind: "turn_pending", request };
      if (turn.status === "blocked") {
        const decision = blockingDecisionOf(this.stores, turn);
        if (decision === null || decision.status === "superseded") return { kind: "cancel", request, outcome: { kind: "requesting_turn_failed", invocationId: turn.id } };
        // Open: the operator decides; resolved: the root support prepares the successor.
        return { kind: "turn_pending", request };
      }
      if (turn.status === "succeeded" && turn.result?.status === "completed") {
        if (outstandingChangesetOf(this.stores, turn) !== null) return { kind: "turn_pending", request };
        return { kind: "ready_to_begin", request };
      }
      if (turn.status === "succeeded" && turn.result?.status === "blocked" && blockingDecisionOf(this.stores, turn) !== null) return { kind: "turn_pending", request };
      return { kind: "cancel", request, outcome: { kind: "requesting_turn_failed", invocationId: turn.id } };
    }
    const gate = this.stores.gates.get(request.gateId!);
    if (gate.status !== "open") throw new InvariantViolationError(`Completion Request ${request.id} is verifying on ${gate.status} Gate ${gate.id}`, { completionRequestId: request.id, gateId: gate.id });
    const { deterministic, evaluated } = this.criteriaOfGate(gate);
    const recorded = new Map(this.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : ("" as AcceptanceCriterionId), e] as const));
    for (const criterion of deterministic) {
      const evaluation = recorded.get(criterion.id);
      if (evaluation === undefined) return { kind: "checks_pending", request, gate };
      if (evaluation.verdict !== "pass") return { kind: "checks_failed", request, gate, failed: evaluation };
    }
    if (!evaluated.every((id) => recorded.has(id))) {
      const invocation = this.stores.invocations.latestByGate(gate.id);
      if (invocation === null) return { kind: "evaluator_pending", request, gate };
      if (!INVOCATION_MACHINE.isTerminal(invocation.status)) return { kind: "evaluator_active", request, gate, invocation };
      const decision = blockedOn(this.stores, invocation);
      if (decision !== null) return { kind: "evaluator_blocked", request, gate, invocation, decision };
      return { kind: "evaluator_terminal", request, gate, invocation };
    }
    const failedIds = [...recorded.values()].filter((e) => e.verdict !== "pass").flatMap((e) => (e.subject.kind === "acceptance_criterion" ? [e.subject.acceptanceCriterionId] : []));
    if (failedIds.length > 0) return { kind: "judged_failed", request, gate, failedIds: failedIds.sort() };
    const changes = this.derivedChanges(run, gate, recorded);
    if (changes.length > 0) return { kind: "derive_pending", request, gate, changes };
    const conditions = this.conditionsOf(run, gate, recorded);
    if (conditions.length > 0) return { kind: "conditions_unmet", request, gate, conditions };
    const synthesis = this.stores.invocations.latestSynthesisByGate(gate.id);
    if (synthesis === null) return { kind: "synthesis_pending", request, gate };
    if (!INVOCATION_MACHINE.isTerminal(synthesis.status)) return { kind: "synthesis_active", request, gate, invocation: synthesis };
    const decision = blockedOn(this.stores, synthesis);
    if (decision !== null) return { kind: "synthesis_blocked", request, gate, invocation: synthesis, decision };
    return { kind: "synthesis_terminal", request, gate, invocation: synthesis };
  }

  /** The scheduler-facing advice; `now` decides an active Invocation's readiness. */
  advice(runId: RunId, now: Timestamp = this.deps.ctx.clock()): CompletionAdvice {
    const phase = this.phaseOf(runId);
    switch (phase.kind) {
      case "idle":
      case "turn_pending":
        return { kind: "none" };
      case "ready_to_begin":
        return { kind: "begin", completionRequestId: phase.request.id };
      case "cancel":
      case "checks_failed":
      case "judged_failed":
      case "conditions_unmet":
        return { kind: "complete", completionRequestId: phase.request.id };
      case "checks_pending":
        return { kind: "checks", gateId: phase.gate.id };
      case "evaluator_pending":
        return { kind: "prepare_evaluator", gateId: phase.gate.id };
      case "evaluator_active":
      case "synthesis_active":
        return activeInvocationAdvice(this.deps.executor, phase.invocation, now);
      case "evaluator_blocked":
      case "synthesis_blocked":
        if (phase.decision.status === "open") return { kind: "blocked", invocationId: phase.invocation.id, decisionId: phase.decision.id };
        return phase.kind === "evaluator_blocked" ? { kind: "settle_evaluator", gateId: phase.gate.id, invocationId: phase.invocation.id } : { kind: "settle_synthesis", gateId: phase.gate.id, invocationId: phase.invocation.id };
      case "evaluator_terminal":
        return { kind: "settle_evaluator", gateId: phase.gate.id, invocationId: phase.invocation.id };
      case "derive_pending":
        return { kind: "derive", gateId: phase.gate.id };
      case "synthesis_pending":
        return { kind: "prepare_synthesis", gateId: phase.gate.id };
      case "synthesis_terminal":
        return { kind: "settle_synthesis", gateId: phase.gate.id, invocationId: phase.invocation.id };
    }
  }

  // ---------------------------------------------------------------------------
  // Derivation and structural conditions (pure over rows)
  // ---------------------------------------------------------------------------

  private revisionOf(gate: Gate): RequirementRevision {
    return this.stores.requirements.getRevision(gate.requirementRevisionId!);
  }

  /** The status changes the Gate's Evaluations imply over the pinned tree; empty once they are recorded. */
  private derivedChanges(run: Run, gate: Gate, recorded: ReadonlyMap<AcceptanceCriterionId, Evaluation>): DerivedStatusChange[] {
    const revision = this.revisionOf(gate);
    const statuses = new Map(revision.tree.map((e) => [e.id, this.stores.requirements.get(e.id).status] as const));
    const gateCriteria = new Set(gate.acceptanceCriterionIds);
    const criteriaByLeaf = new Map<RequirementId, AcceptanceCriterionId[]>();
    for (const entry of this.facts.leafEntries(revision)) {
      criteriaByLeaf.set(entry.id, this.facts.leafCriteria(revision, entry).map((c) => c.id).filter((id) => gateCriteria.has(id)));
    }
    return deriveRequirementStatuses({
      revision,
      statuses,
      criteriaByLeaf,
      evaluations: recorded,
      currentEvidence: (id) => this.stores.requirements.history(id).at(-1)?.evidence ?? [],
    });
  }

  /** The structural conditions that keep the Gate from passing once every criterion passed and every status is derived. */
  private conditionsOf(run: Run, gate: Gate, recorded: ReadonlyMap<AcceptanceCriterionId, Evaluation>): CompletionCondition[] {
    const conditions: CompletionCondition[] = [];
    for (const id of gate.acceptanceCriterionIds) {
      const evaluation = recorded.get(id);
      if (evaluation === undefined) conditions.push({ kind: "criterion_unjudged", acceptanceCriterionId: id });
      else if (evaluation.verdict !== "pass") conditions.push({ kind: "requirement_unsatisfied", requirementId: (this.stores.requirements.getAcceptanceCriterion(id).requirementId ?? id) as RequirementId, status: "violated" });
    }
    for (const id of gate.requirementIds) {
      const status = this.stores.requirements.get(id).status;
      if (status !== "satisfied" && status !== "waived" && status !== "retired") conditions.push({ kind: "requirement_unsatisfied", requirementId: id, status });
    }
    for (const task of this.facts.currentTasks(run)) {
      if (task.status !== "completed" && task.status !== "cancelled") conditions.push({ kind: "task_unfinished", taskId: task.id, status: task.status });
    }
    for (const decision of this.facts.openOperatorDecisions(run)) conditions.push({ kind: "decision_unresolved", decisionId: decision.id });
    for (const changeset of this.stores.changesets.listByRun(run.id)) {
      if (changeset.kind === "invocation" && changeset.integrationStatus !== "integrated") conditions.push({ kind: "changeset_unintegrated", changesetId: changeset.id, status: changeset.integrationStatus });
    }
    for (const node of this.stores.gates.listByKind(run.id, "node_exit")) {
      if (node.status === "open") conditions.push({ kind: "node_gate_open", gateId: node.id, planNodeId: node.planNodeId! });
    }
    for (const task of this.stores.tasks.listRemediationTasks(run.id)) {
      if (!TASK_MACHINE.isTerminal(task.status) && this.stores.gates.get(task.gateId!).kind === "node_exit") conditions.push({ kind: "node_gate_open", gateId: task.gateId!, planNodeId: task.planNodeId! });
    }
    for (const node of this.stores.plans.currentGraph(run.id).nodes) {
      if (node.sourcePath === ROOT_SOURCE_PATH) continue;
      if (node.status === "failed" || !["succeeded", "cancelled", "skipped"].includes(node.status)) conditions.push({ kind: "node_unfinished", planNodeId: node.id, status: node.status });
    }
    const current = this.facts.integrationSnapshotId(run);
    if (current !== gate.snapshotId) conditions.push({ kind: "snapshot_moved", pinnedSnapshotId: gate.snapshotId!, currentSnapshotId: current });
    return conditions;
  }

  // ---------------------------------------------------------------------------
  // Beginning verification
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: the request is `requested` and its turn settled;
   * every precondition is revalidated; the Snapshot, revision, leaf set,
   * criterion set, and candidate are pinned; the Run enters `verifying`; the
   * Gate opens; the request enters `verifying`. Drift cancels the request
   * with its exact codes instead.
   */
  begin(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      if (phase.kind === "cancel") return this.cancel(phase.request, phase.outcome, options);
      if (phase.kind !== "ready_to_begin") return { kind: "no_change" };
      const run = this.stores.runs.get(runId);
      const request = phase.request;
      const codes = this.facts.preflight(run, request.invocationId);
      if (codes.length > 0) {
        const outcome: CompletionRequestOutcome = codes.includes("run_completion_cycles_exhausted") ? { kind: "run_completion_cycles_exhausted", maxRunCompletionCycles: run.verificationPolicy.maxRunCompletionCycles } : { kind: "preconditions_changed", codes };
        return this.cancel(request, outcome, options);
      }
      const revision = this.facts.pinnedRevision(run);
      if (revision === null) return this.cancel(request, { kind: "preconditions_changed", codes: ["no_deterministic_completion_criterion"] }, options);
      const criteria = this.facts.criteriaOf(run, revision);
      const snapshotId = this.facts.integrationSnapshotId(run)!;
      const candidate = this.facts.candidateArtifactIds(run);
      this.stores.runs.transition(run.id, { to: "verifying" }, options);
      const gate = this.stores.gates.open(
        { runId: run.id, planNodeId: null, kind: "run_completion", acceptanceCriterionIds: criteria.all, snapshotId, candidateArtifactIds: candidate, completionRequestId: request.id, requirementRevisionId: revision.id, requirementIds: this.facts.leafIds(revision) },
        options,
      );
      this.stores.completionRequests.transition(request.id, { to: "verifying", gateId: gate.id }, options);
      return { kind: "completion_begun", completionRequestId: request.id, gateId: gate.id, ordinal: gate.ordinal, snapshotId };
    });
  }

  /** Cancels the active `requested` request whose requesting turn ended without completing (called by the root support before it fails the Run). */
  cancelEndedRequest(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      return phase.kind === "cancel" ? this.cancel(phase.request, phase.outcome, options) : { kind: "no_change" };
    });
  }

  private cancel(request: CompletionRequest, outcome: CompletionRequestOutcome, options: WriteOptions): CompletionOutcome {
    this.stores.completionRequests.transition(request.id, { to: "cancelled", outcome }, options);
    return { kind: "completion_cancelled", completionRequestId: request.id, outcome };
  }

  // ---------------------------------------------------------------------------
  // Deterministic checks (external)
  // ---------------------------------------------------------------------------

  /** Runs the Gate's pending deterministic criteria in canonical order, outside any transaction, recording each once. */
  async verify(runId: RunId, options: WriteOptions = {}): Promise<CompletionOutcome> {
    const { ctx, checks } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("completion checks run outside any transaction; command execution is external");
    const phase = this.phaseOf(runId);
    if (phase.kind !== "checks_pending") return { kind: "no_change" };
    const gate = phase.gate;
    const outcome = await checks.run({ runId, planNodeId: null, scope: { kind: "gate", gateId: gate.id }, snapshotId: gate.snapshotId!, artifactIds: gate.candidateArtifactIds, criteria: this.criteriaOfGate(gate).deterministic }, options);
    if (outcome.kind === "infrastructure_failure") return { kind: "completion_verification_failed", gateId: gate.id, acceptanceCriterionId: outcome.acceptanceCriterionId, failure: outcome.failure, message: outcome.message };
    return { kind: "completion_verified", gateId: gate.id, verdict: outcome.kind === "passed" ? "pass" : "fail", evaluationIds: outcome.checks.map((c) => c.evaluation.id) };
  }

  // ---------------------------------------------------------------------------
  // The Gate Evaluator (final reserve)
  // ---------------------------------------------------------------------------

  private evaluatorAllocation(run: Run) {
    const revisionId = run.verificationPolicy.evaluatorAgentDefinitionRevisionId;
    if (revisionId === null) throw new InvariantViolationError(`Run ${run.id} names no Gate Evaluator; the completion preflight admits no evaluated criterion without one`, { runId: run.id });
    return { revisionId, allocation: this.stores.agents.getRevision(revisionId).defaultLimits.allocation };
  }

  /** In one root transaction: the Gate's one read-only Evaluator, funded directly from the Run's final reserve; an unfundable one fails the request. */
  prepareEvaluator(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      if (phase.kind !== "evaluator_pending") return { kind: "no_change" };
      const run = this.stores.runs.get(runId);
      return this.prepareEvaluatorFor(run, phase.request, phase.gate, null, [], options);
    });
  }

  private candidateInput(run: Run, request: CompletionRequest, gate: Gate): ManifestInput {
    return { kind: "gate_candidate", gateId: gate.id, gateKind: "run_completion", snapshotId: gate.snapshotId!, artifactIds: gate.candidateArtifactIds, acceptanceCriterionIds: this.criteriaOfGate(gate).evaluated, completionRequestId: request.id, requirementRevisionId: gate.requirementRevisionId, tasks: this.facts.taskLedger(run) };
  }

  private prepareEvaluatorFor(run: Run, request: CompletionRequest, gate: Gate, predecessor: Invocation | null, extraInputs: ManifestInput[], options: WriteOptions): CompletionOutcome {
    const { revisionId, allocation } = this.evaluatorAllocation(run);
    if (!this.facts.finalReserveFits(run, allocation)) return this.fail(run, request, gate, { kind: "final_reserve_exhausted", use: "run_completion" }, options);
    const prepared = this.deps.preparation.prepare({
      runId: run.id,
      planNodeId: this.root(run).id,
      role: "evaluator",
      purpose: "evaluate",
      patternPosition: null,
      gateId: gate.id,
      agentDefinitionRevisionId: revisionId,
      continuedFromInvocationId: predecessor?.id ?? null,
      funding: { source: "run_final_reserve", use: "run_completion" },
      inputs: [this.candidateInput(run, request, gate), ...extraInputs],
      artifactIds: gate.candidateArtifactIds,
      correlationId: options.correlationId ?? null,
      causationSeq: options.causationSeq ?? null,
    });
    return { kind: "completion_evaluator_prepared", gateId: gate.id, invocationId: prepared.invocation.id };
  }

  /** In one root transaction: the Evaluator's verdicts as Evaluations, a failed Gate on any failure, or the successor of a blocked Evaluator. */
  settleEvaluator(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      const run = this.stores.runs.get(runId);
      if (phase.kind === "evaluator_blocked") {
        if (phase.decision.status === "open") return { kind: "no_change" };
        return this.successor(run, phase.request, phase.gate, phase.invocation, phase.decision, options);
      }
      if (phase.kind !== "evaluator_terminal") return { kind: "no_change" };
      const { request, gate, invocation } = phase;
      if (invocation.status !== "succeeded" || invocation.result === null || invocation.result.status !== "completed") return this.fail(run, request, gate, { kind: "evaluator_failed", invocationId: invocation.id }, options);
      const evaluation = invocation.result.evaluation;
      if (evaluation === null) throw new InvariantViolationError(`Evaluator Invocation ${invocation.id} completed without an evaluation; the result validator admits none`, { invocationId: invocation.id });
      this.recordEvaluations(run, gate, invocation, evaluation, options);
      const verdicts = this.stores.evaluations.gateCriterionEvaluationsOf(gate.id);
      const recorded = new Set(verdicts.map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")));
      if (!this.criteriaOfGate(gate).all.every((id) => recorded.has(id))) return { kind: "completion_evaluations_recorded", gateId: gate.id, evaluationIds: verdicts.map((e) => e.id) };
      const failedIds = verdicts.filter((e) => e.verdict !== "pass").flatMap((e) => (e.subject.kind === "acceptance_criterion" ? [e.subject.acceptanceCriterionId] : []));
      if (failedIds.length > 0) return this.fail(run, request, gate, { kind: "criteria_failed", acceptanceCriterionIds: failedIds.sort() }, options);
      return { kind: "completion_evaluations_recorded", gateId: gate.id, evaluationIds: verdicts.map((e) => e.id) };
    });
  }

  private recordEvaluations(run: Run, gate: Gate, evaluator: Invocation, evaluation: EvaluatorResult, options: WriteOptions): void {
    const existing = new Set(this.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")));
    const producedBy = { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: evaluator.agentDefinitionRevisionId };
    for (const criterion of [...evaluation.criteria].sort((a, b) => (a.acceptanceCriterionId < b.acceptanceCriterionId ? -1 : 1))) {
      if (existing.has(criterion.acceptanceCriterionId)) continue;
      this.stores.evaluations.record(
        { runId: run.id, planNodeId: null, gateId: gate.id, subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion.acceptanceCriterionId }, context: null, verdict: criterion.verdict, evidence: criterion.evidence, producedBy, artifactIds: gate.candidateArtifactIds, snapshotId: gate.snapshotId },
        options,
      );
    }
  }

  /** The successor of a completion Invocation blocked on a now-resolved Decision: the same Gate and typed inputs, continuing from the blocked one. */
  private successor(run: Run, request: CompletionRequest, gate: Gate, predecessor: Invocation, decision: Decision, options: WriteOptions): CompletionOutcome {
    if (decision.status !== "resolved" || decision.resolution === null) {
      const failure: CompletionGateFailure = predecessor.purpose === "final_synthesis" ? { kind: "final_synthesis_failed", invocationId: predecessor.id } : { kind: "evaluator_failed", invocationId: predecessor.id };
      return this.fail(run, request, gate, failure, options);
    }
    const resolution: ManifestInput =
      predecessor.status === "blocked" && decision.kind === "side_effect_approval"
        ? { kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: predecessor.id, attemptId: approvalSubjectOf(decision).attemptId, tool: approvalSubjectOf(decision).tool, callDigest: approvalSubjectOf(decision).callDigest, callArtifactId: approvalSubjectOf(decision).callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" }
        : decisionResolutionInputOf(decision);
    const prepared = predecessor.purpose === "final_synthesis" ? this.prepareSynthesisFor(run, request, gate, predecessor, [resolution], options) : this.prepareEvaluatorFor(run, request, gate, predecessor, [resolution], options);
    if (prepared.kind !== "completion_evaluator_prepared" && prepared.kind !== "final_synthesis_prepared") return prepared;
    return { kind: "successor_prepared", invocationId: prepared.invocationId, decisionId: decision.id };
  }

  // ---------------------------------------------------------------------------
  // Requirement derivation
  // ---------------------------------------------------------------------------

  /** In one root transaction: every derived status change, each referencing the Gate and its Evaluation Evidence; nothing for an unchanged status. */
  derive(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      if (phase.kind !== "derive_pending") return { kind: "no_change" };
      const { gate, changes } = phase;
      for (const change of changes) {
        this.stores.requirements.recordStatusChange({ requirementId: change.requirementId, runId, to: change.to, actor: "runtime", evidence: change.evidence, gateId: gate.id, decisionId: null, rationale: change.rationale }, options);
      }
      return { kind: "requirement_statuses_derived", gateId: gate.id, changes: changes.map((c) => ({ requirementId: c.requirementId, from: c.from, to: c.to })) };
    });
  }

  // ---------------------------------------------------------------------------
  // Final synthesis (final reserve, read-only)
  // ---------------------------------------------------------------------------

  private synthesisAllocation(run: Run) {
    const root = this.root(run);
    const operation = operationAt(root.shape, { kind: "orchestrator" });
    if (operation === null) throw new InvariantViolationError(`root PlanNode ${root.id} has no orchestrator position`, { planNodeId: root.id });
    return this.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
  }

  /** The typed final-synthesis input: canonical completion facts only. */
  private synthesisInput(run: Run, request: CompletionRequest, gate: Gate): ManifestInput {
    const revision = this.revisionOf(gate);
    const requirements = this.facts.leafEntries(revision).map((entry) => {
      const requirement = this.stores.requirements.get(entry.id);
      const waiver = requirement.status === "waived" ? (this.stores.requirements.history(entry.id).findLast((c) => c.to === "waived")?.decisionId ?? null) : null;
      return { requirementId: entry.id, status: requirement.status, waiverDecisionId: waiver };
    });
    const evaluations = this.stores.evaluations
      .gateCriterionEvaluationsOf(gate.id)
      .map((e) => ({ evaluationId: e.id, acceptanceCriterionId: e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : ("" as AcceptanceCriterionId), verdict: e.verdict, producedBy: e.producedBy.kind, evidence: e.evidence }))
      .sort((a, b) => (a.evaluationId < b.evaluationId ? -1 : 1));
    const usage = this.stores.usage.totalsForRun(run.id);
    const attempts = this.stores.invocations.listByRun(run.id).reduce((n, i) => n + this.stores.invocations.attemptsConsumed(i.id), 0);
    const capacity = this.stores.reservations.runCapacity(run.id);
    return {
      kind: "final_synthesis",
      completionRequestId: request.id,
      gateId: gate.id,
      snapshotId: gate.snapshotId!,
      requirementRevisionId: gate.requirementRevisionId!,
      requirements,
      evaluations,
      tasks: this.facts.taskLedger(run),
      artifactIds: gate.candidateArtifactIds,
      usage: { costUsd: usage.costUsd, tokens: usage.inputTokensUncached + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens, attempts },
      // The effective final-reserve limit: the immutable base reserve plus approved final-reserve Budget Increases.
      finalReserve: { limit: capacity.finalReserve, consumed: capacity.final.committed },
      unresolved: [],
    };
  }

  /** In one root transaction: the one read-only final-synthesis turn, funded directly from the final reserve; an unfundable one fails the request. */
  prepareSynthesis(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      if (phase.kind !== "synthesis_pending") return { kind: "no_change" };
      const run = this.stores.runs.get(runId);
      return this.prepareSynthesisFor(run, phase.request, phase.gate, null, [], options);
    });
  }

  private prepareSynthesisFor(run: Run, request: CompletionRequest, gate: Gate, predecessor: Invocation | null, extraInputs: ManifestInput[], options: WriteOptions): CompletionOutcome {
    if (!this.facts.finalReserveFits(run, this.synthesisAllocation(run))) return this.fail(run, request, gate, { kind: "final_reserve_exhausted", use: "final_synthesis" }, options);
    const root = this.root(run);
    const latest = this.stores.invocations.latestAtPosition(root.id, "orchestrator");
    const prepared = this.deps.preparation.prepare({
      runId: run.id,
      planNodeId: root.id,
      role: "orchestrator",
      purpose: "final_synthesis",
      patternPosition: { kind: "orchestrator" },
      gateId: gate.id,
      continuedFromInvocationId: predecessor?.id ?? latest?.id ?? null,
      funding: { source: "run_final_reserve", use: "final_synthesis" },
      inputs: [this.synthesisInput(run, request, gate), ...extraInputs],
      artifactIds: gate.candidateArtifactIds,
      correlationId: options.correlationId ?? null,
      causationSeq: options.causationSeq ?? null,
    });
    return { kind: "final_synthesis_prepared", gateId: gate.id, invocationId: prepared.invocation.id };
  }

  /**
   * In one root transaction: a completed synthesis becomes the canonical
   * final-report Artifact, the Gate closes `passed` with it, the request
   * passes, the `operator_signoff` Gate opens with its one `signoff`
   * Decision, and the Run enters `awaiting_signoff`; a failed synthesis
   * fails the request; a blocked one continues in a successor.
   */
  settleSynthesis(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      const run = this.stores.runs.get(runId);
      if (phase.kind === "synthesis_blocked") {
        if (phase.decision.status === "open") return { kind: "no_change" };
        return this.successor(run, phase.request, phase.gate, phase.invocation, phase.decision, options);
      }
      if (phase.kind !== "synthesis_terminal") return { kind: "no_change" };
      const { request, gate, invocation } = phase;
      if (invocation.status !== "succeeded" || invocation.result === null || invocation.result.status !== "completed" || invocation.result.finalReport === null) {
        return this.fail(run, request, gate, { kind: "final_synthesis_failed", invocationId: invocation.id }, options);
      }
      // The structural conditions still hold at this moment; the verified Snapshot is the one the operator is asked to accept.
      const recorded = new Map(this.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : ("" as AcceptanceCriterionId), e] as const));
      const conditions = this.conditionsOf(run, gate, recorded);
      if (conditions.length > 0) return this.fail(run, request, gate, { kind: "conditions_unmet", conditions }, options);
      const report: FinalReport = { version: 1, runId: run.id, completionRequestId: request.id, gateId: gate.id, snapshotId: gate.snapshotId!, requirementRevisionId: gate.requirementRevisionId!, report: invocation.result.finalReport };
      const artifact = this.stores.artifacts.create(
        { runId: run.id, mediaType: FINAL_REPORT_MEDIA_TYPE, producer: { kind: "runtime", component: "final_report" }, taskId: null, title: `final report of ${request.id}` },
        new TextEncoder().encode(canonicalFinalReport(report)),
        options,
      );
      this.stores.gates.close(gate.id, "passed", null, { ...options, reportArtifactId: artifact.id });
      this.stores.completionRequests.transition(request.id, { to: "passed", reportArtifactId: artifact.id }, options);
      const signoff = this.stores.gates.open(
        { runId: run.id, planNodeId: null, kind: "operator_signoff", acceptanceCriterionIds: [], snapshotId: gate.snapshotId, candidateArtifactIds: gate.candidateArtifactIds, completionRequestId: request.id, requirementRevisionId: gate.requirementRevisionId, requirementIds: gate.requirementIds, completionGateId: gate.id, reportArtifactId: artifact.id },
        options,
      );
      const decision = this.stores.decisions.request(
        {
          conversationId: run.conversationId,
          runId: run.id,
          kind: "signoff",
          resolutionPolicy: "operator_required",
          requestedBy: { kind: "runtime" },
          question: `Accept the verified result of Run ${run.id} (Snapshot ${gate.snapshotId}) or request changes?`,
          options: [
            { id: SIGNOFF_OPTIONS[0], label: "Accept", description: "Accept the verified integration Snapshot as the Run's final result." },
            { id: SIGNOFF_OPTIONS[1], label: "Request changes", description: "Return the Run to running with your requested changes." },
          ],
          recommendedOptionId: null,
          rationale: null,
          affects: { requirementIds: gate.requirementIds, taskIds: [], planNodeIds: [this.root(run).id] },
          deadlineAt: null,
          activationCondition: null,
          subject: { kind: "signoff", runId: run.id, gateId: signoff.id, completionGateId: gate.id, completionRequestId: request.id, snapshotId: gate.snapshotId!, reportArtifactId: artifact.id },
          supersedesDecisionId: null,
        },
        options,
      );
      this.stores.runs.transition(run.id, { to: "awaiting_signoff" }, options);
      return { kind: "completion_passed", completionRequestId: request.id, gateId: gate.id, reportArtifactId: artifact.id, signoffGateId: signoff.id, decisionId: decision.id };
    });
  }

  // ---------------------------------------------------------------------------
  // Failure and cancellation
  // ---------------------------------------------------------------------------

  /** In one root transaction: the consequence of a cancelled request, failed checks, failed verdicts, or unmet conditions. */
  complete(runId: RunId, options: WriteOptions = {}): CompletionOutcome {
    return this.deps.ctx.tx.write((): CompletionOutcome => {
      const phase = this.phaseOf(runId);
      const run = this.stores.runs.get(runId);
      switch (phase.kind) {
        case "cancel":
          return this.cancel(phase.request, phase.outcome, options);
        case "checks_failed":
          return this.fail(run, phase.request, phase.gate, { kind: "criteria_failed", acceptanceCriterionIds: [phase.failed.subject.kind === "acceptance_criterion" ? phase.failed.subject.acceptanceCriterionId : ("" as AcceptanceCriterionId)] }, options);
        case "judged_failed":
          return this.fail(run, phase.request, phase.gate, { kind: "criteria_failed", acceptanceCriterionIds: phase.failedIds }, options);
        case "conditions_unmet":
          return this.fail(run, phase.request, phase.gate, { kind: "conditions_unmet", conditions: phase.conditions }, options);
        default:
          return { kind: "no_change" };
      }
    });
  }

  /**
   * Closes the Gate `failed` with the closed fact, ends the request `failed`
   * with the same outcome, creates the one runtime-owned remediation Task on
   * the root (linked to the Gate, the failed criteria's Requirements, and the
   * judged and command-output Artifacts), and returns the Run to `running`.
   * The root Orchestrator's batched `gate_result` turn takes it from there;
   * completion is never retried automatically.
   */
  private fail(run: Run, request: CompletionRequest, gate: Gate, failure: CompletionGateFailure, options: WriteOptions): CompletionOutcome {
    const closed = this.stores.gates.close(gate.id, "failed", failure, options);
    this.stores.completionRequests.transition(request.id, { to: "failed", outcome: failure }, options);
    const evaluations = this.stores.evaluations.gateCriterionEvaluationsOf(gate.id);
    const evidenceArtifacts = evaluations.flatMap((e) => e.evidence.flatMap((v: Evidence) => (v.kind === "command" ? [v.outputArtifactId] : v.kind === "artifact" ? [v.artifactId] : [])));
    const failedCriteria = failure.kind === "criteria_failed" ? failure.acceptanceCriterionIds : [];
    const requirementIds = new Set<RequirementId>();
    for (const id of failedCriteria) {
      const owner = this.stores.requirements.getAcceptanceCriterion(id).requirementId;
      if (owner !== null) requirementIds.add(owner);
    }
    if (failure.kind === "conditions_unmet") for (const condition of failure.conditions) if (condition.kind === "requirement_unsatisfied") requirementIds.add(condition.requirementId);
    const task = this.stores.tasks.create(
      {
        runId: run.id,
        planNodeId: this.root(run).id,
        origin: "runtime",
        gateId: closed.id,
        subject: `Remediate run_completion Gate cycle ${closed.ordinal} of Completion Request ${request.id}: ${failure.kind}`,
        requirementIds: [...requirementIds].sort(),
        requirementRevisionId: gate.requirementRevisionId,
        inputArtifactIds: [...new Set([...gate.candidateArtifactIds, ...evidenceArtifacts])].sort(),
        requiredOutputs: [],
        replacesTaskId: null,
      },
      options,
    );
    this.stores.runs.transition(run.id, { to: "running" }, options);
    return { kind: "completion_failed", completionRequestId: request.id, gateId: closed.id, remediationTaskId: task.id, outcome: failure };
  }

  // ---------------------------------------------------------------------------
  // Remediation facts (read by the root)
  // ---------------------------------------------------------------------------

  /** The pending (not yet ended) remediation Tasks of failed run_completion Gates of the Run, in creation order. */
  pendingRemediations(runId: RunId): { gate: Gate; task: Task }[] {
    const out: { gate: Gate; task: Task }[] = [];
    for (const task of this.stores.tasks.listRemediationTasks(runId)) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "running") continue;
      const gate = this.stores.gates.get(task.gateId!);
      if (gate.kind !== "run_completion" || gate.status !== "failed") continue;
      out.push({ gate, task });
    }
    return out;
  }

  /** The criteria of the Gate, for callers that need the typed rows. */
  criteriaRows(gate: Gate): AcceptanceCriterion[] {
    return [...gate.acceptanceCriterionIds].sort().map((id) => this.stores.requirements.getAcceptanceCriterion(id)).sort(byId);
  }
}
