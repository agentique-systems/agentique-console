import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type {
  ArtifactId,
  DecisionId,
  InvocationId,
  PlanNodeId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  TaskId,
} from "./ids.ts";
import { evidenceSchema, type Evidence } from "./requirements.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

export const TASK_STATUSES = ["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Who created the Task: Orchestrator `create_tasks` or validated Coordinator `propose_tasks`. */
export const TASK_ORIGINS = ["orchestrator", "coordinator", "runtime"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export type TaskBlockReason =
  | { kind: "decision"; decisionId: DecisionId }
  | { kind: "input"; description: string }
  | { kind: "dependency_failed"; taskId: TaskId }
  | { kind: "dependency_cancelled"; taskId: TaskId }
  | { kind: "replan"; description: string };

export const taskBlockReasonSchema: z.ZodType<TaskBlockReason> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decision"), decisionId: idSchema("decision") }),
  z.strictObject({ kind: z.literal("input"), description: nonEmptyString }),
  z.strictObject({ kind: z.literal("dependency_failed"), taskId: idSchema("task") }),
  z.strictObject({ kind: z.literal("dependency_cancelled"), taskId: idSchema("task") }),
  z.strictObject({ kind: z.literal("replan"), description: nonEmptyString }),
]);

export const TASK_FAILURE_REASONS = ["attempts_exhausted", "permanent_failure", "allocation_exhausted"] as const;
export type TaskFailureReason = (typeof TASK_FAILURE_REASONS)[number];

export interface Task {
  id: TaskId;
  runId: RunId;
  /** The node the Task is tagged with (required for Coordinator-proposed Tasks). */
  planNodeId: PlanNodeId | null;
  /** The active Invocation assigned to the Task, while `running`. */
  invocationId: InvocationId | null;
  origin: TaskOrigin;
  subject: string;
  requirementIds: RequirementId[];
  /** The pinned revision the Requirement references name (Coordinator-proposed Tasks). */
  requirementRevisionId: RequirementRevisionId | null;
  inputArtifactIds: ArtifactId[];
  requiredOutputs: string[];
  outputArtifactIds: ArtifactId[];
  evidence: Evidence[];
  status: TaskStatus;
  blockReason: TaskBlockReason | null;
  failureReason: TaskFailureReason | null;
  replacesTaskId: TaskId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  endedAt: Timestamp | null;
}

export const TASK_MACHINE = defineStateMachine<TaskStatus>("Task", TASK_STATUSES, {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["completed", "blocked", "failed"],
  blocked: ["ready", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
});

export const taskSchema: z.ZodType<Task> = z
  .strictObject({
    id: idSchema("task"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    invocationId: idSchema("invocation").nullable(),
    origin: z.enum(TASK_ORIGINS),
    subject: nonEmptyString,
    requirementIds: uniqueIds(idSchema("requirement")),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    inputArtifactIds: uniqueIds(idSchema("artifact")),
    requiredOutputs: z.array(nonEmptyString),
    outputArtifactIds: uniqueIds(idSchema("artifact")),
    evidence: z.array(evidenceSchema),
    status: z.enum(TASK_STATUSES),
    blockReason: taskBlockReasonSchema.nullable(),
    failureReason: z.enum(TASK_FAILURE_REASONS).nullable(),
    replacesTaskId: idSchema("task").nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
  })
  .refine((t) => (t.status === "blocked") === (t.blockReason !== null), {
    message: "blockReason is set exactly when the Task is blocked",
    path: ["blockReason"],
  })
  .refine((t) => (t.status === "failed") === (t.failureReason !== null), {
    message: "failureReason is set exactly when the Task failed",
    path: ["failureReason"],
  })
  .refine((t) => t.status === "running" || t.invocationId === null || TASK_MACHINE.isTerminal(t.status), {
    message: "only a running or finished Task carries an Invocation",
    path: ["invocationId"],
  })
  .refine((t) => TASK_MACHINE.isTerminal(t.status) === (t.endedAt !== null), {
    message: "endedAt is set exactly when the Task is terminal",
    path: ["endedAt"],
  })
  .refine((t) => t.origin !== "coordinator" || (t.planNodeId !== null && t.requirementRevisionId !== null), {
    message: "a Coordinator-proposed Task is tagged with its node and pinned revision",
    path: ["planNodeId"],
  })
  .refine((t) => t.origin !== "coordinator" || t.requirementIds.length > 0, {
    message: "a Coordinator-proposed Task references a non-empty subset of its node's scope",
    path: ["requirementIds"],
  })
  .refine((t) => t.id !== t.replacesTaskId, { message: "a Task cannot replace itself", path: ["replacesTaskId"] });

export interface TaskInput {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  origin: TaskOrigin;
  subject: string;
  requirementIds: RequirementId[];
  requirementRevisionId: RequirementRevisionId | null;
  inputArtifactIds: ArtifactId[];
  requiredOutputs: string[];
  replacesTaskId: TaskId | null;
}

export const taskInputSchema: z.ZodType<TaskInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    origin: z.enum(TASK_ORIGINS),
    subject: nonEmptyString,
    requirementIds: uniqueIds(idSchema("requirement")),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    inputArtifactIds: uniqueIds(idSchema("artifact")),
    requiredOutputs: z.array(nonEmptyString),
    replacesTaskId: idSchema("task").nullable(),
  })
  .refine(
    (t) => t.origin !== "coordinator" || (t.planNodeId !== null && t.requirementRevisionId !== null && t.requirementIds.length > 0),
    { message: "a Coordinator-proposed Task names its node, pinned revision, and Requirements", path: ["origin"] },
  );

export interface TaskDependency {
  runId: RunId;
  taskId: TaskId;
  dependsOnTaskId: TaskId;
}

export const taskDependencySchema: z.ZodType<TaskDependency> = z
  .strictObject({
    runId: idSchema("run"),
    taskId: idSchema("task"),
    dependsOnTaskId: idSchema("task"),
  })
  .refine((d) => d.taskId !== d.dependsOnTaskId, { message: "a Task cannot depend on itself", path: ["dependsOnTaskId"] });

/** A Task transition request with the fields each target state requires. */
export type TaskTransition =
  | { to: "ready" }
  | { to: "running"; invocationId: InvocationId }
  | { to: "blocked"; blockReason: TaskBlockReason }
  | { to: "completed"; evidence: Evidence[]; outputArtifactIds: ArtifactId[] }
  | { to: "failed"; failureReason: TaskFailureReason }
  | { to: "cancelled" };

/**
 * Detects whether adding `taskId -> dependsOnTaskId` would create a cycle
 * given the existing dependency edges of the Run.
 */
export function wouldCreateDependencyCycle(
  edges: ReadonlyArray<Pick<TaskDependency, "taskId" | "dependsOnTaskId">>,
  taskId: TaskId,
  dependsOnTaskId: TaskId,
): boolean {
  if (taskId === dependsOnTaskId) return true;
  const adjacency = new Map<TaskId, TaskId[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.taskId) ?? [];
    list.push(edge.dependsOnTaskId);
    adjacency.set(edge.taskId, list);
  }
  // A cycle exists iff taskId is reachable from dependsOnTaskId.
  const stack = [dependsOnTaskId];
  const seen = new Set<TaskId>();
  while (stack.length > 0) {
    const current = stack.pop() as TaskId;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

export function assertTaskCompletion(evidence: Evidence[], requiredOutputs: string[], outputArtifactIds: ArtifactId[]): void {
  if (evidence.length === 0) {
    throw new ValidationError("a completed Task carries Evidence");
  }
  if (requiredOutputs.length > 0 && outputArtifactIds.length === 0) {
    throw new ValidationError("a completed Task with required outputs carries its output Artifacts", {
      requiredOutputs,
    });
  }
}
