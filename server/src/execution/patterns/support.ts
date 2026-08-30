/**
 * The canonical step engine shared by the `single` and `chain` Pattern
 * runners (execution-model §5.1, §5.2, §7.2–§7.6, §9.1, §9.2). A Pattern
 * runner never talks to a provider: it owns its node's lifecycle in short
 * root transactions — revalidating the current revision, membership, node
 * status, and active Invocation inside each — and returns closed, typed
 * outcomes. Integration of a Changeset is the one external step, awaited
 * outside every transaction through the integration service.
 *
 * Everything here is derived from canonical rows: Pattern positions,
 * Invocations and their results, Changesets, Handoffs by key, Decisions,
 * reservations. Nothing reads a transcript, an Event, or process memory,
 * and every operation is safe to repeat: a step already prepared, a
 * Changeset already integrated, a Handoff already created, or a node
 * already transitioned is found, never duplicated.
 */
import {
  allocationFits,
  ConflictError,
  INVOCATION_MACHINE,
  isIdOfKind,
  PLAN_NODE_MACHINE,
  operationAt,
  patternPositionKey,
  ROOT_SOURCE_PATH,
  TASK_MACHINE,
  type Changeset,
  type CompiledOperation,
  type Decision,
  type DecisionId,
  type HandoffId,
  type Invocation,
  type InvocationId,
  type ManifestInput,
  type PatternPlanNode,
  type PatternPosition,
  type PlanGraph,
  type PlanNode,
  type PlanNodeFailureReason,
  type PlanNodeId,
  type PlanNodeWaitReason,
  type RunId,
  type Task,
  type TaskId,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../../persistence/context.ts";
import type { Stores } from "../../persistence/stores/index.ts";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import type { AttemptExecutor } from "../attempt-executor.ts";
import type { ResourceGovernor } from "../governor.ts";
import { HandoffRouter } from "../handoff-routing.ts";
import type { ChangesetIntegrationService } from "../integration-service.ts";
import type { InvocationPreparationService } from "../invocation-preparation-service.ts";

/** What a node needs next, from canonical rows alone (read-only). */
export type NodeAdvice =
  /** `ready` (or `running` with no Invocation yet): prepare the first position. */
  | { kind: "start" }
  /** The active Invocation may create its next Attempt now. */
  | { kind: "execute"; invocationId: InvocationId }
  /** An Attempt of the active Invocation is executing in this process. */
  | { kind: "attempt_in_flight"; invocationId: InvocationId }
  /** The active Invocation's retry is permitted only from `notBefore`. */
  | { kind: "retry_not_before"; invocationId: InvocationId; notBefore: Timestamp }
  /** The latest Invocation is terminal and its consequences are not yet applied to the node. */
  | { kind: "settle"; invocationId: InvocationId }
  /** The node waits; `cleared` says whether the condition has cleared and `resume` applies; `wakeAt` when a time is known. */
  | { kind: "waiting"; reason: PlanNodeWaitReason; cleared: boolean; wakeAt: Timestamp | null }
  | { kind: "terminal"; status: "succeeded" | "failed" | "cancelled" | "skipped" }
  /** Work complete; the node has Gate criteria and Gates arrive in a later phase. */
  | { kind: "awaiting_gate_phase" }
  /** The node's `extend` allocation policy would apply and extension arrives in a later phase. */
  | { kind: "awaiting_allocation_extension_phase" }
  /** The node is not a member of the current revision: its own started work may finish, nothing new starts. */
  | { kind: "not_current"; invocationId: InvocationId | null };

/** The closed outcome of one canonical runner action. */
export type PatternRunnerOutcome =
  | { kind: "started"; invocationId: InvocationId; position: PatternPosition }
  | { kind: "step_prepared"; invocationId: InvocationId; position: PatternPosition; handoffId: HandoffId }
  | { kind: "successor_prepared"; invocationId: InvocationId; position: PatternPosition; decisionId: DecisionId }
  | { kind: "succeeded"; outputArtifactIds: string[]; handoffIds: HandoffId[] }
  | { kind: "failed"; reason: PlanNodeFailureReason }
  | { kind: "cancelled" }
  | { kind: "waiting"; reason: PlanNodeWaitReason; wakeAt: Timestamp | null }
  | { kind: "resumed"; reason: PlanNodeWaitReason }
  | { kind: "awaiting_gate_phase" }
  | { kind: "awaiting_allocation_extension_phase" }
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
  governor: ResourceGovernor;
  provider: { readonly provider: string };
}

/** The Decision a `blocked` result names, when its blocker is a Decision id of the Run; otherwise `null`. */
export function blockingDecisionOf(stores: Stores, invocation: Invocation): Decision | null {
  if (invocation.status === "blocked" && invocation.blockedByDecisionId !== null) return stores.decisions.get(invocation.blockedByDecisionId);
  const result = invocation.result;
  if (invocation.status !== "succeeded" || result === null || result.status !== "blocked" || !isIdOfKind("decision", result.blocker)) return null;
  try {
    const decision = stores.decisions.get(result.blocker);
    return decision.runId === invocation.runId ? decision : null;
  } catch {
    return null;
  }
}

/** The Changeset of an Invocation that is not yet integrated, if any. */
export function outstandingChangesetOf(stores: Stores, invocation: Invocation): Changeset | null {
  return stores.changesets.listByRun(invocation.runId).find((c) => c.invocationId === invocation.id && c.integrationStatus !== "integrated") ?? null;
}

/**
 * The generic sequential engine: a node executes a fixed sequence of
 * positions one Invocation at a time. `single` has one position; `chain`
 * has one per step. The runners own validation and expose this engine.
 */
export class SequentialStepEngine {
  readonly router: HandoffRouter;

  constructor(
    private readonly deps: PatternRunnerDependencies,
    private readonly pattern: "single" | "chain",
  ) {
    this.router = new HandoffRouter(deps.stores);
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  /** Where the node stands and what it needs, from rows alone; never writes. */
  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const { stores } = this.deps;
    const node = this.node(nodeId);
    const graph = stores.plans.currentGraph(node.runId);
    const current = graph.nodes.some((n) => n.id === node.id);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const latest = this.latestInvocation(node);
    if (!current) return { kind: "not_current", invocationId: latest?.id ?? null };
    if (node.status === "pending") throw new ConflictError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, latest, now);
    if (node.status === "ready" || latest === null) return { kind: "start" };
    if (!INVOCATION_MACHINE.isTerminal(latest.status)) {
      const inspection = this.deps.executor.inspectInvocation(latest.id, now);
      if (inspection.next.permitted) return { kind: "execute", invocationId: latest.id };
      switch (inspection.next.reason) {
        case "attempt_active":
          return { kind: "attempt_in_flight", invocationId: latest.id };
        case "retry_not_yet":
          return { kind: "retry_not_before", invocationId: latest.id, notBefore: inspection.next.notBefore! };
        default:
          // allocation exhaustion or a refused retry: the executor settles the Invocation on the next execute call.
          return { kind: "execute", invocationId: latest.id };
      }
    }
    if (latest.status === "succeeded" && latest.result?.status === "completed" && this.isComplete(node, latest)) {
      return node.gateAcceptanceCriterionIds.length > 0 ? { kind: "awaiting_gate_phase" } : { kind: "settle", invocationId: latest.id };
    }
    return { kind: "settle", invocationId: latest.id };
  }

  /** A waiting node's condition, and whether it has cleared; `latest` is null only for a budget wait before the first Invocation. */
  private inspectWaiting(node: PatternPlanNode, latest: Invocation | null, now: Timestamp): NodeAdvice {
    const { stores, governor } = this.deps;
    const reason = node.waitReason!;
    if (latest === null && reason !== "budget") throw new Error(`PlanNode ${node.id} waits on ${reason} without an Invocation`);
    switch (reason) {
      case "decision": {
        const decision = blockingDecisionOf(stores, latest!);
        return { kind: "waiting", reason, cleared: decision !== null && decision.status !== "open", wakeAt: null };
      }
      case "provider_capacity": {
        const manifest = stores.invocations.getManifest(latest!.id);
        const refusal = governor.check({ runId: node.runId, provider: this.deps.provider.provider, worktrees: latest!.workspaceCleanup === "pending" && manifest.content.worktreePath !== null ? 1 : 0 });
        return { kind: "waiting", reason, cleared: refusal === null, wakeAt: refusal?.retryAfter ?? null };
      }
      case "budget": {
        const next = latest === null ? this.positions(node)[0]! : this.nextPosition(node, latest);
        const fits = next === null || this.allocationFor(node, next).fits;
        return { kind: "waiting", reason, cleared: fits, wakeAt: null };
      }
      case "integration_conflict": {
        const changeset = outstandingChangesetOf(stores, latest!);
        if (changeset === null || changeset.integrationStatus !== "conflict" || changeset.conflictTaskId === null) return { kind: "waiting", reason, cleared: true, wakeAt: null };
        return { kind: "waiting", reason, cleared: TASK_MACHINE.isTerminal(stores.tasks.get(changeset.conflictTaskId).status), wakeAt: null };
      }
      case "operator":
        return { kind: "waiting", reason, cleared: false, wakeAt: null };
    }
    void now;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: revalidate the revision, membership, and
   * `ready` status; move the node to `running`; ensure and deliver the
   * current-revision sequence Handoffs addressed to it; ready its owned
   * Tasks; and prepare the first position's Invocation, funded from the
   * node under its allocation policy.
   */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      const graph = stores.plans.currentGraph(node.runId);
      if (node.status === "running" && this.latestInvocation(node) !== null) return { kind: "no_change" };
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: graph.revisionNumber };
      if (node.status === "ready") stores.plans.transitionNode(node.id, { to: "running" }, options);
      this.router.ensureSequenceHandoffsInto(graph, node.id, options);
      const handoffIds = this.router.pendingHandoffsFor(node.runId, node.id).map((h) => h.id);
      const position = this.positions(node)[0]!;
      const prepared = this.prepare(this.node(node.id), position, { continuedFromInvocationId: null, handoffIds, inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position };
    });
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies the consequences of the node's latest terminal Invocation:
   * integration of its Changeset (outside any transaction), then in one
   * transaction the next step with its Handoff, the node's completion with
   * its outputs and sequence Handoffs, its failure or cancellation, or its
   * wait on a Decision or an integration conflict. Repeating it applies
   * nothing twice.
   */
  async settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx, stores, integration } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.node(nodeId);
    const latest = this.latestInvocation(node);
    if (latest === null || !INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (latest.status === "succeeded" && latest.result !== null && latest.result.status === "completed") {
      const changeset = outstandingChangesetOf(stores, latest);
      if (changeset !== null) {
        const outcome = await integration.integrate(changeset.id, options);
        if (outcome.kind === "conflict" || outcome.kind === "conflict_pending") return this.markWaiting(nodeId, expectedRevisionNumber, "integration_conflict", options);
        if (outcome.kind === "conflict_unresolved") return this.fail(nodeId, expectedRevisionNumber, "integration_conflict", latest, options);
      }
      return ctx.tx.write((): PatternRunnerOutcome => this.complete(nodeId, expectedRevisionNumber, latest.id, options));
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const current = this.node(nodeId);
      const invocation = stores.invocations.get(latest.id);
      if (PLAN_NODE_MACHINE.isTerminal(current.status)) return { kind: "no_change" };
      // A waiting node's consequences are already applied; `resume` acts once its condition clears.
      if (current.status === "waiting") return { kind: "no_change" };
      switch (invocation.status) {
        case "blocked":
          return this.wait(current, "decision", options);
        case "cancelled":
          stores.plans.transitionNode(current.id, { to: "cancelled", reason: "invocation_cancelled" }, options);
          return { kind: "cancelled" };
        case "failed":
          return this.failNow(current, "invocation_failed", invocation, options);
        case "succeeded": {
          const result = invocation.result!;
          if (result.status === "failed") return this.failNow(current, "result_failed", invocation, options);
          if (result.status === "blocked") return blockingDecisionOf(stores, invocation) !== null ? this.wait(current, "decision", options) : this.failNow(current, "result_blocked", invocation, options);
          throw new Error("unreachable: a completed result is settled above");
        }
        default:
          throw new Error(`unreachable: Invocation ${invocation.id} is ${invocation.status}`);
      }
    });
  }

  /** Inside the settle transaction, for a completed final or intermediate step whose Changeset is integrated. */
  private complete(nodeId: PlanNodeId, expectedRevisionNumber: number, invocationId: InvocationId, options: WriteOptions): PatternRunnerOutcome {
    const { stores } = this.deps;
    const stale = this.staleness(nodeId, expectedRevisionNumber);
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
      if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
      const outputArtifactIds = [...result.artifactIds].sort();
      stores.plans.transitionNode(node.id, { to: "succeeded", outputArtifactIds }, options);
      const handoffs = this.router.ensureSequenceHandoffsFrom(stores.plans.currentGraph(node.runId), node.id, options);
      return { kind: "succeeded", outputArtifactIds, handoffIds: handoffs.map((h) => h.handoff.id) };
    }
    const handoff = this.router.ensureChainStepHandoff(node, invocation, options).handoff;
    if (stores.invocations.latestAtPosition(node.id, patternPositionKey(next)) !== null) return { kind: "no_change" };
    const prepared = this.prepare(node, next, { continuedFromInvocationId: null, handoffIds: [handoff.id], inputs: [] }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "step_prepared", invocationId: prepared.invocationId, position: next, handoffId: handoff.id };
  }

  // ---------------------------------------------------------------------------
  // Waiting and resuming
  // ---------------------------------------------------------------------------

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
   * Clears a wait whose condition has cleared: the node returns to
   * `running` with the exact reason; a resolved Decision additionally
   * prepares the successor Invocation at the same position, continuing
   * from the blocked one with the typed resolution input, re-owning its
   * Tasks, on a fresh reservation and worktree, never widening Tool Policy.
   */
  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      if (node.status !== "waiting") return { kind: "no_change" };
      const reason = node.waitReason!;
      const advice = this.inspectWaiting(node, this.latestInvocation(node), ctx.clock());
      if (advice.kind !== "waiting" || !advice.cleared) return { kind: "no_change" };
      const running = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      if (reason !== "decision") return { kind: "resumed", reason };
      const predecessor = this.latestInvocation(running)!;
      const decision = blockingDecisionOf(stores, predecessor)!;
      const position = predecessor.patternPosition!;
      if (decision.status !== "resolved" || decision.resolution === null) {
        // Superseded without a resolution: the successor cannot carry an answer; the node fails as blocked.
        return this.failNow(running, "result_blocked", predecessor, options);
      }
      const inputs: ManifestInput[] =
        predecessor.status === "blocked" && decision.kind === "side_effect_approval" && decision.subject !== null
          ? [{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: predecessor.id, attemptId: decision.subject.attemptId, tool: decision.subject.tool, callDigest: decision.subject.callDigest, callArtifactId: decision.subject.callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" }]
          : [{ kind: "decision_resolution", decisionId: decision.id }];
      const handoffIds = stores.invocations.getManifest(predecessor.id).content.handoffs.map((h) => h.handoffId);
      const prepared = this.prepare(running, position, { continuedFromInvocationId: predecessor.id, handoffIds, inputs }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "successor_prepared", invocationId: prepared.invocationId, position, decisionId: decision.id };
    });
  }

  private wait(node: PatternPlanNode, reason: PlanNodeWaitReason, options: WriteOptions): PatternRunnerOutcome {
    this.deps.stores.plans.transitionNode(node.id, { to: "waiting", waitReason: reason }, options);
    return { kind: "waiting", reason, wakeAt: null };
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  private fail(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: PlanNodeFailureReason, invocation: Invocation | null, options: WriteOptions): PatternRunnerOutcome {
    return this.deps.ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.node(nodeId);
      if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
      return this.failNow(node, reason, invocation, options);
    });
  }

  /** Fails the node now (from `running` or `waiting`), failing every owned Task still running on its terminal Invocations. */
  private failNow(node: PatternPlanNode, reason: PlanNodeFailureReason, invocation: Invocation | null, options: WriteOptions): PatternRunnerOutcome {
    const { stores } = this.deps;
    const current = node.status === "waiting" ? (stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode) : node;
    for (const owned of stores.invocations.listByPlanNode(current.id)) {
      if (!INVOCATION_MACHINE.isTerminal(owned.status)) continue;
      for (const taskId of owned.taskIds) {
        const task = stores.tasks.get(taskId);
        if (task.status === "running" && task.invocationId === owned.id) stores.tasks.transition(task.id, { to: "failed", failureReason: "permanent_failure" }, options);
      }
    }
    void invocation;
    stores.plans.transitionNode(current.id, { to: "failed", reason }, options);
    return { kind: "failed", reason };
  }

  // ---------------------------------------------------------------------------
  // Preparation of one position
  // ---------------------------------------------------------------------------

  /** Prepares the Invocation at `position` under the node's allocation policy; inside the caller's transaction. */
  private prepare(node: PatternPlanNode, position: PatternPosition, request: { continuedFromInvocationId: InvocationId | null; handoffIds: string[]; inputs: ManifestInput[] }, options: WriteOptions): { kind: "prepared"; invocationId: InvocationId } | { kind: "refused"; outcome: PatternRunnerOutcome } {
    const { stores, preparation } = this.deps;
    const operation = operationAt(node.shape, position);
    if (operation === null) throw new Error(`PlanNode ${node.id} has no ${patternPositionKey(position)} position`);
    const funding = this.allocationFor(node, position);
    if (!funding.fits) {
      switch (node.onAllocationExhausted) {
        case "fail":
          return { kind: "refused", outcome: this.failNow(node, "allocation_exhausted", null, options) };
        case "wait":
          return { kind: "refused", outcome: this.wait(node, "budget", options) };
        case "extend":
          return { kind: "refused", outcome: { kind: "awaiting_allocation_extension_phase" } };
      }
    }
    const tasks = this.readyOwnedTasks(node, operation, options);
    if (tasks.kind === "unavailable") return { kind: "refused", outcome: this.failNow(node, "task_unavailable", null, options) };
    const prepared = preparation.prepare({
      runId: node.runId,
      planNodeId: node.id,
      role: "worker",
      purpose: "step",
      patternPosition: position,
      continuedFromInvocationId: request.continuedFromInvocationId,
      handoffIds: request.handoffIds as never,
      inputs: request.inputs,
      correlationId: options.correlationId ?? null,
      causationSeq: options.causationSeq ?? null,
    });
    return { kind: "prepared", invocationId: prepared.invocation.id };
  }

  /** Whether the node's unconsumed, unreserved allocation covers the operation's default Invocation allocation. */
  private allocationFor(node: PatternPlanNode, position: PatternPosition): { fits: boolean } {
    const operation = operationAt(node.shape, position);
    if (operation === null) return { fits: false };
    const allocation = this.deps.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
    return { fits: allocationFits(allocation, this.deps.stores.reservations.capacity({ type: "plan_node", id: node.id }).available) };
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
    const { stores } = this.deps;
    const positions = this.positions(node);
    for (let i = positions.length - 1; i >= 0; i -= 1) {
      const latest = stores.invocations.latestAtPosition(node.id, patternPositionKey(positions[i]!));
      if (latest !== null) return latest;
    }
    return null;
  }

  node(nodeId: PlanNodeId): PatternPlanNode {
    const node = this.deps.stores.plans.getNode(nodeId);
    if (node.kind !== "pattern") throw new ConflictError(`PlanNode ${nodeId} is a join node; it has no Pattern runner`);
    if (node.sourcePath === ROOT_SOURCE_PATH) throw new ConflictError(`PlanNode ${nodeId} is the root Orchestrator node; no Pattern runner completes it`);
    if (node.pattern !== this.pattern) throw new ConflictError(`PlanNode ${nodeId} is a ${node.pattern} node, not ${this.pattern}`);
    return node;
  }

  /** `null` when the current revision is the expected one and the node is a member; a `stale` outcome otherwise. */
  private staleness(nodeId: PlanNodeId, expectedRevisionNumber: number): PatternRunnerOutcome | null {
    const node = this.deps.stores.plans.getNode(nodeId);
    const current = this.deps.stores.plans.latestRevisionNumber(node.runId);
    if (current !== expectedRevisionNumber) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
    const member = this.deps.stores.plans.listMembership(node.runId, current).some((m) => m.planNodeId === nodeId);
    if (!member) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
    return null;
  }

  graphOf(runId: RunId): PlanGraph {
    return this.deps.stores.plans.currentGraph(runId);
  }

  memberOf(graph: PlanGraph, nodeId: PlanNodeId): PlanNode | null {
    return graph.nodes.find((n) => n.id === nodeId) ?? null;
  }
}
