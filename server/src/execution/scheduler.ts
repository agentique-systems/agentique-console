/**
 * The Run scheduler (execution-model §4.3, §7.1, §7.4, §7.8, §14). A
 * deterministic runtime component — not an agent, not a prompt — with two
 * boundaries:
 *
 * - `reconcileRun(runId)`: a read-only projection that explains, from
 *   canonical rows alone, what the next canonical actions are, what waits
 *   on what, which work belongs to a later phase, and when to look again.
 * - `advanceRun(runId, { maxActions })`: an asynchronous, bounded pass that
 *   performs those actions one at a time, re-projecting the current
 *   accepted graph and its condition facts before every state-changing
 *   action and revalidating the revision, membership, node state, and
 *   active Invocations inside each mutation transaction (the Pattern
 *   runners and the join settler do that), until the Run is quiescent,
 *   waiting, terminal, at the action limit, left with only later-phase
 *   work, or an infrastructure failure stops it.
 *
 * Readiness is the pure evaluator over the current graph plus the explicit
 * canonical condition facts projected from rows (`readiness-facts.ts`).
 * Provider executions run outside every transaction; several independent
 * Attempts may execute concurrently within one pass, and the first of them
 * to end is what re-triggers projection while the others keep running —
 * nothing polls and no interval exists.
 * Retry `notBefore`, provider `retryAfter`, and Invocation deadlines are
 * returned as typed resumption times; deadlines are enforced from the caller's
 * clock at the start of each iteration. Routine progress creates no
 * conversational message and no status update of any kind.
 *
 * A per-Run in-process guard makes concurrent `advanceRun` calls join one
 * pass; canonical database constraints remain the source of correctness.
 */
import {
  boundedFailureMessage,
  grantsWriteCapability,
  PLAN_NODE_MACHINE,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  type AttemptId,
  type CoordinatorPurpose,
  type GateId,
  type InvocationId,
  type Pattern,
  type PatternPosition,
  type PlanNode,
  type PlanNodeId,
  type PlanNodeWaitReason,
  type RunId,
  type RunStatus,
  type RunWaitReason,
  type TaskId,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { AttemptExecutor, ExecutionOutcome } from "./attempt-executor.ts";
import type { ResourceGovernor } from "./governor.ts";
import { JoinNodeSettler, type JoinOutcome } from "./join.ts";
import { runnerFor, type NodeAdvice, type PatternRunnerOutcome, type PatternRunners, type RootAdvice, type RootOutcome } from "./patterns/index.ts";
import { projectReadinessInput } from "./readiness-facts.ts";
import { decideReadiness, evaluateReadiness, type ReadinessDecision, type SkipCause } from "./readiness.ts";

export type SchedulerAction =
  /** The Run was `waiting` and work can proceed again: clear the exact reason. */
  | { kind: "resume_run"; reason: RunWaitReason }
  | { kind: "ready_node"; nodeId: PlanNodeId }
  | { kind: "skip_node"; nodeId: PlanNodeId; cause: SkipCause; failed: PlanNodeId[] }
  | { kind: "start_node"; nodeId: PlanNodeId; pattern: Pattern }
  /** A running node prepares one more position: a parallel item, a Worker Task, a blocked position's successor, or (with `turn`) a Coordinator logical turn. */
  | { kind: "start_position"; nodeId: PlanNodeId; position: PatternPosition; turn?: CoordinatorPurpose }
  | { kind: "execute_invocation"; nodeId: PlanNodeId; invocationId: InvocationId; worktrees: number }
  /** An evaluator_optimizer round's deterministic Acceptance Criteria run now, outside every transaction, through the check port. */
  | { kind: "verify_node"; nodeId: PlanNodeId; round: number }
  /** A node whose candidate is complete and integrated opens its next `node_exit` Gate (execution-model §10). */
  | { kind: "open_node_gate"; nodeId: PlanNodeId }
  /** The open Gate's deterministic Acceptance Criteria run now, outside every transaction, through the check port. */
  | { kind: "run_gate_checks"; nodeId: PlanNodeId; gateId: GateId }
  /** The open Gate's one read-only Evaluator Invocation is prepared. */
  | { kind: "prepare_gate_evaluator"; nodeId: PlanNodeId; gateId: GateId }
  /** The Gate's rows imply a consequence: verdicts recorded, the Gate closed, the node settled or failed, or its remediation Task created. */
  | { kind: "settle_node_gate"; nodeId: PlanNodeId; gateId: GateId }
  | { kind: "settle_node"; nodeId: PlanNodeId; invocationId: InvocationId | null }
  /** A `ready` join executes deterministically: policy, index Artifact, terminal transition, edge Handoffs — in one transaction. */
  | { kind: "settle_join"; nodeId: PlanNodeId }
  | { kind: "settle_removed_node"; nodeId: PlanNodeId; invocationId: InvocationId | null }
  | { kind: "resume_node"; nodeId: PlanNodeId; reason: PlanNodeWaitReason }
  | { kind: "wait_node"; nodeId: PlanNodeId; reason: "provider_capacity"; wakeAt: Timestamp | null }
  | { kind: "settle_root"; invocationId: InvocationId }
  /** No current work can proceed and no Attempt is running: the Run records the reason. */
  | { kind: "wait_run"; reason: RunWaitReason };

export type SchedulerStopReason = "quiescent" | "waiting" | "action_limit" | "run_terminal" | "unsupported" | "infrastructure_failure";

export interface WaitingCondition {
  nodeId: PlanNodeId;
  reason: PlanNodeWaitReason;
  wakeAt: Timestamp | null;
}

export interface DeferredWork {
  nodeId: PlanNodeId;
  reason: "awaiting_allocation_extension_phase";
  pattern: Pattern | null;
}

/** A node whose failed `node_exit` Gate is being remediated by its owner (the root Orchestrator); no action of its own. */
export interface RemediatingNode {
  nodeId: PlanNodeId;
  gateId: GateId;
  taskId: TaskId;
}

export interface NodeProjection {
  nodeId: PlanNodeId;
  pattern: Pattern | null;
  status: PlanNode["status"];
  readiness: ReadinessDecision | null;
  advice: NodeAdvice | RootAdvice | null;
  current: boolean;
}

export interface SchedulerProjection {
  runId: RunId;
  revisionNumber: number;
  run: { status: RunStatus; waitReason: RunWaitReason | null };
  nodes: NodeProjection[];
  /** The canonical actions, in scheduling order; the first is what a pass performs next. */
  actions: SchedulerAction[];
  waiting: WaitingCondition[];
  deferred: DeferredWork[];
  /** Nodes whose failed Gate awaits its owner's remediation. */
  remediating: RemediatingNode[];
  /** Ready nodes (or further positions) not started this pass because the Run's `maxConcurrency` is reached; they start as active Invocations end. */
  limited: PlanNodeId[];
  /** Invocations whose Attempt is executing in this process. */
  inFlight: InvocationId[];
  /** The earliest known time at which projection may change without an Attempt ending. */
  wakeAt: Timestamp | null;
  concurrency: { active: number; max: number | null };
  /** What a pass stops with once no action remains. */
  stop: Exclude<SchedulerStopReason, "action_limit" | "infrastructure_failure">;
}

export interface PerformedAction {
  action: SchedulerAction;
  outcome: PatternRunnerOutcome | RootOutcome | JoinOutcome | { kind: "prepared"; attemptId: AttemptId } | { kind: "capacity_refused" } | { kind: "not_permitted"; reason: string } | { kind: "transitioned" } | { kind: "stale" } | { kind: "no_change" };
}

export interface SchedulerOutcome {
  runId: RunId;
  stop: SchedulerStopReason;
  actions: PerformedAction[];
  /** Attempts executed to completion during the pass, in completion order. */
  executed: AttemptId[];
  waiting: WaitingCondition[];
  deferred: DeferredWork[];
  remediating: RemediatingNode[];
  wakeAt: Timestamp | null;
  failure: { message: string } | null;
}

export interface SchedulerConfig {
  /** The default bound on actions per pass. */
  maxActions: number;
}

export const DEFAULT_SCHEDULER_CONFIG: Readonly<SchedulerConfig> = Object.freeze({ maxActions: 64 });

const RUN_WAIT_REASONS_BY_NODE: Readonly<Record<PlanNodeWaitReason, RunWaitReason>> = {
  decision: "decision",
  budget: "budget",
  provider_capacity: "provider_capacity",
  integration_conflict: "integration_conflict",
  operator: "operator",
};

function earliest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export class RunScheduler {
  readonly #passes = new Map<RunId, Promise<SchedulerOutcome>>();
  private readonly joins: JoinNodeSettler;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly executor: AttemptExecutor,
    private readonly governor: ResourceGovernor,
    private readonly runners: PatternRunners,
    private readonly provider: { readonly provider: string },
    private readonly config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  ) {
    this.joins = new JoinNodeSettler(ctx, stores);
  }

  // ---------------------------------------------------------------------------
  // Projection
  // ---------------------------------------------------------------------------

  /** The next canonical actions and every wait, from rows alone; writes nothing. */
  reconcileRun(runId: RunId, now: Timestamp = this.ctx.clock()): SchedulerProjection {
    const run = this.stores.runs.get(runId);
    const graph = this.stores.plans.currentGraph(runId);
    const base = { runId, revisionNumber: graph.revisionNumber, run: { status: run.status, waitReason: run.waitReason } };
    if (RUN_MACHINE.isTerminal(run.status)) return { ...base, nodes: [], actions: [], waiting: [], deferred: [], remediating: [], limited: [], inFlight: [], wakeAt: null, concurrency: { active: 0, max: run.budget.maxConcurrency }, stop: "run_terminal" };
    const readiness = new Map(evaluateReadiness(projectReadinessInput(this.stores, graph)).decisions.map((d) => [d.nodeId, d] as const));
    const nodes: NodeProjection[] = [];
    const actions: SchedulerAction[] = [];
    const waiting: WaitingCondition[] = [];
    const deferred: DeferredWork[] = [];
    const remediating: RemediatingNode[] = [];
    const limited: PlanNodeId[] = [];
    // Every Attempt of the Run executing in this process, from the executor's record, whatever its node advises.
    const inFlight = [...new Set(this.executor.inFlight().map((a) => this.stores.invocations.getAttempt(a)).filter((a) => a.runId === runId).map((a) => a.invocationId))].sort();
    let wakeAt: Timestamp | null = null;
    let active = this.stores.invocations.listActive(runId).length;
    const max = run.budget.maxConcurrency;
    const withinNodeLimit = (node: PlanNode) => node.maxConcurrency === null || this.stores.invocations.listByPlanNode(node.id).filter((i) => !["blocked", "succeeded", "failed", "cancelled"].includes(i.status)).length < node.maxConcurrency;

    // The root Orchestrator node: its existing turns execute and settle; it is never started or completed here.
    const root = graph.nodes.find((n) => n.sourcePath === ROOT_SOURCE_PATH)!;
    const rootAdvice = this.runners.root.inspect(runId, now);
    nodes.push({ nodeId: root.id, pattern: "single", status: root.status, readiness: readiness.get(root.id) ?? null, advice: rootAdvice, current: true });
    switch (rootAdvice.kind) {
      case "execute": {
        const refusal = this.capacityRefusal(runId, rootAdvice.invocationId);
        if (refusal === null) actions.push({ kind: "execute_invocation", nodeId: root.id, invocationId: rootAdvice.invocationId, worktrees: this.worktreesOf(rootAdvice.invocationId) });
        else {
          waiting.push({ nodeId: root.id, reason: "provider_capacity", wakeAt: refusal.retryAfter });
          wakeAt = earliest(wakeAt, refusal.retryAfter);
        }
        break;
      }
      case "attempt_in_flight":
        wakeAt = earliest(wakeAt, this.executor.inspectInvocation(rootAdvice.invocationId, now).deadlineAt);
        break;
      case "retry_not_before":
        wakeAt = earliest(wakeAt, rootAdvice.notBefore);
        break;
      case "settle":
        actions.push({ kind: "settle_root", invocationId: rootAdvice.invocationId });
        break;
      case "blocked":
        waiting.push({ nodeId: root.id, reason: "decision", wakeAt: null });
        break;
      case "idle":
      case "run_terminal":
        break;
    }

    // Every other current member, in scheduling order.
    for (const node of graph.nodes) {
      if (node.id === root.id) continue;
      const decision = readiness.get(node.id)!;
      const projection: NodeProjection = { nodeId: node.id, pattern: node.kind === "pattern" ? node.pattern : null, status: node.status, readiness: decision, advice: null, current: true };
      nodes.push(projection);
      switch (decision.kind) {
        case "become_ready":
          actions.push({ kind: "ready_node", nodeId: node.id });
          continue;
        case "become_skipped":
          actions.push({ kind: "skip_node", nodeId: node.id, cause: decision.cause, failed: decision.failed });
          continue;
        case "remain_pending":
        case "terminal":
          continue;
        case "ready":
        case "active":
          break;
      }
      if (node.kind === "join") {
        // A ready join executes deterministically now; it never runs, waits, or holds an Invocation.
        if (decision.kind === "ready") actions.push({ kind: "settle_join", nodeId: node.id });
        continue;
      }
      const advice = runnerFor(this.runners, node.pattern).inspect(node.id, now);
      projection.advice = advice;
      switch (advice.kind) {
        case "start":
        case "start_position":
          if (max !== null && active >= max) {
            limited.push(node.id);
            break;
          }
          if (!withinNodeLimit(node)) break;
          active += 1;
          actions.push(advice.kind === "start" ? { kind: "start_node", nodeId: node.id, pattern: node.pattern } : { kind: "start_position", nodeId: node.id, position: advice.position, ...(advice.turn === undefined ? {} : { turn: advice.turn }) });
          break;
        case "execute": {
          const refusal = this.capacityRefusal(runId, advice.invocationId);
          if (refusal === null) actions.push({ kind: "execute_invocation", nodeId: node.id, invocationId: advice.invocationId, worktrees: this.worktreesOf(advice.invocationId) });
          else {
            actions.push({ kind: "wait_node", nodeId: node.id, reason: "provider_capacity", wakeAt: refusal.retryAfter });
            wakeAt = earliest(wakeAt, refusal.retryAfter);
          }
          break;
        }
        case "attempt_in_flight":
          wakeAt = earliest(wakeAt, this.executor.inspectInvocation(advice.invocationId, now).deadlineAt);
          break;
        case "retry_not_before":
          wakeAt = earliest(wakeAt, advice.notBefore);
          break;
        case "settle":
          actions.push({ kind: "settle_node", nodeId: node.id, invocationId: advice.invocationId });
          break;
        case "verify":
          actions.push({ kind: "verify_node", nodeId: node.id, round: advice.round });
          break;
        case "open_gate":
          actions.push({ kind: "open_node_gate", nodeId: node.id });
          break;
        case "verify_gate":
          actions.push({ kind: "run_gate_checks", nodeId: node.id, gateId: advice.gateId });
          break;
        case "prepare_gate_evaluator":
          if (max !== null && active >= max) {
            limited.push(node.id);
            break;
          }
          if (!withinNodeLimit(node)) break;
          active += 1;
          actions.push({ kind: "prepare_gate_evaluator", nodeId: node.id, gateId: advice.gateId });
          break;
        case "settle_gate":
          actions.push({ kind: "settle_node_gate", nodeId: node.id, gateId: advice.gateId });
          break;
        case "awaiting_remediation":
          remediating.push({ nodeId: node.id, gateId: advice.gateId, taskId: advice.taskId });
          break;
        case "waiting":
          if (advice.cleared) actions.push({ kind: "resume_node", nodeId: node.id, reason: advice.reason });
          else {
            waiting.push({ nodeId: node.id, reason: advice.reason, wakeAt: advice.wakeAt });
            wakeAt = earliest(wakeAt, advice.wakeAt);
          }
          break;
        case "awaiting_allocation_extension_phase":
          deferred.push({ nodeId: node.id, reason: advice.kind, pattern: node.pattern });
          break;
        case "terminal":
        case "not_current":
          break;
      }
    }

    // Nodes that left the current membership may finish their own started work; they never start or activate anything.
    const members = new Set(graph.nodes.map((n) => n.id));
    for (const node of this.stores.plans.listNodes(runId)) {
      if (members.has(node.id) || node.kind !== "pattern" || PLAN_NODE_MACHINE.isTerminal(node.status) || node.sourcePath === ROOT_SOURCE_PATH) continue;
      const advice = runnerFor(this.runners, node.pattern).inspect(node.id, now);
      nodes.push({ nodeId: node.id, pattern: node.pattern, status: node.status, readiness: null, advice, current: false });
      if (advice.kind === "not_current" && advice.settle) actions.push({ kind: "settle_removed_node", nodeId: node.id, invocationId: advice.invocationId });
    }
    for (const invocationId of inFlight) wakeAt = earliest(wakeAt, this.executor.inspectInvocation(invocationId, now).deadlineAt);

    // Run-level: resume before any other action; wait only when nothing can proceed and nothing is running.
    if (run.status === "waiting" && actions.length > 0) actions.unshift({ kind: "resume_run", reason: run.waitReason! });
    if (actions.length === 0 && run.status === "running" && waiting.length > 0 && inFlight.length === 0 && limited.length === 0) {
      actions.push({ kind: "wait_run", reason: RUN_WAIT_REASONS_BY_NODE[waiting[0]!.reason] });
    }
    const stop: SchedulerProjection["stop"] = waiting.length > 0 || inFlight.length > 0 || limited.length > 0 || wakeAt !== null ? "waiting" : deferred.length > 0 ? "unsupported" : "quiescent";
    return { ...base, nodes, actions, waiting, deferred, remediating, limited, inFlight, wakeAt, concurrency: { active, max }, stop };
  }

  private capacityRefusal(runId: RunId, invocationId: InvocationId) {
    return this.governor.check({ runId, provider: this.provider.provider, worktrees: this.worktreesOf(invocationId) });
  }

  private worktreesOf(invocationId: InvocationId): number {
    return grantsWriteCapability(this.stores.invocations.getManifest(invocationId).content) ? 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Advancement
  // ---------------------------------------------------------------------------

  /** Whether a pass for the Run is executing in this process. */
  isAdvancing(runId: RunId): boolean {
    return this.#passes.has(runId);
  }

  /**
   * Performs the Run's canonical actions until it is quiescent, waiting,
   * terminal, at `maxActions`, left with only later-phase work, or stopped
   * by an infrastructure failure. A concurrent call for the same Run joins
   * the pass in progress and receives its outcome.
   */
  advanceRun(runId: RunId, options: { maxActions?: number; correlationId?: string | null } = {}): Promise<SchedulerOutcome> {
    const existing = this.#passes.get(runId);
    if (existing) return existing;
    const pass = this.#pass(runId, options.maxActions ?? this.config.maxActions, { correlationId: options.correlationId ?? null }).finally(() => {
      this.#passes.delete(runId);
    });
    this.#passes.set(runId, pass);
    return pass;
  }

  async #pass(runId: RunId, maxActions: number, meta: WriteOptions): Promise<SchedulerOutcome> {
    const actions: PerformedAction[] = [];
    const executed: AttemptId[] = [];
    const batch = new Map<AttemptId, Promise<ExecutionOutcome>>();
    const failureOf = (reason: unknown) => ({ message: boundedFailureMessage(reason instanceof Error ? reason.message : String(reason)) });
    /** Awaits every executing Attempt (when the pass ends). */
    const settle = async (): Promise<{ message: string } | null> => {
      const results = await Promise.allSettled(batch.values());
      batch.clear();
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      return rejected ? failureOf(rejected.reason) : null;
    };
    /** Awaits the first executing Attempt to end: its completion is what re-triggers projection while the others keep running. */
    const settleFirst = async (): Promise<{ message: string } | null> => {
      const ended = await Promise.race([...batch.entries()].map(([attemptId, promise]) => promise.then(() => attemptId, () => attemptId)));
      const promise = batch.get(ended)!;
      batch.delete(ended);
      try {
        await promise;
        return null;
      } catch (error) {
        return failureOf(error);
      }
    };
    const finish = async (stop: SchedulerStopReason, failure: { message: string } | null = null): Promise<SchedulerOutcome> => {
      const batchFailure = await settle();
      let finalFailure = failure ?? batchFailure;
      let projection: SchedulerProjection | null = null;
      try {
        projection = this.reconcileRun(runId);
      } catch (error) {
        // A projection that cannot be computed (a missing or contradictory condition fact) is an infrastructure failure, never a guess.
        finalFailure = finalFailure ?? failureOf(error);
      }
      return { runId, stop: finalFailure !== null ? "infrastructure_failure" : stop, actions, executed, waiting: projection?.waiting ?? [], deferred: projection?.deferred ?? [], remediating: projection?.remediating ?? [], wakeAt: projection?.wakeAt ?? null, failure: finalFailure };
    };
    for (;;) {
      this.executor.enforceDeadlines(this.ctx.clock());
      let projection: SchedulerProjection;
      try {
        projection = this.reconcileRun(runId);
      } catch (error) {
        return finish("infrastructure_failure", failureOf(error));
      }
      if (projection.stop === "run_terminal") return finish("run_terminal");
      const action = projection.actions[0];
      if (action === undefined) {
        if (batch.size > 0) {
          const failure = await settleFirst();
          if (failure !== null) return finish("infrastructure_failure", failure);
          continue;
        }
        return finish(projection.stop);
      }
      if (actions.length >= maxActions) return finish("action_limit");
      try {
        const outcome = await this.#perform(runId, projection, action, batch, executed, meta);
        actions.push({ action, outcome });
      } catch (error) {
        return finish("infrastructure_failure", { message: boundedFailureMessage(error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  async #perform(runId: RunId, projection: SchedulerProjection, action: SchedulerAction, batch: Map<AttemptId, Promise<ExecutionOutcome>>, executed: AttemptId[], meta: WriteOptions): Promise<PerformedAction["outcome"]> {
    const revision = projection.revisionNumber;
    switch (action.kind) {
      case "resume_run":
        this.stores.runs.transition(runId, { to: "running", clearedWaitReason: action.reason }, meta);
        return { kind: "transitioned" };
      case "wait_run":
        return this.ctx.tx.write(() => {
          const run = this.stores.runs.get(runId);
          if (run.status !== "running") return { kind: "no_change" };
          // Revalidated inside the transaction: nothing may have become runnable meanwhile.
          const again = this.reconcileRun(runId);
          if (again.revisionNumber !== revision || again.actions.some((a) => a.kind !== "wait_run") || again.inFlight.length > 0) return { kind: "stale" };
          this.stores.runs.transition(runId, { to: "waiting", waitReason: action.reason }, meta);
          return { kind: "transitioned" };
        });
      case "ready_node":
      case "skip_node":
        return this.ctx.tx.write(() => this.#applyReadiness(runId, revision, action, meta));
      case "start_node":
        return runnerFor(this.runners, action.pattern).start(action.nodeId, revision, meta);
      case "start_position":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).startPosition(action.nodeId, revision, action.position, meta);
      case "verify_node":
        // Deterministic checks are external like a Changeset application: outside every transaction, recorded afterwards.
        return this.runners.evaluatorOptimizer.verify(action.nodeId, revision, meta);
      case "open_node_gate":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).openGate(action.nodeId, revision, meta);
      case "run_gate_checks":
        // Gate checks are external like an optimizer round's: outside every transaction, recorded afterwards.
        return runnerFor(this.runners, this.patternOf(action.nodeId)).verifyGate(action.nodeId, revision, meta);
      case "prepare_gate_evaluator":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).prepareGateEvaluator(action.nodeId, revision, meta);
      case "settle_node_gate":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).settleGate(action.nodeId, revision, meta);
      case "settle_node":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).settle(action.nodeId, revision, meta);
      case "settle_join":
        return this.joins.settle(action.nodeId, revision, meta);
      case "settle_removed_node":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).settleRemoved(action.nodeId, meta);
      case "resume_node":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).resume(action.nodeId, revision, meta);
      case "wait_node":
        return runnerFor(this.runners, this.patternOf(action.nodeId)).markWaiting(action.nodeId, revision, action.reason, meta);
      case "settle_root":
        return this.runners.root.settle(runId, meta);
      case "execute_invocation": {
        const prepared = await this.executor.prepareNextAttempt(action.invocationId, meta);
        if (prepared.kind === "prepared") {
          // The provider call runs outside every transaction; its completion re-triggers projection when the batch settles.
          batch.set(prepared.attempt.id, this.executor.executePreparedAttempt(prepared.attempt.id, meta).then((outcome) => (executed.push(outcome.attempt.id), outcome)));
          return { kind: "prepared", attemptId: prepared.attempt.id };
        }
        if (prepared.kind === "capacity_refused") {
          if (action.nodeId !== this.stores.plans.rootNode(runId).id) runnerFor(this.runners, this.patternOf(action.nodeId)).markWaiting(action.nodeId, revision, "provider_capacity", meta);
          return { kind: "capacity_refused" };
        }
        return { kind: "not_permitted", reason: prepared.reason };
      }
    }
  }

  /** Applies one readiness decision after re-deciding it inside the transaction against the current graph and facts. */
  #applyReadiness(runId: RunId, revision: number, action: Extract<SchedulerAction, { kind: "ready_node" | "skip_node" }>, meta: WriteOptions): PerformedAction["outcome"] {
    const graph = this.stores.plans.currentGraph(runId);
    if (graph.revisionNumber !== revision || !graph.nodes.some((n) => n.id === action.nodeId)) return { kind: "stale" };
    const decision = decideReadiness(projectReadinessInput(this.stores, graph), action.nodeId);
    if (action.kind === "ready_node" && decision.kind === "become_ready") {
      this.stores.plans.transitionNode(action.nodeId, { to: "ready" }, meta);
      return { kind: "transitioned" };
    }
    if (action.kind === "skip_node" && decision.kind === "become_skipped") {
      this.stores.plans.transitionNode(action.nodeId, { to: "skipped" }, meta);
      return { kind: "transitioned" };
    }
    return { kind: "stale" };
  }

  private patternOf(nodeId: PlanNodeId): Pattern {
    const node = this.stores.plans.getNode(nodeId);
    if (node.kind !== "pattern") throw new Error(`PlanNode ${nodeId} is a join node`);
    return node.pattern;
  }
}
