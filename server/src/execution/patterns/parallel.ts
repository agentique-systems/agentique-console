/**
 * The `parallel` Pattern runner (execution-model §5.4, §7.7, §9.2): a
 * static, non-empty list of independent leaf items, one Worker Invocation
 * each at position `parallel_item { index, count }`, run concurrently within
 * the Run's and the node's `maxConcurrency`, the governor's leases, and the
 * node's remaining allocation; then one canonical index Artifact; then,
 * when the shape has one, one aggregation Invocation over that index.
 *
 * Items are independent: each receives only its own operation's input plus
 * the node's incoming edge Handoffs, never another item's result. Items are
 * prepared one position per scheduler iteration (`start_position`), so no
 * single transaction creates every item and the database's one-active-
 * Invocation-per-position rule bounds duplicates.
 *
 * Integration is deterministic: Attempts finish in any order, but writing
 * Changesets are integrated in item-index order, never completion order. An
 * item's Changeset is integrated only once every lower-index item is
 * determined — terminal and integrated, or terminal without a Changeset —
 * so a later item that finished first stays pending. A conflict follows the
 * ordinary conflict lifecycle (the node waits with `integration_conflict`;
 * a second conflict, or a failed or cancelled conflict Task, fails the
 * node) and never lets another item's Changeset pass it.
 *
 * Once every item is terminal and every successful writing Changeset is
 * integrated, exactly one index Artifact (`PARALLEL_INDEX_MEDIA_TYPE`) is
 * created in the same transaction that consumes it — the node's success
 * (no aggregation), the `parallel_index` Handoff plus the aggregation
 * Invocation, or the node's failure — so a repeated pass or restart never
 * creates a second one. `requireAll: true` needs every item to succeed;
 * `requireAll: false` needs at least one; failed items stay in the index
 * as failed. An approval-blocked item continues through a successor at the
 * same position once its Decision resolves; while a blocked item's
 * Decision is open and nothing else can proceed, the node waits.
 *
 * With an aggregation, the index is delivered through one canonical
 * Handoff, the aggregation's Changeset is integrated before settlement, its
 * result Artifacts are the node's output, and its failure fails the node.
 * Without one, the index Artifact is the node's output.
 */
import {
  canonicalParallelIndex,
  indexArtifactTitle,
  INVOCATION_MACHINE,
  InvariantViolationError,
  PARALLEL_INDEX_MEDIA_TYPE,
  PLAN_NODE_MACHINE,
  TASK_MACHINE,
  type Artifact,
  type Invocation,
  type ParallelIndex,
  type ParallelIndexEntry,
  type PatternPlanNode,
  type PatternPosition,
  type PlanNodeId,
  type Timestamp,
} from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf, PatternNodeSupport, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

const AGGREGATION: PatternPosition = { kind: "parallel_aggregation" };

/** The canonical state of one item position, from rows. */
type ItemState =
  | { kind: "unstarted" }
  | { kind: "active"; invocation: Invocation }
  /** Blocked on a Decision (by status or by a `blocked` result naming one). */
  | { kind: "blocked"; invocation: Invocation; decisionStatus: "open" | "resolved" | "superseded" }
  /** Completed with a Changeset not yet integrated (pending or in conflict). */
  | { kind: "pending_integration"; invocation: Invocation; conflict: boolean }
  /** Terminal and determined: succeeded (integrated) or failed or cancelled. */
  | { kind: "done"; invocation: Invocation; entry: ParallelIndexEntry };

interface ParallelState {
  items: ItemState[];
  count: number;
  aggregation: Invocation | null;
}

export class ParallelPatternRunner {
  readonly pattern = "parallel" as const;
  private readonly support: PatternNodeSupport;

  constructor(private readonly deps: PatternRunnerDependencies) {
    this.support = new PatternNodeSupport(deps, "parallel");
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const state = this.state(node);
    if (!this.support.isCurrentMember(node)) {
      const advice = node.status === "running" ? this.runningAdvice(node, state, now) : null;
      const settle = advice !== null && advice.kind === "settle";
      return { kind: "not_current", invocationId: advice !== null && "invocationId" in advice ? advice.invocationId : null, settle };
    }
    if (node.status === "pending") throw new InvariantViolationError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, state);
    if (node.status === "ready") return { kind: "start" };
    return this.runningAdvice(node, state, now);
  }

  /** The next canonical action of a running node, in a fixed priority: execute, start a position, settle, report an in-flight or timed wait. */
  private runningAdvice(node: PatternPlanNode, state: ParallelState, now: Timestamp): NodeAdvice {
    const { stores } = this.deps;
    const active = state.items.flatMap((s) => (s.kind === "active" ? [s.invocation] : []));
    const advices = active.map((i) => activeInvocationAdvice(this.deps.executor, i, now));
    const executable = advices.find((a) => a.kind === "execute");
    if (executable) return executable;
    for (const [index, item] of state.items.entries()) {
      if (item.kind === "unstarted" || (item.kind === "blocked" && item.decisionStatus === "resolved")) return { kind: "start_position", position: { kind: "parallel_item", index, count: state.count } };
    }
    if (this.nextIntegrable(state) !== null) return { kind: "settle", invocationId: this.nextIntegrable(state)!.id };
    if (state.items.some((s) => s.kind === "blocked" && s.decisionStatus === "superseded")) return { kind: "settle", invocationId: null };
    if (state.items.every((s) => s.kind === "done")) {
      if (node.shape.pattern !== "parallel" || node.shape.aggregate === null) return { kind: "settle", invocationId: null };
      const aggregation = state.aggregation;
      if (aggregation === null) return { kind: "settle", invocationId: null };
      if (!INVOCATION_MACHINE.isTerminal(aggregation.status)) return activeInvocationAdvice(this.deps.executor, aggregation, now);
      const blocked = blockedOn(stores, aggregation);
      if (blocked !== null && blocked.status === "resolved") return { kind: "start_position", position: AGGREGATION };
      if (aggregation.status === "succeeded" && aggregation.result?.status === "completed" && outstandingChangesetOf(stores, aggregation) === null && node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
      return { kind: "settle", invocationId: aggregation.id };
    }
    const inFlight = advices.find((a) => a.kind === "attempt_in_flight");
    if (inFlight) return inFlight;
    const retries = advices.filter((a): a is Extract<NodeAdvice, { kind: "retry_not_before" }> => a.kind === "retry_not_before").sort((a, b) => (a.notBefore < b.notBefore ? -1 : 1));
    if (retries[0]) return retries[0];
    if (state.items.some((s) => s.kind === "pending_integration" && s.conflict)) return { kind: "settle", invocationId: null };
    if (state.items.some((s) => s.kind === "blocked" && s.decisionStatus === "open")) return { kind: "settle", invocationId: null };
    throw new InvariantViolationError(`parallel PlanNode ${node.id} has no next action from its rows`, { planNodeId: node.id });
  }

  private inspectWaiting(node: PatternPlanNode, state: ParallelState): NodeAdvice {
    const { stores } = this.deps;
    const invocations = [...state.items.flatMap((s) => ("invocation" in s ? [s.invocation] : [])), ...(state.aggregation === null ? [] : [state.aggregation])];
    return this.support.inspectWaiting(node, {
      blocked: invocations.filter((i) => INVOCATION_MACHINE.isTerminal(i.status) && blockedOn(stores, i) !== null),
      selectorDecision: null,
      nextPosition: this.nextPositionToFund(node, state),
      capacity: invocations.find((i) => !INVOCATION_MACHINE.isTerminal(i.status)) ?? null,
      conflicted: invocations.filter((i) => outstandingChangesetOf(stores, i)?.integrationStatus === "conflict"),
    });
  }

  private nextPositionToFund(node: PatternPlanNode, state: ParallelState): PatternPosition | null {
    const index = state.items.findIndex((s) => s.kind === "unstarted" || (s.kind === "blocked" && s.decisionStatus === "resolved"));
    if (index >= 0) return { kind: "parallel_item", index, count: state.count };
    if (node.shape.pattern === "parallel" && node.shape.aggregate !== null && state.items.every((s) => s.kind === "done") && state.aggregation === null) return AGGREGATION;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /** In one root transaction: the node runs, its incoming edge Handoffs are ensured and delivered, and item 0 is prepared. */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      let node = this.support.node(nodeId);
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      const first: PatternPosition = { kind: "parallel_item", index: 0, count: this.count(node) };
      if (node.status === "running" && this.support.latestAt(node, first) !== null) return { kind: "no_change" };
      if (node.status === "ready") node = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      this.support.router.ensureEdgeHandoffsInto(this.support.readinessInput(node.runId), node.id, options);
      const prepared = this.support.prepare(node, first, { continuedFromInvocationId: null, handoffIds: this.support.incomingHandoffIds(node), inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position: first };
    });
  }

  /**
   * Prepares one more position of a running node: an unstarted item (its
   * own operation input plus the node's edge Handoffs, nothing of any other
   * item), the successor of a blocked item whose Decision resolved, or the
   * aggregation once the index Handoff exists. One position per call; the
   * database refuses a second active Invocation at a position.
   */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, position: PatternPosition, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      if (position.kind !== "parallel_item" && position.kind !== "parallel_aggregation") throw new InvariantViolationError(`PlanNode ${node.id} has no ${position.kind} position`);
      if (position.kind === "parallel_item" && (position.count !== this.count(node) || position.index >= position.count)) throw new InvariantViolationError(`PlanNode ${node.id} has no item ${position.index} of ${position.count}`);
      const latest = this.support.latestAt(node, position);
      if (latest !== null) {
        if (!INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
        const decision = blockedOn(stores, latest);
        if (decision === null || decision.status === "open") return { kind: "no_change" };
        return this.support.prepareSuccessor(node, latest, decision, [], options);
      }
      if (position.kind === "parallel_aggregation") {
        const handoff = this.support.router.parallelIndexHandoff(node.runId, node.id);
        if (handoff === null) return { kind: "no_change" };
        const prepared = this.support.prepare(node, position, { continuedFromInvocationId: null, handoffIds: [handoff.id], inputs: [] }, options);
        if (prepared.kind !== "prepared") return prepared.outcome;
        return { kind: "step_prepared", invocationId: prepared.invocationId, position, handoffId: handoff.id };
      }
      const prepared = this.support.prepare(node, position, { continuedFromInvocationId: null, handoffIds: this.support.incomingHandoffIds(node), inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position };
    });
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies the next canonical consequence: the next integrable item's
   * Changeset (outside any transaction, in index order), or the
   * aggregation's; then, in one transaction, the index and the node's
   * completion, failure, aggregation preparation, or wait. Repeating it
   * applies nothing twice.
   */
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    return this.settleWith(nodeId, expectedRevisionNumber, options, true);
  }

  /** Finishes the own work of a node that left the current membership: integrations, index, and completion, but no successor Handoff. */
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
    const state = this.state(node);
    const integrable = this.nextIntegrable(state);
    if (integrable !== null) {
      const step = await this.support.integrate(integrable, options);
      if (step.kind === "integrated") return { kind: "integrated", invocationId: integrable.id };
      if (!current) return { kind: "no_change" };
      if (step.kind === "conflict") return this.support.markWaiting(nodeId, expectedRevisionNumber!, "integration_conflict", options);
      return this.support.fail(nodeId, expectedRevisionNumber!, "integration_conflict", options);
    }
    const aggregation = state.aggregation;
    if (state.items.every((s) => s.kind === "done") && aggregation !== null && aggregation.status === "succeeded" && aggregation.result?.status === "completed") {
      const step = await this.support.integrate(aggregation, options);
      if (step.kind !== "integrated") {
        if (!current) return { kind: "no_change" };
        return step.kind === "conflict" ? this.support.markWaiting(nodeId, expectedRevisionNumber!, "integration_conflict", options) : this.support.fail(nodeId, expectedRevisionNumber!, "integration_conflict", options);
      }
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      if (current) {
        const stale = this.support.staleness(nodeId, expectedRevisionNumber!);
        if (stale) return stale;
      }
      return this.apply(this.support.node(nodeId), options, current);
    });
  }

  /** Inside a transaction: the consequence of the node's canonical rows once nothing is left to integrate. */
  private apply(node: PatternPlanNode, options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const { stores } = this.deps;
    if (node.status !== "running") return { kind: "no_change" };
    const state = this.state(node);
    if (this.nextIntegrable(state) !== null) return { kind: "no_change" };
    if (state.items.some((s) => s.kind === "blocked" && s.decisionStatus === "superseded")) return this.support.failNow(node, "result_blocked", options);
    if (state.items.some((s) => s.kind === "pending_integration" && s.conflict)) return this.support.wait(node, "integration_conflict", options);
    if (!state.items.every((s) => s.kind === "done")) {
      const progress = state.items.some((s) => s.kind === "unstarted" || s.kind === "active" || (s.kind === "blocked" && s.decisionStatus === "resolved"));
      if (progress) return { kind: "no_change" };
      if (state.items.some((s) => s.kind === "blocked" && s.decisionStatus === "open")) return this.support.wait(node, "decision", options);
      return { kind: "no_change" };
    }
    const entries = state.items.map((s) => (s.kind === "done" ? s.entry : null)).filter((e): e is ParallelIndexEntry => e !== null);
    const succeeded = entries.filter((e) => e.outcome === "succeeded").length;
    const policyMet = node.shape.pattern === "parallel" && (node.shape.requireAll ? succeeded === entries.length : succeeded > 0);
    if (node.shape.pattern !== "parallel") throw new Error("unreachable");
    if (node.shape.aggregate === null) {
      const index = this.createIndex(node, entries, options);
      if (!policyMet) return this.support.failNow(node, "parallel_items_failed", options, [index.id]);
      if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
      return this.support.succeedNow(node, [index.id], options, current);
    }
    const existing = this.support.router.parallelIndexHandoff(node.runId, node.id);
    if (existing === null) {
      const index = this.createIndex(node, entries, options);
      if (!policyMet) return this.support.failNow(node, "parallel_items_failed", options, [index.id]);
      const handoff = this.support.router.ensureParallelIndexHandoff(node, index.id, options).handoff;
      const prepared = this.support.prepare(node, AGGREGATION, { continuedFromInvocationId: null, handoffIds: [handoff.id], inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "step_prepared", invocationId: prepared.invocationId, position: AGGREGATION, handoffId: handoff.id };
    }
    const aggregation = state.aggregation;
    if (aggregation === null) {
      const prepared = this.support.prepare(node, AGGREGATION, { continuedFromInvocationId: null, handoffIds: [existing.id], inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "step_prepared", invocationId: prepared.invocationId, position: AGGREGATION, handoffId: existing.id };
    }
    if (!INVOCATION_MACHINE.isTerminal(aggregation.status)) return { kind: "no_change" };
    switch (aggregation.status) {
      case "blocked":
        return this.support.wait(node, "decision", options);
      case "cancelled":
        return this.support.cancelNow(node, options);
      case "failed":
        return this.support.failNow(node, "invocation_failed", options);
      case "succeeded": {
        const result = aggregation.result!;
        if (result.status === "failed") return this.support.failNow(node, "result_failed", options);
        if (result.status === "blocked") return blockingDecisionOf(stores, aggregation) !== null ? this.support.wait(node, "decision", options) : this.support.failNow(node, "result_blocked", options);
        if (outstandingChangesetOf(stores, aggregation) !== null) return { kind: "no_change" };
        if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
        return this.support.succeedNow(node, result.artifactIds, options, current);
      }
      default:
        throw new Error(`unreachable: Invocation ${aggregation.id} is ${aggregation.status}`);
    }
  }

  /** The one canonical index Artifact, created in the transaction that consumes it. */
  private createIndex(node: PatternPlanNode, entries: ParallelIndexEntry[], options: WriteOptions): Artifact {
    const index: ParallelIndex = { version: 1, planNodeId: node.id, items: entries };
    return this.deps.stores.artifacts.create(
      { runId: node.runId, mediaType: PARALLEL_INDEX_MEDIA_TYPE, producer: { kind: "runtime", component: "parallel_index" }, taskId: null, title: indexArtifactTitle("parallel", node.id) },
      new TextEncoder().encode(canonicalParallelIndex(index)),
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
   * Clears a wait whose condition has cleared: the node returns to
   * `running`; for a `decision` wait the first blocked position whose
   * Decision resolved gets its successor now, and any further one on the
   * following iterations through `start_position`.
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
      const candidates = [...state.items.flatMap((s) => ("invocation" in s ? [s.invocation] : [])), ...(state.aggregation === null ? [] : [state.aggregation])];
      const blocked = candidates.find((i) => INVOCATION_MACHINE.isTerminal(i.status) && (blockedOn(stores, i)?.status ?? "open") !== "open");
      if (!blocked) return { kind: "resumed", reason };
      return this.support.prepareSuccessor(running, blocked, blockedOn(stores, blocked)!, [], options);
    });
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  private count(node: PatternPlanNode): number {
    if (node.shape.pattern !== "parallel") throw new Error("unreachable");
    return node.shape.items.length;
  }

  /** The items' positions, in index order. */
  positions(node: PatternPlanNode): PatternPosition[] {
    const count = this.count(node);
    return Array.from({ length: count }, (_, index) => ({ kind: "parallel_item" as const, index, count }));
  }

  /** The state of every position from rows: the latest Invocation at each, its outcome, and its integration. */
  private state(node: PatternPlanNode): ParallelState {
    const { stores } = this.deps;
    const count = this.count(node);
    const items = this.positions(node).map((position, index): ItemState => {
      const invocation = this.support.latestAt(node, position);
      if (invocation === null) return { kind: "unstarted" };
      if (!INVOCATION_MACHINE.isTerminal(invocation.status)) return { kind: "active", invocation };
      const decision = blockedOn(stores, invocation);
      if (decision !== null) return { kind: "blocked", invocation, decisionStatus: decision.status };
      switch (invocation.status) {
        case "cancelled":
          return { kind: "done", invocation, entry: { index, invocationId: invocation.id, outcome: "cancelled", outputArtifactIds: [], failure: null } };
        case "failed":
          return { kind: "done", invocation, entry: { index, invocationId: invocation.id, outcome: "failed", outputArtifactIds: [], failure: { kind: "invocation_failed", invocationFailureReason: invocation.failureReason } } };
        case "succeeded": {
          const result = invocation.result!;
          if (result.status === "failed") return { kind: "done", invocation, entry: { index, invocationId: invocation.id, outcome: "failed", outputArtifactIds: [], failure: { kind: "result_failed", invocationFailureReason: null } } };
          if (result.status === "blocked") return { kind: "done", invocation, entry: { index, invocationId: invocation.id, outcome: "failed", outputArtifactIds: [], failure: { kind: "result_blocked", invocationFailureReason: null } } };
          const changeset = outstandingChangesetOf(stores, invocation);
          if (changeset !== null) return { kind: "pending_integration", invocation, conflict: changeset.integrationStatus === "conflict" };
          return { kind: "done", invocation, entry: { index, invocationId: invocation.id, outcome: "succeeded", outputArtifactIds: [...result.artifactIds].sort(), failure: null } };
        }
        default:
          throw new Error(`unreachable: Invocation ${invocation.id} is ${invocation.status}`);
      }
    });
    const aggregation = node.shape.pattern === "parallel" && node.shape.aggregate !== null ? this.support.latestAt(node, AGGREGATION) : null;
    return { items, count, aggregation };
  }

  /**
   * The lowest-index item whose pending Changeset may be integrated now:
   * every lower item is determined (done, or blocked beyond resolution) so
   * no earlier Changeset can still arrive. A conflicted Changeset is
   * integrable again once its Task completed; the service reports the
   * rest of the conflict lifecycle.
   */
  private nextIntegrable(state: ParallelState): Invocation | null {
    for (const item of state.items) {
      if (item.kind === "pending_integration") {
        if (!item.conflict) return item.invocation;
        const changeset = outstandingChangesetOf(this.deps.stores, item.invocation)!;
        const task = changeset.conflictTaskId === null ? null : this.deps.stores.tasks.get(changeset.conflictTaskId);
        return task !== null && TASK_MACHINE.isTerminal(task.status) ? item.invocation : null;
      }
      if (item.kind === "done" || (item.kind === "blocked" && item.decisionStatus === "superseded")) continue;
      return null;
    }
    return null;
  }
}
