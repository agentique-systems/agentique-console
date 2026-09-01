import { and, asc, eq, gt, inArray, isNotNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  assertTaskCompletion,
  canonicalJson,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  ROOT_SOURCE_PATH,
  TASK_MACHINE,
  taskDependencySchema,
  taskInputSchema,
  taskSchema,
  ValidationError,
  wouldCreateDependencyCycle,
  type ArtifactId,
  type Evidence,
  type GateId,
  type PlanNodeId,
  type RunId,
  type Task,
  type TaskDependency,
  type TaskId,
  type TaskInput,
  type TaskTransition,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, gates, invocations, planNodes, taskDependencies, tasks } from "../schema.ts";
import type { ExecutionPlanStore } from "./plans.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof tasks.$inferSelect): Task {
  return parseOrThrow(taskSchema, row, "Task row");
}

/**
 * Which Tasks of a Run one reader sees (execution-model §6.4 `read_tasks`):
 * `current` — every Task not superseded by a replacement (the root
 * Orchestrator); `node` — a Plan Node's complete ledger, superseded rows
 * included (its Coordinator); `ids` — an explicit bounded set (a Worker's
 * own Tasks and their direct dependencies; an Evaluator's Gate candidate).
 */
export type TaskVisibility = { runId: RunId } & ({ kind: "current" } | { kind: "node"; planNodeId: PlanNodeId } | { kind: "ids"; taskIds: readonly TaskId[] });

const replacement = alias(tasks, "replacement");

/**
 * Run-scoped Tasks with the seven runtime-owned states, dependencies that
 * stay acyclic, exact-scope validation for Coordinator-proposed Tasks, and
 * replacement linkage. A failed Task is never reclassified cancelled; a
 * blocked-by-dependency Task is never silently cancelled.
 */
export class TaskStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly plans: ExecutionPlanStore,
  ) {}

  create(input: TaskInput, options?: WriteOptions): Task {
    const valid = parseOrThrow(taskInputSchema, input, "Task input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (valid.planNodeId !== null) {
        const node = requireRow(this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
        assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
        if (node.kind === "join") throw new InvariantViolationError("a join node has no Tasks");
      }
      if (valid.origin === "coordinator") {
        // Exact pinned scope: every Requirement must be a scope row of the node at the pinned revision.
        for (const requirementId of valid.requirementIds) {
          if (!this.plans.isInScope(valid.planNodeId as never, requirementId, valid.requirementRevisionId as never)) {
            throw new InvariantViolationError(
              `Requirement ${requirementId} at revision ${valid.requirementRevisionId} is outside the scope of PlanNode ${valid.planNodeId}`,
              { requirementId, requirementRevisionId: valid.requirementRevisionId, planNodeId: valid.planNodeId },
            );
          }
        }
      }
      if (valid.inputArtifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, valid.inputArtifactIds)).all();
        for (const id of valid.inputArtifactIds) assertSameRun("Artifact", id, requireRow(rows.find((r) => r.id === id), "Artifact", id).runId, run.id);
      }
      if (valid.replacesTaskId !== null) {
        // A replacement names a blocked or failed Task of the same Run, at most once (execution-model §5.5): a completed,
        // cancelled, or unstarted Task is never replaced, and a Task already superseded is historical.
        const replaced = this.get(valid.replacesTaskId);
        assertSameRun("Task", replaced.id, replaced.runId, run.id);
        if (replaced.status !== "blocked" && replaced.status !== "failed") {
          throw new ConflictError(`Task ${replaced.id} is ${replaced.status} and cannot be replaced`, { taskId: replaced.id, status: replaced.status });
        }
        const superseded = this.replacementOf(replaced.id);
        if (superseded !== null) throw new ConflictError(`Task ${replaced.id} is already superseded by ${superseded.id}`, { taskId: replaced.id, supersededByTaskId: superseded.id });
      }
      const gateId = valid.gateId ?? null;
      if (gateId !== null) {
        // A Gate remediation Task (execution-model §10) addresses a failed Gate of the same Run, once: a node_exit Gate on the gated
        // node, a run_completion Gate from the root Plan Node (the root Orchestrator remediates it).
        const gate = requireRow(this.ctx.db.select({ runId: gates.runId, planNodeId: gates.planNodeId, kind: gates.kind, status: gates.status }).from(gates).where(eq(gates.id, gateId)).get(), "Gate", gateId);
        assertSameRun("Gate", gateId, gate.runId, run.id);
        if (gate.status !== "failed") throw new InvariantViolationError(`Gate ${gateId} is ${gate.status}; a remediation Task addresses a failed Gate`, { gateId });
        if (gate.planNodeId === null) {
          const node = valid.planNodeId === null ? null : requireRow(this.ctx.db.select({ sourcePath: planNodes.sourcePath }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(), "PlanNode", valid.planNodeId);
          if (gate.kind !== "run_completion" || node === null || node.sourcePath !== ROOT_SOURCE_PATH) throw new InvariantViolationError(`Gate ${gateId} is a ${gate.kind} Run Gate; its remediation Task is tagged with the root Plan Node`, { gateId, planNodeId: valid.planNodeId });
        } else if (gate.planNodeId !== valid.planNodeId) throw new InvariantViolationError(`Gate ${gateId} belongs to PlanNode ${gate.planNodeId}, not ${String(valid.planNodeId)}`, { gateId, planNodeId: valid.planNodeId });
        const existing = this.remediationTaskOf(gateId);
        if (existing !== null) throw new ConflictError(`Gate ${gateId} already has remediation Task ${existing.id}`, { gateId, taskId: existing.id });
      }
      const now = this.ctx.clock();
      const task: Task = {
        id: this.ctx.ids("task"),
        ...valid,
        gateId,
        invocationId: null,
        outputArtifactIds: [],
        evidence: [],
        status: "pending",
        blockReason: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      parseOrThrow(taskSchema, task, "Task");
      this.ctx.journal.append({
        type: "task.created",
        scope: runScope(run, { planNodeId: task.planNodeId }),
        subjectType: "task",
        subjectId: task.id,
        payload: task,
        ...writeMeta(options),
      });
      this.ctx.db.insert(tasks).values(task).run();
      return task;
    });
  }

  get(id: TaskId): Task {
    return toDomain(requireRow(this.ctx.db.select().from(tasks).where(eq(tasks.id, id)).get(), "Task", id));
  }

  listByRun(runId: RunId): Task[] {
    return this.ctx.db.select().from(tasks).where(eq(tasks.runId, runId)).orderBy(asc(tasks.createdAt), asc(tasks.id)).all().map(toDomain);
  }

  /** Every Task tagged with a Plan Node, historical ones included, in creation order (then id): the node's canonical Task order. */
  listByPlanNode(planNodeId: PlanNodeId): Task[] {
    return this.ctx.db.select().from(tasks).where(eq(tasks.planNodeId, planNodeId)).orderBy(asc(tasks.createdAt), asc(tasks.id)).all().map(toDomain);
  }

  /** One keyset page of the Tasks visible under `visibility`, in id order after `after` (exclusive), at most `limit` rows: one bounded query. */
  page(visibility: TaskVisibility, after: TaskId | undefined, limit: number): Task[] {
    const where = this.visibleWhere(visibility);
    if (where === null) return [];
    return this.ctx.db
      .select()
      .from(tasks)
      .where(and(where, after === undefined ? undefined : gt(tasks.id, after)))
      .orderBy(asc(tasks.id))
      .limit(limit)
      .all()
      .map(toDomain);
  }

  /** Whether Task `id` is visible under `visibility` (one indexed lookup): the cursor and exact-id check. */
  contains(visibility: TaskVisibility, id: TaskId): boolean {
    return this.visibleAmong(visibility, [id]).length === 1;
  }

  /** The subset of `ids` visible under `visibility`, in one bounded query: how a page projects Task references it did not load. */
  visibleAmong(visibility: TaskVisibility, ids: readonly TaskId[]): TaskId[] {
    const where = this.visibleWhere(visibility);
    if (where === null || ids.length === 0) return [];
    return this.ctx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(where, inArray(tasks.id, [...ids])))
      .all()
      .map((row) => row.id as TaskId);
  }

  private visibleWhere(visibility: TaskVisibility) {
    const own = eq(tasks.runId, visibility.runId);
    switch (visibility.kind) {
      case "current":
        return and(own, notExists(this.ctx.db.select({ id: replacement.id }).from(replacement).where(eq(replacement.replacesTaskId, tasks.id))));
      case "node":
        return and(own, eq(tasks.planNodeId, visibility.planNodeId));
      case "ids":
        return visibility.taskIds.length === 0 ? null : and(own, inArray(tasks.id, [...visibility.taskIds]));
    }
  }

  /** The direct dependency ids of each of `taskIds` (edges whose dependent is the Task), in one bounded query; absent Tasks map to nothing. */
  dependencyIdsOf(taskIds: readonly TaskId[]): Map<TaskId, TaskId[]> {
    const out = new Map<TaskId, TaskId[]>();
    if (taskIds.length === 0) return out;
    const rows = this.ctx.db.select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId }).from(taskDependencies).where(inArray(taskDependencies.taskId, [...taskIds])).all();
    for (const row of rows) {
      const list = out.get(row.taskId as TaskId) ?? [];
      list.push(row.dependsOnTaskId as TaskId);
      out.set(row.taskId as TaskId, list);
    }
    for (const list of out.values()) list.sort();
    return out;
  }

  /** The replacement Task id of each superseded Task among `taskIds`, in one bounded query. */
  replacementsOf(taskIds: readonly TaskId[]): Map<TaskId, TaskId> {
    const out = new Map<TaskId, TaskId>();
    if (taskIds.length === 0) return out;
    const rows = this.ctx.db.select({ id: tasks.id, replacesTaskId: tasks.replacesTaskId }).from(tasks).where(inArray(tasks.replacesTaskId, [...taskIds])).all();
    for (const row of rows) out.set(row.replacesTaskId as TaskId, row.id as TaskId);
    return out;
  }

  /** The Task that replaced `taskId`, or `null` while it is not superseded; at most one exists (a database unique index). */
  replacementOf(taskId: TaskId): Task | null {
    const row = this.ctx.db.select().from(tasks).where(eq(tasks.replacesTaskId, taskId)).get();
    return row ? toDomain(row) : null;
  }

  /** The runtime-owned remediation Task of a failed Gate, or `null`; at most one exists (a database unique index). */
  remediationTaskOf(gateId: GateId): Task | null {
    const row = this.ctx.db.select().from(tasks).where(eq(tasks.gateId, gateId)).get();
    return row ? toDomain(row) : null;
  }

  /** Every Gate remediation Task of a Run, in creation order (then id). */
  listRemediationTasks(runId: RunId): Task[] {
    return this.ctx.db.select().from(tasks).where(and(eq(tasks.runId, runId), isNotNull(tasks.gateId))).orderBy(asc(tasks.createdAt), asc(tasks.id)).all().map(toDomain);
  }

  dependencies(runId: RunId): TaskDependency[] {
    return this.ctx.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.runId, runId))
      .all()
      .map((row) => parseOrThrow(taskDependencySchema, row, "TaskDependency row"));
  }

  dependenciesOf(taskId: TaskId): TaskDependency[] {
    return this.ctx.db
      .select()
      .from(taskDependencies)
      .where(or(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, taskId)))
      .all()
      .map((row) => parseOrThrow(taskDependencySchema, row, "TaskDependency row"));
  }

  addDependency(taskId: TaskId, dependsOnTaskId: TaskId, options?: WriteOptions): TaskDependency {
    return this.ctx.tx.write(() => {
      const task = this.get(taskId);
      const dependency = this.get(dependsOnTaskId);
      assertSameRun("Task", dependsOnTaskId, dependency.runId, task.runId);
      // A dependency is added before the Task starts: while it is pending, or while it is blocked waiting on a dependency's replacement.
      if (task.status !== "pending" && task.status !== "blocked") throw new ConflictError(`Task ${taskId} is ${task.status}; dependencies are added while pending or blocked`);
      const edge = parseOrThrow(taskDependencySchema, { runId: task.runId, taskId, dependsOnTaskId }, "TaskDependency");
      const existing = this.dependencies(task.runId);
      if (existing.some((e) => e.taskId === taskId && e.dependsOnTaskId === dependsOnTaskId)) {
        throw new ConflictError(`Task ${taskId} already depends on ${dependsOnTaskId}`);
      }
      if (wouldCreateDependencyCycle(existing, taskId, dependsOnTaskId)) {
        throw new ValidationError(`Task ${taskId} depending on ${dependsOnTaskId} would create a cycle`, { taskId, dependsOnTaskId });
      }
      const run = loadRunRef(this.ctx, task.runId);
      this.ctx.journal.append({
        type: "task.dependency_added",
        scope: runScope(run, { planNodeId: task.planNodeId }),
        subjectType: "task",
        subjectId: taskId,
        payload: edge,
        ...writeMeta(options),
      });
      this.ctx.db.insert(taskDependencies).values(edge).run();
      return edge;
    });
  }

  /** True when every dependency is completed (the readiness precondition on dependencies). */
  dependenciesCompleted(taskId: TaskId): boolean {
    const edges = this.dependencies(this.get(taskId).runId).filter((e) => e.taskId === taskId);
    if (edges.length === 0) return true;
    const rows = this.ctx.db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, edges.map((e) => e.dependsOnTaskId))).all();
    return rows.every((r) => r.status === "completed");
  }

  /**
   * Associates Evidence and output Artifacts with a non-terminal Task
   * (execution-model §5.5.1 `update_task`): additions only, deduplicated
   * against what the Task already carries; a repeat of an existing
   * association changes nothing and writes nothing. Output Artifacts belong
   * to the Task's Run. A terminal Task is immutable.
   */
  recordEvidence(id: TaskId, additions: { evidence: Evidence[]; outputArtifactIds: ArtifactId[] }, options?: WriteOptions): Task {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (TASK_MACHINE.isTerminal(current.status)) throw new ConflictError(`Task ${id} is ${current.status}; a terminal Task is immutable`, { taskId: id, status: current.status });
      const run = loadRunRef(this.ctx, current.runId);
      const seen = new Set(current.evidence.map((e) => canonicalJson(e)));
      const evidence = additions.evidence.filter((e) => {
        const key = canonicalJson(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const outputArtifactIds = [...new Set(additions.outputArtifactIds)].filter((artifactId) => !current.outputArtifactIds.includes(artifactId));
      if (outputArtifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, outputArtifactIds)).all();
        for (const artifactId of outputArtifactIds) assertSameRun("Artifact", artifactId, requireRow(rows.find((r) => r.id === artifactId), "Artifact", artifactId).runId, current.runId);
      }
      if (evidence.length === 0 && outputArtifactIds.length === 0) return current;
      const next: Task = { ...current, evidence: [...current.evidence, ...evidence], outputArtifactIds: [...current.outputArtifactIds, ...outputArtifactIds], updatedAt: this.ctx.clock() };
      parseOrThrow(taskSchema, next, "Task");
      this.ctx.journal.append({
        type: "task.evidence_recorded",
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: current.invocationId }),
        subjectType: "task",
        subjectId: id,
        payload: { taskId: id, evidence, outputArtifactIds },
        ...writeMeta(options),
      });
      this.ctx.db.update(tasks).set({ evidence: next.evidence, outputArtifactIds: next.outputArtifactIds, updatedAt: next.updatedAt }).where(eq(tasks.id, id)).run();
      return next;
    });
  }

  transition(id: TaskId, transition: TaskTransition, options?: WriteOptions): Task {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      TASK_MACHINE.assertTransition(current.status, transition.to, { taskId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: Task = { ...current, status: transition.to, blockReason: null, updatedAt: now };
      let payload: unknown = { from: current.status, to: transition.to, reason: null };
      switch (transition.to) {
        case "ready":
          if (current.status === "pending" && !this.dependenciesCompleted(id)) {
            throw new InvariantViolationError(`Task ${id} has dependencies that are not completed`);
          }
          next.invocationId = null;
          break;
        case "running": {
          const invocation = requireRow(
            this.ctx.db.select({ runId: invocations.runId, status: invocations.status }).from(invocations).where(eq(invocations.id, transition.invocationId)).get(),
            "Invocation",
            transition.invocationId,
          );
          assertSameRun("Invocation", transition.invocationId, invocation.runId, current.runId);
          next.invocationId = transition.invocationId;
          payload = { from: current.status, to: "running", invocationId: transition.invocationId };
          break;
        }
        case "blocked":
          if (transition.blockReason.kind === "dependency_failed" || transition.blockReason.kind === "dependency_cancelled") {
            const dependency = this.get(transition.blockReason.taskId);
            assertSameRun("Task", dependency.id, dependency.runId, current.runId);
            if (!this.dependencies(current.runId).some((e) => e.taskId === id && e.dependsOnTaskId === dependency.id)) {
              throw new ValidationError(`Task ${id} does not depend on ${dependency.id}`);
            }
          }
          // A blocked Task is no longer assigned; a new Invocation is created when it resumes.
          next.invocationId = null;
          next.blockReason = transition.blockReason;
          payload = { from: current.status, to: "blocked", blockReason: transition.blockReason };
          break;
        case "completed": {
          assertTaskCompletion(transition.evidence, current.requiredOutputs, transition.outputArtifactIds);
          if (transition.outputArtifactIds.length > 0) {
            const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, transition.outputArtifactIds)).all();
            for (const artifactId of transition.outputArtifactIds) assertSameRun("Artifact", artifactId, requireRow(rows.find((r) => r.id === artifactId), "Artifact", artifactId).runId, current.runId);
          }
          next.evidence = transition.evidence;
          next.outputArtifactIds = transition.outputArtifactIds;
          payload = { from: current.status, to: "completed", outputArtifactIds: transition.outputArtifactIds, evidence: transition.evidence };
          break;
        }
        case "failed":
          next.failureReason = transition.failureReason;
          payload = { from: current.status, to: "failed", failureReason: transition.failureReason };
          break;
        case "cancelled":
          break;
      }
      if (TASK_MACHINE.isTerminal(next.status)) next.endedAt = now;
      parseOrThrow(taskSchema, next, "Task");
      const eventType = (
        {
          ready: "task.ready",
          running: "task.started",
          blocked: "task.blocked",
          completed: "task.completed",
          failed: "task.failed",
          cancelled: "task.cancelled",
        } as const
      )[transition.to];
      this.ctx.journal.append({
        type: eventType,
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: next.invocationId }),
        subjectType: "task",
        subjectId: id,
        payload: payload as never,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(tasks)
        .set({
          status: next.status,
          invocationId: next.invocationId,
          blockReason: next.blockReason,
          failureReason: next.failureReason,
          evidence: next.evidence,
          outputArtifactIds: next.outputArtifactIds,
          updatedAt: next.updatedAt,
          endedAt: next.endedAt,
        })
        .where(eq(tasks.id, id))
        .run();
      return next;
    });
  }
}
