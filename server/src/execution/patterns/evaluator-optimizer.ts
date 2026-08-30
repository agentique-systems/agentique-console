/**
 * The `evaluator_optimizer` Pattern runner (execution-model §5.6, §4.3,
 * §7.7, §10; invariant 11 deterministic verification precedes LLM
 * evaluation). One node executes rounds; in each round a candidate is
 * produced, the node's deterministic Acceptance Criteria are run against
 * the exact integration Snapshot that holds it, and — only when every
 * deterministic criterion passed — one read-only Evaluator judges it. Every
 * round verdict is a canonical `optimizer_verdict` Evaluation naming the
 * node, the round, the judged Snapshot, and the judged Artifacts; nothing is
 * inferred from a status, summary, transcript, Handoff, or Event.
 *
 * Inline form (`shape.producer` set, `shape.round === null`): round `r`
 * prepares one Worker Invocation at `producer_round { round: r }` (round 1
 * with the node's incoming edge Handoffs; round `r > 1` additionally with
 * the `optimizer_feedback:<node>:<r−1>` Handoff carrying the previous
 * candidate and the typed `optimizer_feedback` input naming the previous
 * verdict, continuing from the previous producer), integrates its Changeset,
 * runs the deterministic checks (the `verify` action, external), and on a
 * deterministic pass prepares one Evaluator Invocation at
 * `evaluator_round { round: r }` with the `optimizer_candidate:<node>:<r>`
 * Handoff and the typed `optimizer_candidate` input. A deterministic failure
 * records a runtime `fail` verdict and skips the Evaluator. A `pass` settles
 * the node `succeeded` with the candidate as its output; a `fail` or
 * `inconclusive` below `maxRounds` starts the next round; at `maxRounds` the
 * node fails with `optimizer_rounds_exhausted`. Exactly one producer or
 * Evaluator position is active at a time; each round is a new Invocation,
 * never a retry Attempt; an approval successor continues at the same
 * position with the same typed inputs.
 *
 * Evaluate-only form (`shape.producer === null`, fixed `shape.round`): the
 * candidate is the Artifact set carried by the node's incoming `sequence`
 * Handoffs in canonical edge order (the exits of the unrolled producer
 * subgraph, every Changeset of which is integrated before the node is
 * ready). The same deterministic-then-Evaluator round follows. The recorded
 * verdict is the readiness fact that activates the node's edges: a `pass`
 * succeeds the node with the candidate as output (its `sequence` edges
 * deliver, its `retry` edge is inactive, later rounds are skipped); a
 * non-final `fail` or `inconclusive` also succeeds the node — as a control
 * node, so the typed `retry(r+1)` edge can be consumed — with the judged
 * candidate as output, which the retry Handoff carries to the next producer
 * round; the candidate did not pass, and nothing reads the node's success as
 * acceptance. A final `fail` or `inconclusive` fails the node.
 *
 * Gate boundary: the node's `gateAcceptanceCriterionIds` are the round
 * criteria, consumed by this contract on the exact judged Snapshot and
 * Artifacts; a passing round settles the node without a separate
 * `node_exit` Gate and nothing is evaluated twice. Everything is derived
 * from rows and safe to repeat.
 */
import {
  INVOCATION_MACHINE,
  InvariantViolationError,
  PLAN_NODE_MACHINE,
  type AcceptanceCriterion,
  type AcceptanceCriterionId,
  type ArtifactId,
  type Evaluation,
  type EvaluatorResult,
  type Invocation,
  type ManifestInput,
  type PatternPlanNode,
  type PatternPosition,
  type PlanNodeId,
  type SnapshotId,
  type Timestamp,
} from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { edgeActivation, predecessorEdges } from "../readiness.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf, PatternNodeSupport, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

type OptimizerShape = Extract<PatternPlanNode["shape"], { pattern: "evaluator_optimizer" }>;

/** The canonical facts of one round, from rows. */
interface RoundState {
  round: number;
  /** The latest producer Invocation at `producer_round`; always `null` for an evaluate-only node. */
  producer: Invocation | null;
  evaluator: Invocation | null;
  /** The round's criterion Evaluations by Acceptance Criterion id. */
  criteria: Evaluation[];
  /** The one overall verdict, once recorded. */
  verdict: Evaluation | null;
}

interface OptimizerState {
  node: PatternPlanNode;
  shape: OptimizerShape;
  inline: boolean;
  /** The round the node is at: the highest round with a producer (inline), or the fixed round (evaluate-only). */
  current: RoundState;
  deterministic: AcceptanceCriterion[];
  evaluatedIds: AcceptanceCriterionId[];
}

/** Where a round stands once its candidate is known, from its Evaluations alone. */
type RoundPhase =
  | { kind: "checks_pending" }
  | { kind: "checks_failed"; failed: Evaluation }
  | { kind: "checks_passed" }
  | { kind: "judged"; verdict: Evaluation };

export class EvaluatorOptimizerPatternRunner {
  readonly pattern = "evaluator_optimizer" as const;
  private readonly support: PatternNodeSupport;

  constructor(private readonly deps: PatternRunnerDependencies) {
    this.support = new PatternNodeSupport(deps, "evaluator_optimizer");
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const state = this.state(node);
    if (!this.support.isCurrentMember(node)) {
      const advice = node.status === "running" ? this.runningAdvice(state, now) : null;
      const latest = state.current.evaluator ?? state.current.producer;
      return { kind: "not_current", invocationId: latest?.id ?? null, settle: advice !== null && advice.kind === "settle" };
    }
    if (node.status === "pending") throw new InvariantViolationError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, state);
    if (node.status === "ready") return { kind: "start" };
    return this.runningAdvice(state, now);
  }

  /** The next canonical action of a running node: the producer, then the checks, then the Evaluator, then the verdict's consequence. */
  private runningAdvice(state: OptimizerState, now: Timestamp): NodeAdvice {
    const { stores } = this.deps;
    const { current } = state;
    if (state.inline) {
      const producer = current.producer;
      if (producer === null) return { kind: "start" };
      if (!INVOCATION_MACHINE.isTerminal(producer.status)) return activeInvocationAdvice(this.deps.executor, producer, now);
      if (producer.status !== "succeeded" || producer.result === null || producer.result.status !== "completed") return { kind: "settle", invocationId: producer.id };
      if (outstandingChangesetOf(stores, producer) !== null) return { kind: "settle", invocationId: producer.id };
    }
    const phase = this.phase(state, current);
    switch (phase.kind) {
      case "judged":
        return { kind: "settle", invocationId: current.evaluator?.id ?? current.producer?.id ?? null };
      case "checks_failed":
        return { kind: "settle", invocationId: null };
      case "checks_pending":
        return { kind: "verify", round: current.round };
      case "checks_passed": {
        const evaluator = current.evaluator;
        if (evaluator === null) return { kind: "settle", invocationId: null };
        if (!INVOCATION_MACHINE.isTerminal(evaluator.status)) return activeInvocationAdvice(this.deps.executor, evaluator, now);
        return { kind: "settle", invocationId: evaluator.id };
      }
    }
  }

  private inspectWaiting(node: PatternPlanNode, state: OptimizerState): NodeAdvice {
    const { stores } = this.deps;
    const invocations = [state.current.producer, state.current.evaluator].filter((i): i is Invocation => i !== null);
    return this.support.inspectWaiting(node, {
      blocked: invocations.filter((i) => INVOCATION_MACHINE.isTerminal(i.status) && blockedOn(stores, i) !== null),
      selectorDecision: null,
      nextPosition: this.nextPositionToFund(state),
      capacity: invocations.find((i) => !INVOCATION_MACHINE.isTerminal(i.status)) ?? null,
      conflicted: state.current.producer === null ? [] : [state.current.producer],
    });
  }

  /** The position a budget wait must fund next, from rows. */
  private nextPositionToFund(state: OptimizerState): PatternPosition | null {
    const { current, shape } = state;
    const maxRounds = shape.maxRounds;
    if (state.inline && current.producer === null) return { kind: "producer_round", round: current.round, maxRounds };
    const phase = this.phase(state, current);
    if (phase.kind === "checks_passed" && current.evaluator === null) return { kind: "evaluator_round", round: current.round, maxRounds };
    if (phase.kind === "judged" && phase.verdict.verdict !== "pass" && state.inline && current.round < maxRounds) return { kind: "producer_round", round: current.round + 1, maxRounds };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: the node runs and its incoming edge Handoffs are ensured and delivered; an inline node
   * prepares producer round 1 with them, an evaluate-only node opens its round over the candidate they carry.
   */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      let node = this.support.node(nodeId);
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      const shape = optimizerShape(node);
      if (node.status === "running") {
        if (shape.producer === null || this.support.latestAt(node, { kind: "producer_round", round: 1, maxRounds: shape.maxRounds }) !== null) return { kind: "no_change" };
      }
      if (node.status === "ready") node = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      this.support.router.ensureEdgeHandoffsInto(this.support.readinessInput(node.runId), node.id, options);
      if (shape.producer === null) return { kind: "round_opened", round: shape.round! };
      return this.prepareProducer(node, 1, null, options);
    });
  }

  /** The optimizer advises no further position of its own; the request is a no-op after revalidation. */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, _position: PatternPosition, _options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.staleness(nodeId, expectedRevisionNumber) ?? { kind: "no_change" };
  }

  // ---------------------------------------------------------------------------
  // Deterministic verification (external)
  // ---------------------------------------------------------------------------

  /**
   * Runs the current round's pending deterministic Acceptance Criteria in
   * canonical order, outside any transaction, against the round's exact
   * integration Snapshot. Each outcome is recorded once by the check
   * service; the first failure also records the round's runtime `fail`
   * verdict in the same transaction, so the Evaluator is never invoked. An
   * infrastructure failure records nothing and is returned typed.
   */
  async verify(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx, stores, checks } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner verifies outside any transaction; command execution is external");
    const stale = this.support.staleness(nodeId, expectedRevisionNumber);
    if (stale) return stale;
    const node = this.support.node(nodeId);
    if (node.status !== "running") return { kind: "no_change" };
    const state = this.state(node);
    if (this.phase(state, state.current).kind !== "checks_pending") return { kind: "no_change" };
    const round = state.current.round;
    const snapshotId = this.roundSnapshot(state);
    const artifactIds = this.candidate(state);
    const outcome = await checks.run({ runId: node.runId, planNodeId: node.id, round: { round, maxRounds: state.shape.maxRounds }, snapshotId, artifactIds, criteria: state.deterministic }, options);
    if (outcome.kind === "infrastructure_failure") return { kind: "verification_failed", round, acceptanceCriterionId: outcome.acceptanceCriterionId, failure: outcome.failure, message: outcome.message };
    if (outcome.kind === "passed") return { kind: "verified", round, verdict: "pass", evaluationIds: outcome.checks.map((c) => c.evaluation.id) };
    // The first deterministic failure ends the round: one runtime verdict, recorded once.
    const verdict = ctx.tx.write((): Evaluation => {
      const again = this.state(this.support.node(nodeId));
      return again.current.verdict ?? this.recordRuntimeFailure(again, outcome.failed.evaluation, snapshotId, artifactIds, options);
    });
    return { kind: "verified", round, verdict: "fail", evaluationIds: [...outcome.checks.map((c) => c.evaluation.id), verdict.id] };
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies the next canonical consequence: the producer's Changeset (outside any transaction), then in one transaction
   * the round's progression — the Evaluator's preparation, the verdict from a validated Evaluator result, the next
   * producer round with its feedback, the node's success or failure, or its wait. Repeating it applies nothing twice.
   */
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    return this.settleWith(nodeId, expectedRevisionNumber, options, true);
  }

  /** Finishes the own work of a node that left the current membership: integration and the round's settlement, but no successor Handoff and no new Invocation. */
  settleRemoved(nodeId: PlanNodeId, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    return this.settleWith(nodeId, null, options, false);
  }

  private async settleWith(nodeId: PlanNodeId, expectedRevisionNumber: number | null, options: WriteOptions, current: boolean): Promise<PatternRunnerOutcome> {
    const { ctx, stores } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (current && !this.support.isCurrentMember(node)) return { kind: "stale", expectedRevisionNumber: expectedRevisionNumber ?? 0, currentRevisionNumber: stores.plans.latestRevisionNumber(node.runId) };
    if (!current && this.support.isCurrentMember(node)) throw new InvariantViolationError(`PlanNode ${nodeId} is a current member; settle it through the current revision`);
    const producer = this.state(node).current.producer;
    if (producer !== null && producer.status === "succeeded" && producer.result?.status === "completed" && outstandingChangesetOf(stores, producer) !== null) {
      const step = await this.support.integrate(producer, options);
      if (step.kind !== "integrated") {
        if (!current) return { kind: "no_change" };
        return step.kind === "conflict" ? this.support.markWaiting(nodeId, expectedRevisionNumber!, "integration_conflict", options) : this.support.fail(nodeId, expectedRevisionNumber!, "integration_conflict", options);
      }
      return { kind: "integrated", invocationId: producer.id };
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      if (current) {
        const stale = this.support.staleness(nodeId, expectedRevisionNumber!);
        if (stale) return stale;
      }
      return this.apply(this.support.node(nodeId), options, current);
    });
  }

  /** Inside a transaction: the consequence of the node's canonical rows. */
  private apply(node: PatternPlanNode, options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const { stores } = this.deps;
    if (node.status !== "running") return { kind: "no_change" };
    const state = this.state(node);
    const round = state.current;
    if (state.inline) {
      const producer = round.producer;
      if (producer === null) return current ? this.prepareProducer(node, 1, null, options) : { kind: "no_change" };
      if (!INVOCATION_MACHINE.isTerminal(producer.status)) return { kind: "no_change" };
      switch (producer.status) {
        case "blocked":
          return this.support.wait(node, "decision", options);
        case "cancelled":
          return this.support.cancelNow(node, options);
        case "failed":
          // A producer that failed after its permitted Attempts fails the node; no verdict is manufactured.
          return this.support.failNow(node, "invocation_failed", options);
        case "succeeded": {
          const result = producer.result!;
          if (result.status === "failed") return this.support.failNow(node, "result_failed", options);
          if (result.status === "blocked") return blockingDecisionOf(stores, producer) !== null ? this.support.wait(node, "decision", options) : this.support.failNow(node, "result_blocked", options);
          if (outstandingChangesetOf(stores, producer) !== null) return { kind: "no_change" };
          break;
        }
        default:
          throw new Error(`unreachable: Invocation ${producer.id} is ${producer.status}`);
      }
    }
    const phase = this.phase(state, round);
    switch (phase.kind) {
      case "checks_pending":
        return { kind: "no_change" };
      case "checks_failed": {
        // A deterministic failure recorded without its round verdict (a crash between the two): derive the verdict now.
        const verdict = this.recordRuntimeFailure(state, phase.failed, this.roundSnapshot(state), this.candidate(state), options);
        return this.applyVerdict(node, this.state(node), verdict, options, current);
      }
      case "checks_passed":
        return this.applyEvaluator(node, state, options, current);
      case "judged":
        return this.applyVerdict(node, state, phase.verdict, options, current);
    }
  }

  /** The Evaluator's lifecycle once the deterministic checks passed: prepare it, wait on it, or record its validated verdict. */
  private applyEvaluator(node: PatternPlanNode, state: OptimizerState, options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const { stores } = this.deps;
    const round = state.current;
    const evaluator = round.evaluator;
    if (evaluator === null) return current ? this.prepareEvaluator(node, state, options) : { kind: "no_change" };
    if (!INVOCATION_MACHINE.isTerminal(evaluator.status)) return { kind: "no_change" };
    switch (evaluator.status) {
      case "blocked":
        return this.support.wait(node, "decision", options);
      case "cancelled":
        return this.support.cancelNow(node, options);
      case "failed":
        // A permanently failed Evaluator Invocation fails the node; no verdict is manufactured.
        return this.support.failNow(node, "invocation_failed", options);
      case "succeeded": {
        const result = evaluator.result!;
        if (result.status === "failed") return this.support.failNow(node, "result_failed", options);
        if (result.status === "blocked") return blockingDecisionOf(stores, evaluator) !== null ? this.support.wait(node, "decision", options) : this.support.failNow(node, "result_blocked", options);
        if (result.evaluation === null) throw new InvariantViolationError(`Evaluator Invocation ${evaluator.id} completed without an evaluation; the result validator admits none`, { invocationId: evaluator.id });
        const verdict = this.recordEvaluatorResult(state, evaluator, result.evaluation, options);
        return this.applyVerdict(node, this.state(node), verdict, options, current);
      }
      default:
        throw new Error(`unreachable: Invocation ${evaluator.id} is ${evaluator.status}`);
    }
  }

  /**
   * The consequence of the round's recorded verdict. Inline: pass → succeed with the candidate; fail or inconclusive → the
   * next producer round with the feedback Handoff and input, or `optimizer_rounds_exhausted` at the last round.
   * Evaluate-only: pass → succeed with the candidate (sequence edges deliver); non-final fail or inconclusive → succeed as
   * a control node with the judged candidate (only the retry edge delivers); final → fail.
   */
  private applyVerdict(node: PatternPlanNode, state: OptimizerState, verdict: Evaluation, options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const round = state.current;
    const candidate = this.candidate(state);
    if (verdict.verdict === "pass") return this.support.succeedNow(node, candidate, options, current);
    if (round.round >= state.shape.maxRounds) return this.support.failNow(node, "optimizer_rounds_exhausted", options, verdict.artifactIds);
    if (!state.inline) return this.support.succeedNow(node, candidate, options, current);
    if (!current) return { kind: "no_change" };
    const feedback = this.support.router.ensureOptimizerFeedbackHandoff(node, verdict, options).handoff;
    const nextRound = round.round + 1;
    if (this.support.latestAt(node, { kind: "producer_round", round: nextRound, maxRounds: state.shape.maxRounds }) !== null) return { kind: "no_change" };
    const input: ManifestInput = { kind: "optimizer_feedback", evaluationId: verdict.id, round: round.round, verdict: verdict.verdict, evidence: verdict.evidence };
    return this.prepareProducer(node, nextRound, { predecessor: round.producer!, feedbackHandoffId: feedback.id, input }, options);
  }

  // ---------------------------------------------------------------------------
  // Preparation
  // ---------------------------------------------------------------------------

  /** Producer round `round`: round 1 with the node's edge Handoffs; a later round additionally with the feedback Handoff and input, continuing from the previous producer. */
  private prepareProducer(node: PatternPlanNode, round: number, feedback: { predecessor: Invocation; feedbackHandoffId: string; input: ManifestInput } | null, options: WriteOptions): PatternRunnerOutcome {
    const shape = optimizerShape(node);
    const position: PatternPosition = { kind: "producer_round", round, maxRounds: shape.maxRounds };
    if (this.support.latestAt(node, position) !== null) return { kind: "no_change" };
    const handoffIds = [...this.support.incomingHandoffIds(node), ...(feedback === null ? [] : [feedback.feedbackHandoffId as never])];
    const prepared = this.support.prepare(node, position, { continuedFromInvocationId: feedback?.predecessor.id ?? null, handoffIds, inputs: feedback === null ? [] : [feedback.input] }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "started", invocationId: prepared.invocationId, position };
  }

  /** The round's one Evaluator: the candidate Handoff (inline) or the incoming edge Handoffs (evaluate-only), the typed candidate input, and (inline, round > 1) the previous round's feedback. */
  private prepareEvaluator(node: PatternPlanNode, state: OptimizerState, options: WriteOptions): PatternRunnerOutcome {
    const round = state.current;
    const position: PatternPosition = { kind: "evaluator_round", round: round.round, maxRounds: state.shape.maxRounds };
    if (this.support.latestAt(node, position) !== null) return { kind: "no_change" };
    const inputs: ManifestInput[] = [this.candidateInput(state)];
    let handoffIds: string[];
    if (state.inline) {
      const candidate = this.support.router.ensureOptimizerCandidateHandoff(node, round.producer!, options).handoff;
      handoffIds = [candidate.id];
      if (round.round > 1) {
        const previous = this.deps.stores.evaluations.optimizerVerdictOf(node.id, round.round - 1);
        const feedback = this.support.router.optimizerFeedbackHandoff(node.runId, node.id, round.round - 1);
        if (previous === null || previous.verdict === "pass" || feedback === null) throw new InvariantViolationError(`round ${round.round} of PlanNode ${node.id} started without the previous round's feedback`, { planNodeId: node.id, round: round.round });
        handoffIds.push(feedback.id);
        inputs.push({ kind: "optimizer_feedback", evaluationId: previous.id, round: previous.context!.round, verdict: previous.verdict as "fail" | "inconclusive", evidence: previous.evidence });
      }
    } else {
      handoffIds = this.support.incomingHandoffIds(node);
    }
    const prepared = this.support.prepare(node, position, { continuedFromInvocationId: null, handoffIds: handoffIds as never, inputs }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "started", invocationId: prepared.invocationId, position };
  }

  private candidateInput(state: OptimizerState): ManifestInput {
    return { kind: "optimizer_candidate", round: state.current.round, maxRounds: state.shape.maxRounds, snapshotId: this.roundSnapshot(state), artifactIds: this.candidate(state), acceptanceCriterionIds: state.evaluatedIds };
  }

  // ---------------------------------------------------------------------------
  // Evaluations
  // ---------------------------------------------------------------------------

  /** The runtime's `fail` verdict for a round whose deterministic check failed; its Evidence names the failing Evaluation and its command. */
  private recordRuntimeFailure(state: OptimizerState, failed: Evaluation, snapshotId: SnapshotId, artifactIds: ArtifactId[], options: WriteOptions): Evaluation {
    const existing = this.deps.stores.evaluations.optimizerVerdictOf(state.node.id, state.current.round);
    if (existing !== null) return existing;
    return this.deps.stores.evaluations.record(
      {
        runId: state.node.runId,
        planNodeId: state.node.id,
        gateId: null,
        subject: { kind: "optimizer_round" },
        context: { kind: "optimizer_verdict", round: state.current.round, maxRounds: state.shape.maxRounds },
        verdict: "fail",
        evidence: [{ kind: "evaluation", evaluationId: failed.id }, ...failed.evidence],
        producedBy: { kind: "runtime" },
        artifactIds,
        snapshotId,
      },
      options,
    );
  }

  /** The validated Evaluator result as canonical rows: one Evaluation per evaluated criterion, then the overall verdict; each recorded once. */
  private recordEvaluatorResult(state: OptimizerState, evaluator: Invocation, evaluation: EvaluatorResult, options: WriteOptions): Evaluation {
    const { stores } = this.deps;
    const round = state.current;
    const snapshotId = this.roundSnapshot(state);
    const artifactIds = this.candidate(state);
    const producedBy = { kind: "evaluator" as const, invocationId: evaluator.id, agentDefinitionRevisionId: evaluator.agentDefinitionRevisionId };
    const context = { round: round.round, maxRounds: state.shape.maxRounds };
    for (const criterion of [...evaluation.criteria].sort((a, b) => (a.acceptanceCriterionId < b.acceptanceCriterionId ? -1 : 1))) {
      if (round.criteria.some((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId === criterion.acceptanceCriterionId)) continue;
      stores.evaluations.record(
        { runId: state.node.runId, planNodeId: state.node.id, gateId: null, subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion.acceptanceCriterionId }, context: { kind: "optimizer_criterion", ...context }, verdict: criterion.verdict, evidence: criterion.evidence, producedBy, artifactIds, snapshotId },
        options,
      );
    }
    const existing = stores.evaluations.optimizerVerdictOf(state.node.id, round.round);
    if (existing !== null) return existing;
    return stores.evaluations.record(
      { runId: state.node.runId, planNodeId: state.node.id, gateId: null, subject: { kind: "optimizer_round" }, context: { kind: "optimizer_verdict", ...context }, verdict: evaluation.verdict, evidence: evaluation.evidence, producedBy, artifactIds, snapshotId },
      options,
    );
  }

  // ---------------------------------------------------------------------------
  // Waiting and resuming
  // ---------------------------------------------------------------------------

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome {
    return this.support.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }

  /**
   * Clears a wait whose condition has cleared: the node returns to `running`; for a `decision` wait the blocked producer
   * or Evaluator gets its approval successor at the same round position, with the same typed optimizer inputs, so a
   * continuation never consumes another round.
   */
  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (node.status !== "waiting") return { kind: "no_change" };
      const reason = node.waitReason!;
      const state = this.state(node);
      const advice = this.inspectWaiting(node, state);
      if (advice.kind !== "waiting" || !advice.cleared) return { kind: "no_change" };
      const running = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      if (reason !== "decision") return { kind: "resumed", reason };
      const blocked = [state.current.evaluator, state.current.producer].find((i): i is Invocation => i !== null && INVOCATION_MACHINE.isTerminal(i.status) && (blockedOn(stores, i)?.status ?? "open") !== "open");
      if (blocked === undefined) return { kind: "resumed", reason };
      const extra = stores.invocations.getManifest(blocked.id).content.inputs.filter((i) => i.kind === "optimizer_candidate" || i.kind === "optimizer_feedback");
      return this.support.prepareSuccessor(running, blocked, blockedOn(stores, blocked)!, extra, options);
    });
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  /** The node's state from rows: the current round's Invocations and Evaluations, and the criteria split by kind. */
  private state(node: PatternPlanNode): OptimizerState {
    const { stores } = this.deps;
    const shape = optimizerShape(node);
    const inline = shape.producer !== null;
    const criteria = node.gateAcceptanceCriterionIds.map((id) => stores.requirements.getAcceptanceCriterion(id));
    const deterministic = criteria.filter((c) => c.check.kind === "deterministic").sort((a, b) => (a.id < b.id ? -1 : 1));
    const evaluatedIds = criteria.filter((c) => c.check.kind === "evaluated").map((c) => c.id).sort();
    let round: number;
    if (inline) {
      round = 1;
      for (let r = shape.maxRounds; r >= 1; r -= 1) {
        if (this.support.latestAt(node, { kind: "producer_round", round: r, maxRounds: shape.maxRounds }) !== null) {
          round = r;
          break;
        }
      }
    } else {
      round = shape.round!;
    }
    const current: RoundState = {
      round,
      producer: inline ? this.support.latestAt(node, { kind: "producer_round", round, maxRounds: shape.maxRounds }) : null,
      evaluator: this.support.latestAt(node, { kind: "evaluator_round", round, maxRounds: shape.maxRounds }),
      criteria: stores.evaluations.optimizerCriterionEvaluationsOf(node.id, round),
      verdict: stores.evaluations.optimizerVerdictOf(node.id, round),
    };
    return { node, shape, inline, current, deterministic, evaluatedIds };
  }

  /** Where the round stands from its Evaluations: judged, or its deterministic checks pending, failed, or all passed. */
  private phase(state: OptimizerState, round: RoundState): RoundPhase {
    if (round.verdict !== null) return { kind: "judged", verdict: round.verdict };
    const byCriterion = new Map(round.criteria.map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e] as const));
    for (const criterion of state.deterministic) {
      const evaluation = byCriterion.get(criterion.id);
      if (evaluation === undefined) return { kind: "checks_pending" };
      if (evaluation.verdict !== "pass") return { kind: "checks_failed", failed: evaluation };
    }
    return { kind: "checks_passed" };
  }

  /** The round's judged Snapshot: the one its Evaluations or its Evaluator's manifest already recorded, otherwise the Run's current integration Snapshot. */
  private roundSnapshot(state: OptimizerState): SnapshotId {
    const { stores } = this.deps;
    const recorded = state.current.verdict?.snapshotId ?? state.current.criteria[0]?.snapshotId ?? null;
    if (recorded !== null) return recorded;
    const evaluator = state.current.evaluator;
    if (evaluator !== null) {
      const candidate = stores.invocations.getManifest(evaluator.id).content.inputs.find((i): i is Extract<ManifestInput, { kind: "optimizer_candidate" }> => i.kind === "optimizer_candidate");
      if (candidate !== undefined) return candidate.snapshotId;
    }
    const run = stores.runs.get(state.node.runId);
    const id = run.integrationSnapshotId ?? run.baseSnapshotId;
    if (id === null) throw new InvariantViolationError(`Run ${run.id} has no integration Snapshot to verify`, { runId: run.id });
    return id;
  }

  /**
   * The round's candidate Artifact ids: the producer's result Artifacts (inline), or the Artifacts carried by the node's
   * incoming `sequence` Handoffs in canonical edge order (evaluate-only), each id once.
   */
  private candidate(state: OptimizerState): ArtifactId[] {
    if (state.inline) {
      const producer = state.current.producer;
      if (producer === null || producer.result === null) throw new InvariantViolationError(`round ${state.current.round} of PlanNode ${state.node.id} has no candidate yet`, { planNodeId: state.node.id });
      return [...producer.result.artifactIds].sort();
    }
    // Exactly the delivering sequence edges of the current revision, in canonical order; an inactive edge (a route's own
    // sequence edge under a composite selection, a skipped alternative) carries nothing.
    const input = this.support.readinessInput(state.node.runId);
    const ids: ArtifactId[] = [];
    for (const edge of predecessorEdges(input.graph, state.node.id)) {
      if (edge.type !== "sequence" || edgeActivation(input, edge).kind !== "delivers") continue;
      const handoff = this.deps.stores.handoffs.getByKey(state.node.runId, `sequence:${edge.sourceNodeId}:${state.node.id}`);
      if (handoff === null) throw new InvariantViolationError(`the sequence Handoff from PlanNode ${edge.sourceNodeId} into ${state.node.id} does not exist`, { planNodeId: state.node.id });
      for (const id of handoff.artifactIds) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
}

/** The immutable evaluator_optimizer shape of a node. */
function optimizerShape(node: PatternPlanNode): OptimizerShape {
  if (node.shape.pattern !== "evaluator_optimizer") throw new Error(`PlanNode ${node.id} is a ${node.shape.pattern} node, not an evaluator_optimizer`);
  return node.shape;
}
