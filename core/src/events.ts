import { z } from "zod";
import { agentDefinitionRevisionSchema, agentDefinitionSchema } from "./agents.ts";
import { artifactSchema } from "./artifacts.ts";
import { budgetReservationSchema, RESERVATION_RELEASE_REASONS } from "./budgets.ts";
import { capacityLeaseSchema } from "./capacity.ts";
import { conversationMessageSchema, conversationSchema } from "./conversations.ts";
import { decisionResolutionSchema, decisionSchema } from "./decisions.ts";
import { handoffSchema } from "./handoffs.ts";
import type { AttemptId, ConversationId, InvocationId, PlanNodeId, RunId, WorkspaceId } from "./ids.ts";
import {
  attemptSchema,
  contextManifestSchema,
  invocationResultSchema,
  invocationSchema,
  INVOCATION_FAILURE_REASONS,
  INVOCATION_WAIT_REASONS,
  ATTEMPT_FAILURE_CLASSES,
} from "./invocations.ts";
import {
  executionPlanRevisionSchema,
  planEdgeSchema,
  planNodeRequirementSchema,
  planNodeSchema,
  planRejectionReasonSchema,
  planRevisionNodeSchema,
  PLAN_NODE_STATUSES,
  PLAN_NODE_WAIT_REASONS,
} from "./plans.ts";
import {
  acceptanceCriterionSchema,
  evidenceSchema,
  requirementRevisionSchema,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_ACTORS,
} from "./requirements.ts";
import { runFailureSchema, runSchema, RUN_STATUSES, RUN_WAIT_REASONS } from "./runs.ts";
import { taskBlockReasonSchema, taskDependencySchema, taskSchema, TASK_FAILURE_REASONS, TASK_STATUSES } from "./tasks.ts";
import { approvedToolCallUseSchema } from "./tool-calls.ts";
import { usageSchema } from "./usage.ts";
import { changesetSchema, publicationSchema, snapshotSchema } from "./workspace-state.ts";
import { workspaceSchema } from "./workspaces.ts";
import { evaluationSchema, gateSchema } from "./verification.ts";
import { idSchema, nonEmptyString, parseOrThrow, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/** Who caused an Event. */
export type EventActor =
  | { kind: "operator" }
  | { kind: "runtime" }
  | { kind: "invocation"; invocationId: InvocationId }
  | { kind: "policy"; policy: "use_default_after_deadline" };

export const eventActorSchema: z.ZodType<EventActor> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator") }),
  z.strictObject({ kind: z.literal("runtime") }),
  z.strictObject({ kind: z.literal("invocation"), invocationId: idSchema("invocation") }),
  z.strictObject({ kind: z.literal("policy"), policy: z.literal("use_default_after_deadline") }),
]);

/** The objects an Event concerns; at least a Workspace, Conversation, or Run. */
export interface EventScope {
  workspaceId: WorkspaceId | null;
  conversationId: ConversationId | null;
  runId: RunId | null;
  planNodeId: PlanNodeId | null;
  invocationId: InvocationId | null;
  attemptId: AttemptId | null;
}

export const eventScopeSchema: z.ZodType<EventScope> = z
  .strictObject({
    workspaceId: idSchema("workspace").nullable(),
    conversationId: idSchema("conversation").nullable(),
    runId: idSchema("run").nullable(),
    planNodeId: idSchema("planNode").nullable(),
    invocationId: idSchema("invocation").nullable(),
    attemptId: idSchema("attempt").nullable(),
  })
  .refine((s) => s.workspaceId !== null || s.conversationId !== null || s.runId !== null, {
    message: "an Event is scoped to a Workspace, Conversation, or Run",
    path: ["runId"],
  });

const transition = <S extends readonly [string, ...string[]]>(statuses: S) =>
  z.strictObject({ from: z.enum(statuses), to: z.enum(statuses), reason: nonEmptyString.nullable() });

/**
 * The Event catalogue: every journaled Event type and the schema of its
 * payload. Types are `<object>.<past_tense_verb>`. Transient stream Events
 * (`stream.*`) are not journaled and are not listed here.
 */
export const EVENT_CATALOGUE = {
  "workspace.created": workspaceSchema,
  "workspace.updated": workspaceSchema,
  "conversation.created": conversationSchema,
  "conversation.updated": conversationSchema,
  "conversation.message_posted": conversationMessageSchema,
  "run.created": runSchema,
  "run.started": transition(RUN_STATUSES),
  "run.waiting": z.strictObject({ from: z.enum(RUN_STATUSES), to: z.literal("waiting"), waitReason: z.enum(RUN_WAIT_REASONS) }),
  "run.wait_cleared": z.strictObject({ from: z.literal("waiting"), to: z.literal("running"), clearedWaitReason: z.enum(RUN_WAIT_REASONS) }),
  "run.verifying": transition(RUN_STATUSES),
  "run.verification_failed": transition(RUN_STATUSES),
  "run.awaiting_signoff": transition(RUN_STATUSES),
  "run.changes_requested": transition(RUN_STATUSES),
  "run.completed": z.strictObject({ from: z.enum(RUN_STATUSES), to: z.literal("completed"), finalSnapshotId: idSchema("snapshot") }),
  "run.failed": z.strictObject({ from: z.enum(RUN_STATUSES), to: z.literal("failed"), failure: runFailureSchema }),
  "run.cancelled": transition(RUN_STATUSES),
  "run.published": publicationSchema,
  "run.publish_failed": publicationSchema,
  "execution_plan.revised": executionPlanRevisionSchema,
  /** The complete compiled graph of one accepted revision: its membership, member nodes, edges, and scope rows. */
  "execution_plan.compiled": z.strictObject({
    runId: idSchema("run"),
    revisionNumber: z.number().int().min(1),
    membership: z.array(planRevisionNodeSchema),
    nodes: z.array(planNodeSchema),
    edges: z.array(planEdgeSchema),
    requirements: z.array(planNodeRequirementSchema),
    createdNodeIds: uniqueIds(idSchema("planNode")),
    reusedNodeIds: uniqueIds(idSchema("planNode")),
    cancelledNodeIds: uniqueIds(idSchema("planNode")),
  }),
  /** A proposal that was not accepted: no revision number is consumed and nothing else is written. */
  "execution_plan.rejected": z.strictObject({
    runId: idSchema("run"),
    proposedByInvocationId: idSchema("invocation").nullable(),
    currentRevisionNumber: z.number().int().min(1),
    reasons: z.array(planRejectionReasonSchema).min(1),
  }),
  "plan_node.created": planNodeSchema,
  "plan_node.ready": transition(PLAN_NODE_STATUSES),
  "plan_node.started": transition(PLAN_NODE_STATUSES),
  "plan_node.waiting": z.strictObject({ from: z.enum(PLAN_NODE_STATUSES), to: z.literal("waiting"), waitReason: z.enum(PLAN_NODE_WAIT_REASONS) }),
  "plan_node.wait_cleared": transition(PLAN_NODE_STATUSES),
  "plan_node.succeeded": z.strictObject({ from: z.enum(PLAN_NODE_STATUSES), to: z.literal("succeeded"), outputArtifactIds: z.array(idSchema("artifact")) }),
  "plan_node.failed": transition(PLAN_NODE_STATUSES),
  "plan_node.cancelled": transition(PLAN_NODE_STATUSES),
  "plan_node.skipped": transition(PLAN_NODE_STATUSES),
  "requirement_revision.created": requirementRevisionSchema,
  "requirement.created": z.strictObject({ requirementId: idSchema("requirement"), requirementRevisionId: idSchema("requirementRevision") }),
  "requirement.status_changed": z.strictObject({
    requirementId: idSchema("requirement"),
    from: z.enum(REQUIREMENT_STATUSES),
    to: z.enum(REQUIREMENT_STATUSES),
    actor: z.enum(REQUIREMENT_STATUS_ACTORS),
    evidence: z.array(evidenceSchema),
    gateId: idSchema("gate").nullable(),
    decisionId: idSchema("decision").nullable(),
  }),
  "acceptance_criterion.created": acceptanceCriterionSchema,
  "decision.requested": decisionSchema,
  "decision.resolved": z.strictObject({ decisionId: idSchema("decision"), kind: nonEmptyString, resolution: decisionResolutionSchema }),
  "decision.superseded": z.strictObject({ decisionId: idSchema("decision"), supersededByDecisionId: idSchema("decision") }),
  "task.created": taskSchema,
  "task.dependency_added": taskDependencySchema,
  "task.ready": transition(TASK_STATUSES),
  "task.started": z.strictObject({ from: z.enum(TASK_STATUSES), to: z.literal("running"), invocationId: idSchema("invocation") }),
  "task.blocked": z.strictObject({ from: z.enum(TASK_STATUSES), to: z.literal("blocked"), blockReason: taskBlockReasonSchema }),
  "task.completed": z.strictObject({ from: z.enum(TASK_STATUSES), to: z.literal("completed"), outputArtifactIds: z.array(idSchema("artifact")), evidence: z.array(evidenceSchema) }),
  "task.failed": z.strictObject({ from: z.enum(TASK_STATUSES), to: z.literal("failed"), failureReason: z.enum(TASK_FAILURE_REASONS) }),
  "task.cancelled": transition(TASK_STATUSES),
  "artifact.created": artifactSchema,
  "handoff.created": handoffSchema,
  "handoff.delivered": z.strictObject({ handoffId: idSchema("handoff") }),
  "handoff.cancelled": z.strictObject({ handoffId: idSchema("handoff") }),
  "agent_definition.created": agentDefinitionSchema,
  "agent_definition_revision.created": agentDefinitionRevisionSchema,
  "invocation.created": invocationSchema,
  "invocation.started": z.strictObject({ invocationId: idSchema("invocation") }),
  "invocation.waiting": z.strictObject({ invocationId: idSchema("invocation"), waitReason: z.enum(INVOCATION_WAIT_REASONS) }),
  "invocation.wait_cleared": z.strictObject({ invocationId: idSchema("invocation") }),
  /** Terminal: an `approval_required` call was intercepted; the Decision's subject names the call by digest and Artifact, never by bytes. */
  "invocation.blocked": z.strictObject({ invocationId: idSchema("invocation"), decisionId: idSchema("decision") }),
  /** A writing Invocation's worktree exists and must be released once the Invocation is terminal. */
  "invocation.workspace_prepared": z.strictObject({ invocationId: idSchema("invocation"), worktreePath: nonEmptyString }),
  /** The external release succeeded; recorded only afterwards, so a crash in between leaves the obligation pending for recovery. */
  "invocation.workspace_released": z.strictObject({ invocationId: idSchema("invocation") }),
  "invocation.succeeded": z.strictObject({ invocationId: idSchema("invocation"), result: invocationResultSchema }),
  "invocation.failed": z.strictObject({ invocationId: idSchema("invocation"), failureReason: z.enum(INVOCATION_FAILURE_REASONS) }),
  "invocation.cancelled": z.strictObject({ invocationId: idSchema("invocation") }),
  "context_manifest.created": contextManifestSchema,
  "attempt.created": attemptSchema,
  "attempt.started": z.strictObject({ attemptId: idSchema("attempt"), capacityLeaseId: idSchema("capacityLease").nullable() }),
  "attempt.succeeded": z.strictObject({ attemptId: idSchema("attempt"), transcriptArtifactId: idSchema("artifact").nullable() }),
  "attempt.failed": z.strictObject({ attemptId: idSchema("attempt"), failureClass: z.enum(ATTEMPT_FAILURE_CLASSES) }),
  "attempt.timed_out": z.strictObject({ attemptId: idSchema("attempt") }),
  "attempt.interrupted": z.strictObject({ attemptId: idSchema("attempt") }),
  "attempt.cancelled": z.strictObject({ attemptId: idSchema("attempt") }),
  /** One approval grant was claimed, in its own committed transaction, before the call could execute; ids, tool, and digest only, never the call bytes. */
  "approved_tool_call.used": approvedToolCallUseSchema,
  "evaluation.recorded": evaluationSchema,
  "gate.opened": gateSchema,
  "gate.passed": z.strictObject({ gateId: idSchema("gate") }),
  "gate.failed": z.strictObject({ gateId: idSchema("gate") }),
  "snapshot.taken": snapshotSchema,
  "changeset.recorded": changesetSchema,
  "changeset.integrated": z.strictObject({ changesetId: idSchema("changeset"), integratedSnapshotId: idSchema("snapshot") }),
  "changeset.conflicted": z.strictObject({ changesetId: idSchema("changeset"), conflictTaskId: idSchema("task") }),
  "capacity_lease.granted": capacityLeaseSchema,
  "capacity_lease.released": z.strictObject({ leaseId: idSchema("capacityLease") }),
  "budget_reservation.created": budgetReservationSchema,
  "budget_reservation.released": z.strictObject({
    reservationId: idSchema("budgetReservation"),
    releaseReason: z.enum(RESERVATION_RELEASE_REASONS),
    consumed: z.strictObject({ costUsd: z.number(), tokens: z.number(), attempts: z.number() }),
  }),
  "usage.recorded": usageSchema,
} as const;

export type EventType = keyof typeof EVENT_CATALOGUE;
export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as EventType[];

export type EventPayload<T extends EventType> = z.output<(typeof EVENT_CATALOGUE)[T]>;

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.hasOwn(EVENT_CATALOGUE, value);
}

export function validateEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return parseOrThrow(EVENT_CATALOGUE[type] as z.ZodType<EventPayload<T>>, payload, `payload of ${type}`);
}

/** One append-only journal entry. The sequence number is its stable identity. */
export interface Event<T extends EventType = EventType> {
  seq: number;
  type: T;
  occurredAt: Timestamp;
  scope: EventScope;
  actor: EventActor;
  subjectType: string;
  subjectId: string;
  payload: EventPayload<T>;
  /** Groups Events caused by one external request or command. */
  correlationId: string | null;
  /** The Event that directly caused this one. */
  causationSeq: number | null;
}

export interface EventInput<T extends EventType = EventType> {
  type: T;
  scope: EventScope;
  actor: EventActor;
  subjectType: string;
  subjectId: string;
  payload: EventPayload<T>;
  correlationId: string | null;
  causationSeq: number | null;
}

export const eventEnvelopeSchema = z.strictObject({
  seq: z.number().int().min(1),
  type: z.string().refine(isEventType, { message: "unknown Event type" }),
  occurredAt: timestampSchema,
  scope: eventScopeSchema,
  actor: eventActorSchema,
  subjectType: nonEmptyString,
  subjectId: nonEmptyString,
  payload: z.unknown(),
  correlationId: nonEmptyString.nullable(),
  causationSeq: z.number().int().min(1).nullable(),
});

/** The `run.*` Event type a Run transition produces. */
export function runTransitionEventType(from: string, to: string): EventType {
  switch (to) {
    case "running":
      if (from === "waiting") return "run.wait_cleared";
      if (from === "verifying") return "run.verification_failed";
      if (from === "awaiting_signoff") return "run.changes_requested";
      return "run.started";
    case "waiting":
      return "run.waiting";
    case "verifying":
      return "run.verifying";
    case "awaiting_signoff":
      return "run.awaiting_signoff";
    case "completed":
      return "run.completed";
    case "failed":
      return "run.failed";
    case "cancelled":
      return "run.cancelled";
    default:
      throw new Error(`no run Event for transition ${from} -> ${to}`);
  }
}

/** The `plan_node.*` Event type a Plan Node transition produces. */
export function planNodeTransitionEventType(from: string, to: string): EventType {
  switch (to) {
    case "ready":
      return "plan_node.ready";
    case "running":
      return from === "waiting" ? "plan_node.wait_cleared" : "plan_node.started";
    case "waiting":
      return "plan_node.waiting";
    case "succeeded":
      return "plan_node.succeeded";
    case "failed":
      return "plan_node.failed";
    case "cancelled":
      return "plan_node.cancelled";
    case "skipped":
      return "plan_node.skipped";
    default:
      throw new Error(`no plan_node Event for transition ${from} -> ${to}`);
  }
}
