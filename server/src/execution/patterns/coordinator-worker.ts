/**
 * The `coordinator_worker` Pattern runner (execution-model §5.5, §5.5.1,
 * §6.4, §7.3, §7.7, §7.9, §9.2): one Coordinator role proposes Tasks
 * through the runtime-tool boundary, the runtime validates, orders,
 * funds, schedules, integrates, and fans in the Workers, and a Coordinator
 * synthesizes the results. The Coordinator proposes intent; the runtime
 * owns all Task creation, dependencies, readiness, allocation, retries,
 * fan-in, waiting, and progress. Workers never address one another or the
 * Coordinator; a Coordinator sees a Worker only as a Handoff.
 *
 * Coordinator logical turns, at the one `coordinator_turn` position:
 * - `decompose`: once, at node start, with the node's incoming edge
 *   Handoffs and the empty ledger. It must accept exactly one non-empty
 *   Task proposal before a completed result advances the node; a completed
 *   result without one fails the node with `coordinator_no_progress`.
 * - `replan`: only when deterministic work cannot advance any Task — no
 *   Worker is active or runnable and no Changeset can be integrated — and
 *   the unresolved blocker frontier (failed and unreplaced Tasks, Tasks
 *   blocked by a failed or cancelled dependency or by a Worker's report,
 *   unresolved integration conflicts) is non-empty. The whole frontier is
 *   coalesced into one turn; it receives the Worker-result Handoffs since
 *   the previous turn and only the blocker facts not delivered before. It
 *   must make canonical progress (an accepted proposal, a cancellation, or
 *   a changed frontier); otherwise the node fails with
 *   `coordinator_no_progress`.
 * - `synthesize`: once, when every current Task is completed or cancelled,
 *   every completed Task's Changeset is integrated and its Worker-result
 *   Handoff exists, no conflict is open, and no Worker is active. Its result
 *   Artifacts (after its own Changeset is integrated) are the node's output.
 * An approval successor at the same position continues the same logical
 * turn: it consumes no turn of `maxCoordinatorInvocations` and never
 * duplicates its predecessor's accepted proposal. Logical turns are
 * bounded by `maxCoordinatorInvocations`; exhausting them while blockers
 * remain or synthesis is due fails the node with
 * `coordinator_invocations_exhausted`.
 *
 * Workers: one `worker` Invocation per runnable current Task at
 * `worker_task { taskId }`, its reservation transferred from the Task's,
 * at most `maxConcurrentWorkers` active (independently of the Run's and the
 * governor's limits), started in canonical Task order, one per scheduler
 * iteration, and never while a Coordinator turn is active. A Worker's
 * manifest holds exactly its Task, that Task's Requirements, and its input
 * Artifacts. Writing Changesets are integrated in the canonical Task order
 * (dependency order, then creation order — never completion order): a
 * Task's Changeset waits until every earlier Task is determined. Only an
 * integrated result gets its `worker_result` Handoff; a conflict follows
 * the ordinary conflict lifecycle and joins the blocker frontier.
 *
 * Everything here is derived from rows: the pure Task projection, positions,
 * Invocations and results, runtime-tool call records, Changesets, Handoffs
 * by key, Decisions, reservations. Every operation is safe to repeat.
 */
import {
  coordinatorBlockerKey,
  INVOCATION_MACHINE,
  InvariantViolationError,
  PLAN_NODE_MACHINE,
  TASK_MACHINE,
  type Changeset,
  type CoordinatorBlocker,
  type CoordinatorPurpose,
  type CoordinatorWorkerBounds,
  type Decision,
  type Handoff,
  type Invocation,
  type ManifestInput,
  type PatternPlanNode,
  type PatternPosition,
  type PlanNodeFailureReason,
  type PlanNodeId,
  type Task,
  type TaskId,
  type TaskLedgerEntry,
  type Timestamp,
} from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { logicalTurnInvocationIds } from "../runtime-tools.ts";
import { projectNodeTasks, type TaskProjection } from "../task-projection.ts";
import { activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf, PatternNodeSupport, type NodeAdvice, type PatternRunnerDependencies, type PatternRunnerOutcome } from "./support.ts";

const TURN: PatternPosition = { kind: "coordinator_turn" };

/** One current Task with its Worker facts, from rows. */
interface WorkerFacts {
  task: Task;
  /** The latest Invocation at the Task's position, if any. */
  invocation: Invocation | null;
  /** The Worker's outstanding (pending or conflicted) Changeset, if any. */
  outstanding: Changeset | null;
  handoff: Handoff | null;
}

interface CoordinatorState {
  node: PatternPlanNode;
  bounds: CoordinatorWorkerBounds;
  /** Every Invocation at the `coordinator_turn` position, in creation order. */
  turns: Invocation[];
  latestTurn: Invocation | null;
  /** Logical turns used: approval continuations of a blocked predecessor are not counted. */
  turnsUsed: number;
  projection: TaskProjection;
  /** Per current Task, in canonical order. */
  workers: Map<TaskId, WorkerFacts>;
  activeWorkers: Invocation[];
  /** Current `running` Tasks whose assigned Worker ended without reporting them: normalized before anything else. */
  staleRunning: WorkerFacts[];
  /** The unresolved blocker frontier: Task blockers in canonical order, then integration conflicts. */
  frontier: CoordinatorBlocker[];
}

export class CoordinatorWorkerPatternRunner {
  readonly pattern = "coordinator_worker" as const;
  private readonly support: PatternNodeSupport;

  constructor(private readonly deps: PatternRunnerDependencies) {
    this.support = new PatternNodeSupport(deps, "coordinator_worker");
  }

  // ---------------------------------------------------------------------------
  // Read-only inspection
  // ---------------------------------------------------------------------------

  inspect(nodeId: PlanNodeId, now: Timestamp = this.deps.ctx.clock()): NodeAdvice {
    const node = this.support.node(nodeId);
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "terminal", status: node.status as "succeeded" | "failed" | "cancelled" | "skipped" };
    const state = this.state(node);
    if (!this.support.isCurrentMember(node)) {
      const settle = node.status === "running" && this.settlementDue(state);
      return { kind: "not_current", invocationId: state.latestTurn?.id ?? null, settle };
    }
    if (node.status === "pending") throw new InvariantViolationError(`PlanNode ${node.id} is pending; readiness is decided by the scheduler`);
    if (node.status === "waiting") return this.inspectWaiting(node, state);
    if (node.status === "ready") return { kind: "start" };
    return this.runningAdvice(state, now);
  }

  /** The next canonical action of a running node, in a fixed priority. */
  private runningAdvice(state: CoordinatorState, now: Timestamp): NodeAdvice {
    const { stores } = this.deps;
    const turn = state.latestTurn;
    // 1. A Coordinator turn in progress, or one whose consequences are not yet applied, comes first; Workers never start meanwhile.
    if (turn !== null && !INVOCATION_MACHINE.isTerminal(turn.status)) return activeInvocationAdvice(this.deps.executor, turn, now);
    if (turn === null) return { kind: "start" };
    if (this.turnNeedsSettlement(state)) {
      const decision = blockedOn(stores, turn);
      if (decision !== null && decision.status === "resolved") return { kind: "start_position", position: TURN, turn: turn.purpose as CoordinatorPurpose };
      // Synthesis complete and integrated on a node with Gate criteria: work is done; the Gate phase is a later phase.
      if (turn.purpose === "synthesize" && turn.status === "succeeded" && turn.result?.status === "completed" && outstandingChangesetOf(stores, turn) === null && state.node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
      return { kind: "settle", invocationId: turn.id };
    }
    // 2. The Task projection: readiness and dependency blocking, and Workers that ended without reporting their Task.
    if (state.projection.decisions.length > 0 || state.staleRunning.length > 0) return { kind: "settle", invocationId: null };
    // 3. A Worker blocked on a Decision that resolved continues at its position.
    for (const taskId of state.projection.order) {
      const w = state.workers.get(taskId)!;
      if (w.task.status === "blocked" && w.task.blockReason?.kind === "decision" && w.invocation !== null && INVOCATION_MACHINE.isTerminal(w.invocation.status)) {
        const decision = blockedOn(stores, w.invocation);
        if (decision !== null && decision.status === "resolved") return { kind: "start_position", position: { kind: "worker_task", taskId } };
      }
    }
    // 4. Integration in canonical order; 5. the result Handoff of an integrated Task.
    const integrable = this.nextIntegrable(state);
    if (integrable !== null) return { kind: "settle", invocationId: integrable.invocation!.id };
    if (this.missingHandoff(state) !== null) return { kind: "settle", invocationId: null };
    // 6. Runnable Tasks within maxConcurrentWorkers, in canonical order.
    if (state.activeWorkers.length < state.bounds.maxConcurrentWorkers) {
      const runnable = state.projection.order.find((id) => state.projection.states.get(id)!.kind === "runnable");
      if (runnable !== undefined) return { kind: "start_position", position: { kind: "worker_task", taskId: runnable } };
    }
    // 7. Active Workers: execute, in flight, or the earliest retry.
    const advices = state.activeWorkers.map((i) => activeInvocationAdvice(this.deps.executor, i, now));
    const executable = advices.find((a) => a.kind === "execute");
    if (executable) return executable;
    const inFlight = advices.find((a) => a.kind === "attempt_in_flight");
    if (inFlight) return inFlight;
    const retries = advices.filter((a): a is Extract<NodeAdvice, { kind: "retry_not_before" }> => a.kind === "retry_not_before").sort((a, b) => (a.notBefore < b.notBefore ? -1 : 1));
    if (retries[0]) return retries[0];
    if (state.activeWorkers.length > 0 || state.projection.order.some((id) => state.projection.states.get(id)!.kind === "runnable")) return { kind: "settle", invocationId: null };
    // 8. Nothing deterministic can proceed: the frontier goes to one replan turn, or the resolved graph to synthesis.
    if (state.frontier.length > 0) return state.turnsUsed < state.bounds.maxCoordinatorInvocations ? { kind: "start_position", position: TURN, turn: "replan" } : { kind: "settle", invocationId: null };
    if (this.synthesisReady(state)) return state.turnsUsed < state.bounds.maxCoordinatorInvocations ? { kind: "start_position", position: TURN, turn: "synthesize" } : { kind: "settle", invocationId: null };
    // 9. Only Decision-blocked Tasks (or integrations held behind one) remain: the node waits on the Decision.
    if (this.openDecisionBlocked(state).length > 0) return { kind: "settle", invocationId: null };
    throw new InvariantViolationError(`coordinator_worker PlanNode ${state.node.id} has no next action from its rows`, { planNodeId: state.node.id });
  }

  private inspectWaiting(node: PatternPlanNode, state: CoordinatorState): NodeAdvice {
    const { stores } = this.deps;
    const invocations = [...(state.latestTurn === null ? [] : [state.latestTurn]), ...[...state.workers.values()].flatMap((w) => (w.invocation === null ? [] : [w.invocation]))];
    return this.support.inspectWaiting(node, {
      blocked: invocations.filter((i) => INVOCATION_MACHINE.isTerminal(i.status) && blockedOn(stores, i) !== null),
      selectorDecision: null,
      nextPosition: TURN,
      capacity: invocations.find((i) => !INVOCATION_MACHINE.isTerminal(i.status)) ?? null,
      conflicted: state.latestTurn === null ? [] : [state.latestTurn],
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /** In one root transaction: the node runs, its incoming edge Handoffs are ensured, and the `decompose` turn is prepared. */
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      let node = this.support.node(nodeId);
      if (node.status !== "ready" && node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      if (node.status === "running" && this.support.latestAt(node, TURN) !== null) return { kind: "no_change" };
      if (node.status === "ready") node = stores.plans.transitionNode(node.id, { to: "running" }, options) as PatternPlanNode;
      this.support.router.ensureEdgeHandoffsInto(this.support.readinessInput(node.runId), node.id, options);
      return this.prepareTurn(node, "decompose", this.state(node), options);
    });
  }

  /**
   * Prepares one more position of a running node: a runnable Task's Worker
   * (its Task reservation transferred), the successor of a Worker or turn
   * blocked on a resolved Decision, or the next Coordinator logical turn
   * (`replan` on a blocker frontier, `synthesize` on a resolved graph). One
   * position per call; nothing starts while a Coordinator turn is active.
   */
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, position: PatternPosition, options: WriteOptions = {}): PatternRunnerOutcome {
    const { ctx, stores } = this.deps;
    return ctx.tx.write((): PatternRunnerOutcome => {
      const stale = this.support.staleness(nodeId, expectedRevisionNumber);
      if (stale) return stale;
      const node = this.support.node(nodeId);
      if (node.status !== "running") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: expectedRevisionNumber };
      const state = this.state(node);
      const turn = state.latestTurn;
      if (turn !== null && !INVOCATION_MACHINE.isTerminal(turn.status)) return { kind: "no_change" };
      if (position.kind === "coordinator_turn") {
        if (turn !== null && this.turnNeedsSettlement(state)) {
          const decision = blockedOn(stores, turn);
          if (decision === null || decision.status !== "resolved") return { kind: "no_change" };
          return this.prepareTurnSuccessor(node, turn, decision, options);
        }
        if (state.projection.decisions.length > 0 || state.staleRunning.length > 0 || state.activeWorkers.length > 0 || this.nextIntegrable(state) !== null || this.missingHandoff(state) !== null) return { kind: "no_change" };
        if (state.projection.order.some((id) => state.projection.states.get(id)!.kind === "runnable")) return { kind: "no_change" };
        if (state.frontier.length > 0) return this.prepareTurn(node, "replan", state, options);
        if (this.synthesisReady(state)) return this.prepareTurn(node, "synthesize", state, options);
        return { kind: "no_change" };
      }
      if (position.kind !== "worker_task") throw new InvariantViolationError(`PlanNode ${node.id} has no ${position.kind} position`);
      const w = state.workers.get(position.taskId);
      if (w === undefined) return { kind: "no_change" };
      if (w.invocation !== null && !INVOCATION_MACHINE.isTerminal(w.invocation.status)) return { kind: "no_change" };
      if (state.activeWorkers.length >= state.bounds.maxConcurrentWorkers) return { kind: "no_change" };
      if (w.task.status === "blocked" && w.task.blockReason?.kind === "decision" && w.invocation !== null) {
        const decision = blockedOn(stores, w.invocation);
        if (decision === null || decision.status !== "resolved") return { kind: "no_change" };
        stores.tasks.transition(w.task.id, { to: "ready" }, options);
        return this.support.prepareSuccessor(node, w.invocation, decision, [], options);
      }
      if (w.task.status !== "ready") return { kind: "no_change" };
      const reservation = stores.reservations.activeForChild({ type: "task", id: w.task.id });
      if (reservation === null) throw new InvariantViolationError(`ready Task ${w.task.id} holds no Task reservation`, { taskId: w.task.id });
      const prepared = this.support.prepareAs(node, position, "task", { continuedFromInvocationId: null, handoffIds: [], inputs: [], taskReservationId: reservation.id }, options);
      if (prepared.kind !== "prepared") return prepared.outcome;
      return { kind: "started", invocationId: prepared.invocationId, position };
    });
  }

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------

  /**
   * Applies the next canonical consequence: the next integrable Worker
   * Changeset or the synthesis Changeset (outside any transaction), then, in
   * one transaction, the turn's settlement, the Task projection, the
   * Worker-result Handoff, a bound failure, or a Decision wait. Repeating
   * it applies nothing twice.
   */
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): Promise<PatternRunnerOutcome> {
    return this.settleWith(nodeId, expectedRevisionNumber, options, true);
  }

  /** Finishes the own work of a node that left the current membership: integrations, Handoffs, and completion, but no successor Handoff and no new turn. */
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
    const turn = state.latestTurn;
    // A Coordinator turn writes in its own worktree: its Changeset is integrated before anything the turn decided proceeds.
    if (turn !== null && turn.status === "succeeded" && turn.result?.status === "completed" && outstandingChangesetOf(stores, turn) !== null) {
      const step = await this.support.integrate(turn, options);
      if (step.kind !== "integrated") {
        if (!current) return { kind: "no_change" };
        return step.kind === "conflict" ? this.support.markWaiting(nodeId, expectedRevisionNumber!, "integration_conflict", options) : this.support.fail(nodeId, expectedRevisionNumber!, "integration_conflict", options);
      }
      if (turn.purpose !== "synthesize") return { kind: "integrated", invocationId: turn.id };
    } else if (node.status === "running" && (turn === null || INVOCATION_MACHINE.isTerminal(turn.status)) && !this.turnNeedsSettlement(state)) {
      const integrable = this.nextIntegrable(state);
      if (integrable !== null) {
        const step = await this.support.integrate(integrable.invocation!, options);
        if (step.kind === "integrated") return { kind: "integrated", invocationId: integrable.invocation!.id };
        if (step.kind === "conflict") return { kind: "conflicted", invocationId: integrable.invocation!.id };
        return current ? this.support.fail(nodeId, expectedRevisionNumber!, "integration_conflict", options) : { kind: "no_change" };
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
    const turn = state.latestTurn;
    if (turn === null || !INVOCATION_MACHINE.isTerminal(turn.status)) return { kind: "no_change" };
    if (this.turnNeedsSettlement(state)) {
      switch (turn.status) {
        case "blocked": {
          const decision = blockedOn(stores, turn);
          if (decision === null) return this.failNode(state, "result_blocked", options);
          if (decision.status === "open") return this.support.wait(node, "decision", options);
          if (decision.status === "resolved") return this.prepareTurnSuccessor(node, turn, decision, options);
          return this.failNode(state, "result_blocked", options);
        }
        case "cancelled":
          this.cancelUnstartedTasks(state, options);
          return this.support.cancelNow(node, options);
        case "failed":
          return this.failNode(state, "invocation_failed", options);
        case "succeeded": {
          const result = turn.result!;
          if (result.status === "failed") return this.failNode(state, "result_failed", options);
          if (result.status === "blocked") {
            const decision = blockingDecisionOf(stores, turn);
            if (decision === null) return this.failNode(state, "result_blocked", options);
            if (decision.status === "open") return this.support.wait(node, "decision", options);
            if (decision.status === "resolved") return this.prepareTurnSuccessor(node, turn, decision, options);
            return this.failNode(state, "result_blocked", options);
          }
          if (outstandingChangesetOf(stores, turn) !== null) return { kind: "no_change" };
          switch (turn.purpose) {
            case "decompose":
              return this.failNode(state, "coordinator_no_progress", options);
            case "replan":
              return this.failNode(state, "coordinator_no_progress", options);
            case "synthesize": {
              if (node.gateAcceptanceCriterionIds.length > 0) return { kind: "awaiting_gate_phase" };
              return this.support.succeedNow(node, result.artifactIds, options, current);
            }
            default:
              throw new Error(`unreachable: Coordinator turn ${turn.id} has purpose ${turn.purpose}`);
          }
        }
        default:
          throw new Error(`unreachable: Invocation ${turn.id} is ${turn.status}`);
      }
    }
    // The Task projection and the normalization of Workers that ended without reporting their Task.
    const projected = this.applyProjection(state, options);
    if (projected !== null) return projected;
    const missing = this.missingHandoff(state);
    if (missing !== null) {
      const ensured = this.support.router.ensureWorkerResultHandoff(node, missing.invocation!, missing.task, options);
      return { kind: "worker_result_recorded", invocationId: missing.invocation!.id, handoffId: ensured.handoff.id };
    }
    if (this.nextIntegrable(state) !== null) return { kind: "no_change" };
    if (state.activeWorkers.length > 0 || state.projection.order.some((id) => state.projection.states.get(id)!.kind === "runnable")) return { kind: "no_change" };
    if (state.frontier.length > 0 || this.synthesisReady(state)) {
      if (state.turnsUsed >= state.bounds.maxCoordinatorInvocations) return this.failNode(state, "coordinator_invocations_exhausted", options);
      // A new turn is prepared through `start_position`; nothing else applies here.
      return { kind: "no_change" };
    }
    if (this.openDecisionBlocked(state).length > 0) return this.support.wait(node, "decision", options);
    return { kind: "no_change" };
  }

  /** Applies the pure projection's decisions and normalizes stale running Tasks; `null` when nothing changed. */
  private applyProjection(state: CoordinatorState, options: WriteOptions): PatternRunnerOutcome | null {
    const { stores } = this.deps;
    const readied: TaskId[] = [];
    const blocked: TaskId[] = [];
    for (const w of state.staleRunning) {
      const result = w.invocation!.result!;
      if (result.status === "failed") {
        stores.tasks.transition(w.task.id, { to: "failed", failureReason: "permanent_failure" }, options);
        blocked.push(w.task.id);
        continue;
      }
      const decision = blockingDecisionOf(stores, w.invocation!);
      stores.tasks.transition(w.task.id, { to: "blocked", blockReason: decision !== null ? { kind: "decision", decisionId: decision.id } : { kind: "input", description: result.blocker ?? "the Worker ended without completing the Task" } }, options);
      blocked.push(w.task.id);
    }
    for (const decision of state.projection.decisions) {
      if (decision.kind === "become_ready") {
        stores.tasks.transition(decision.taskId, { to: "ready" }, options);
        readied.push(decision.taskId);
      } else {
        stores.tasks.transition(decision.taskId, { to: "blocked", blockReason: decision.blockReason }, options);
        blocked.push(decision.taskId);
      }
    }
    return readied.length + blocked.length === 0 ? null : { kind: "tasks_projected", readied, blocked };
  }

  // ---------------------------------------------------------------------------
  // Coordinator turns
  // ---------------------------------------------------------------------------

  /** Prepares the next logical turn: its ledger and bounds as typed input, its Handoffs, and (for replan) the blockers not delivered before. */
  private prepareTurn(node: PatternPlanNode, purpose: CoordinatorPurpose, state: CoordinatorState, options: WriteOptions): PatternRunnerOutcome {
    if (state.turnsUsed >= state.bounds.maxCoordinatorInvocations) return this.failNode(state, "coordinator_invocations_exhausted", options);
    const blockerKeys = state.frontier.map(coordinatorBlockerKey).sort();
    const inputs: ManifestInput[] = [{ kind: "coordinator_turn", purpose, bounds: state.bounds, turnsUsed: state.turnsUsed + 1, tasks: this.ledger(node), blockerKeys }];
    if (purpose === "replan") {
      const delivered = this.deliveredBlockerKeys(state);
      for (const blocker of state.frontier) if (!delivered.has(coordinatorBlockerKey(blocker))) inputs.push({ kind: "coordinator_blocker", blocker });
    }
    const handoffIds = purpose === "decompose" ? this.support.router.pendingHandoffsFor(node.runId, node.id).map((h) => h.id) : this.support.router.workerResultHandoffs(node.runId, node.id, "pending").map((h) => h.id);
    const prepared = this.support.prepareAs(node, TURN, purpose, { continuedFromInvocationId: state.latestTurn?.id ?? null, handoffIds, inputs }, options);
    if (prepared.kind !== "prepared") return prepared.outcome;
    return { kind: "started", invocationId: prepared.invocationId, position: TURN };
  }

  /** The approval successor of a blocked turn: the same logical turn, purpose, ledger, blockers, and Handoffs; no turn consumed. */
  private prepareTurnSuccessor(node: PatternPlanNode, predecessor: Invocation, decision: Decision, options: WriteOptions): PatternRunnerOutcome {
    const previous = this.deps.stores.invocations.getManifest(predecessor.id).content.inputs;
    const turnInput = previous.find((i): i is Extract<ManifestInput, { kind: "coordinator_turn" }> => i.kind === "coordinator_turn");
    if (!turnInput) throw new InvariantViolationError(`Coordinator turn ${predecessor.id} carries no coordinator_turn input`);
    const extra: ManifestInput[] = [{ ...turnInput, tasks: this.ledger(node) }, ...previous.filter((i) => i.kind === "coordinator_blocker")];
    return this.support.prepareSuccessor(node, predecessor, decision, extra, options);
  }

  /** The canonical Task ledger of the node: every Task ever accepted, by id, with its replacement links and outputs. */
  private ledger(node: PatternPlanNode): TaskLedgerEntry[] {
    const tasks = this.deps.stores.tasks.listByPlanNode(node.id).filter((t) => t.origin === "coordinator");
    const supersededBy = new Map(tasks.flatMap((t) => (t.replacesTaskId === null ? [] : [[t.replacesTaskId, t.id] as const])));
    return tasks
      .map((t) => ({ taskId: t.id, subject: t.subject, status: t.status, replacesTaskId: t.replacesTaskId, supersededByTaskId: supersededBy.get(t.id) ?? null, outputArtifactIds: [...t.outputArtifactIds].sort() }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  }

  /** The blocker keys every earlier Coordinator turn of the node was delivered. */
  private deliveredBlockerKeys(state: CoordinatorState): Set<string> {
    const keys = new Set<string>();
    for (const turn of state.turns) {
      for (const input of this.deps.stores.invocations.getManifest(turn.id).content.inputs) {
        if (input.kind === "coordinator_blocker") keys.add(coordinatorBlockerKey(input.blocker));
      }
    }
    return keys;
  }

  /** Whether the latest terminal turn's consequences are still to be applied. */
  private turnNeedsSettlement(state: CoordinatorState): boolean {
    const turn = state.latestTurn;
    if (turn === null || !INVOCATION_MACHINE.isTerminal(turn.status)) return false;
    if (turn.status !== "succeeded") return true;
    const result = turn.result!;
    if (result.status !== "completed") return true;
    if (outstandingChangesetOf(this.deps.stores, turn) !== null) return true;
    switch (turn.purpose) {
      case "decompose":
        return !this.proposalAccepted(turn);
      case "replan":
        return !this.progressMade(turn, state);
      case "synthesize":
        return true;
      default:
        return true;
    }
  }

  /** Whether the logical turn accepted a Task proposal (a committed `propose_tasks` call of any of its Invocations). */
  private proposalAccepted(turn: Invocation): boolean {
    return logicalTurnInvocationIds(this.deps.stores, turn).some((id) => this.deps.stores.runtimeToolCalls.listByInvocation(id).some((c) => c.tool === "propose_tasks"));
  }

  /** Canonical progress of a replan turn: any accepted mutating call, or a frontier that differs from the one it was prepared with. */
  private progressMade(turn: Invocation, state: CoordinatorState): boolean {
    const { stores } = this.deps;
    if (logicalTurnInvocationIds(stores, turn).some((id) => stores.runtimeToolCalls.listByInvocation(id).length > 0)) return true;
    const input = stores.invocations.getManifest(turn.id).content.inputs.find((i): i is Extract<ManifestInput, { kind: "coordinator_turn" }> => i.kind === "coordinator_turn");
    const before = input === undefined ? [] : input.blockerKeys;
    const now = state.frontier.map(coordinatorBlockerKey).sort();
    return before.length !== now.length || before.some((key, i) => key !== now[i]);
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  /** Fails the node, cancelling its unstarted current Tasks (their reservations released); failed Tasks stay failed. */
  private failNode(state: CoordinatorState, reason: PlanNodeFailureReason, options: WriteOptions): PatternRunnerOutcome {
    this.cancelUnstartedTasks(state, options);
    return this.support.failNow(state.node, reason, options);
  }

  private cancelUnstartedTasks(state: CoordinatorState, options: WriteOptions): void {
    const { stores } = this.deps;
    for (const task of state.projection.current) {
      const fresh = stores.tasks.get(task.id);
      if (fresh.status !== "pending" && fresh.status !== "ready" && fresh.status !== "blocked") continue;
      stores.tasks.transition(fresh.id, { to: "cancelled" }, options);
      const reservation = stores.reservations.activeForChild({ type: "task", id: fresh.id });
      if (reservation) stores.reservations.release(reservation.id, "task_cancelled", { costUsd: 0, tokens: 0, attempts: 0 }, options);
    }
  }

  // ---------------------------------------------------------------------------
  // Waiting and resuming
  // ---------------------------------------------------------------------------

  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome {
    return this.support.markWaiting(nodeId, expectedRevisionNumber, reason, options);
  }

  /**
   * Clears a wait whose condition has cleared: the node returns to
   * `running`; for a `decision` wait the blocked turn or the first blocked
   * Worker whose Decision resolved gets its successor now.
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
      const turn = state.latestTurn;
      if (turn !== null && INVOCATION_MACHINE.isTerminal(turn.status)) {
        const decision = blockedOn(stores, turn);
        if (decision !== null && decision.status === "resolved" && this.turnNeedsSettlement(state)) return this.prepareTurnSuccessor(running, turn, decision, options);
      }
      for (const taskId of state.projection.order) {
        const w = state.workers.get(taskId)!;
        if (w.invocation === null || !INVOCATION_MACHINE.isTerminal(w.invocation.status)) continue;
        const decision = blockedOn(stores, w.invocation);
        if (decision === null || decision.status !== "resolved" || w.task.status !== "blocked" || w.task.blockReason?.kind !== "decision") continue;
        if (state.activeWorkers.length >= state.bounds.maxConcurrentWorkers) break;
        stores.tasks.transition(w.task.id, { to: "ready" }, options);
        return this.support.prepareSuccessor(running, w.invocation, decision, [], options);
      }
      return { kind: "resumed", reason };
    });
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  /** The node's complete state from rows: turns, the Task projection, Workers, integrations, Handoffs, and the frontier. */
  private state(node: PatternPlanNode): CoordinatorState {
    const { stores } = this.deps;
    if (node.shape.pattern !== "coordinator_worker") throw new Error(`PlanNode ${node.id} is a ${node.shape.pattern} node, not a coordinator_worker`);
    const bounds = node.shape.bounds;
    const turns = stores.invocations.listAtPosition(node.id, "coordinator_turn");
    const turnsById = new Map(turns.map((t) => [t.id, t] as const));
    const turnsUsed = turns.filter((t) => t.continuedFromInvocationId === null || turnsById.get(t.continuedFromInvocationId)?.status !== "blocked").length;
    const projection = projectNodeTasks(stores, node);
    const workers = new Map<TaskId, WorkerFacts>();
    const activeWorkers: Invocation[] = [];
    const staleRunning: WorkerFacts[] = [];
    const conflicts: CoordinatorBlocker[] = [];
    for (const taskId of projection.order) {
      const task = projection.current.find((t) => t.id === taskId)!;
      const invocation = this.support.latestAt(node, { kind: "worker_task", taskId });
      const outstanding = invocation === null ? null : outstandingChangesetOf(stores, invocation);
      const facts: WorkerFacts = { task, invocation, outstanding, handoff: this.support.router.workerResultHandoff(node.runId, node.id, taskId) };
      workers.set(taskId, facts);
      if (invocation !== null && !INVOCATION_MACHINE.isTerminal(invocation.status)) activeWorkers.push(invocation);
      if (invocation !== null && task.status === "running" && task.invocationId === invocation.id && invocation.status === "succeeded" && invocation.result !== null && invocation.result.status !== "completed") staleRunning.push(facts);
      if (outstanding !== null && outstanding.integrationStatus === "conflict" && outstanding.conflictTaskId !== null) {
        const conflictTask = stores.tasks.get(outstanding.conflictTaskId);
        if (!TASK_MACHINE.isTerminal(conflictTask.status)) {
          conflicts.push({ kind: "integration_conflict", taskId, invocationId: invocation!.id, changesetId: outstanding.id, conflictTaskId: conflictTask.id, reportArtifactId: conflictTask.inputArtifactIds[0] ?? null });
        }
      }
    }
    return { node, bounds, turns, latestTurn: turns.at(-1) ?? null, turnsUsed, projection, workers, activeWorkers, staleRunning, frontier: [...projection.frontier, ...conflicts] };
  }

  /**
   * The first completed Task in canonical order whose Changeset may be
   * integrated now: every earlier Task is determined — integrated, failed,
   * cancelled, or blocked without a pending successor — so no earlier
   * Changeset can still arrive. A conflicted Changeset becomes integrable
   * again once its conflict Task ended; the service reports the rest.
   */
  private nextIntegrable(state: CoordinatorState): WorkerFacts | null {
    const { stores } = this.deps;
    for (const taskId of state.projection.order) {
      const w = state.workers.get(taskId)!;
      if (w.task.status === "completed" && w.outstanding !== null) {
        if (w.outstanding.integrationStatus === "pending") return w;
        const conflictTask = w.outstanding.conflictTaskId === null ? null : stores.tasks.get(w.outstanding.conflictTaskId);
        return conflictTask !== null && TASK_MACHINE.isTerminal(conflictTask.status) ? w : null;
      }
      if (!this.determined(w)) return null;
    }
    return null;
  }

  /** Whether a Task can no longer produce a Changeset that must precede later ones. */
  private determined(w: WorkerFacts): boolean {
    switch (w.task.status) {
      case "completed":
        return w.outstanding === null;
      case "failed":
      case "cancelled":
        return true;
      case "blocked":
        return w.task.blockReason?.kind !== "decision";
      default:
        return false;
    }
  }

  /** A completed, integrated Task whose Worker-result Handoff does not exist yet, in canonical order. */
  private missingHandoff(state: CoordinatorState): WorkerFacts | null {
    for (const taskId of state.projection.order) {
      const w = state.workers.get(taskId)!;
      if (w.task.status === "completed" && w.outstanding === null && w.handoff === null && w.invocation !== null && w.invocation.status === "succeeded" && w.invocation.result?.status === "completed") return w;
    }
    return null;
  }

  private synthesisReady(state: CoordinatorState): boolean {
    if (state.latestTurn === null || state.latestTurn.purpose === "synthesize" || state.activeWorkers.length > 0 || state.frontier.length > 0) return false;
    for (const taskId of state.projection.order) {
      const w = state.workers.get(taskId)!;
      if (w.task.status === "cancelled") continue;
      if (w.task.status !== "completed" || w.outstanding !== null || w.handoff === null) return false;
    }
    return true;
  }

  /** Terminal Invocations (the turn or Workers) blocked on a Decision that is still open. */
  private openDecisionBlocked(state: CoordinatorState): Invocation[] {
    const { stores } = this.deps;
    const candidates = [...(state.latestTurn === null ? [] : [state.latestTurn]), ...[...state.workers.values()].flatMap((w) => (w.invocation === null ? [] : [w.invocation]))];
    return candidates.filter((i) => INVOCATION_MACHINE.isTerminal(i.status) && blockedOn(stores, i)?.status === "open");
  }

  /** Whether a removed node has own work to settle. */
  private settlementDue(state: CoordinatorState): boolean {
    return this.turnNeedsSettlement(state) || state.projection.decisions.length > 0 || state.staleRunning.length > 0 || this.nextIntegrable(state) !== null || this.missingHandoff(state) !== null;
  }
}
