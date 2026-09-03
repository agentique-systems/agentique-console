/**
 * Pure Task readiness for a coordinator_worker node (execution-model §5.5,
 * §7.9). A function of one explicit `TaskProjectionInput` — every Task the
 * node ever accepted (history included), the node's dependency edges, and
 * the Artifact ids that exist — to the node's **current Task set**, its
 * canonical order, the readiness decisions the runtime applies, and the
 * unresolved blocker frontier. It queries no store, reads no clock,
 * transcript, Event, Coordinator claim, or Invocation order.
 *
 * Current versus historical Tasks: a Task superseded by an accepted
 * replacement (`replacesTaskId`) stays in history but is no longer a current
 * leaf; the replacement is the current Task for that line of work. A failed
 * Task is never reclassified; it is simply superseded. Dependencies are
 * resolved through replacement: when a replacement is accepted the runtime
 * copies every current dependent's edge onto it, so a dependent that was
 * blocked by the failed Task waits on the replacement instead and a
 * superseded dependency never blocks anyone. Cumulative bounds count every
 * Task ever accepted, superseded ones included.
 *
 * Canonical order (integration and start order): a topological order over
 * the current Tasks' effective dependencies, ties broken by the Task's
 * creation order (the input order). Provider completion order plays no part.
 */
import { type ArtifactId, type CoordinatorBlocker, type PatternPlanNode, type Task, type TaskBlockReason, type TaskDependency, type TaskId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";

export interface TaskProjectionInput {
  /** Every Coordinator-proposed Task of the node, in canonical creation order (creation time, then id). */
  tasks: readonly Task[];
  /** Every dependency edge of the Run that touches those Tasks. */
  dependencies: readonly TaskDependency[];
  /** The Artifact ids that exist in the Run. */
  availableArtifactIds: ReadonlySet<ArtifactId>;
}

export type TaskReadinessDecision =
  /** `pending` or dependency-blocked with every effective dependency completed and every input Artifact present. */
  | { kind: "become_ready"; taskId: TaskId }
  /** `pending` with an effective dependency that failed or was cancelled. */
  | { kind: "become_blocked"; taskId: TaskId; blockReason: TaskBlockReason };

/** What the projection says about one current Task once the decisions are applied. */
export type CurrentTaskState =
  /** `ready` (after the decisions): a Worker Invocation may start. */
  | { kind: "runnable" }
  /** `pending`, or dependency-blocked on a dependency that is still in progress (a pending replacement included). */
  | { kind: "waiting_dependencies"; awaiting: TaskId[] }
  /** `running`: assigned to an active Invocation, or to a terminal one whose consequences are not yet applied. */
  | { kind: "running" }
  /** `blocked` on a Decision: continues through a successor Invocation once it resolves; never a Coordinator matter. */
  | { kind: "blocked_decision" }
  /** Unresolved without a Coordinator: failed and unreplaced, blocked by a failed or cancelled dependency, or blocked by a Worker's report. */
  | { kind: "unresolved"; blocker: CoordinatorBlocker }
  | { kind: "completed" }
  | { kind: "cancelled" };

export interface TaskProjection {
  /** Current Tasks (not superseded), in canonical creation order. */
  current: Task[];
  /** Superseded Task id → the replacement that superseded it. */
  supersededBy: ReadonlyMap<TaskId, TaskId>;
  /** Effective dependencies per current Task: current dependencies only, superseded ones excluded. */
  effectiveDependencies: ReadonlyMap<TaskId, TaskId[]>;
  /** The canonical order of the current Tasks. */
  order: TaskId[];
  /** The transitions the runtime applies now, in canonical order. */
  decisions: TaskReadinessDecision[];
  /** Every current Task's state once the decisions are applied, in canonical order. */
  states: ReadonlyMap<TaskId, CurrentTaskState>;
  /** The unresolved blocker frontier from Tasks alone (integration conflicts are added by the runner), in canonical order. */
  frontier: CoordinatorBlocker[];
}

export function projectTasks(input: TaskProjectionInput): TaskProjection {
  const byId = new Map(input.tasks.map((t) => [t.id, t] as const));
  const supersededBy = new Map<TaskId, TaskId>();
  for (const task of input.tasks) {
    if (task.replacesTaskId !== null && byId.has(task.replacesTaskId)) {
      if (supersededBy.has(task.replacesTaskId)) throw new Error(`Task ${task.replacesTaskId} is replaced twice (${supersededBy.get(task.replacesTaskId)}, ${task.id})`);
      supersededBy.set(task.replacesTaskId, task.id);
    }
  }
  const current = input.tasks.filter((t) => !supersededBy.has(t.id));
  const position = new Map(current.map((t, index) => [t.id, index] as const));
  const effectiveDependencies = new Map<TaskId, TaskId[]>();
  for (const task of current) {
    const deps = input.dependencies
      .filter((d) => d.taskId === task.id && byId.has(d.dependsOnTaskId) && !supersededBy.has(d.dependsOnTaskId))
      .map((d) => d.dependsOnTaskId)
      .sort((a, b) => position.get(a)! - position.get(b)!);
    effectiveDependencies.set(task.id, deps);
  }
  const order = canonicalOrder(current, effectiveDependencies);

  const decisions: TaskReadinessDecision[] = [];
  const projected = new Map<TaskId, Task["status"]>(current.map((t) => [t.id, t.status] as const));
  for (const taskId of order) {
    const task = byId.get(taskId)!;
    const deps = effectiveDependencies.get(taskId)!;
    const inputsPresent = task.inputArtifactIds.every((id) => input.availableArtifactIds.has(id));
    const failedDependency = deps.find((d) => byId.get(d)!.status === "failed") ?? null;
    const cancelledDependency = deps.find((d) => byId.get(d)!.status === "cancelled") ?? null;
    const allCompleted = deps.every((d) => byId.get(d)!.status === "completed");
    if (task.status === "pending") {
      if (failedDependency !== null) {
        decisions.push({ kind: "become_blocked", taskId, blockReason: { kind: "dependency_failed", taskId: failedDependency } });
        projected.set(taskId, "blocked");
      } else if (cancelledDependency !== null) {
        decisions.push({ kind: "become_blocked", taskId, blockReason: { kind: "dependency_cancelled", taskId: cancelledDependency } });
        projected.set(taskId, "blocked");
      } else if (allCompleted && inputsPresent) {
        decisions.push({ kind: "become_ready", taskId });
        projected.set(taskId, "ready");
      }
    } else if (task.status === "blocked" && (task.blockReason?.kind === "dependency_failed" || task.blockReason?.kind === "dependency_cancelled")) {
      if (allCompleted && inputsPresent) {
        decisions.push({ kind: "become_ready", taskId });
        projected.set(taskId, "ready");
      }
    }
  }

  const states = new Map<TaskId, CurrentTaskState>();
  const frontier: CoordinatorBlocker[] = [];
  for (const taskId of order) {
    const task = byId.get(taskId)!;
    const status = projected.get(taskId)!;
    const deps = effectiveDependencies.get(taskId)!;
    let state: CurrentTaskState;
    switch (status) {
      case "ready":
        state = { kind: "runnable" };
        break;
      case "pending":
        state = { kind: "waiting_dependencies", awaiting: deps.filter((d) => byId.get(d)!.status !== "completed") };
        break;
      case "running":
        state = { kind: "running" };
        break;
      case "completed":
        state = { kind: "completed" };
        break;
      case "cancelled":
        state = { kind: "cancelled" };
        break;
      case "failed":
        state = { kind: "unresolved", blocker: { kind: "task_failed", taskId, failureReason: task.failureReason! } };
        break;
      case "blocked": {
        const reason = task.status === "blocked" ? task.blockReason! : decisions.find((d): d is Extract<TaskReadinessDecision, { kind: "become_blocked" }> => d.kind === "become_blocked" && d.taskId === taskId)!.blockReason;
        if (reason.kind === "decision") state = { kind: "blocked_decision" };
        else if (reason.kind === "dependency_failed" || reason.kind === "dependency_cancelled") {
          const unresolved = deps.some((d) => byId.get(d)!.status === "failed" || byId.get(d)!.status === "cancelled");
          state = unresolved ? { kind: "unresolved", blocker: { kind: "task_blocked", taskId, blockReason: reason } } : { kind: "waiting_dependencies", awaiting: deps.filter((d) => byId.get(d)!.status !== "completed") };
        } else state = { kind: "unresolved", blocker: { kind: "task_blocked", taskId, blockReason: reason } };
        break;
      }
    }
    states.set(taskId, state);
    if (state.kind === "unresolved") frontier.push(state.blocker);
  }
  return { current, supersededBy, effectiveDependencies, order, decisions, states, frontier };
}

/** Kahn's algorithm over the effective dependencies, always taking the earliest-created available Task. */
function canonicalOrder(current: readonly Task[], effectiveDependencies: ReadonlyMap<TaskId, TaskId[]>): TaskId[] {
  const remaining = new Map(current.map((t) => [t.id, new Set(effectiveDependencies.get(t.id) ?? [])] as const));
  const order: TaskId[] = [];
  while (remaining.size > 0) {
    const next = current.find((t) => remaining.has(t.id) && remaining.get(t.id)!.size === 0);
    if (!next) throw new Error(`the Task dependencies of ${[...remaining.keys()].join(", ")} form a cycle`);
    remaining.delete(next.id);
    order.push(next.id);
    for (const deps of remaining.values()) deps.delete(next.id);
  }
  return order;
}

/** The projector: reads exactly the node's Tasks, their dependency edges, and the Run's Artifact ids; nothing else. */
export function projectNodeTasks(stores: Stores, node: Pick<PatternPlanNode, "id" | "runId">): TaskProjection {
  const tasks = stores.tasks.listByPlanNode(node.id).filter((t) => t.origin === "coordinator");
  const ids = new Set(tasks.map((t) => t.id));
  const dependencies = stores.tasks.dependencies(node.runId).filter((d) => ids.has(d.taskId));
  const availableArtifactIds = new Set(stores.artifacts.listByRun(node.runId).map((a) => a.id));
  return projectTasks({ tasks, dependencies, availableArtifactIds });
}
