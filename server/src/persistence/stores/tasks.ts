import { asc, eq, inArray, or } from "drizzle-orm";
import {
  assertTaskCompletion,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  TASK_MACHINE,
  taskDependencySchema,
  taskInputSchema,
  taskSchema,
  ValidationError,
  wouldCreateDependencyCycle,
  type PlanNodeId,
  type RunId,
  type Task,
  type TaskDependency,
  type TaskId,
  type TaskInput,
  type TaskTransition,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, invocations, planNodes, taskDependencies, tasks } from "../schema.ts";
import type { ExecutionPlanStore } from "./plans.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof tasks.$inferSelect): Task {
  return parseOrThrow(taskSchema, row, "Task row");
}

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
      const now = this.ctx.clock();
      const task: Task = {
        id: this.ctx.ids("task"),
        ...valid,
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

  /** The Task that replaced `taskId`, or `null` while it is not superseded; at most one exists (a database unique index). */
  replacementOf(taskId: TaskId): Task | null {
    const row = this.ctx.db.select().from(tasks).where(eq(tasks.replacesTaskId, taskId)).get();
    return row ? toDomain(row) : null;
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
