/**
 * The `node_exit` Gate engine (execution-model §10; invariant 11): the one
 * runtime component that opens, checks, judges, closes, and remediates the
 * Gate of a `pattern` Plan Node whose Pattern has produced and integrated
 * its candidate output. Every supported Pattern runner (`single`, `chain`,
 * `route`, `parallel`, `coordinator_worker`) delegates its Gate phase here;
 * the `evaluator_optimizer` Pattern consumes its Gate criteria inside its
 * rounds and never reaches this engine. No agent schedules, waits for,
 * groups, retries, or closes a Gate.
 *
 * One verification cycle, from rows alone:
 *
 * 1. `open`: the node is `running`, a current member, its candidate is
 *    known and integrated, no Gate is open, and the Run's
 *    `maxNodeGateCycles` permits another cycle. One transaction opens the
 *    Gate with the next ordinal, the exact criteria in id order, the exact
 *    integration Snapshot, and the exact candidate Artifact ids.
 * 2. `verify` (external, outside every transaction): the deterministic
 *    criteria run in id order through the shared check service against a
 *    disposable view of the Gate's Snapshot; each outcome is recorded once;
 *    the first failure stops the checks, and no Evaluator is invoked.
 * 3. `prepareEvaluator`: when every deterministic criterion passed and
 *    evaluated criteria exist, exactly one read-only Evaluator Invocation of
 *    the Run's verification-policy revision is created for the Gate,
 *    funded from the node's allocation, with one typed `gate_candidate`
 *    input naming the Gate, its Snapshot, its candidate, and exactly the
 *    evaluated criteria; no transcript, no unrelated history.
 * 4. `settle`: the Evaluator's validated result becomes one Evaluation per
 *    evaluated criterion on the Gate's Snapshot and candidate (never a
 *    model-supplied replacement); once every criterion has a verdict the
 *    Gate closes `passed` (every verdict `pass`) or `failed` (any `fail` or
 *    `inconclusive`). A pass settles the node `succeeded` with the candidate
 *    and creates its edge Handoffs in the same transaction. A failure
 *    creates exactly one runtime-owned remediation Task naming the Gate
 *    (the judged and command-output Artifacts as its inputs), or fails the
 *    node with `gate_cycles_exhausted` when no cycle remains. A permanently
 *    failed Evaluator closes the Gate `failed` with the `evaluator_failed`
 *    fact and fails the node with `gate_evaluator_failed`: no criterion
 *    verdict is invented.
 * 5. Remediation is owned by the root Orchestrator (`root.ts`) or by the
 *    node's Coordinator (`coordinator-worker.ts`); once the remediation Task
 *    is completed, the next cycle opens a new Gate with the next ordinal on
 *    the new integration Snapshot and the persisted candidate (the Task's
 *    output Artifacts when remediation replaced the output, otherwise the
 *    previous candidate; a Coordinator's fresh synthesis for its node). A
 *    remediation Task that failed or was cancelled fails the node with
 *    `gate_remediation_failed`.
 *
 * Every step is derived from Gate, Evaluation, Invocation, and Task rows and
 * is safe to repeat: an existing open Gate, a recorded check, an existing
 * Evaluator, a recorded Evaluation, a closed Gate, a settled node, or an
 * existing remediation Task is found, never duplicated. Closed Gates are
 * never mutated; a later cycle is a new Gate.
 */
import {
  INVOCATION_MACHINE,
  InvariantViolationError,
  PLAN_NODE_MACHINE,
  type AcceptanceCriterion,
  type AcceptanceCriterionId,
  type AgentDefinitionRevisionId,
  type ArtifactId,
  type Decision,
  type Evaluation,
  type EvaluatorResult,
  type Evidence,
  type Gate,
  type GateId,
  type Invocation,
  type ManifestInput,
  type PatternPlanNode,
  type PlanNodeId,
  type Task,
  type Timestamp,
  approvalSubjectOf,
  decisionResolutionInputOf,
} from "@agentique-console/core";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf } from "./invocation-facts.ts";
import type { NodeAdvice, PatternNodeSupport, PatternRunnerOutcome } from "./patterns/support.ts";

/** Who remediates a failed Gate of the node (execution-model §10). */
export type GateRemediationOwner = "root" | "coordinator";

/**
 * What a Pattern runner tells the Gate engine about its node: how a failed
 * Gate is remediated, and the Pattern's complete, integrated candidate output
 * for a new verification cycle (`null` while none is ready). `candidate` is
 * consulted inside the opening transaction only, so a Pattern whose candidate
 * is a runtime index Artifact may create it there; `fresh` says whether the
 * Pattern produced a candidate newer than the latest Gate (a Coordinator's
 * new synthesis), which a Coordinator-remediated node needs before its next
 * Gate opens.
 */
export interface GateCandidateSource {
  owner: GateRemediationOwner;
  candidate: (options: WriteOptions) => ArtifactId[] | null;
  fresh?: () => boolean;
}

/** Where a node's Gate phase stands, from rows alone. */
export type GatePhase =
  /** No Gate is open and the next cycle may open now. */
  | { kind: "open_gate"; ordinal: number }
  /** The latest Gate failed (or the next cycle is due) and the Run permits no further cycle: the node fails. */
  | { kind: "cycles_exhausted"; gate: Gate }
  | { kind: "checks_pending"; gate: Gate }
  | { kind: "checks_failed"; gate: Gate; failed: Evaluation }
  | { kind: "evaluator_pending"; gate: Gate }
  | { kind: "evaluator_active"; gate: Gate; invocation: Invocation }
  /** The Evaluator ended blocked on a Decision (an approval-required read tool): the node waits and continues with a successor. */
  | { kind: "evaluator_blocked"; gate: Gate; invocation: Invocation; decision: Decision }
  /** The Evaluator is terminal and its consequences (Evaluations, closing) are not yet applied. */
  | { kind: "evaluator_terminal"; gate: Gate; invocation: Invocation }
  /** Every criterion has a verdict and the Gate is still open. */
  | { kind: "judged"; gate: Gate; verdict: "passed" | "failed" }
  /** The latest Gate passed and the node is not yet settled. */
  | { kind: "passed"; gate: Gate }
  /** The latest Gate failed and its remediation Task does not exist yet. */
  | { kind: "failed_unremediated"; gate: Gate }
  /** The remediation Task exists and has not ended: its owner works on it. */
  | { kind: "remediation_pending"; gate: Gate; task: Task }
  /** The remediation Task ended without completing: the node fails. */
  | { kind: "remediation_failed"; gate: Gate; task: Task }
  /** Remediation completed but the Pattern has not yet produced its next candidate (a Coordinator's next synthesis). */
  | { kind: "candidate_pending"; gate: Gate; task: Task };

export class NodeExitGates {
  constructor(private readonly support: PatternNodeSupport) {}

  private get stores() {
    return this.support.deps.stores;
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  /** The node's Gate criteria by kind, in canonical id order. */
  criteriaOf(node: PatternPlanNode): { deterministic: AcceptanceCriterion[]; evaluated: AcceptanceCriterionId[]; all: AcceptanceCriterionId[] } {
    const criteria = [...node.gateAcceptanceCriterionIds].sort().map((id) => this.stores.requirements.getAcceptanceCriterion(id));
    return {
      deterministic: criteria.filter((c) => c.check.kind === "deterministic"),
      evaluated: criteria.filter((c) => c.check.kind === "evaluated").map((c) => c.id),
      all: criteria.map((c) => c.id),
    };
  }

  /** The latest Evaluator Invocation of a Gate, or `null`. */
  evaluatorOf(gate: Gate): Invocation | null {
    return this.stores.invocations.latestByGate(gate.id);
  }

  /** The Evaluator Invocation of the node's open Gate, if any: what a Decision wait may be blocked on. */
  openGateEvaluator(node: PatternPlanNode): Invocation | null {
    const gate = this.stores.gates.openGateOf(node.id);
    return gate === null ? null : this.evaluatorOf(gate);
  }

  /** The node's Gate phase from rows alone; `source.fresh` decides a Coordinator-remediated node's next cycle. */
  phaseOf(node: PatternPlanNode, source: GateCandidateSource): GatePhase {
    const gates = this.stores.gates.listByPlanNode(node.id);
    const latest = gates.at(-1) ?? null;
    const max = this.stores.runs.get(node.runId).verificationPolicy.maxNodeGateCycles;
    if (latest === null) return { kind: "open_gate", ordinal: 1 };
    if (latest.status === "open") return this.openPhase(node, latest);
    if (latest.status === "passed") return { kind: "passed", gate: latest };
    const task = this.stores.tasks.remediationTaskOf(latest.id);
    if (task === null) return gates.length >= max ? { kind: "cycles_exhausted", gate: latest } : { kind: "failed_unremediated", gate: latest };
    switch (task.status) {
      case "completed":
        if (gates.length >= max) return { kind: "cycles_exhausted", gate: latest };
        if (source.owner === "coordinator" && source.fresh !== undefined && !source.fresh()) return { kind: "candidate_pending", gate: latest, task };
        return { kind: "open_gate", ordinal: gates.length + 1 };
      case "failed":
      case "cancelled":
        return { kind: "remediation_failed", gate: latest, task };
      default:
        return { kind: "remediation_pending", gate: latest, task };
    }
  }

  /** An open Gate's phase: its checks, then its Evaluator, then its verdict. */
  private openPhase(node: PatternPlanNode, gate: Gate): GatePhase {
    const { deterministic, evaluated } = this.criteriaOf(node);
    const recorded = new Map(this.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e] as const));
    for (const criterion of deterministic) {
      const evaluation = recorded.get(criterion.id);
      if (evaluation === undefined) return { kind: "checks_pending", gate };
      if (evaluation.verdict !== "pass") return { kind: "checks_failed", gate, failed: evaluation };
    }
    if (evaluated.every((id) => recorded.has(id))) return { kind: "judged", gate, verdict: [...recorded.values()].every((e) => e.verdict === "pass") ? "passed" : "failed" };
    const invocation = this.evaluatorOf(gate);
    if (invocation === null) return { kind: "evaluator_pending", gate };
    if (!INVOCATION_MACHINE.isTerminal(invocation.status)) return { kind: "evaluator_active", gate, invocation };
    const decision = blockedOn(this.stores, invocation);
    if (decision !== null) return { kind: "evaluator_blocked", gate, invocation, decision };
    return { kind: "evaluator_terminal", gate, invocation };
  }

  /** The scheduler-facing advice for a node whose Pattern work is complete and integrated. */
  advice(node: PatternPlanNode, source: GateCandidateSource, now: Timestamp): NodeAdvice {
    const phase = this.phaseOf(node, source);
    switch (phase.kind) {
      case "open_gate":
        return { kind: "open_gate" };
      case "checks_pending":
        return { kind: "verify_gate", gateId: phase.gate.id };
      case "evaluator_pending":
        return { kind: "prepare_gate_evaluator", gateId: phase.gate.id };
      case "evaluator_active":
        return activeInvocationAdvice(this.support.deps.executor, phase.invocation, now);
      case "remediation_pending":
        return { kind: "awaiting_remediation", gateId: phase.gate.id, taskId: phase.task.id };
      case "candidate_pending":
        // The Pattern produces the next candidate through its own actions; the runner never asks the engine here.
        throw new InvariantViolationError(`PlanNode ${node.id} awaits its next candidate before Gate ${phase.gate.ordinal + 1}`, { planNodeId: node.id });
      default:
        return { kind: "settle_gate", gateId: phase.gate.id };
    }
  }

  // ---------------------------------------------------------------------------
  // Opening
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: revalidate the revision, membership, and
   * `running` status; the phase must still be `open_gate`; pin the current
   * integration Snapshot and the candidate — the Pattern's own for the first
   * cycle and for a Coordinator's fresh synthesis, otherwise the completed
   * remediation Task's output Artifacts when it replaced the output and the
   * previous Gate's candidate when it did not — and open the Gate with the
   * next ordinal. The store refuses a second open Gate and a cycle beyond
   * the bound.
   */
  open(nodeId: PlanNodeId, expectedRevisionNumber: number, source: GateCandidateSource, options: WriteOptions): PatternRunnerOutcome {
    const { ctx } = this.support.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (node.status !== "running") return { kind: "no_change" };
      if (node.gateAcceptanceCriterionIds.length === 0) throw new InvariantViolationError(`PlanNode ${node.id} has no Gate criteria; the runner settles it without a Gate`, { planNodeId: node.id });
      const phase = this.phaseOf(node, source);
      if (phase.kind === "cycles_exhausted") return this.exhaust(node, options);
      if (phase.kind !== "open_gate") return { kind: "no_change" };
      const candidate = this.nextCandidate(node, source, options);
      if (candidate === null) return { kind: "no_change" };
      const run = this.stores.runs.get(node.runId);
      const snapshotId = run.integrationSnapshotId ?? run.baseSnapshotId;
      if (snapshotId === null) throw new InvariantViolationError(`Run ${run.id} has no integration Snapshot to verify`, { runId: run.id });
      const gate = this.stores.gates.open({ runId: node.runId, planNodeId: node.id, kind: "node_exit", acceptanceCriterionIds: [...node.gateAcceptanceCriterionIds].sort(), snapshotId, candidateArtifactIds: [...new Set(candidate)].sort() }, options);
      return { kind: "gate_opened", gateId: gate.id, ordinal: gate.ordinal, snapshotId: gate.snapshotId!, candidateArtifactIds: gate.candidateArtifactIds };
    });
  }

  /** The candidate the next Gate judges (execution-model §10 "candidate invalidation"), or `null` while the Pattern has none. */
  private nextCandidate(node: PatternPlanNode, source: GateCandidateSource, options: WriteOptions): ArtifactId[] | null {
    const gates = this.stores.gates.listByPlanNode(node.id);
    const previous = gates.at(-1) ?? null;
    if (previous === null || source.owner === "coordinator") return source.candidate(options);
    const task = this.stores.tasks.remediationTaskOf(previous.id);
    if (task === null || task.status !== "completed") throw new InvariantViolationError(`Gate ${previous.id} of PlanNode ${node.id} was not remediated`, { gateId: previous.id });
    return task.outputArtifactIds.length > 0 ? [...task.outputArtifactIds] : [...previous.candidateArtifactIds];
  }

  // ---------------------------------------------------------------------------
  // Deterministic verification (external)
  // ---------------------------------------------------------------------------

  /** Runs the open Gate's pending deterministic criteria in canonical order, outside any transaction, recording each once. */
  async verify(nodeId: PlanNodeId, expectedRevisionNumber: number, source: GateCandidateSource, options: WriteOptions): Promise<PatternRunnerOutcome> {
    const { ctx, checks } = this.support.deps;
    if (ctx.tx.inTransaction) throw new Error("Gate checks run outside any transaction; command execution is external");
    const stale = this.support.staleness(nodeId, expectedRevisionNumber);
    if (stale) return stale;
    const node = this.support.node(nodeId);
    if (node.status !== "running") return { kind: "no_change" };
    const phase = this.phaseOf(node, source);
    if (phase.kind !== "checks_pending") return { kind: "no_change" };
    const gate = phase.gate;
    const outcome = await checks.run({ runId: node.runId, planNodeId: node.id, scope: { kind: "gate", gateId: gate.id }, snapshotId: gate.snapshotId!, artifactIds: gate.candidateArtifactIds, criteria: this.criteriaOf(node).deterministic }, options);
    if (outcome.kind === "infrastructure_failure") return { kind: "gate_verification_failed", gateId: gate.id, acceptanceCriterionId: outcome.acceptanceCriterionId, failure: outcome.failure, message: outcome.message };
    return { kind: "gate_verified", gateId: gate.id, verdict: outcome.kind === "passed" ? "pass" : "fail", evaluationIds: outcome.checks.map((c) => c.evaluation.id) };
  }

  // ---------------------------------------------------------------------------
  // The Evaluator
  // ---------------------------------------------------------------------------

  /** In one root transaction: the Gate's one read-only Evaluator Invocation, funded from the node under its allocation policy. */
  prepareEvaluator(nodeId: PlanNodeId, expectedRevisionNumber: number, source: GateCandidateSource, options: WriteOptions): PatternRunnerOutcome {
    const { ctx } = this.support.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (node.status !== "running") return { kind: "no_change" };
      const phase = this.phaseOf(node, source);
      if (phase.kind !== "evaluator_pending") return { kind: "no_change" };
      return this.prepareEvaluatorFor(node, phase.gate, null, [], options);
    });
  }

  /** The Run's Gate Evaluator revision; plan validation admits no evaluated Gate criterion on a Run without one. */
  private evaluatorRevisionOf(node: PatternPlanNode): AgentDefinitionRevisionId {
    const run = this.stores.runs.get(node.runId);
    const revisionId = run.verificationPolicy.evaluatorAgentDefinitionRevisionId;
    if (revisionId === null) throw new InvariantViolationError(`Run ${run.id} names no Gate Evaluator; plan validation admits no evaluated Gate criterion without one`, { runId: run.id });
    return revisionId;
  }

  /** The allocation one Gate Evaluator Invocation of the node needs: the Run's Evaluator revision's default. */
  private evaluatorAllocation(node: PatternPlanNode) {
    return this.stores.agents.getRevision(this.evaluatorRevisionOf(node)).defaultLimits.allocation;
  }

  /** Whether the node can fund one Gate Evaluator Invocation now — directly or through the extension its `extend` policy admits (what a `budget` wait of the Gate phase is cleared by). */
  evaluatorFits(node: PatternPlanNode): boolean {
    return this.support.deps.capacity.admits(node, this.evaluatorAllocation(node)).fits;
  }

  /** Whether the node's open Gate awaits its Evaluator (none exists yet): the phase whose funding a `budget` wait concerns. */
  awaitingEvaluator(node: PatternPlanNode): boolean {
    const gate = this.stores.gates.openGateOf(node.id);
    return gate !== null && this.evaluatorOf(gate) === null && this.criteriaOf(node).evaluated.length > 0;
  }

  /** The Evaluator (or its approval successor) of a Gate: one typed `gate_candidate` input, the candidate readable by id, no Handoff. */
  private prepareEvaluatorFor(node: PatternPlanNode, gate: Gate, predecessor: Invocation | null, extraInputs: ManifestInput[], options: WriteOptions): PatternRunnerOutcome {
    const { preparation } = this.support.deps;
    const revisionId = this.evaluatorRevisionOf(node);
    // The Evaluator is funded from the node under its allocation policy through the one capacity operation, in this transaction.
    const funded = this.support.deps.capacity.ensure(node, this.evaluatorAllocation(node), "gate_evaluator", options);
    if (funded.kind === "ineligible") throw new InvariantViolationError(`PlanNode ${node.id} cannot fund a Gate Evaluator: ${funded.reason.kind}`, { planNodeId: node.id, reason: funded.reason });
    if (funded.kind === "refused") return funded.policy === "fail" ? this.support.failNow(node, "allocation_exhausted", options) : this.support.wait(node, "budget", options);
    const input: ManifestInput = { kind: "gate_candidate", gateId: gate.id, gateKind: gate.kind, snapshotId: gate.snapshotId!, artifactIds: gate.candidateArtifactIds, acceptanceCriterionIds: this.criteriaOf(node).evaluated, completionRequestId: null, requirementRevisionId: null, tasks: [] };
    const prepared = preparation.prepare({
      runId: node.runId,
      planNodeId: node.id,
      role: "evaluator",
      purpose: "evaluate",
      patternPosition: null,
      gateId: gate.id,
      agentDefinitionRevisionId: revisionId,
      continuedFromInvocationId: predecessor?.id ?? null,
      inputs: [input, ...extraInputs],
      artifactIds: gate.candidateArtifactIds,
      correlationId: options.correlationId ?? null,
      causationSeq: options.causationSeq ?? null,
    });
    return { kind: "gate_evaluator_prepared", gateId: gate.id, invocationId: prepared.invocation.id };
  }

  /**
   * The successor of a Gate Evaluator blocked on a now-resolved Decision:
   * the same Gate and typed candidate input, continuing from the blocked
   * Invocation with the typed resolution, on a fresh reservation; a
   * superseded Decision without a resolution fails the node as blocked.
   */
  prepareEvaluatorSuccessor(node: PatternPlanNode, predecessor: Invocation, decision: Decision, options: WriteOptions): PatternRunnerOutcome {
    if (predecessor.gateId === null) throw new InvariantViolationError(`Invocation ${predecessor.id} is not a Gate Evaluator`, { invocationId: predecessor.id });
    const gate = this.stores.gates.get(predecessor.gateId);
    if (decision.status !== "resolved" || decision.resolution === null) return this.support.failNow(node, "result_blocked", options);
    const resolution: ManifestInput =
      predecessor.status === "blocked" && decision.kind === "side_effect_approval" && decision.subject !== null
        ? { kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: predecessor.id, attemptId: approvalSubjectOf(decision).attemptId, tool: approvalSubjectOf(decision).tool, callDigest: approvalSubjectOf(decision).callDigest, callArtifactId: approvalSubjectOf(decision).callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" }
        : decisionResolutionInputOf(decision);
    const prepared = this.prepareEvaluatorFor(node, gate, predecessor, [resolution], options);
    if (prepared.kind !== "gate_evaluator_prepared") return prepared;
    return { kind: "successor_prepared", invocationId: prepared.invocationId, position: null, decisionId: decision.id };
  }

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction, the next canonical consequence of the Gate's
   * rows: the Evaluator's verdicts recorded and the Gate closed, a
   * deterministic failure closed, the node settled on a pass, the
   * remediation Task created on a failure, the node failed on cycle
   * exhaustion, a failed remediation, or a failed Evaluator. Repeating it
   * applies nothing twice.
   */
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, source: GateCandidateSource, options: WriteOptions): PatternRunnerOutcome {
    const { ctx } = this.support.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (PLAN_NODE_MACHINE.isTerminal(node.status) || node.status === "waiting") return { kind: "no_change" };
      const phase = this.phaseOf(node, source);
      switch (phase.kind) {
        case "checks_failed": {
          const failedIds = [phase.failed].map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")).filter((id): id is AcceptanceCriterionId => id !== "");
          return this.closeFailed(node, phase.gate, failedIds, options);
        }
        case "judged": {
          if (phase.verdict === "passed") return this.closePassed(node, phase.gate, options);
          const failedIds = this.stores.evaluations.gateCriterionEvaluationsOf(phase.gate.id).filter((e) => e.verdict !== "pass").map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")).filter((id): id is AcceptanceCriterionId => id !== "");
          return this.closeFailed(node, phase.gate, failedIds, options);
        }
        case "evaluator_terminal":
          return this.settleEvaluator(node, phase.gate, phase.invocation, options);
        case "evaluator_blocked":
          return this.support.wait(node, "decision", options);
        case "passed":
          return this.succeed(node, phase.gate, options);
        case "failed_unremediated":
          return this.remediate(node, phase.gate, options);
        case "remediation_failed":
          return this.support.failNow(node, "gate_remediation_failed", options);
        case "cycles_exhausted":
          return this.exhaust(node, options);
        default:
          return { kind: "no_change" };
      }
    });
  }

  /** The Evaluator's consequences: its validated verdicts as Evaluations and the Gate's closure; a permanent failure closes the Gate without a verdict. */
  private settleEvaluator(node: PatternPlanNode, gate: Gate, evaluator: Invocation, options: WriteOptions): PatternRunnerOutcome {
    switch (evaluator.status) {
      case "cancelled":
        return this.support.cancelNow(node, options);
      case "failed":
        return this.closeEvaluatorFailed(node, gate, evaluator, options);
      case "succeeded": {
        const result = evaluator.result!;
        if (result.status === "failed") return this.closeEvaluatorFailed(node, gate, evaluator, options);
        if (result.status === "blocked") return blockingDecisionOf(this.stores, evaluator) !== null ? this.support.wait(node, "decision", options) : this.closeEvaluatorFailed(node, gate, evaluator, options);
        if (result.evaluation === null) throw new InvariantViolationError(`Evaluator Invocation ${evaluator.id} completed without an evaluation; the result validator admits none`, { invocationId: evaluator.id });
        this.recordEvaluations(node, gate, evaluator, result.evaluation, options);
        const verdicts = this.stores.evaluations.gateCriterionEvaluationsOf(gate.id);
        const { all } = this.criteriaOf(node);
        const recorded = new Set(verdicts.map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")));
        if (!all.every((id) => recorded.has(id))) return { kind: "gate_evaluations_recorded", gateId: gate.id, evaluationIds: verdicts.map((e) => e.id) };
        if (verdicts.every((e) => e.verdict === "pass")) return this.closePassed(node, gate, options);
        return this.closeFailed(node, gate, verdicts.filter((e) => e.verdict !== "pass").map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")).filter((id): id is AcceptanceCriterionId => id !== ""), options);
      }
      default:
        throw new Error(`unreachable: Invocation ${evaluator.id} is ${evaluator.status}`);
    }
  }

  /** One Evaluation per reported evaluated criterion on the Gate's own Snapshot and candidate; existing rows are kept. */
  private recordEvaluations(node: PatternPlanNode, gate: Gate, evaluator: Invocation, evaluation: EvaluatorResult, options: WriteOptions): void {
    const existing = new Set(this.stores.evaluations.gateCriterionEvaluationsOf(gate.id).map((e) => (e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "")));
    const producedBy = { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: evaluator.agentDefinitionRevisionId };
    for (const criterion of [...evaluation.criteria].sort((a, b) => (a.acceptanceCriterionId < b.acceptanceCriterionId ? -1 : 1))) {
      if (existing.has(criterion.acceptanceCriterionId)) continue;
      this.stores.evaluations.record(
        { runId: node.runId, planNodeId: node.id, gateId: gate.id, subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion.acceptanceCriterionId }, context: null, verdict: criterion.verdict, evidence: criterion.evidence, producedBy, artifactIds: gate.candidateArtifactIds, snapshotId: gate.snapshotId },
        options,
      );
    }
  }

  /** Gate pass, node settlement, edge Handoffs, and reservation release in one transaction. */
  private closePassed(node: PatternPlanNode, gate: Gate, options: WriteOptions): PatternRunnerOutcome {
    const closed = this.stores.gates.close(gate.id, "passed", null, options);
    return this.succeed(node, closed, options);
  }

  private succeed(node: PatternPlanNode, gate: Gate, options: WriteOptions): PatternRunnerOutcome {
    const done = this.support.succeedNow(node, gate.candidateArtifactIds, options);
    if (done.kind !== "succeeded") return done;
    return { kind: "gate_passed", gateId: gate.id, outputArtifactIds: done.outputArtifactIds, handoffIds: done.handoffIds };
  }

  /** The Gate closes on its failed criteria; a further cycle gets its remediation Task, an exhausted bound fails the node. */
  private closeFailed(node: PatternPlanNode, gate: Gate, failedIds: AcceptanceCriterionId[], options: WriteOptions): PatternRunnerOutcome {
    const closed = this.stores.gates.close(gate.id, "failed", { kind: "criteria_failed", acceptanceCriterionIds: [...new Set(failedIds)].sort() }, options);
    return this.remediate(node, closed, options);
  }

  /** A permanently failed Evaluator: the Gate closes with the `evaluator_failed` fact and the node fails; no criterion verdict is invented. */
  private closeEvaluatorFailed(node: PatternPlanNode, gate: Gate, evaluator: Invocation, options: WriteOptions): PatternRunnerOutcome {
    this.stores.gates.close(gate.id, "failed", { kind: "evaluator_failed", invocationId: evaluator.id }, options);
    return this.support.failNow(node, "gate_evaluator_failed", options);
  }

  /** The one remediation Task of a failed Gate, or the node's failure when the cycle bound permits no further Gate. */
  private remediate(node: PatternPlanNode, gate: Gate, options: WriteOptions): PatternRunnerOutcome {
    if (gate.failure?.kind === "evaluator_failed") return this.support.failNow(node, "gate_evaluator_failed", options);
    const existing = this.stores.tasks.remediationTaskOf(gate.id);
    if (existing !== null) return { kind: "gate_failed", gateId: gate.id, remediationTaskId: existing.id };
    const max = this.stores.runs.get(node.runId).verificationPolicy.maxNodeGateCycles;
    if (gate.ordinal >= max) return this.exhaust(node, options);
    const failedIds = gate.failure?.kind === "criteria_failed" ? gate.failure.acceptanceCriterionIds : [];
    const evaluations = this.stores.evaluations.gateCriterionEvaluationsOf(gate.id);
    const outputs = evaluations.flatMap((e) => e.evidence.flatMap((v: Evidence) => (v.kind === "command" ? [v.outputArtifactId] : [])));
    const task = this.stores.tasks.create(
      {
        runId: node.runId,
        planNodeId: node.id,
        origin: "runtime",
        gateId: gate.id,
        subject: `Remediate node_exit Gate cycle ${gate.ordinal} of PlanNode ${node.id}: ${failedIds.length} of ${gate.acceptanceCriterionIds.length} Acceptance Criteria did not pass`,
        requirementIds: [],
        requirementRevisionId: null,
        inputArtifactIds: [...new Set([...gate.candidateArtifactIds, ...outputs])].sort(),
        requiredOutputs: [],
        replacesTaskId: null,
      },
      options,
    );
    return { kind: "gate_failed", gateId: gate.id, remediationTaskId: task.id };
  }

  private exhaust(node: PatternPlanNode, options: WriteOptions): PatternRunnerOutcome {
    return this.support.failNow(node, "gate_cycles_exhausted", options);
  }

  // ---------------------------------------------------------------------------
  // Remediation facts (read by the owners)
  // ---------------------------------------------------------------------------

  /** The pending (not yet ended) remediation Task of a node's latest failed Gate, if any. */
  pendingRemediationOf(node: PatternPlanNode): { gate: Gate; task: Task } | null {
    const latest = this.stores.gates.listByPlanNode(node.id).at(-1) ?? null;
    if (latest === null || latest.status !== "failed") return null;
    const task = this.stores.tasks.remediationTaskOf(latest.id);
    if (task === null || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return null;
    return { gate: latest, task };
  }

  /** The typed `gate_result` manifest input of a closed Gate, restating its canonical facts. */
  gateResultInput(gate: Gate): ManifestInput {
    const task = this.stores.tasks.remediationTaskOf(gate.id);
    return {
      kind: "gate_result",
      gateId: gate.id,
      gateKind: gate.kind,
      planNodeId: gate.planNodeId,
      ordinal: gate.ordinal,
      passed: gate.status === "passed",
      snapshotId: gate.snapshotId,
      artifactIds: [...gate.candidateArtifactIds].sort(),
      failedAcceptanceCriterionIds: gate.failure?.kind === "criteria_failed" ? [...gate.failure.acceptanceCriterionIds].sort() : [],
      evaluationIds: this.stores.evaluations.listByGate(gate.id).map((e) => e.id).sort(),
      remediationTaskId: task?.id ?? null,
    };
  }

  /** Marks a remediation Task addressed by `invocation`: `pending`/`ready` → `running` → `completed` with the given Evidence and outputs. */
  completeRemediation(task: Task, invocation: Invocation, evidence: Evidence[], outputArtifactIds: ArtifactId[], options: WriteOptions): Task {
    let current = this.stores.tasks.get(task.id);
    if (current.status === "completed") return current;
    if (current.status === "blocked") current = this.stores.tasks.transition(current.id, { to: "ready" }, options);
    if (current.status === "pending") current = this.stores.tasks.transition(current.id, { to: "ready" }, options);
    if (current.status === "ready") current = this.stores.tasks.transition(current.id, { to: "running", invocationId: invocation.id }, options);
    if (current.status !== "running") throw new InvariantViolationError(`remediation Task ${task.id} is ${current.status} and cannot be completed`, { taskId: task.id });
    return this.stores.tasks.transition(current.id, { to: "completed", evidence, outputArtifactIds: [...new Set(outputArtifactIds)].sort() }, options);
  }

  /** Assigns a remediation Task to the Invocation that works on it: `pending`/`ready`/`blocked` → `running`. */
  assignRemediation(task: Task, invocation: Invocation, options: WriteOptions): Task {
    let current = this.stores.tasks.get(task.id);
    if (current.status === "running" && current.invocationId === invocation.id) return current;
    if (current.status === "running") current = this.stores.tasks.transition(current.id, { to: "blocked", blockReason: { kind: "input", description: `Invocation ${current.invocationId ?? "(none)"} ended without addressing the Gate` } }, options);
    if (current.status === "blocked") current = this.stores.tasks.transition(current.id, { to: "ready" }, options);
    if (current.status === "pending") current = this.stores.tasks.transition(current.id, { to: "ready" }, options);
    if (current.status !== "ready") throw new InvariantViolationError(`remediation Task ${task.id} is ${current.status} and cannot be assigned`, { taskId: task.id });
    return this.stores.tasks.transition(current.id, { to: "running", invocationId: invocation.id }, options);
  }

  /** Ends a remediation Task whose owner ended without addressing it: `running` → `failed`, an unassigned one → `cancelled`. */
  failRemediation(task: Task, options: WriteOptions): Task {
    const current = this.stores.tasks.get(task.id);
    if (current.status === "failed" || current.status === "cancelled" || current.status === "completed") return current;
    if (current.status === "running") return this.stores.tasks.transition(current.id, { to: "failed", failureReason: "permanent_failure" }, options);
    return this.stores.tasks.transition(current.id, { to: "cancelled" }, options);
  }

  /** The remediation Tasks currently assigned to an Invocation (their `invocationId` names it), in creation order. */
  remediationTasksOf(invocation: Invocation): Task[] {
    return this.stores.tasks.listRemediationTasks(invocation.runId).filter((t) => t.invocationId === invocation.id && t.gateId !== null);
  }

}
