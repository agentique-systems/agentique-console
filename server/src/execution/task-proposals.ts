/**
 * Coordinator Task proposals and cancellations (execution-model §5.5.1):
 * the executable handlers behind the `propose_tasks` and Coordinator
 * `update_task` runtime tools. The Coordinator proposes intent; the runtime
 * owns every Task fact it already knows — Run, Plan Node, origin, pinned
 * Requirement revision, Worker Agent Definition revision, role, purpose,
 * Pattern position, reservation parent, ids, timestamps — and validates the
 * complete batch against canonical rows before creating anything.
 *
 * Validation is read-only and atomic over the batch: the first failing rule
 * of any proposed Task rejects the whole batch with a stable code, and
 * nothing is written. On acceptance one root transaction (the caller's)
 * cancels the blocked Tasks the batch replaces, creates every Task, every
 * dependency (including the edges copied from replaced Tasks' dependents),
 * and every Task reservation for the Worker's default allocation, and
 * returns the stable mapping from proposal-local keys to Task ids. Every
 * accepted Task therefore already holds its Worker reservation; capacity is
 * never reserved lazily later.
 */
import {
  allocationFits,
  NotFoundError,
  TASK_MACHINE,
  ValidationError,
  type Allocation,
  type CoordinatorWorkerBounds,
  type Invocation,
  type PatternPlanNode,
  type RuntimeToolRejection,
  type RuntimeToolResult,
  type Task,
  type TaskId,
  type TaskProposalBatch,
  type TaskUpdateRequest,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

/** The Invocation a handler executes for; every fact comes from the Attempt being executed, never from the adapter. */
export interface RuntimeToolCaller {
  invocation: Invocation;
  node: PatternPlanNode;
}

export type HandlerOutcome = { kind: "applied"; result: RuntimeToolResult } | { kind: "rejected"; reasons: RuntimeToolRejection[] };

class Rejected extends Error {
  constructor(readonly reasons: RuntimeToolRejection[]) {
    super(reasons.map((r) => r.message).join("; "));
    this.name = "Rejected";
  }
}

function reject(code: RuntimeToolRejection["code"], message: string, path: string | null = null): never {
  throw new Rejected([{ code, message, path }]);
}

/** The coordinator_worker shape of a node, or a rejection. */
function shapeOf(node: PatternPlanNode): Extract<PatternPlanNode["shape"], { pattern: "coordinator_worker" }> {
  if (node.shape.pattern !== "coordinator_worker") throw new ValidationError(`PlanNode ${node.id} is a ${node.shape.pattern} node, not a coordinator_worker`);
  return node.shape;
}

/** A blocked or failed current Task of the node is replaceable; `superseded` maps already-replaced Tasks. */
function replaceable(task: Task): boolean {
  return task.status === "blocked" || task.status === "failed";
}

export class TaskProposalService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  /**
   * Validates the whole batch, then applies it inside the caller's
   * transaction. Rejections carry the failing rule; nothing is written for a
   * rejected batch (validation is read-only and precedes every write).
   */
  propose(caller: RuntimeToolCaller, batch: TaskProposalBatch, options: WriteOptions): HandlerOutcome {
    try {
      const plan = this.validateProposal(caller, batch);
      return { kind: "applied", result: this.applyProposal(caller, batch, plan, options) };
    } catch (error) {
      if (error instanceof Rejected) return { kind: "rejected", reasons: error.reasons };
      throw error;
    }
  }

  /** Cancels one of the node's `pending`, `ready`, or `blocked` current Tasks, releasing its Task reservation. */
  cancel(caller: RuntimeToolCaller, request: TaskUpdateRequest, options: WriteOptions): HandlerOutcome {
    try {
      const { node } = caller;
      let task: Task;
      try {
        task = this.stores.tasks.get(request.taskId);
      } catch (error) {
        if (error instanceof NotFoundError) reject("task_not_cancellable", `Task ${request.taskId} does not exist`, "taskId");
        throw error;
      }
      if (task.runId !== node.runId || task.planNodeId !== node.id) reject("task_not_cancellable", `Task ${task.id} does not belong to PlanNode ${node.id}`, "taskId");
      if (task.status !== "pending" && task.status !== "ready" && task.status !== "blocked") reject("task_not_cancellable", `Task ${task.id} is ${task.status}; only a pending, ready, or blocked Task can be cancelled`, "taskId");
      if (this.stores.tasks.replacementOf(task.id) !== null) reject("task_not_cancellable", `Task ${task.id} is superseded by a replacement`, "taskId");
      const cancelled = this.cancelTask(task, options);
      return { kind: "applied", result: { tool: "update_task", taskId: cancelled.id, status: cancelled.status } };
    } catch (error) {
      if (error instanceof Rejected) return { kind: "rejected", reasons: error.reasons };
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Validation (read-only)
  // ---------------------------------------------------------------------------

  private validateProposal(caller: RuntimeToolCaller, batch: TaskProposalBatch): ProposalPlan {
    const { node, invocation } = caller;
    const shape = shapeOf(node);
    const bounds: CoordinatorWorkerBounds = shape.bounds;
    // Rules 1–2: a running Coordinator Invocation of this exact node with a proposing purpose.
    if (invocation.role !== "coordinator" || invocation.planNodeId !== node.id || invocation.runId !== node.runId) reject("caller_not_running", `Invocation ${invocation.id} is not a Coordinator Invocation of PlanNode ${node.id}`);
    if (invocation.status !== "running") reject("caller_not_running", `Invocation ${invocation.id} is ${invocation.status}`);
    if (invocation.purpose !== "decompose" && invocation.purpose !== "replan") reject("purpose_not_permitted", `a ${invocation.purpose} turn cannot propose Tasks`);
    // Rule 14: the bounds themselves must hold.
    if (bounds.maxConcurrentWorkers > bounds.maxTasks) reject("invalid_bounds", `maxConcurrentWorkers ${bounds.maxConcurrentWorkers} exceeds maxTasks ${bounds.maxTasks}`);
    if (bounds.maxCoordinatorInvocations < 2) reject("invalid_bounds", `maxCoordinatorInvocations ${bounds.maxCoordinatorInvocations} cannot hold a decompose and a synthesize turn`);

    const existing = this.stores.tasks.listByPlanNode(node.id).filter((t) => t.origin === "coordinator");
    const existingById = new Map(existing.map((t) => [t.id, t] as const));
    const superseded = new Set(existing.flatMap((t) => (t.replacesTaskId !== null ? [t.replacesTaskId] : [])));
    const scope = node.scope;
    const keys = new Set<string>();
    const replacedInBatch = new Set<TaskId>();

    batch.tasks.forEach((proposal, index) => {
      const at = (field: string) => `tasks.${index}.${field}`;
      if (keys.has(proposal.key)) reject("duplicate_key", `proposal key ${proposal.key} appears twice in the batch`, at("key"));
      keys.add(proposal.key);
      // Rules 3–4: a non-empty subset of the exact pinned leaf scope, none retired.
      for (const requirementId of proposal.requirementIds) {
        if (scope === null || !this.stores.plans.isInScope(node.id, requirementId, scope.requirementRevisionId)) {
          reject("requirement_out_of_scope", `Requirement ${requirementId} is outside the pinned scope of PlanNode ${node.id}`, at("requirementIds"));
        }
        if (this.stores.requirements.get(requirementId).status === "retired") reject("requirement_retired", `Requirement ${requirementId} is retired`, at("requirementIds"));
      }
      // Rule 5: every input Artifact exists and belongs to the Run.
      for (const artifactId of proposal.inputArtifactIds) {
        let artifact;
        try {
          artifact = this.stores.artifacts.get(artifactId);
        } catch (error) {
          if (error instanceof NotFoundError) reject("unknown_artifact", `Artifact ${artifactId} does not exist`, at("inputArtifactIds"));
          throw error;
        }
        if (artifact.runId !== node.runId) reject("foreign_artifact", `Artifact ${artifactId} belongs to Run ${artifact.runId}`, at("inputArtifactIds"));
      }
      // Rule 6: dependencies within the batch or on current Tasks of this node.
      for (const key of proposal.dependsOnKeys) {
        if (key === proposal.key) reject("dependency_cycle", `Task ${proposal.key} depends on itself`, at("dependsOnKeys"));
        if (!batch.tasks.some((t) => t.key === key)) reject("unknown_dependency_key", `dependency key ${key} is not in the batch`, at("dependsOnKeys"));
      }
      for (const taskId of proposal.dependsOnTaskIds) {
        const dependency = existingById.get(taskId);
        if (!dependency) reject("foreign_dependency", `Task ${taskId} is not a Task of PlanNode ${node.id}`, at("dependsOnTaskIds"));
        if (superseded.has(taskId)) reject("foreign_dependency", `Task ${taskId} is superseded and no longer a current Task`, at("dependsOnTaskIds"));
      }
      // Rules 8–9: a replacement names a blocked or failed current Task of the node, once.
      if (proposal.replacesTaskId !== null) {
        const replaced = existingById.get(proposal.replacesTaskId);
        if (!replaced) reject("invalid_replacement", `Task ${proposal.replacesTaskId} is not a Task of PlanNode ${node.id}`, at("replacesTaskId"));
        if (superseded.has(replaced.id)) reject("invalid_replacement", `Task ${replaced.id} is already superseded`, at("replacesTaskId"));
        if (!replaceable(replaced)) reject("invalid_replacement", `Task ${replaced.id} is ${replaced.status}; only a blocked or failed Task can be replaced`, at("replacesTaskId"));
        if (replacedInBatch.has(replaced.id)) reject("invalid_replacement", `Task ${replaced.id} is replaced twice in the batch`, at("replacesTaskId"));
        replacedInBatch.add(replaced.id);
      }
    });

    // Rule 7: the resulting dependency graph — existing edges, batch edges, and the edges copied from replaced Tasks' dependents — is acyclic.
    const edges: [string, string][] = this.stores.tasks
      .dependencies(node.runId)
      .filter((d) => existingById.has(d.taskId) && existingById.has(d.dependsOnTaskId))
      .map((d) => [d.taskId, d.dependsOnTaskId]);
    const keyNode = (key: string) => `key:${key}`;
    const dependents = new Map<TaskId, TaskId[]>();
    for (const edge of edges) {
      const list = dependents.get(edge[1] as TaskId) ?? [];
      list.push(edge[0] as TaskId);
      dependents.set(edge[1] as TaskId, list);
    }
    for (const proposal of batch.tasks) {
      for (const key of proposal.dependsOnKeys) edges.push([keyNode(proposal.key), keyNode(key)]);
      for (const taskId of proposal.dependsOnTaskIds) edges.push([keyNode(proposal.key), taskId]);
      if (proposal.replacesTaskId !== null) {
        for (const dependent of dependents.get(proposal.replacesTaskId) ?? []) {
          const task = existingById.get(dependent)!;
          if (!TASK_MACHINE.isTerminal(task.status) && !superseded.has(task.id)) edges.push([dependent, keyNode(proposal.key)]);
        }
      }
    }
    const cycle = findCycle(edges);
    if (cycle !== null) reject("dependency_cycle", `the proposed dependencies form a cycle through ${cycle.replace(/^key:/, "")}`, "tasks");

    // Rule 11: cumulative maxTasks counts every Task ever accepted for the node.
    if (existing.length + batch.tasks.length > bounds.maxTasks) {
      reject("max_tasks_exceeded", `the node has accepted ${existing.length} Task(s); ${batch.tasks.length} more would exceed maxTasks ${bounds.maxTasks}`, "tasks");
    }
    // Rules 12–13: every Worker allocation fits, and the whole batch fits atomically, the node's remaining allocation.
    const allocation = this.stores.agents.getRevision(shape.worker.agentDefinitionRevisionId).defaultLimits.allocation;
    const total: Allocation = { costUsd: allocation.costUsd * batch.tasks.length, tokens: allocation.tokens * batch.tasks.length, attempts: allocation.attempts * batch.tasks.length };
    const available = this.stores.reservations.capacity({ type: "plan_node", id: node.id }).available;
    if (!allocationFits(total, available)) {
      reject("allocation_insufficient", `${batch.tasks.length} Worker allocation(s) of ${allocation.costUsd} USD / ${allocation.tokens} tokens / ${allocation.attempts} attempts do not fit the node's remaining allocation`, "tasks");
    }
    return { allocation, existingById, dependents, superseded };
  }

  // ---------------------------------------------------------------------------
  // Application (inside the caller's transaction)
  // ---------------------------------------------------------------------------

  private applyProposal(caller: RuntimeToolCaller, batch: TaskProposalBatch, plan: ProposalPlan, options: WriteOptions): RuntimeToolResult {
    const { node } = caller;
    const scope = node.scope!;
    // A replaced blocked Task is cancelled (its Task reservation released); a replaced failed Task stays failed in history.
    for (const proposal of batch.tasks) {
      if (proposal.replacesTaskId === null) continue;
      const replaced = plan.existingById.get(proposal.replacesTaskId)!;
      if (replaced.status === "blocked") this.cancelTask(replaced, options);
    }
    const created = new Map<string, Task>();
    for (const proposal of batch.tasks) {
      const task = this.stores.tasks.create(
        {
          runId: node.runId,
          planNodeId: node.id,
          origin: "coordinator",
          subject: proposal.subject,
          requirementIds: proposal.requirementIds,
          requirementRevisionId: scope.requirementRevisionId,
          inputArtifactIds: proposal.inputArtifactIds,
          requiredOutputs: proposal.requiredOutputs,
          replacesTaskId: proposal.replacesTaskId,
        },
        options,
      );
      created.set(proposal.key, task);
    }
    for (const proposal of batch.tasks) {
      const task = created.get(proposal.key)!;
      for (const key of proposal.dependsOnKeys) this.stores.tasks.addDependency(task.id, created.get(key)!.id, options);
      for (const taskId of proposal.dependsOnTaskIds) this.stores.tasks.addDependency(task.id, taskId, options);
      // Dependents of a replaced Task wait on the replacement; the superseded dependency never blocks them again.
      if (proposal.replacesTaskId !== null) {
        for (const dependent of plan.dependents.get(proposal.replacesTaskId) ?? []) {
          const current = this.stores.tasks.get(dependent);
          if (!TASK_MACHINE.isTerminal(current.status) && !plan.superseded.has(current.id)) this.stores.tasks.addDependency(current.id, task.id, options);
        }
      }
    }
    for (const proposal of batch.tasks) {
      const task = created.get(proposal.key)!;
      this.stores.reservations.reserveOrdinary({ runId: node.runId, parent: { type: "plan_node", id: node.id }, child: { type: "task", id: task.id }, amount: plan.allocation }, options);
    }
    const taskIds = batch.tasks.map((p) => created.get(p.key)!.id);
    return { tool: "propose_tasks", taskIds, taskIdsByKey: Object.fromEntries(batch.tasks.map((p) => [p.key, created.get(p.key)!.id])) };
  }

  /** Cancels a pending, ready, or blocked Task and releases its active Task reservation. */
  private cancelTask(task: Task, options: WriteOptions): Task {
    const cancelled = this.stores.tasks.transition(task.id, { to: "cancelled" }, options);
    const reservation = this.stores.reservations.activeForChild({ type: "task", id: task.id });
    if (reservation) this.stores.reservations.release(reservation.id, "task_cancelled", { costUsd: 0, tokens: 0, attempts: 0 }, options);
    return cancelled;
  }
}

interface ProposalPlan {
  allocation: Allocation;
  existingById: ReadonlyMap<TaskId, Task>;
  /** Existing Task id → the current Tasks that depend on it. */
  dependents: ReadonlyMap<TaskId, TaskId[]>;
  superseded: ReadonlySet<TaskId>;
}

/** A node on a cycle of the directed edges (`from → to`), or `null` when acyclic. */
function findCycle(edges: readonly [string, string][]): string | null {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): string | null => {
    const current = state.get(node);
    if (current === "done") return null;
    if (current === "visiting") return node;
    state.set(node, "visiting");
    for (const next of adjacency.get(node) ?? []) {
      const found = visit(next);
      if (found !== null) return found;
    }
    state.set(node, "done");
    return null;
  };
  for (const start of adjacency.keys()) {
    const found = visit(start);
    if (found !== null) return found;
  }
  return null;
}
