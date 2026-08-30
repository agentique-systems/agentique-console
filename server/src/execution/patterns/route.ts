/**
 * The `route` Pattern runner (execution-model §5.3, §4.3): one selector
 * chooses exactly one branch, the runtime records the choice as the node's
 * one canonical `route_selection` Evaluation, and either an inline branch
 * runs inside the node or a composite branch's subgraph is activated
 * through its `branch(label)` edge by the pure readiness evaluator.
 *
 * Selectors:
 * - `decision_answer`: the referenced Decision is read (its Conversation
 *   and Run ownership checked); while it is open the node waits with reason
 *   `decision`; once resolved its chosen option is mapped through
 *   `labelsByOptionId` and validated against the shape's branch bindings.
 *   No model is invoked and no Attempt is consumed; a resolution that maps
 *   to no branch fails the node with `route_selection_failed`.
 * - `evaluator`: one read-only Evaluator Invocation (role `evaluator`,
 *   purpose `select`, position `route_selection`) receives the node's
 *   incoming edge Handoffs and the empty selector input the compiled shape
 *   authorizes, and returns the typed `routeSelection`; the result
 *   validator admits only a label the shape binds, so an invalid label is
 *   an invalid result that retries within the Invocation's Attempts and
 *   fails the node with `route_selection_failed` after them. Evaluators are
 *   read-only by role policy and record no Changeset.
 *
 * The selection is recorded exactly once per node (store check and database
 * unique index) in the same transaction that acts on it: an inline branch's
 * Worker Invocation (position `route_branch { label }`, the selection
 * Evaluation as its typed `route_selection` input, the node's Handoffs
 * delivered) is prepared, or the node succeeds with no fabricated output and
 * the `branch(label)` Handoff to the composite branch's entry is created.
 * Repeated passes and restarts find the Evaluation from rows and never
 * record a second one or prepare a second Invocation.
 *
 * An inline branch behaves like a `single` step: retries stay
 * Invocation-owned, an approval successor continues at the same position
 * with the selection input re-delivered, its Changeset is integrated before
 * the node settles, its result Artifacts are the node's output, and its
 * failure fails the node. Successors are readied by the readiness evaluator
 * from the graph plus the recorded selection: an inline selection delivers
 * along the route's `sequence` edges and skips every composite branch; a
 * composite selection delivers through the selected branch's exits only.
 */
import { INVOCATION_MACHINE, InvariantViolationError, PLAN_NODE_MACHINE, type Decision, type Evaluation, type Invocation, type ManifestInput, type PatternPlanNode, type PatternPosition, type PlanNodeId, type Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf, PatternNodeSupport, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

const SELECTION: PatternPosition = { kind: "route_selection" };

export class RoutePatternRunner {
  readonly pattern = "route" as const;
  private readonly support: PatternNodeSupport;

  constructor(private readonly deps: PatternRunnerDependencies) {
    this.support = new PatternNodeSupport(deps, "route");
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const state = this.state(node);
    if (!this.support.isCurrentMember(node)) {
      const latest = state.branch ?? state.selection;
      const settle = latest !== null && INVOCATION_MACHINE.isTerminal(latest.status) && !(node.status === "waiting" && blockedOn(this.deps.stores, latest) !== null);
      return { kind: "not_current", invocationId: latest?.id ?? null, settle };
    }
    if (node.status === "pending") throw new InvariantViolationError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, state);
    if (node.status === "ready") return { kind: "start" };
    // Running.
    if (state.fact === null) {
      if (routeShape(node).selector.kind === "decision_answer") return { kind: "settle", invocationId: null };
      const selection = state.selection;
      if (selection === null) return { kind: "start" };
      if (!INVOCATION_MACHINE.isTerminal(selection.status)) return activeInvocationAdvice(this.deps.executor, selection, now);
      return { kind: "settle", invocationId: selection.id };
    }
    if (state.binding === null || state.binding.inline === null) return { kind: "settle", invocationId: null };
    const branch = state.branch;
    if (branch === null) return { kind: "settle", invocationId: null };
    if (!INVOCATION_MACHINE.isTerminal(branch.status)) return activeInvocationAdvice(this.deps.executor, branch, now);
    if (branch.status === "succeeded" && branch.result?.status === "completed" && outstandingChangesetOf(this.deps.stores, branch) === null && node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
    return { kind: "settle", invocationId: branch.id };
  }

  private inspectWaiting(node: PatternPlanNode, state: RouteState): NodeAdvice {
    const latest = state.branch ?? state.selection;
    return this.support.inspectWaiting(node, {
      blocked: latest !== null && blockedOn(this.deps.stores, latest) !== null ? [latest] : [],
      selectorDecision: state.fact === null && routeShape(node).selector.kind === "decision_answer" ? this.selectorDecision(node) : null,
      nextPosition: state.fact === null ? (routeShape(node).selector.kind === "evaluator" ? SELECTION : null) : state.binding?.inline !== null && state.branch === null ? { kind: "route_branch", label: state.fact.subject.kind === "route_selection" ? state.fact.subject.selectedLabel : "" } : null,
      capacity: latest,
      conflicted: latest === null ? [] : [latest],
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: the node runs, its incoming edge Handoffs are
   * ensured and delivered, and its selector begins — a Decision selector is
   * applied at once (or waited on), an Evaluator selector's Invocation is
   * prepared at the `route_selection` position.
   */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      let node = this.support.node(nodeId);
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      const state = this.state(node);
      if (node.status === "running" && (state.fact !== null || state.selection !== null)) return { kind: "no_change" };
      if (node.status === "ready") node = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      this.support.router.ensureEdgeHandoffsInto(this.support.readinessInput(node.runId), node.id, options);
      if (routeShape(node).selector.kind === "decision_answer") return this.applyDecisionSelector(node, options);
      const prepared = this.support.prepare(node, SELECTION, { continuedFromInvocationId: null, handoffIds: this.support.incomingHandoffIds(node), inputs: [] }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position: SELECTION };
    });
  }

  /** The route advises no further position of its own; the request is a no-op after revalidation. */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, _position: PatternPosition, _options: WriteOptions = {}): PatternRunnerOutcome {
    return this.support.staleness(nodeId, expectedRevisionNumber) ?? { kind: "no_change" };
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies what the node's canonical rows imply: a resolved selector
   * Decision or a terminal selection Invocation records the selection and
   * prepares the inline branch or completes the composite selection; a
   * terminal branch Invocation integrates its Changeset (outside any
   * transaction) and then completes, fails, or waits the node. Repeating it
   * applies nothing twice.
   */
  async settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    const branch = this.state(node).branch;
    if (branch !== null && branch.status === "succeeded" && branch.result?.status === "completed") {
      const step = await this.support.integrate(branch, options);
      if (step.kind === "conflict") return this.support.markWaiting(nodeId, expectedRevisionNumber, "integration_conflict", options);
      if (step.kind === "conflict_unresolved") return this.support.fail(nodeId, expectedRevisionNumber, "integration_conflict", options);
    }
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      return this.apply(this.support.node(nodeId), options, true);
    });
  }

  /** Finishes the own work of a node that left the current membership: the selection or branch settles, but no successor Handoff is created. */
  async settleRemoved(nodeId: PlanNodeId, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    const { ctx } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("a Pattern runner settles outside any transaction; integration is external");
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (this.support.isCurrentMember(node)) throw new InvariantViolationError(`PlanNode ${nodeId} is a current member; settle it through the current revision`);
    const branch = this.state(node).branch;
    if (branch !== null && branch.status === "succeeded" && branch.result?.status === "completed") {
      const step = await this.support.integrate(branch, options);
      if (step.kind !== "integrated") return { kind: "no_change" };
    }
    return ctx.tx.write((): PatternRunnerOutcome => this.apply(this.support.node(nodeId), options, false));
  }

  /** Inside a transaction: the consequence of the node's current canonical state. */
  private apply(node: PatternPlanNode, options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const { stores } = this.deps;
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
    if (node.status === "waiting") return { kind: "no_change" };
    if (node.status !== "running") return { kind: "no_change" };
    const state = this.state(node);
    if (state.fact === null) {
      if (routeShape(node).selector.kind === "decision_answer") return this.applyDecisionSelector(node, options);
      const selection = state.selection;
      if (selection === null || !INVOCATION_MACHINE.isTerminal(selection.status)) return { kind: "no_change" };
      switch (selection.status) {
        case "blocked":
          return this.support.wait(node, "decision", options);
        case "cancelled":
          return this.support.cancelNow(node, options);
        case "failed":
          return this.support.failNow(node, "route_selection_failed", options);
        case "succeeded": {
          const result = selection.result!;
          if (result.status === "completed" && result.routeSelection !== null) {
            return this.applySelection(node, result.routeSelection.selectedLabel, { kind: "evaluator", invocationId: selection.id, agentDefinitionRevisionId: selection.agentDefinitionRevisionId }, options, current);
          }
          if (result.status === "blocked" && blockingDecisionOf(stores, selection) !== null) return this.support.wait(node, "decision", options);
          return this.support.failNow(node, "route_selection_failed", options);
        }
        default:
          throw new Error(`unreachable: Invocation ${selection.id} is ${selection.status}`);
      }
    }
    const binding = state.binding;
    if (binding === null) throw new InvariantViolationError(`route PlanNode ${node.id} recorded a selection its shape does not bind`, { planNodeId: node.id, evaluationId: state.fact.id });
    if (binding.inline === null) return this.support.succeedNow(node, [], options, current);
    const branch = state.branch;
    if (branch === null) return this.prepareBranch(node, state.fact, options);
    if (!INVOCATION_MACHINE.isTerminal(branch.status)) return { kind: "no_change" };
    switch (branch.status) {
      case "blocked":
        return this.support.wait(node, "decision", options);
      case "cancelled":
        return this.support.cancelNow(node, options);
      case "failed":
        return this.support.failNow(node, "invocation_failed", options);
      case "succeeded": {
        const result = branch.result!;
        if (result.status === "failed") return this.support.failNow(node, "result_failed", options);
        if (result.status === "blocked") return blockingDecisionOf(stores, branch) !== null ? this.support.wait(node, "decision", options) : this.support.failNow(node, "result_blocked", options);
        if (outstandingChangesetOf(stores, branch) !== null) return { kind: "no_change" };
        if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
        return this.support.succeedNow(node, result.artifactIds, options, current);
      }
      default:
        throw new Error(`unreachable: Invocation ${branch.id} is ${branch.status}`);
    }
  }

  /** The Decision selector: wait while open, fail when superseded or unmapped, otherwise record the mapped label. */
  private applyDecisionSelector(node: PatternPlanNode, options: WriteOptions): PatternRunnerOutcome {
    const selector = routeShape(node).selector;
    if (selector.kind !== "decision_answer") throw new Error("unreachable");
    const decision = this.selectorDecision(node);
    if (decision.status === "open") return this.support.wait(node, "decision", options);
    if (decision.status !== "resolved" || decision.resolution === null) return this.support.failNow(node, "route_selection_failed", options);
    const label = selector.labelsByOptionId[decision.resolution.chosenOptionId];
    if (label === undefined) return this.support.failNow(node, "route_selection_failed", options);
    return this.applySelection(node, label, { kind: "runtime" }, options, true);
  }

  /** Records the one canonical selection and acts on it in the same transaction. */
  private applySelection(node: PatternPlanNode, label: string, producedBy: Evaluation["producedBy"], options: WriteOptions, current: boolean): PatternRunnerOutcome {
    const binding = node.shape.pattern === "route" ? (node.shape.branches.find((b) => b.label === label) ?? null) : null;
    if (binding === null) return this.support.failNow(node, "route_selection_failed", options);
    const evaluation = this.deps.stores.evaluations.record({ runId: node.runId, planNodeId: node.id, gateId: null, subject: { kind: "route_selection", selectedLabel: label }, verdict: "pass", evidence: [], producedBy, artifactIds: [] }, options);
    if (binding.inline === null) {
      const done = this.support.succeedNow(node, [], options, current);
      return done.kind === "succeeded" ? { kind: "selected", evaluationId: evaluation.id, selectedLabel: label, invocationId: null } : done;
    }
    return this.prepareBranch(node, evaluation, options);
  }

  /** The inline branch's Worker Invocation, delivered the node's edge Handoffs and the selection as its typed input. */
  private prepareBranch(node: PatternPlanNode, evaluation: Evaluation, options: WriteOptions): PatternRunnerOutcome {
    if (evaluation.subject.kind !== "route_selection") throw new Error("unreachable");
    const label = evaluation.subject.selectedLabel;
    const position: PatternPosition = { kind: "route_branch", label };
    if (this.support.latestAt(node, position) !== null) return { kind: "no_change" };
    const prepared = this.support.prepare(node, position, { continuedFromInvocationId: null, handoffIds: this.support.incomingHandoffIds(node), inputs: [this.selectionInput(evaluation)] }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "selected", evaluationId: evaluation.id, selectedLabel: label, invocationId: prepared.invocationId };
  }

  private selectionInput(evaluation: Evaluation): ManifestInput {
    if (evaluation.subject.kind !== "route_selection") throw new Error("unreachable");
    return { kind: "route_selection", evaluationId: evaluation.id, selectedLabel: evaluation.subject.selectedLabel };
  }

  // ---------------------------------------------------------------------------
  // Waiting and resuming
  // ---------------------------------------------------------------------------

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome {
    return this.support.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }

  /**
   * Clears a wait whose condition has cleared: a resolved selector Decision
   * is applied; a resolved Decision of a blocked selection or branch
   * Invocation prepares its successor at the same position (the branch
   * successor keeps the selection as its typed input); other waits return
   * the node to `running`.
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
      const latest = state.branch ?? state.selection;
      if (latest === null || blockedOn(stores, latest) === null) return this.applyDecisionSelector(running, options);
      const extra = latest.patternPosition?.kind === "route_branch" && state.fact !== null ? [this.selectionInput(state.fact)] : [];
      return this.support.prepareSuccessor(running, latest, blockedOn(stores, latest)!, extra, options);
    });
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  /** The referenced selector Decision, validated to belong to the node's Conversation and Run. */
  private selectorDecision(node: PatternPlanNode): Decision {
    const selector = routeShape(node).selector;
    if (selector.kind !== "decision_answer") throw new Error(`PlanNode ${node.id} has no Decision selector`);
    const decision = this.deps.stores.decisions.get(selector.decisionId);
    const run = this.deps.stores.runs.get(node.runId);
    if (decision.conversationId !== run.conversationId) throw new InvariantViolationError(`Decision ${decision.id} belongs to another Conversation`, { decisionId: decision.id, planNodeId: node.id });
    if (decision.runId !== null && decision.runId !== run.id) throw new InvariantViolationError(`Decision ${decision.id} belongs to another Run`, { decisionId: decision.id, planNodeId: node.id });
    return decision;
  }

  /** The node's canonical state: its selection fact, the binding it names, and the latest selection and branch Invocations. */
  private state(node: PatternPlanNode): RouteState {
    if (node.shape.pattern !== "route") throw new Error("unreachable");
    const fact = this.deps.stores.evaluations.routeSelectionOf(node.id);
    const label = fact !== null && fact.subject.kind === "route_selection" ? fact.subject.selectedLabel : null;
    const binding = label === null ? null : (node.shape.branches.find((b) => b.label === label) ?? null);
    const selection = routeShape(node).selector.kind === "evaluator" ? this.support.latestAt(node, SELECTION) : null;
    const branch = label === null || binding === null || binding.inline === null ? null : this.support.latestAt(node, { kind: "route_branch", label });
    return { fact, binding, selection, branch };
  }

  /** The node's recorded selection, for callers that need the canonical fact. */
  selectionOf(nodeId: PlanNodeId): Evaluation | null {
    return this.deps.stores.evaluations.routeSelectionOf(this.support.node(nodeId).id);
  }
}

/** The immutable route shape of a route node. */
function routeShape(node: PatternPlanNode): Extract<PatternPlanNode["shape"], { pattern: "route" }> {
  if (node.shape.pattern !== "route") throw new Error(`PlanNode ${node.id} is a ${node.shape.pattern} node, not a route`);
  return node.shape;
}

interface RouteState {
  fact: Evaluation | null;
  binding: { label: string; inline: unknown | null } | null;
  selection: Invocation | null;
  branch: Invocation | null;
}
