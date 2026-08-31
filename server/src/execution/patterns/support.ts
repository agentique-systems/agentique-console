/**
 * The canonical machinery shared by every Pattern runner (execution-model
 * §5, §7.2–§7.6, §9.1, §9.2): `PatternNodeSupport` owns what every runner
 * needs — node loading and revision revalidation, the current readiness
 * input, Invocation preparation at a typed position under the node's
 * allocation policy, owned-Task readying, waiting and failing, integration
 * of an Invocation's Changeset, the decision-resolution successor — and the
 * `SequentialStepEngine` runs the `single` and `chain` Patterns over it. A
 * Pattern runner never talks to a provider: it owns its node's lifecycle in
 * short root transactions — revalidating the current revision, membership,
 * node status, and active Invocations inside each — and returns closed,
 * typed outcomes. Integration of a Changeset and a Gate's deterministic checks are the
 * external steps, awaited outside every transaction through the integration
 * and check services; the `node_exit` Gate phase itself lives in
 * `../gates.ts` and is reached through `PatternNodeSupport.gates`.
 *
 * Everything here is derived from canonical rows: Pattern positions,
 * Invocations and their results, Changesets, Handoffs by key, Decisions,
 * Evaluations, reservations. Nothing reads a transcript, an Event, or
 * process memory, and every operation is safe to repeat: a position already
 * prepared, a Changeset already integrated, a Handoff already created, or a
 * node already transitioned is found, never duplicated.
 */
import {
  ConflictError,
  InvariantViolationError,
  INVOCATION_MACHINE,
  PATTERN_POSITION_BINDINGS,
  PLAN_NODE_MACHINE,
  operationAt,
  patternPositionKey,
  ROOT_SOURCE_PATH,
  TASK_MACHINE,
  type AcceptanceCriterionId,
  type Allocation,
  type ArtifactId,
  type BudgetReservationId,
  type CompiledOperation,
  type CoordinatorPurpose,
  type Decision,
  type DecisionId,
  type EvaluationId,
  type GateId,
  type HandoffId,
  type Invocation,
  type InvocationId,
  type InvocationPurpose,
  type ManifestInput,
  type Pattern,
  type PatternPlanNode,
  type PatternPosition,
  type PlanGraph,
  type PlanNode,
  type PlanNodeFailureReason,
  type PlanNodeId,
  type PlanNodeWaitReason,
  type RunId,
  type SnapshotId,
  type Task,
  type TaskId,
  type Timestamp,
  approvalSubjectOf,
} from "@agentique-console/core";
import type { PersistenceContext } from "../../persistence/context.ts";
import type { Stores } from "../../persistence/stores/index.ts";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import type { AcceptanceCheckService } from "../acceptance-checks.ts";
import type { AttemptExecutor } from "../attempt-executor.ts";
import { NodeExitGates, type GateCandidateSource } from "../gates.ts";
import type { ResourceGovernor } from "../governor.ts";
import { HandoffRouter } from "../handoff-routing.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf } from "../invocation-facts.ts";
import type { AcceptanceCriterionExecutionFailure } from "../ports/acceptance-criterion-execution.ts";
import type { ChangesetIntegrationService } from "../integration-service.ts";
import type { InvocationPreparationService } from "../invocation-preparation-service.ts";
import type { CapacityAdmission, PlanNodeCapacity } from "../plan-node-capacity.ts";
import { currentReadinessInput } from "../readiness-facts.ts";
import type { ReadinessInput } from "../readiness.ts";

/** What a node needs next, from canonical rows alone (read-only). */
export type NodeAdvice =
  /** `ready` (or `running` with no Invocation yet): prepare the first position. */
  | { kind: "start" }
  /**
   * A running node may prepare another position now: a further parallel item, a runnable Coordinator Task's Worker, the
   * successor of a blocked position whose Decision resolved, or (with `turn`) the next Coordinator logical turn.
   */
  | { kind: "start_position"; position: PatternPosition; turn?: CoordinatorPurpose }
  /** The named active Invocation may create its next Attempt now. */
  | { kind: "execute"; invocationId: InvocationId }
  /** An evaluator_optimizer round's deterministic Acceptance Criteria are pending: run them (external, outside any transaction). */
  | { kind: "verify"; round: number }
  /** An Attempt of an active Invocation is executing in this process. */
  | { kind: "attempt_in_flight"; invocationId: InvocationId }
  /** An active Invocation's retry is permitted only from `notBefore`. */
  | { kind: "retry_not_before"; invocationId: InvocationId; notBefore: Timestamp }
  /** A terminal Invocation's consequences (or a selector Decision's answer) are not yet applied to the node; `invocationId` names the Invocation concerned when one exists. */
  | { kind: "settle"; invocationId: InvocationId | null }
  /** The Pattern's candidate is complete and integrated: the next `node_exit` Gate cycle may open now (execution-model §10). */
  | { kind: "open_gate" }
  /** The open Gate's deterministic Acceptance Criteria are pending: run them (external, outside any transaction). */
  | { kind: "verify_gate"; gateId: GateId }
  /** The open Gate's deterministic criteria passed and evaluated criteria remain: prepare its one Evaluator Invocation. */
  | { kind: "prepare_gate_evaluator"; gateId: GateId }
  /** The Gate's rows imply a consequence not yet applied: record verdicts, close it, settle the node, create its remediation Task, or fail the node. */
  | { kind: "settle_gate"; gateId: GateId }
  /** The Gate failed and its remediation Task is owned elsewhere (the root Orchestrator); the node waits for it. */
  | { kind: "awaiting_remediation"; gateId: GateId; taskId: TaskId }
  /** The node waits; `cleared` says whether the condition has cleared and `resume` applies; `wakeAt` when a time is known. */
  | { kind: "waiting"; reason: PlanNodeWaitReason; cleared: boolean; wakeAt: Timestamp | null }
  | { kind: "terminal"; status: "succeeded" | "failed" | "cancelled" | "skipped" }
  /** The node is not a member of the current revision: its own started work may finish (`settle` says a settlement is due), nothing new starts. */
  | { kind: "not_current"; invocationId: InvocationId | null; settle: boolean };

/** The closed outcome of one canonical runner action. */
export type PatternRunnerOutcome =
  | { kind: "started"; invocationId: InvocationId; position: PatternPosition }
  /** An evaluate-only evaluator_optimizer node started its round over its incoming candidate; no Invocation exists until its checks pass. */
  | { kind: "round_opened"; round: number }
  | { kind: "step_prepared"; invocationId: InvocationId; position: PatternPosition; handoffId: HandoffId }
  /** `position` is `null` for a Gate Evaluator's successor. */
  | { kind: "successor_prepared"; invocationId: InvocationId; position: PatternPosition | null; decisionId: DecisionId }
  /** A route node recorded its selection; `invocationId` is the inline branch Invocation, or `null` for a composite selection. */
  | { kind: "selected"; evaluationId: EvaluationId; selectedLabel: string; invocationId: InvocationId | null }
  /** A parallel item's or a Coordinator Worker's Changeset was integrated in canonical order. */
  | { kind: "integrated"; invocationId: InvocationId }
  /** A Worker's Changeset conflicted: recorded through the conflict lifecycle, now an unresolved blocker of its coordinator_worker node. */
  | { kind: "conflicted"; invocationId: InvocationId }
  /** The runtime applied its Task readiness projection: these Tasks became ready or blocked. */
  | { kind: "tasks_projected"; readied: TaskId[]; blocked: TaskId[] }
  /** A completed, integrated Worker Task's result Handoff was recorded for the next Coordinator turn. */
  | { kind: "worker_result_recorded"; invocationId: InvocationId; handoffId: HandoffId }
  /** An evaluator_optimizer round's deterministic checks ran: every one passed, or the first failure ended the round with a runtime verdict. */
  | { kind: "verified"; round: number; verdict: "pass" | "fail"; evaluationIds: EvaluationId[] }
  /** An evaluator_optimizer round's deterministic check could not be carried out; nothing was recorded for it and a later pass retries. */
  | { kind: "verification_failed"; round: number; acceptanceCriterionId: string; failure: string; message: string }
  /** An evaluator_optimizer round's overall verdict was recorded from the validated Evaluator result (or derived by the runtime). */
  | { kind: "verdict_recorded"; round: number; verdict: "pass" | "fail" | "inconclusive"; evaluationId: EvaluationId }
  /** A `node_exit` Gate opened with its pinned Snapshot and candidate (execution-model §10). */
  | { kind: "gate_opened"; gateId: GateId; ordinal: number; snapshotId: SnapshotId; candidateArtifactIds: ArtifactId[] }
  /** The Gate's deterministic checks ran: every one passed, or the first failure ended them. */
  | { kind: "gate_verified"; gateId: GateId; verdict: "pass" | "fail"; evaluationIds: EvaluationId[] }
  /** A Gate check could not be carried out; nothing was recorded for it and a later pass retries. */
  | { kind: "gate_verification_failed"; gateId: GateId; acceptanceCriterionId: AcceptanceCriterionId; failure: AcceptanceCriterionExecutionFailure; message: string }
  | { kind: "gate_evaluator_prepared"; gateId: GateId; invocationId: InvocationId }
  /** The Evaluator's verdicts were recorded; the Gate stays open until every criterion has one. */
  | { kind: "gate_evaluations_recorded"; gateId: GateId; evaluationIds: EvaluationId[] }
  /** The Gate closed `passed` and the node succeeded with the candidate; its edge Handoffs exist. */
  | { kind: "gate_passed"; gateId: GateId; outputArtifactIds: string[]; handoffIds: HandoffId[] }
  /** The Gate closed `failed`; its one remediation Task exists (or the node failed on an exhausted cycle bound, reported as `failed`). */
  | { kind: "gate_failed"; gateId: GateId; remediationTaskId: TaskId | null }
  /** A Coordinator's replan turn made canonical progress on a failed Gate delivered to it: the remediation Task is addressed; the next synthesis is the next Gate's candidate. */
  | { kind: "gate_remediation_addressed"; gateId: GateId; taskId: TaskId; invocationId: InvocationId }
  | { kind: "succeeded"; outputArtifactIds: string[]; handoffIds: HandoffId[] }
  | { kind: "failed"; reason: PlanNodeFailureReason }
  | { kind: "cancelled" }
  | { kind: "waiting"; reason: PlanNodeWaitReason; wakeAt: Timestamp | null }
  | { kind: "resumed"; reason: PlanNodeWaitReason }
  /** The revision, membership, or node state changed since projection; nothing was written. */
  | { kind: "stale"; expectedRevisionNumber: number; currentRevisionNumber: number }
  /** Already applied by an earlier pass; nothing was written. */
  | { kind: "no_change" };

export interface PatternRunnerDependencies {
  ctx: PersistenceContext;
  stores: Stores;
  executor: AttemptExecutor;
  preparation: InvocationPreparationService;
  integration: ChangesetIntegrationService;
  /** Deterministic Acceptance Criterion execution, used by the evaluator_optimizer runner for its rounds. */
  checks: AcceptanceCheckService;
  /** Reservable Plan Node capacity (execution-model §7.6): the one operation that funds a node's next child under its allocation policy. */
  capacity: PlanNodeCapacity;
  governor: ResourceGovernor;
  provider: { readonly provider: string };
}

export { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf } from "../invocation-facts.ts";

/** The outcome of integrating an Invocation's outstanding Changeset, reduced to what a runner acts on. */
export type IntegrationStep = { kind: "integrated" } | { kind: "conflict" } | { kind: "conflict_unresolved" };

export interface PreparationRequest {
  continuedFromInvocationId: InvocationId | null;
  handoffIds: HandoffId[];
  inputs: ManifestInput[];
  /** A Coordinator Task's reservation to transfer (a `worker_task` position); the node's allocation check is then already settled. */
  taskReservationId?: BudgetReservationId;
}

/** Everything a waiting node's condition is checked against. */
export interface WaitContext {
  /** Terminal Invocations blocked on a Decision (by status or result), whose resolution clears a `decision` wait. */
  blocked: Invocation[];
  /** For a `decision` wait with no blocked Invocation: the selector Decision a route node waits on. */
  selectorDecision: Decision | null;
  /** The next position the node must fund, for a `budget` wait; `null` when none. */
  nextPosition: PatternPosition | null;
  /** An active Invocation whose Attempt was refused capacity, for a `provider_capacity` wait. */
  capacity: Invocation | null;
  /** Invocations whose Changeset is in conflict, for an `integration_conflict` wait. */
  conflicted: Invocation[];
}

export class PatternNodeSupport {
  readonly router: HandoffRouter;
  /** The `node_exit` Gate engine shared by every runner (execution-model §10). */
  readonly gates: NodeExitGates;

  constructor(
    readonly deps: PatternRunnerDependencies,
    readonly pattern: Pattern,
  ) {
    this.router = new HandoffRouter(deps.stores);
    this.gates = new NodeExitGates(this);
  }

  // ---------------------------------------------------------------------------
  // Canonical reads
  // ---------------------------------------------------------------------------

  node(nodeId: PlanNodeId): PatternPlanNode {
    const node = this.deps.stores.plans.getNode(nodeId);
    if (node.kind !== "pattern") throw new ConflictError(`PlanNode ${nodeId} is a join node; it has no Pattern runner`);
    if (node.sourcePath === ROOT_SOURCE_PATH) throw new ConflictError(`PlanNode ${nodeId} is the root Orchestrator node; no Pattern runner completes it`);
    if (node.pattern !== this.pattern) throw new ConflictError(`PlanNode ${nodeId} is a ${node.pattern} node, not ${this.pattern}`);
    return node;
  }

  /** `null` when the current revision is the expected one and the node is a member; a `stale` outcome otherwise. */
  staleness(nodeId: PlanNodeId, expectedRevisionNumber: number): PatternRunnerOutcome | null {
    const node = this.deps.stores.plans.getNode(nodeId);
    const current = this.deps.stores.plans.latestRevisionNumber(node.runId);
    if (current !== expectedRevisionNumber) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
    const member = this.deps.stores.plans.listMembership(node.runId, current).some((m) => m.planNodeId === nodeId);
    if (!member) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
    return null;
  }

  isCurrentMember(node: PlanNode): boolean {
    return this.deps.stores.plans.listMembership(node.runId, this.deps.stores.plans.latestRevisionNumber(node.runId)).some((m) => m.planNodeId === node.id);
  }

  /** The current graph with its condition facts, from rows: what every Handoff activation is computed from. */
  readinessInput(runId: RunId): ReadinessInput {
    return currentReadinessInput(this.deps.stores, runId);
  }

  graphOf(runId: RunId): PlanGraph {
    return this.deps.stores.plans.currentGraph(runId);
  }

  memberOf(graph: PlanGraph, nodeId: PlanNodeId): PlanNode | null {
    return graph.nodes.find((n) => n.id === nodeId) ?? null;
  }

  latestAt(node: PatternPlanNode, position: PatternPosition): Invocation | null {
    return this.deps.stores.invocations.latestAtPosition(node.id, patternPositionKey(position));
  }

  /** The ids of every edge Handoff addressed to the node: what each of its first-position Invocations is delivered. */
  incomingHandoffIds(node: PatternPlanNode): HandoffId[] {
    return this.router.incomingHandoffsFor(node.runId, node.id).map((h) => h.id);
  }

  /**
   * The typed `optimizer_feedback` input an Invocation receives with every
   * `retry` Handoff among its deliveries (execution-model §5.6): the canonical
   * round verdict of the evaluate-only node the retry edge leaves, read from
   * rows, so the entry of the next unrolled producer round knows why the
   * previous round failed. Every other Handoff adds nothing.
   */
  retryFeedbackInputs(handoffIds: readonly HandoffId[]): ManifestInput[] {
    const { stores } = this.deps;
    return handoffIds.flatMap((id): ManifestInput[] => {
      const handoff = stores.handoffs.get(id);
      if (!handoff.handoffKey.startsWith("retry:") || handoff.source.kind !== "plan_node") return [];
      const verdict = stores.evaluations.optimizerVerdictsOfNode(handoff.source.planNodeId).at(-1);
      if (verdict === undefined || verdict.context === null || verdict.context.kind !== "optimizer_verdict") throw new InvariantViolationError(`retry Handoff ${handoff.id} leaves PlanNode ${handoff.source.planNodeId}, which recorded no round verdict`, { handoffId: handoff.id });
      if (verdict.verdict === "pass") throw new InvariantViolationError(`retry Handoff ${handoff.id} exists although PlanNode ${handoff.source.planNodeId} passed round ${verdict.context.round}`, { handoffId: handoff.id, evaluationId: verdict.id });
      return [{ kind: "optimizer_feedback", evaluationId: verdict.id, round: verdict.context.round, verdict: verdict.verdict, evidence: verdict.evidence }];
    });
  }

  // ---------------------------------------------------------------------------
  // Preparation
  // ---------------------------------------------------------------------------

  /**
   * Prepares the Invocation at `position` — role and purpose from the
   * position's binding, operation from the immutable shape — under the
   * node's allocation policy; inside the caller's transaction.
   */
  prepare(node: PatternPlanNode, position: PatternPosition, request: PreparationRequest, options: WriteOptions): { kind: "prepared"; invocationId: InvocationId } | { kind: "refused"; outcome: PatternRunnerOutcome } {
    const { preparation } = this.deps;
    const operation = operationAt(node.shape, position);
    if (operation === null) throw new Error(`PlanNode ${node.id} has no ${patternPositionKey(position)} position`);
    const binding = PATTERN_POSITION_BINDINGS[position.kind];
    if (binding.purpose === null) throw new Error(`position ${position.kind} fixes no purpose; a Pattern runner prepares only fixed-purpose positions`);
    return this.prepareAs(node, position, binding.purpose, request, options);
  }

  /** `prepare` for a position whose purpose the runner fixes (a Coordinator turn): the same funding, ownership, and manifest rules. */
  prepareAs(node: PatternPlanNode, position: PatternPosition, purpose: InvocationPurpose, request: PreparationRequest, options: WriteOptions): { kind: "prepared"; invocationId: InvocationId } | { kind: "refused"; outcome: PatternRunnerOutcome } {
    const { preparation } = this.deps;
    const operation = operationAt(node.shape, position);
    if (operation === null) throw new Error(`PlanNode ${node.id} has no ${patternPositionKey(position)} position`);
    const binding = PATTERN_POSITION_BINDINGS[position.kind];
    if (binding.purpose !== null && binding.purpose !== purpose) throw new Error(`position ${position.kind} fixes purpose ${binding.purpose}, not ${purpose}`);
    // A transferred Task reservation was checked against the node when the Task was accepted; fresh funding goes through the one
    // capacity operation, which extends the node's allocation under `extend` in this same transaction or refuses by policy.
    if (request.taskReservationId === undefined) {
      const funded = this.deps.capacity.ensure(node, this.requiredFor(node, position), "invocation", options);
      if (funded.kind === "ineligible") throw new InvariantViolationError(`PlanNode ${node.id} cannot fund ${patternPositionKey(position)}: ${funded.reason.kind}`, { planNodeId: node.id, reason: funded.reason });
      if (funded.kind === "refused") return { kind: "refused", outcome: funded.policy === "fail" ? this.failNow(node, "allocation_exhausted", options) : this.wait(node, "budget", options) };
    }
    const tasks = this.readyOwnedTasks(node, operation, options);
    if (tasks.kind === "unavailable") return { kind: "refused", outcome: this.failNow(node, "task_unavailable", options) };
    const prepared = preparation.prepare({
      runId: node.runId,
      planNodeId: node.id,
      role: binding.role,
      purpose,
      patternPosition: position,
      continuedFromInvocationId: request.continuedFromInvocationId,
      handoffIds: request.handoffIds,
      inputs: [...request.inputs, ...this.retryFeedbackInputs(request.handoffIds)],
      ...(request.taskReservationId === undefined ? {} : { funding: { source: "task_transfer" as const, taskReservationId: request.taskReservationId } }),
      correlationId: options.correlationId ?? null,
      causationSeq: options.causationSeq ?? null,
    });
    return { kind: "prepared", invocationId: prepared.invocation.id };
  }

  /**
   * The successor of a terminal Invocation blocked on a now-resolved
   * Decision, at the same position, continuing from it with the typed
   * resolution input (plus `extraInputs`, e.g. a route selection) and its
   * predecessor's Handoffs, on a fresh reservation and worktree. A
   * superseded Decision without a resolution fails the node as blocked.
   */
  prepareSuccessor(node: PatternPlanNode, predecessor: Invocation, decision: Decision, extraInputs: ManifestInput[], options: WriteOptions): PatternRunnerOutcome {
    const { stores } = this.deps;
    const position = predecessor.patternPosition!;
    if (decision.status !== "resolved" || decision.resolution === null) return this.failNow(node, "result_blocked", options);
    const resolution: ManifestInput =
      predecessor.status === "blocked" && decision.kind === "side_effect_approval" && decision.subject !== null
        ? { kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: predecessor.id, attemptId: approvalSubjectOf(decision).attemptId, tool: approvalSubjectOf(decision).tool, callDigest: approvalSubjectOf(decision).callDigest, callArtifactId: approvalSubjectOf(decision).callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" }
        : { kind: "decision_resolution", decisionId: decision.id };
    const handoffIds = stores.invocations.getManifest(predecessor.id).content.handoffs.map((h) => h.handoffId);
    const prepared = this.prepareAs(node, position, predecessor.purpose, { continuedFromInvocationId: predecessor.id, handoffIds, inputs: [...extraInputs, resolution] }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "successor_prepared", invocationId: prepared.invocationId, position, decisionId: decision.id };
  }

  /** The allocation the Invocation at `position` needs: its operation's Agent Definition default. */
  requiredFor(node: PatternPlanNode, position: PatternPosition): Allocation {
    const operation = operationAt(node.shape, position);
    if (operation === null) throw new Error(`PlanNode ${node.id} has no ${patternPositionKey(position)} position`);
    return this.deps.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
  }

  /** Whether the node can fund the Invocation at `position` now — from its effective allocation, or through the extension its `extend` policy admits (read-only). */
  admits(node: PatternPlanNode, position: PatternPosition): CapacityAdmission {
    return this.deps.capacity.admits(node, this.requiredFor(node, position));
  }

  /**
   * Readies the Tasks an operation names so the Invocation can own them:
   * `pending` with completed dependencies → `ready`; `blocked` on a
   * resolved Decision or by a predecessor that ended → `ready`; `running`
   * on a terminal predecessor of this node → `blocked` → `ready`. Anything
   * else the node cannot own.
   */
  private readyOwnedTasks(node: PatternPlanNode, operation: CompiledOperation, options: WriteOptions): { kind: "ready" } | { kind: "unavailable"; taskId: TaskId; status: Task["status"] } {
    const { stores } = this.deps;
    for (const taskId of operation.input.taskIds) {
      const task = stores.tasks.get(taskId);
      if (task.planNodeId !== null && task.planNodeId !== node.id) return { kind: "unavailable", taskId, status: task.status };
      switch (task.status) {
        case "ready":
          continue;
        case "pending":
          if (!stores.tasks.dependenciesCompleted(taskId)) return { kind: "unavailable", taskId, status: task.status };
          stores.tasks.transition(taskId, { to: "ready" }, options);
          continue;
        case "blocked": {
          const reason = task.blockReason!;
          if (reason.kind === "decision" && stores.decisions.get(reason.decisionId).status === "open") return { kind: "unavailable", taskId, status: task.status };
          if (reason.kind === "dependency_failed" || reason.kind === "dependency_cancelled") return { kind: "unavailable", taskId, status: task.status };
          stores.tasks.transition(taskId, { to: "ready" }, options);
          continue;
        }
        case "running": {
          const holder = task.invocationId === null ? null : stores.invocations.get(task.invocationId);
          if (holder === null || holder.planNodeId !== node.id || !INVOCATION_MACHINE.isTerminal(holder.status)) return { kind: "unavailable", taskId, status: task.status };
          stores.tasks.transition(taskId, { to: "blocked", blockReason: { kind: "input", description: `Invocation ${holder.id} ended ${holder.status} without reporting the Task` } }, options);
          stores.tasks.transition(taskId, { to: "ready" }, options);
          continue;
        }
        default:
          return { kind: "unavailable", taskId, status: task.status };
      }
    }
    return { kind: "ready" };
  }

  // ---------------------------------------------------------------------------
  // Waiting, failing, integrating
  // ---------------------------------------------------------------------------

  /** A waiting node's condition and whether it has cleared, from the runner's wait context. */
  inspectWaiting(node: PatternPlanNode, context: WaitContext): NodeAdvice {
    const { stores, governor } = this.deps;
    const reason = node.waitReason!;
    switch (reason) {
      case "decision": {
        const evaluator = this.gates.openGateEvaluator(node);
        if (evaluator !== null && INVOCATION_MACHINE.isTerminal(evaluator.status) && blockedOn(stores, evaluator) !== null && !context.blocked.some((i) => i.id === evaluator.id)) context.blocked.push(evaluator);
        if (context.blocked.length > 0) {
          const cleared = context.blocked.some((invocation) => {
            const decision = blockedOn(stores, invocation);
            return decision !== null && decision.status !== "open";
          });
          return { kind: "waiting", reason, cleared, wakeAt: null };
        }
        if (context.selectorDecision !== null) return { kind: "waiting", reason, cleared: context.selectorDecision.status !== "open", wakeAt: null };
        throw new Error(`PlanNode ${node.id} waits on a Decision without a blocked Invocation or selector`);
      }
      case "provider_capacity": {
        const invocation = context.capacity;
        const worktrees = invocation !== null && invocation.workspaceCleanup === "pending" && stores.invocations.getManifest(invocation.id).content.worktreePath !== null ? 1 : 0;
        const refusal = governor.check({ runId: node.runId, provider: this.deps.provider.provider, worktrees });
        return { kind: "waiting", reason, cleared: refusal === null, wakeAt: refusal?.retryAfter ?? null };
      }
      case "budget": {
        // A node whose open Gate awaits its Evaluator waits for the Evaluator's funding, not for a further position's.
        if (this.gates.awaitingEvaluator(node)) return { kind: "waiting", reason, cleared: this.gates.evaluatorFits(node), wakeAt: null };
        const fits = context.nextPosition === null || this.admits(node, context.nextPosition).fits;
        return { kind: "waiting", reason, cleared: fits, wakeAt: null };
      }
      case "integration_conflict": {
        const open = context.conflicted.some((invocation) => {
          const changeset = outstandingChangesetOf(stores, invocation);
          return changeset !== null && changeset.integrationStatus === "conflict" && changeset.conflictTaskId !== null && !TASK_MACHINE.isTerminal(stores.tasks.get(changeset.conflictTaskId).status);
        });
        return { kind: "waiting", reason, cleared: !open, wakeAt: null };
      }
      case "operator":
        return { kind: "waiting", reason, cleared: false, wakeAt: null };
    }
  }

  wait(node: PatternPlanNode, reason: PlanNodeWaitReason, options: WriteOptions): PatternRunnerOutcome {
    this.deps.stores.plans.transitionNode(node.id, { to: "waiting", waitReason: reason }, options);
    return { kind: "waiting", reason, wakeAt: null };
  }

  /** Records that the node cannot proceed for `reason` (idempotent), after revalidation. */
  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: PlanNodeWaitReason, options: WriteOptions = {}): PatternRunnerOutcome {
    return this.deps.ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      if (node.status === "waiting" && node.waitReason === reason) return { kind: "no_change" };
      if (node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      return this.wait(node, reason, options);
    });
  }

  /**
   * A `decision` wait whose blocked Invocation is the open Gate's Evaluator: prepares its successor for the same Gate
   * once the Decision resolved; `null` when the wait belongs to a Pattern position instead.
   */
  resumeGateEvaluator(node: PatternPlanNode, options: WriteOptions): PatternRunnerOutcome | null {
    const evaluator = this.gates.openGateEvaluator(node);
    if (evaluator === null || !INVOCATION_MACHINE.isTerminal(evaluator.status)) return null;
    const decision = blockedOn(this.deps.stores, evaluator);
    if (decision === null || decision.status === "open") return null;
    return this.gates.prepareEvaluatorSuccessor(node, evaluator, decision, options);
  }

  /** Fails the node now (from `running` or `waiting`), failing every owned Task still running on its terminal Invocations. */
  failNow(node: PatternPlanNode, reason: PlanNodeFailureReason, options: WriteOptions, artifactIds: ArtifactId[] = []): PatternRunnerOutcome {
    const { stores } = this.deps;
    const current = node.status === "waiting" ? (stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode) : node;
    for (const owned of stores.invocations.listByPlanNode(current.id)) {
      if (!INVOCATION_MACHINE.isTerminal(owned.status)) continue;
      for (const taskId of owned.taskIds) {
        const task = stores.tasks.get(taskId);
        if (task.status === "running" && task.invocationId === owned.id) stores.tasks.transition(task.id, { to: "failed", failureReason: "permanent_failure" }, options);
      }
    }
    stores.plans.transitionNode(current.id, { to: "failed", reason, artifactIds }, options);
    return { kind: "failed", reason };
  }

  /** Cancels the node now (from `running` or `waiting`) because its Invocation was cancelled. */
  cancelNow(node: PatternPlanNode, options: WriteOptions): PatternRunnerOutcome {
    const { stores } = this.deps;
    if (node.status === "waiting") stores.plans.transitionNode(node.id, { to: "running" }, options);
    stores.plans.transitionNode(node.id, { to: "cancelled", reason: "invocation_cancelled" }, options);
    return { kind: "cancelled" };
  }

  /** Fails the node after revalidation, in its own transaction. */
  fail(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: PlanNodeFailureReason, options: WriteOptions): PatternRunnerOutcome {
    return this.deps.ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
      return this.failNow(node, reason, options);
    });
  }

  /** Succeeds the node with its outputs and creates the current-revision edge Handoffs from it; inside the caller's transaction. */
  succeedNow(node: PatternPlanNode, outputArtifactIds: ArtifactId[], options: WriteOptions, handoffs = true): PatternRunnerOutcome {
    const { stores } = this.deps;
    const current = node.status === "waiting" ? (stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode) : node;
    const outputs = [...outputArtifactIds].sort();
    stores.plans.transitionNode(current.id, { to: "succeeded", outputArtifactIds: outputs }, options);
    if (!handoffs) return { kind: "succeeded", outputArtifactIds: outputs, handoffIds: [] };
    const ensured = this.router.ensureEdgeHandoffsFrom(this.readinessInput(current.runId), current.id, options);
    return { kind: "succeeded", outputArtifactIds: outputs, handoffIds: ensured.map((h) => h.handoff.id) };
  }

  /** Integrates an Invocation's outstanding Changeset outside any transaction; `integrated` when none is outstanding. */
  async integrate(invocation: Invocation, options: WriteOptions): Promise<IntegrationStep> {
    const { ctx, stores, integration } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner integrates outside any transaction; integration is external");
    const changeset = outstandingChangesetOf(stores, invocation);
    if (changeset === null) return { kind: "integrated" };
    const outcome = await integration.integrate(changeset.id, options);
    if (outcome.kind === "integrated" || outcome.kind === "already_integrated") return { kind: "integrated" };
    if (outcome.kind === "conflict_unresolved") return { kind: "conflict_unresolved" };
    return { kind: "conflict" };
  }
}

/**
 * The generic sequential engine: a node executes a fixed sequence of
 * positions one Invocation at a time. `single` has one position; `chain`
 * has one per step. The runners own validation and expose this engine.
 */
export class SequentialStepEngine {
  readonly support: PatternNodeSupport;
  readonly router: HandoffRouter;

  constructor(
    private readonly deps: PatternRunnerDependencies,
    private readonly pattern: "single" | "chain",
  ) {
    this.support = new PatternNodeSupport(deps, pattern);
    this.router = this.support.router;
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  /** Where the node stands and what it needs, from rows alone; never writes. */
  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const node = this.node(nodeId);
    const current = this.support.isCurrentMember(node);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const latest = this.latestInvocation(node);
    if (!current) {
      const settle = latest !== null && INVOCATION_MACHINE.isTerminal(latest.status) && !(node.status === "waiting" && latest.status === "blocked");
      return { kind: "not_current", invocationId: latest?.id ?? null, settle };
    }
    if (node.status === "pending") throw new ConflictError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, latest);
    if (node.status === "ready" || latest === null) return { kind: "start" };
    if (!INVOCATION_MACHINE.isTerminal(latest.status)) return activeInvocationAdvice(this.deps.executor, latest, now);
    if (latest.status === "succeeded" && latest.result?.status === "completed" && this.isComplete(node, latest)) {
      return node.gateAcceptanceCriterionIds.length > 0 ? this.support.gates.advice(node, this.gateSource(node), now) : { kind: "settle", invocationId: latest.id };
    }
    return { kind: "settle", invocationId: latest.id };
  }

  /** The Gate candidate of a `single` or `chain` node: the final position's completed, integrated result Artifacts; remediated by the root Orchestrator. */
  gateSource(node: PatternPlanNode): GateCandidateSource {
    return {
      owner: "root",
      candidate: () => {
        const latest = this.latestInvocation(node);
        if (latest === null || latest.status !== "succeeded" || latest.result?.status !== "completed" || !this.isComplete(node, latest)) return null;
        return [...latest.result.artifactIds];
      },
    };
  }

  openGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.gates.open(nodeId, expectedRevisionNumber, this.gateSource(this.node(nodeId)), options);
  }

  verifyGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    return this.support.gates.verify(nodeId, expectedRevisionNumber, this.gateSource(this.node(nodeId)), options);
  }

  prepareGateEvaluator(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.gates.prepareEvaluator(nodeId, expectedRevisionNumber, this.gateSource(this.node(nodeId)), options);
  }

  settleGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.gates.settle(nodeId, expectedRevisionNumber, this.gateSource(this.node(nodeId)), options);
  }

  /** A waiting node's condition, and whether it has cleared; `latest` is null only for a budget wait before the first Invocation. */
  private inspectWaiting(node: PatternPlanNode, latest: Invocation | null): NodeAdvice {
    const reason = node.waitReason!;
    if (latest === null && reason !== "budget") throw new Error(`PlanNode ${node.id} waits on ${reason} without an Invocation`);
    return this.support.inspectWaiting(node, {
      blocked: latest !== null && blockedOn(this.deps.stores, latest) !== null ? [latest] : [],
      selectorDecision: null,
      nextPosition: latest === null ? this.positions(node)[0]! : this.nextPosition(node, latest),
      capacity: latest,
      conflicted: latest === null ? [] : [latest],
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: revalidate the revision, membership, and
   * `ready` status; move the node to `running`; ensure and deliver the
   * current-revision edge Handoffs addressed to it; ready its owned
   * Tasks; and prepare the first position's Invocation, funded from the
   * node under its allocation policy.
   */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      const graph = stores.plans.currentGraph(node.runId);
      if (node.status === "running" && this.latestInvocation(node) !== null) return { kind: "no_change" };
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: graph.revisionNumber };
      if (node.status === "ready") stores.plans.transitionNode(node.id, { to: "running" }, options);
      this.router.ensureEdgeHandoffsInto(this.support.readinessInput(node.runId), node.id, options);
      const handoffIds = this.router.pendingHandoffsFor(node.runId, node.id).map((h) => h.id);
      const position = this.positions(node)[0]!;
      const prepared = this.support.prepare(this.node(node.id), position, { continuedFromInvocationId: null, handoffIds, inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position };
    });
  }

  /** `single` and `chain` advise no further position; the request is a no-op. */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, _position: PatternPosition, _options: WriteOptions = {}): PatternRunnerOutcome {
    const stale = this.support.staleness(nodeId, expectedRevisionNumber);
    return stale ?? { kind: "no_change" };
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies the consequences of the node's latest terminal Invocation:
   * integration of its Changeset (outside any transaction), then in one
   * transaction the next step with its Handoff, the node's completion with
   * its outputs and edge Handoffs, its failure or cancellation, or its
   * wait on a Decision or an integration conflict. Repeating it applies
   * nothing twice.
   */
  async settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx, stores } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.node(nodeId);
    const latest = this.latestInvocation(node);
    if (latest === null || !INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (latest.status === "succeeded" && latest.result !== null && latest.result.status === "completed") {
      const step = await this.support.integrate(latest, options);
      if (step.kind === "conflict") return this.support.markWaiting(nodeId, expectedRevisionNumber, "integration_conflict", options);
      if (step.kind === "conflict_unresolved") return this.support.fail(nodeId, expectedRevisionNumber, "integration_conflict", options);
      return ctx.tx.write((): PatternRunnerOutcome => this.complete(nodeId, expectedRevisionNumber, latest.id, options));
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const current = this.node(nodeId);
      const invocation = stores.invocations.get(latest.id);
      if (PLAN_NODE_MACHINE.isTerminal(current.status)) return { kind: "no_change" };
      // A waiting node's consequences are already applied; `resume` acts once its condition clears.
      if (current.status === "waiting") return { kind: "no_change" };
      switch (invocation.status) {
        case "blocked":
          return this.support.wait(current, "decision", options);
        case "cancelled":
          return this.support.cancelNow(current, options);
        case "failed":
          return this.support.failNow(current, "invocation_failed", options);
        case "succeeded": {
          const result = invocation.result!;
          if (result.status === "failed") return this.support.failNow(current, "result_failed", options);
          if (result.status === "blocked") return blockingDecisionOf(stores, invocation) !== null ? this.support.wait(current, "decision", options) : this.support.failNow(current, "result_blocked", options);
          throw new Error("unreachable: a completed result is settled above");
        }
        default:
          throw new Error(`unreachable: Invocation ${invocation.id} is ${invocation.status}`);
      }
    });
  }

  /**
   * Finishes the own work of a node that left the current membership
   * (execution-model §4.5): its latest terminal Invocation's Changeset is
   * integrated and the node reaches its own terminal state — succeeded with
   * its outputs only when that Invocation was its final position, failed, or
   * cancelled — but no next step is prepared and no Handoff to any successor
   * is created: only the current revision's graph schedules future work. A
   * removed node whose chain is unfinished stays as it is until cancelled.
   */
  async settleRemoved(nodeId: PlanNodeId, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx, stores } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (this.support.isCurrentMember(node)) throw new ConflictError(`PlanNode ${nodeId} is a current member; settle it through the current revision`);
    const latest = this.latestInvocation(node);
    if (latest === null || !INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
    if (latest.status === "succeeded" && latest.result?.status === "completed") {
      const step = await this.support.integrate(latest, options);
      if (step.kind !== "integrated") return { kind: "no_change" };
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      const current = this.node(nodeId);
      const invocation = stores.invocations.get(latest.id);
      if (PLAN_NODE_MACHINE.isTerminal(current.status)) return { kind: "no_change" };
      switch (invocation.status) {
        case "blocked":
          return current.status === "waiting" ? { kind: "no_change" } : this.support.wait(current, "decision", options);
        case "cancelled":
          return this.support.cancelNow(current, options);
        case "failed":
          return this.support.failNow(current, "invocation_failed", options);
        case "succeeded": {
          const result = invocation.result!;
          if (result.status === "failed") return this.support.failNow(current, "result_failed", options);
          if (result.status === "blocked") return current.status === "waiting" ? { kind: "no_change" } : this.support.wait(current, "decision", options);
          if (this.nextPosition(current, invocation) !== null || current.gateAcceptanceCriterionIds.length > 0) return { kind: "no_change" };
          return this.support.succeedNow(current, result.artifactIds, options, false);
        }
        default:
          throw new Error(`unreachable: Invocation ${invocation.id} is ${invocation.status}`);
      }
    });
  }

  /** Inside the settle transaction, for a completed final or intermediate step whose Changeset is integrated. */
  private complete(nodeId: PlanNodeId, expectedRevisionNumber: number, invocationId: InvocationId, options: WriteOptions): PatternRunnerOutcome {
    const { stores } = this.deps;
    const stale = this.support.staleness(nodeId, expectedRevisionNumber);
    if (stale) return stale;
    let node = this.node(nodeId);
    const invocation = stores.invocations.get(invocationId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (this.latestInvocation(node)?.id !== invocation.id) return { kind: "no_change" };
    if (outstandingChangesetOf(stores, invocation) !== null) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
    if (node.status === "waiting") node = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
    const result = invocation.result!;
    const next = this.nextPosition(node, invocation);
    if (next === null) {
      // With Gate criteria the candidate is complete and integrated here; the Gate engine opens, checks, and settles from now on.
      if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "no_change" };
      return this.support.succeedNow(node, result.artifactIds, options);
    }
    const handoff = this.router.ensureChainStepHandoff(node, invocation, options).handoff;
    if (stores.invocations.latestAtPosition(node.id, patternPositionKey(next)) !== null) return { kind: "no_change" };
    const prepared = this.support.prepare(node, next, { continuedFromInvocationId: null, handoffIds: [handoff.id], inputs: [] }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "step_prepared", invocationId: prepared.invocationId, position: next, handoffId: handoff.id };
  }

  // ---------------------------------------------------------------------------
  // Waiting and resuming
  // ---------------------------------------------------------------------------

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: PlanNodeWaitReason, options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }

  /**
   * Clears a wait whose condition has cleared: the node returns to
   * `running` with the exact reason; a resolved Decision additionally
   * prepares the successor Invocation at the same position, continuing
   * from the blocked one with the typed resolution input, re-owning its
   * Tasks, on a fresh reservation and worktree, never widening Tool Policy.
   */
  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      if (node.status !== "waiting") return { kind: "no_change" };
      const reason = node.waitReason!;
      const advice = this.inspectWaiting(node, this.latestInvocation(node));
      if (advice.kind !== "waiting" || !advice.cleared) return { kind: "no_change" };
      const running = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      if (reason !== "decision") return { kind: "resumed", reason };
      const gated = this.support.resumeGateEvaluator(running, options);
      if (gated !== null) return gated;
      const predecessor = this.latestInvocation(running)!;
      return this.support.prepareSuccessor(running, predecessor, blockingDecisionOf(stores, predecessor)!, [], options);
    });
  }

  // ---------------------------------------------------------------------------
  // Positions and canonical facts
  // ---------------------------------------------------------------------------

  /** The node's positions in Pattern order. */
  positions(node: PatternPlanNode): PatternPosition[] {
    if (node.shape.pattern === "single") return [{ kind: "single" }];
    if (node.shape.pattern === "chain") return node.shape.steps.map((_, index) => ({ kind: "chain_step" as const, index, count: (node.shape as { steps: unknown[] }).steps.length }));
    throw new Error(`PlanNode ${node.id} is a ${node.shape.pattern} node; this engine runs single and chain`);
  }

  /** The position after `invocation`'s, or `null` for the last. */
  private nextPosition(node: PatternPlanNode, invocation: Invocation): PatternPosition | null {
    const positions = this.positions(node);
    const index = positions.findIndex((p) => patternPositionKey(p) === patternPositionKey(invocation.patternPosition!));
    if (index < 0) throw new Error(`Invocation ${invocation.id} occupies no position of PlanNode ${node.id}`);
    return positions[index + 1] ?? null;
  }

  /** True when a completed Invocation's consequences are fully applied: last step with the node still open means not complete. */
  private isComplete(node: PatternPlanNode, invocation: Invocation): boolean {
    if (outstandingChangesetOf(this.deps.stores, invocation) !== null) return false;
    return this.nextPosition(node, invocation) === null;
  }

  /**
   * The Invocation the node is currently at: the latest one at the highest
   * position that has any, from persisted positions — never from creation
   * order across positions.
   */
  latestInvocation(node: PatternPlanNode): Invocation | null {
    const positions = this.positions(node);
    for (let i = positions.length - 1; i >= 0; i -= 1) {
      const latest = this.support.latestAt(node, positions[i]!);
      if (latest !== null) return latest;
    }
    return null;
  }

  node(nodeId: PlanNodeId): PatternPlanNode {
    return this.support.node(nodeId);
  }

  graphOf(runId: RunId): PlanGraph {
    return this.support.graphOf(runId);
  }

  memberOf(graph: PlanGraph, nodeId: PlanNodeId): PlanNode | null {
    return this.support.memberOf(graph, nodeId);
  }
}
