/**
 * The root Orchestrator node under the scheduler (execution-model §3, §4.6,
 * §10). The root is a `single` node held by the `orchestrator` role, but no
 * Pattern runner completes it: it stays `running` for the life of the Run
 * and its Invocations are logical turns. The scheduler executes the root's
 * existing Invocations through the executor (consuming capacity like any
 * other), integrates an Orchestrator turn's Changeset once it completes
 * (the Orchestrator may work directly), continues a turn blocked on an
 * approval once the Decision resolves, and fails the Run when the root
 * Invocation fails after its permitted Attempts (§3 `failed`).
 *
 * The root also owns the remediation of every failed `node_exit` Gate of a
 * node whose Pattern has no Coordinator (`single`, `chain`, `route`,
 * `parallel`): once nothing else can proceed, every pending remediation
 * Task of the Run is batched into one `gate_result` turn that continues the
 * previous turn, carries one typed `gate_result` input per Gate (the Gate's
 * canonical facts; the judged and command-output Artifacts readable by id),
 * and is funded from the root node's ordinary allocation. A completed turn
 * marks every Task it was given addressed (after its own Changeset is
 * integrated) and the gated nodes open their next Gate cycle; a turn that
 * fails, or ends without completing, ends those Tasks instead — the affected
 * nodes fail with `gate_remediation_failed` and the Run stays alive. No
 * turn is created from routine progress; the Orchestrator input queue is a
 * later phase.
 *
 * Every root turn is funded through the one Plan Node capacity operation
 * (execution-model §7.6): the root's `extend` policy creates exactly the
 * Allocation Extension the Run's effective ordinary capacity admits, in the
 * transaction that prepares the turn; when none fits, nothing is written and
 * the Run waits with reason `budget` until an ordinary Budget Increase is
 * approved and the next scheduler pass resumes it.
 */
import {
  InvariantViolationError,
  INVOCATION_MACHINE,
  operationAt,
  PLAN_NODE_MACHINE,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  type Allocation,
  type Decision,
  type DecisionId,
  type Evidence,
  type Gate,
  type Invocation,
  type InvocationId,
  type InvocationPurpose,
  type ManifestInput,
  type PatternPlanNode,
  type RunId,
  type Task,
  type TaskId,
  type Timestamp,
  approvalSubjectOf,
  decisionResolutionInputOf,
  isAgentRequestedDecision,
} from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import type { RunCompletionEngine } from "../completion.ts";
import { NodeExitGates } from "../gates.ts";
import { blockingDecisionOf, outstandingChangesetOf, PatternNodeSupport, type PatternRunnerDependencies } from "./support.ts";

export type RootAdvice =
  /** No turn exists, or the latest turn is fully settled. */
  | { kind: "idle"; invocationId: InvocationId | null }
  | { kind: "execute"; invocationId: InvocationId }
  | { kind: "attempt_in_flight"; invocationId: InvocationId }
  | { kind: "retry_not_before"; invocationId: InvocationId; notBefore: Timestamp }
  /** The latest turn is terminal and its consequences are not yet applied; `funded` says the root can fund the successor turn a resolved blocker implies (always true when none is implied). */
  | { kind: "settle"; invocationId: InvocationId; funded: boolean }
  /** The latest turn is a `gate_result` turn whose consequences (its Changeset, its remediation Tasks) are not yet applied; `funded` as for `settle`. */
  | { kind: "settle_remediation"; invocationId: InvocationId; funded: boolean }
  /** The latest turn is blocked on an open Decision: the `side_effect_approval` of its intercepted call, or the Decision it requested. */
  | { kind: "blocked"; invocationId: InvocationId; decisionId: DecisionId }
  /** The root is idle and these remediation Tasks of failed node_exit Gates await one batched `gate_result` turn; `funded` says the root can fund it now — directly or through the Allocation Extension its `extend` policy admits. */
  | { kind: "remediate"; taskIds: TaskId[]; funded: boolean }
  | { kind: "run_terminal" };

export type RootOutcome =
  | { kind: "integrated"; changesetId: string }
  | { kind: "run_failed" }
  | { kind: "successor_prepared"; invocationId: InvocationId; decisionId: DecisionId }
  /** One `gate_result` turn was prepared for these remediation Tasks, now `running` under it. */
  | { kind: "remediation_prepared"; invocationId: InvocationId; taskIds: TaskId[] }
  /** The `gate_result` turn's Tasks ended: addressed (`completed`) after a completed turn, or ended (`failed`/`cancelled`) after a turn that did not complete. */
  | { kind: "remediation_settled"; invocationId: InvocationId; completed: TaskId[]; ended: TaskId[] }
  /** The root's effective allocation cannot fund the turn and no Allocation Extension fits the Run's effective ordinary capacity: nothing was written; the Run waits with reason `budget` until a Budget Increase is approved. */
  | { kind: "unfunded" }
  | { kind: "no_change" };

/** A pending remediation the root owns: the failed Gate, its Task, and the gated node. */
interface RootRemediation {
  gate: Gate;
  task: Task;
  node: PatternPlanNode;
}

export class RootNodeSupport {
  private readonly gates: NodeExitGates;

  constructor(
    private readonly deps: PatternRunnerDependencies,
    /** The completion engine's remediation facts: failed run_completion Gates the root remediates beside failed node Gates. */
    private readonly completion: RunCompletionEngine,
  ) {
    // The Gate engine's remediation facts read rows only; the root never loads a gated node through this support.
    this.gates = new NodeExitGates(new PatternNodeSupport(deps, "single"));
  }

  rootOf(runId: RunId): PatternPlanNode {
    const root = this.deps.stores.plans.rootNode(runId);
    if (root.kind !== "pattern" || root.sourcePath !== ROOT_SOURCE_PATH) throw new Error(`Run ${runId} has no root Orchestrator node`);
    return root;
  }

  /** The latest Orchestrator turn from the persisted `orchestrator` position. */
  latestTurn(runId: RunId): Invocation | null {
    return this.deps.stores.invocations.latestAtPosition(this.rootOf(runId).id, "orchestrator");
  }

  inspect(runId: RunId, now: Timestamp = this.deps.ctx.clock()): RootAdvice {
    const { stores, executor } = this.deps;
    const run = stores.runs.get(runId);
    if (RUN_MACHINE.isTerminal(run.status)) return { kind: "run_terminal" };
    const latest = this.latestTurn(runId);
    if (latest === null) return this.idle(runId, null);
    if (!INVOCATION_MACHINE.isTerminal(latest.status)) {
      const inspection = executor.inspectInvocation(latest.id, now);
      if (inspection.next.permitted) return { kind: "execute", invocationId: latest.id };
      if (inspection.next.reason === "attempt_active") return { kind: "attempt_in_flight", invocationId: latest.id };
      if (inspection.next.reason === "retry_not_yet") return { kind: "retry_not_before", invocationId: latest.id, notBefore: inspection.next.notBefore! };
      return { kind: "execute", invocationId: latest.id };
    }
    // A final_synthesis turn belongs to the completion engine (execution-model §10): its execution, blocking, and settlement are the
    // engine's, and its failure fails the Completion Request, never the Run.
    if (latest.purpose === "final_synthesis") return this.idle(runId, latest.id);
    if (latest.status === "blocked") {
      const decision = blockingDecisionOf(stores, latest)!;
      // A resolved blocker implies a successor turn, which the root must be able to fund (directly or through an Allocation Extension).
      return decision.status === "open" ? { kind: "blocked", invocationId: latest.id, decisionId: decision.id } : this.settleAdvice(latest, decision.status === "resolved" || isAgentRequestedDecision(decision) ? this.funded(runId) : true);
    }
    if (latest.purpose === "gate_result") {
      // A gate_result turn ends its Tasks, never the Run: unsettled Tasks or an outstanding Changeset are its settlement.
      if (this.unsettledTasksOf(latest).length > 0 || (latest.status === "succeeded" && outstandingChangesetOf(stores, latest) !== null)) return { kind: "settle_remediation", invocationId: latest.id, funded: true };
      return this.idle(runId, latest.id);
    }
    if (latest.status === "failed") return this.rootOf(runId).status === "failed" ? { kind: "idle", invocationId: latest.id } : { kind: "settle", invocationId: latest.id, funded: true };
    if (latest.status === "succeeded" && outstandingChangesetOf(stores, latest) !== null) return { kind: "settle", invocationId: latest.id, funded: true };
    return this.idle(runId, latest.id);
  }

  private settleAdvice(turn: Invocation, funded: boolean): RootAdvice {
    return turn.purpose === "gate_result" ? { kind: "settle_remediation", invocationId: turn.id, funded } : { kind: "settle", invocationId: turn.id, funded };
  }

  /** An idle root with pending root-owned remediations advises one batched `gate_result` turn. */
  private idle(runId: RunId, invocationId: InvocationId | null): RootAdvice {
    const pending = this.pendingRemediations(runId);
    if (pending.length === 0 || this.rootOf(runId).status !== "running") return { kind: "idle", invocationId };
    return { kind: "remediate", taskIds: pending.map((r) => r.task.id), funded: this.funded(runId) };
  }

  // ---------------------------------------------------------------------------
  // Remediation facts (rows only)
  // ---------------------------------------------------------------------------

  /**
   * Every remediation Task the root owns and no turn has ended: the Task of
   * the latest, failed `node_exit` Gate of a running current node whose
   * Pattern has no Coordinator, and the Task of every failed
   * `run_completion` Gate (execution-model §10), in Task creation order, so
   * both kinds coalesce into one `gate_result` turn. A Task assigned to an
   * active turn is not pending.
   */
  pendingRemediations(runId: RunId): RootRemediation[] {
    const { stores } = this.deps;
    const members = new Set(stores.plans.currentGraph(runId).nodes.map((n) => n.id));
    const completion = new Map(this.completion.pendingRemediations(runId).map((r) => [r.task.id, r] as const));
    const pending: RootRemediation[] = [];
    for (const task of stores.tasks.listRemediationTasks(runId)) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "running") continue;
      const node = stores.plans.getNode(task.planNodeId!);
      if (node.kind !== "pattern") continue;
      const runGate = completion.get(task.id);
      if (runGate !== undefined) {
        pending.push({ gate: runGate.gate, task: runGate.task, node });
        continue;
      }
      if (node.pattern === "coordinator_worker" || node.status !== "running" || !members.has(node.id)) continue;
      const remediation = this.gates.pendingRemediationOf(node);
      if (remediation === null || remediation.task.id !== task.id) continue;
      pending.push({ gate: remediation.gate, task: remediation.task, node });
    }
    return pending;
  }

  /** The remediation Tasks a `gate_result` turn was given, from its manifest's typed inputs (never from process memory). */
  tasksOfTurn(turn: Invocation): Task[] {
    const { stores } = this.deps;
    const ids = stores.invocations.getManifest(turn.id).content.inputs.flatMap((i) => (i.kind === "gate_result" && i.remediationTaskId !== null ? [i.remediationTaskId] : []));
    return [...new Set(ids)].sort().map((id) => stores.tasks.get(id));
  }

  private unsettledTasksOf(turn: Invocation): Task[] {
    return this.tasksOfTurn(turn).filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled");
  }

  /** The allocation one Orchestrator turn needs: the root operation's Agent Definition default. */
  private turnAllocation(root: PatternPlanNode): Allocation {
    const operation = operationAt(root.shape, { kind: "orchestrator" });
    if (operation === null) throw new InvariantViolationError(`root PlanNode ${root.id} has no orchestrator position`, { planNodeId: root.id });
    return this.deps.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
  }

  /** Whether the root can fund one more Orchestrator turn now: from its effective allocation, or through the Allocation Extension its `extend` policy admits (read-only). */
  private funded(runId: RunId): boolean {
    const root = this.rootOf(runId);
    return this.deps.capacity.admits(root, this.turnAllocation(root)).fits;
  }

  /** Inside the transaction: funds one root turn through the one capacity operation; `null` when the root cannot fund it now. */
  private fund(root: PatternPlanNode, trigger: "root_turn" | "gate_remediation", options: WriteOptions): RootOutcome | null {
    const funded = this.deps.capacity.ensure(root, this.turnAllocation(root), trigger, options);
    if (funded.kind === "ineligible") throw new InvariantViolationError(`root PlanNode ${root.id} cannot fund a turn: ${funded.reason.kind}`, { planNodeId: root.id, reason: funded.reason });
    return funded.kind === "funded" ? null : { kind: "unfunded" };
  }

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  /** Applies the consequences of the latest terminal turn; repeated calls apply nothing twice. */
  async settle(runId: RunId, options: WriteOptions = {}): Promise<RootOutcome> {
    const { ctx, stores, integration, preparation } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("the root settles outside any transaction; integration is external");
    const latest = this.latestTurn(runId);
    if (latest === null || !INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
    if (latest.status === "succeeded") {
      const changeset = outstandingChangesetOf(stores, latest);
      if (changeset !== null) {
        const outcome = await integration.integrate(changeset.id, options);
        // The Orchestrator's own conflict is recorded as its conflict Task; the root never waits, and the later
        // Orchestrator input phase acts on it.
        return outcome.kind === "integrated" || outcome.kind === "already_integrated" ? { kind: "integrated", changesetId: changeset.id } : { kind: "no_change" };
      }
      if (latest.purpose !== "gate_result") return { kind: "no_change" };
    }
    return ctx.tx.write((): RootOutcome => {
      const root = this.rootOf(runId);
      const run = stores.runs.get(runId);
      const turn = stores.invocations.get(latest.id);
      if (RUN_MACHINE.isTerminal(run.status)) return { kind: "no_change" };
      if (turn.purpose === "gate_result") return this.settleRemediationTurn(run.id, turn, options);
      if (turn.status === "failed") {
        if (root.status === "failed") return { kind: "no_change" };
        // A failed requesting turn cancels its Completion Request before the Run fails (execution-model §10).
        this.completion.cancelEndedRequest(run.id, options);
        if (root.status === "waiting") stores.plans.transitionNode(root.id, { to: "running" }, options);
        stores.plans.transitionNode(root.id, { to: "failed", reason: "invocation_failed" }, options);
        stores.runs.transition(run.id, { to: "failed", failure: { kind: "root_node_failed", summary: `Orchestrator Invocation ${turn.id} failed: ${turn.failureReason ?? "unknown"}`, evidenceArtifactIds: [] } }, options);
        return { kind: "run_failed" };
      }
      if (turn.status === "blocked") {
        const decision = blockingDecisionOf(stores, turn)!;
        const successor = this.successorInputs(turn, decision);
        if (successor === null) return { kind: "no_change" };
        if (stores.invocations.latestAtPosition(root.id, "orchestrator")?.id !== turn.id) return { kind: "no_change" };
        const unfunded = this.fund(root, "root_turn", options);
        if (unfunded !== null) return unfunded;
        const prepared = preparation.prepare({
          runId,
          planNodeId: root.id,
          role: "orchestrator",
          purpose: successor.purpose,
          patternPosition: { kind: "orchestrator" },
          continuedFromInvocationId: turn.id,
          handoffIds: stores.invocations.getManifest(turn.id).content.handoffs.map((h) => h.handoffId),
          inputs: successor.inputs,
          correlationId: options.correlationId ?? null,
          causationSeq: options.causationSeq ?? null,
        });
        return { kind: "successor_prepared", invocationId: prepared.invocation.id, decisionId: decision.id };
      }
      return { kind: "no_change" };
    });
  }

  /**
   * The purpose and typed inputs of the successor a blocked turn's ended
   * Decision implies, or `null` while nothing continues: an approval of the
   * turn's intercepted call continues a plain turn as the `decision_resolution`
   * turn (a `gate_result` turn as itself) with the approval resolution; a
   * Decision the turn requested continues the same logical turn — the same
   * purpose, its turn-defining inputs — with exactly one typed
   * `decision_resolution` input, whether the Decision was resolved or
   * superseded (a stale waiver). No relay turn is ever inserted.
   */
  private successorInputs(turn: Invocation, decision: Decision): { purpose: InvocationPurpose; inputs: ManifestInput[] } | null {
    const previous = this.deps.stores.invocations.getManifest(turn.id).content.inputs;
    if (isAgentRequestedDecision(decision)) {
      if (decision.status === "open") return null;
      const carried = previous.filter((i) => i.kind !== "decision_resolution" && i.kind !== "side_effect_approval_resolution");
      return { purpose: turn.purpose, inputs: [...carried, decisionResolutionInputOf(decision)] };
    }
    if (decision.status !== "resolved" || decision.resolution === null || decision.subject === null) return null;
    const approval: ManifestInput = { kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: turn.id, attemptId: approvalSubjectOf(decision).attemptId, tool: approvalSubjectOf(decision).tool, callDigest: approvalSubjectOf(decision).callDigest, callArtifactId: approvalSubjectOf(decision).callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" };
    if (turn.purpose === "gate_result") return { purpose: "gate_result", inputs: [...previous.filter((i) => i.kind === "gate_result"), approval] };
    return { purpose: "decision_resolution", inputs: [approval] };
  }

  /** The settlement of a `gate_result` turn: its Changeset first (external, through `settle`), then its Tasks in one transaction. */
  settleRemediation(runId: RunId, options: WriteOptions = {}): Promise<RootOutcome> {
    return this.settle(runId, options);
  }

  /**
   * Inside the transaction: a completed turn marks every Task it was given
   * addressed (a Task the Orchestrator reported completed already is, with
   * its own Evidence; the rest with the integration Snapshot and the result
   * Artifacts produced for the Task); a turn blocked on a resolved approval
   * continues in a successor that carries the same `gate_result` inputs and
   * takes over the Tasks; any other ending ends the Tasks, and the gated
   * nodes fail through their Gate engine. The Run never fails here.
   */
  private settleRemediationTurn(runId: RunId, turn: Invocation, options: WriteOptions): RootOutcome {
    const { stores, preparation } = this.deps;
    const tasks = this.unsettledTasksOf(turn);
    if (tasks.length === 0) return { kind: "no_change" };
    if (turn.status === "blocked") {
      const decision = blockingDecisionOf(stores, turn)!;
      if (decision.status === "open") return { kind: "no_change" };
      const successor = this.successorInputs(turn, decision);
      if (successor === null) return this.endTasks(turn, tasks, options);
      if (this.latestTurn(runId)?.id !== turn.id) return { kind: "no_change" };
      const unfunded = this.fund(this.rootOf(runId), "gate_remediation", options);
      if (unfunded !== null) return unfunded;
      const prepared = preparation.prepare({
        runId,
        planNodeId: this.rootOf(runId).id,
        role: "orchestrator",
        purpose: successor.purpose,
        patternPosition: { kind: "orchestrator" },
        continuedFromInvocationId: turn.id,
        handoffIds: stores.invocations.getManifest(turn.id).content.handoffs.map((h) => h.handoffId),
        inputs: successor.inputs,
        correlationId: options.correlationId ?? null,
        causationSeq: options.causationSeq ?? null,
      });
      for (const task of tasks) this.gates.assignRemediation(task, prepared.invocation, options);
      return { kind: "successor_prepared", invocationId: prepared.invocation.id, decisionId: decision.id };
    }
    if (turn.status === "succeeded" && turn.result?.status === "completed") {
      const run = stores.runs.get(runId);
      const snapshotId = run.integrationSnapshotId ?? run.baseSnapshotId;
      const completed: TaskId[] = [];
      const ended: TaskId[] = [];
      for (const task of tasks) {
        // A Task the Orchestrator reported blocked was not addressed by this turn; it ends and its node fails.
        if (task.status === "blocked") {
          ended.push(this.gates.failRemediation(task, options).id);
          continue;
        }
        if (snapshotId === null) throw new InvariantViolationError(`Run ${run.id} has no integration Snapshot; a remediated Gate reopens on one`, { runId: run.id });
        const outputs = turn.result.artifactIds.filter((id) => stores.artifacts.get(id).taskId === task.id);
        const evidence: Evidence[] = [{ kind: "snapshot", snapshotId }];
        completed.push(this.gates.completeRemediation(task, turn, evidence, outputs, options).id);
      }
      return { kind: "remediation_settled", invocationId: turn.id, completed, ended };
    }
    return this.endTasks(turn, tasks, options);
  }

  /** The turn did not complete: every Task it was given ends (`failed` when it was running under the turn, `cancelled` otherwise). */
  private endTasks(turn: Invocation, tasks: Task[], options: WriteOptions): RootOutcome {
    const ended = tasks.map((t) => this.gates.failRemediation(t, options).id);
    return { kind: "remediation_settled", invocationId: turn.id, completed: [], ended };
  }

  // ---------------------------------------------------------------------------
  // Remediation turns
  // ---------------------------------------------------------------------------

  /**
   * In one root transaction: the Run is running, the root idle, and pending
   * root-owned remediations exist; one `gate_result` turn continues the
   * latest turn with one typed `gate_result` input per failed Gate, funded
   * from the root's ordinary allocation; every batched Task becomes
   * `running` under it. Repeating it prepares nothing twice.
   */
  prepareRemediation(runId: RunId, options: WriteOptions = {}): RootOutcome {
    const { ctx, stores, preparation } = this.deps;
    return ctx.tx.write((): RootOutcome => {
      const run = stores.runs.get(runId);
      if (RUN_MACHINE.isTerminal(run.status)) return { kind: "no_change" };
      const root = this.rootOf(runId);
      if (root.status !== "running" || PLAN_NODE_MACHINE.isTerminal(root.status)) return { kind: "no_change" };
      const advice = this.inspect(runId);
      if (advice.kind !== "remediate") return { kind: "no_change" };
      // The turn is funded through the one capacity operation in this transaction: the root's `extend` policy creates the exact Allocation
      // Extension the Run's ordinary capacity admits, or nothing is written and the Run waits on budget.
      const unfunded = this.fund(root, "gate_remediation", options);
      if (unfunded !== null) return unfunded;
      const pending = this.pendingRemediations(runId);
      const inputs: ManifestInput[] = pending.map((r) => this.gates.gateResultInput(r.gate));
      const latest = this.latestTurn(runId);
      const prepared = preparation.prepare({
        runId,
        planNodeId: root.id,
        role: "orchestrator",
        purpose: "gate_result",
        patternPosition: { kind: "orchestrator" },
        continuedFromInvocationId: latest?.id ?? null,
        funding: { source: "plan_node" },
        handoffIds: [],
        inputs,
        correlationId: options.correlationId ?? null,
        causationSeq: options.causationSeq ?? null,
      });
      const taskIds = pending.map((r) => this.gates.assignRemediation(r.task, prepared.invocation, options).id);
      return { kind: "remediation_prepared", invocationId: prepared.invocation.id, taskIds };
    });
  }
}
