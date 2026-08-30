import { z } from "zod";
import { allocationSchema, FINAL_RESERVE_USES, type Allocation, type FinalReserveUse } from "./budgets.ts";
import { DECISION_KINDS, type DecisionKind } from "./decisions.ts";
import { ValidationError } from "./errors.ts";
import { handoffEndpointSchema, HANDOFF_MAX_SUMMARY_LENGTH, type HandoffEndpoint } from "./handoffs.ts";
import type {
  AcceptanceCriterionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  AttemptId,
  CapacityLeaseId,
  ContextManifestId,
  ConversationMessageId,
  DecisionId,
  GateId,
  HandoffId,
  InvocationId,
  PlanNodeId,
  PublicationId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  SnapshotId,
  TaskId,
} from "./ids.ts";
import { PLAN_NODE_STATUSES, planRejectionReasonSchema, type PlanNodeStatus, type PlanRejectionReason } from "./plans.ts";
import { acceptanceCheckSchema, evidenceSchema, REQUIREMENT_STATUSES, type AcceptanceCheck, type Evidence, type RequirementStatus } from "./requirements.ts";
import { agentCapabilitiesSchema, modelPolicySchema, toolPolicySchema, type AgentCapabilities, type ModelPolicy, type ToolPolicy } from "./agents.ts";
import { defineStateMachine } from "./transitions.ts";
import {
  count,
  idSchema,
  nonEmptyString,
  positiveCount,
  sha256Hex,
  timestampSchema,
  uniqueIds,
  type Timestamp,
} from "./validation.ts";
import { approvedToolCallSchema, SIDE_EFFECT_APPROVAL_OPTIONS, type ApprovedToolCall, type SideEffectApprovalOption } from "./tool-calls.ts";
import { PUBLICATION_OUTCOMES, type PublicationOutcome } from "./workspace-state.ts";

// ---------------------------------------------------------------------------
// Roles and purposes (closed)
// ---------------------------------------------------------------------------

export const INVOCATION_ROLES = ["orchestrator", "worker", "coordinator", "evaluator"] as const;
export type InvocationRole = (typeof INVOCATION_ROLES)[number];

export const ORCHESTRATOR_PURPOSES = [
  "operator_input",
  "plan_revision",
  "node_result",
  "decision_resolution",
  "gate_result",
  "publication_result",
  "final_synthesis",
] as const;
export const WORKER_PURPOSES = ["step", "task"] as const;
export const EVALUATOR_PURPOSES = ["select", "evaluate"] as const;
export const COORDINATOR_PURPOSES = ["decompose", "replan", "synthesize"] as const;

/** The closed set of Invocation purposes; every purpose belongs to exactly one role. */
export const INVOCATION_PURPOSES = [
  ...ORCHESTRATOR_PURPOSES,
  ...WORKER_PURPOSES,
  ...EVALUATOR_PURPOSES,
  ...COORDINATOR_PURPOSES,
] as const;
export type InvocationPurpose = (typeof INVOCATION_PURPOSES)[number];

export type OrchestratorPurpose = (typeof ORCHESTRATOR_PURPOSES)[number];
export type WorkerPurpose = (typeof WORKER_PURPOSES)[number];
export type EvaluatorPurpose = (typeof EVALUATOR_PURPOSES)[number];
export type CoordinatorPurpose = (typeof COORDINATOR_PURPOSES)[number];

export const PURPOSES_BY_ROLE: Readonly<Record<InvocationRole, readonly InvocationPurpose[]>> = {
  orchestrator: ORCHESTRATOR_PURPOSES,
  worker: WORKER_PURPOSES,
  evaluator: EVALUATOR_PURPOSES,
  coordinator: COORDINATOR_PURPOSES,
};

export function roleOfPurpose(purpose: InvocationPurpose): InvocationRole {
  for (const role of INVOCATION_ROLES) {
    if (PURPOSES_BY_ROLE[role].includes(purpose)) return role;
  }
  throw new ValidationError(`unknown Invocation purpose ${String(purpose)}`);
}

export function assertPurposeForRole(role: InvocationRole, purpose: InvocationPurpose): void {
  if (!PURPOSES_BY_ROLE[role].includes(purpose)) {
    throw new ValidationError(`purpose ${purpose} is not valid for role ${role}`, { role, purpose });
  }
}

// ---------------------------------------------------------------------------
// Allocation source (closed)
// ---------------------------------------------------------------------------

/**
 * Where an Invocation's allocation is reserved from: its Plan Node (every
 * ordinary Invocation, including transferred Coordinator Task reservations)
 * or the Run's persisted final reserve directly (only the two uses in
 * `FINAL_RESERVE_USES`, which stay attached to the root Plan Node for scope,
 * progress, Event attribution, and Usage roll-up but never consume its
 * ordinary allocation).
 */
export const INVOCATION_ALLOCATION_SOURCES = ["plan_node", "run_final_reserve"] as const;
export type InvocationAllocationSource = (typeof INVOCATION_ALLOCATION_SOURCES)[number];

/** The role and purpose each final-reserve use requires; anything else cannot spend the reserve. */
export const FINAL_RESERVE_USE_BINDINGS: Readonly<Record<FinalReserveUse, { role: InvocationRole; purpose: InvocationPurpose }>> = {
  final_synthesis: { role: "orchestrator", purpose: "final_synthesis" },
  run_completion: { role: "evaluator", purpose: "evaluate" },
};

export interface InvocationFunding {
  allocationSource: InvocationAllocationSource;
  finalReserveUse: FinalReserveUse | null;
}

/** Why an Invocation's funding is inconsistent with its role and purpose; empty when it is consistent. */
export function invocationFundingDefects(invocation: Pick<Invocation, "role" | "purpose"> & InvocationFunding): string[] {
  const defects: string[] = [];
  if ((invocation.allocationSource === "run_final_reserve") !== (invocation.finalReserveUse !== null)) {
    defects.push("a final-reserve Invocation names its use and an ordinary Invocation names none");
  }
  if (invocation.finalReserveUse !== null) {
    const binding = FINAL_RESERVE_USE_BINDINGS[invocation.finalReserveUse];
    if (invocation.role !== binding.role || invocation.purpose !== binding.purpose) {
      defects.push(`final-reserve use ${invocation.finalReserveUse} requires role ${binding.role} with purpose ${binding.purpose}, not ${invocation.role}/${invocation.purpose}`);
    }
  }
  return defects;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * `waiting` is a pause after which the same Invocation can still start or
 * continue (capacity, Budget, operator); `blocked` is terminal: the provider
 * execution is over because an `approval_required` capability call was
 * intercepted, and the logical continuation is a successor Invocation with
 * `continuedFromInvocationId` set once the `side_effect_approval` Decision
 * is resolved.
 */
export const INVOCATION_STATUSES = ["pending", "running", "waiting", "blocked", "succeeded", "failed", "cancelled"] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const INVOCATION_WAIT_REASONS = ["decision", "budget", "provider_capacity", "operator"] as const;
export type InvocationWaitReason = (typeof INVOCATION_WAIT_REASONS)[number];

export const INVOCATION_FAILURE_REASONS = [
  "attempts_exhausted",
  "provider_permanent",
  "allocation_exhausted",
  "result_invalid",
  "cancelled",
] as const;
export type InvocationFailureReason = (typeof INVOCATION_FAILURE_REASONS)[number];

/**
 * The Invocation's Execution Workspace cleanup obligation (execution-model
 * §9.1): `none` for a read-only Invocation (it runs against the Integration
 * Workspace and owns nothing to clean up), `pending` from the moment a
 * writing Invocation's worktree was prepared until the external release
 * succeeded, `released` afterwards. The obligation outlives the Invocation's
 * terminal transition on purpose: canonical settlement commits first, the
 * destructive external cleanup follows, and restart recovery retries every
 * obligation still `pending` on a terminal Invocation.
 */
export const WORKSPACE_CLEANUP_STATES = ["none", "pending", "released"] as const;
export type WorkspaceCleanupState = (typeof WORKSPACE_CLEANUP_STATES)[number];

export const RESULT_STATUSES = ["completed", "failed", "blocked"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const TASK_RESULT_STATUSES = ["completed", "blocked", "failed"] as const;
export type TaskResultStatus = (typeof TASK_RESULT_STATUSES)[number];

export interface TaskResult {
  taskId: TaskId;
  status: TaskResultStatus;
  evidence: Evidence[];
  blocker: string | null;
}

/** The typed result every Attempt returns through `return_result`. */
export interface InvocationResult {
  status: ResultStatus;
  artifactIds: ArtifactId[];
  tasks: TaskResult[];
  evidence: Evidence[];
  summary: string;
  openItems: string[];
  blocker: string | null;
  runOutcome: { kind: "infeasible"; evidence: Evidence[] } | null;
}

export const RESULT_MAX_SUMMARY_LENGTH = 500;
export const RESULT_MAX_OPEN_ITEMS = 10;

/** Every non-terminal status: an Invocation in one of these holds its Plan Node's turn. */
export const ACTIVE_INVOCATION_STATUSES = ["pending", "running", "waiting"] as const satisfies readonly InvocationStatus[];

// ---------------------------------------------------------------------------
// Result validation violations (closed)
// ---------------------------------------------------------------------------

/**
 * Why a candidate result is invalid (execution-model §6.3). The runtime
 * persists a bounded list of these on the failed Attempt so a retry can be
 * rendered deterministically after a restart without re-validating.
 */
export const RESULT_VIOLATION_CODES = [
  "malformed",
  "unknown_artifact",
  "foreign_artifact",
  "unknown_task",
  "foreign_task",
  "task_not_assigned",
  "task_report_not_permitted",
  "task_without_evidence",
  "task_missing_outputs",
  "unknown_evidence_reference",
  "foreign_evidence_reference",
  "run_outcome_not_permitted",
  "run_outcome_without_evidence",
  "changeset_missing",
  "status_incompatible",
] as const;
export type ResultViolationCode = (typeof RESULT_VIOLATION_CODES)[number];

export interface ResultViolation {
  code: ResultViolationCode;
  message: string;
  /** The result path the violation concerns, when one applies. */
  path: string | null;
}

export const RESULT_VIOLATION_MAX_MESSAGE_LENGTH = 300;
export const RESULT_MAX_VIOLATIONS = 20;

export const resultViolationSchema: z.ZodType<ResultViolation> = z.strictObject({
  code: z.enum(RESULT_VIOLATION_CODES),
  message: nonEmptyString.max(RESULT_VIOLATION_MAX_MESSAGE_LENGTH),
  path: nonEmptyString.nullable(),
});

/** Bounds a message for persistence: single line, capped length, never a stack trace. */
export function boundedFailureMessage(message: string, max = ATTEMPT_FAILURE_MAX_MESSAGE_LENGTH): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  const safe = trimmed.length > 0 ? trimmed : "failure";
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

/** Caps a violation list at `RESULT_MAX_VIOLATIONS`, bounding every message. */
export function boundResultViolations(violations: readonly ResultViolation[]): ResultViolation[] {
  return violations.slice(0, RESULT_MAX_VIOLATIONS).map((v) => ({ ...v, message: boundedFailureMessage(v.message, RESULT_VIOLATION_MAX_MESSAGE_LENGTH) }));
}

export const invocationResultSchema: z.ZodType<InvocationResult> = z
  .strictObject({
    status: z.enum(RESULT_STATUSES),
    artifactIds: uniqueIds(idSchema("artifact")),
    tasks: z.array(
      z
        .strictObject({
          taskId: idSchema("task"),
          status: z.enum(TASK_RESULT_STATUSES),
          evidence: z.array(evidenceSchema),
          blocker: nonEmptyString.nullable(),
        })
        .refine((t) => t.status !== "completed" || t.evidence.length > 0, {
          message: "a completed Task carries Evidence",
          path: ["evidence"],
        })
        .refine((t) => t.status !== "blocked" || t.blocker !== null, {
          message: "a blocked Task names its blocker",
          path: ["blocker"],
        }),
    ),
    evidence: z.array(evidenceSchema),
    summary: z.string().max(RESULT_MAX_SUMMARY_LENGTH),
    openItems: z.array(nonEmptyString).max(RESULT_MAX_OPEN_ITEMS),
    blocker: nonEmptyString.nullable(),
    runOutcome: z
      .strictObject({ kind: z.literal("infeasible"), evidence: z.array(evidenceSchema).min(1) })
      .nullable(),
  })
  .refine((r) => (r.status === "blocked") === (r.blocker !== null), {
    message: "blocker is set exactly for a blocked result",
    path: ["blocker"],
  });

export interface Invocation {
  id: InvocationId;
  runId: RunId;
  planNodeId: PlanNodeId;
  role: InvocationRole;
  purpose: InvocationPurpose;
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  continuedFromInvocationId: InvocationId | null;
  taskIds: TaskId[];
  /** The explicit allocation reserved before the Invocation starts, from the source named by `allocationSource`. */
  allocation: Allocation;
  allocationSource: InvocationAllocationSource;
  finalReserveUse: FinalReserveUse | null;
  status: InvocationStatus;
  waitReason: InvocationWaitReason | null;
  failureReason: InvocationFailureReason | null;
  /** The open `side_effect_approval` Decision that ended the Invocation `blocked`; set exactly then. */
  blockedByDecisionId: DecisionId | null;
  result: InvocationResult | null;
  workspaceCleanup: WorkspaceCleanupState;
  workspaceReleasedAt: Timestamp | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export const INVOCATION_MACHINE = defineStateMachine<InvocationStatus>("Invocation", INVOCATION_STATUSES, {
  pending: ["running", "cancelled"],
  running: ["waiting", "blocked", "succeeded", "failed", "cancelled"],
  waiting: ["running", "succeeded", "failed", "cancelled"],
  blocked: [],
  succeeded: [],
  failed: [],
  cancelled: [],
});

export const invocationSchema: z.ZodType<Invocation> = z
  .strictObject({
    id: idSchema("invocation"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    role: z.enum(INVOCATION_ROLES),
    purpose: z.enum(INVOCATION_PURPOSES),
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
    continuedFromInvocationId: idSchema("invocation").nullable(),
    taskIds: uniqueIds(idSchema("task")),
    allocation: allocationSchema,
    allocationSource: z.enum(INVOCATION_ALLOCATION_SOURCES),
    finalReserveUse: z.enum(FINAL_RESERVE_USES).nullable(),
    status: z.enum(INVOCATION_STATUSES),
    waitReason: z.enum(INVOCATION_WAIT_REASONS).nullable(),
    failureReason: z.enum(INVOCATION_FAILURE_REASONS).nullable(),
    blockedByDecisionId: idSchema("decision").nullable(),
    result: invocationResultSchema.nullable(),
    workspaceCleanup: z.enum(WORKSPACE_CLEANUP_STATES),
    workspaceReleasedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .refine((i) => PURPOSES_BY_ROLE[i.role].includes(i.purpose), {
    message: "purpose must belong to the Invocation's role",
    path: ["purpose"],
  })
  .refine((i) => (i.workspaceCleanup === "released") === (i.workspaceReleasedAt !== null), {
    message: "workspaceReleasedAt is set exactly when the Workspace cleanup is released",
    path: ["workspaceReleasedAt"],
  })
  .refine((i) => (i.status === "waiting") === (i.waitReason !== null), {
    message: "waitReason is set exactly when the Invocation is waiting",
    path: ["waitReason"],
  })
  .refine((i) => (i.status === "failed") === (i.failureReason !== null), {
    message: "failureReason is set exactly when the Invocation failed",
    path: ["failureReason"],
  })
  .refine((i) => (i.status === "blocked") === (i.blockedByDecisionId !== null), {
    message: "blockedByDecisionId is set exactly when the Invocation is blocked",
    path: ["blockedByDecisionId"],
  })
  .refine((i) => i.id !== i.continuedFromInvocationId, {
    message: "an Invocation cannot continue from itself",
    path: ["continuedFromInvocationId"],
  })
  .refine((i) => INVOCATION_MACHINE.isTerminal(i.status) === (i.endedAt !== null), {
    message: "endedAt is set exactly when the Invocation is terminal",
    path: ["endedAt"],
  })
  .refine((i) => i.allocation.attempts >= 1, {
    message: "an Invocation allocation permits at least one Attempt",
    path: ["allocation", "attempts"],
  })
  .refine((i) => invocationFundingDefects(i).length === 0, {
    message: "the Invocation's allocation source and final-reserve use agree with its role and purpose",
    path: ["finalReserveUse"],
  })
  .refine((i) => i.allocationSource === "plan_node" || i.taskIds.length === 0, {
    message: "a final-reserve Invocation executes no Task",
    path: ["taskIds"],
  });

export interface InvocationInput {
  runId: RunId;
  planNodeId: PlanNodeId;
  role: InvocationRole;
  purpose: InvocationPurpose;
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  continuedFromInvocationId: InvocationId | null;
  taskIds: TaskId[];
  allocation: Allocation;
  /** Defaults to `plan_node`; `run_final_reserve` requires a `finalReserveUse`. */
  allocationSource?: InvocationAllocationSource;
  finalReserveUse?: FinalReserveUse | null;
}

export const invocationInputSchema: z.ZodType<InvocationInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    role: z.enum(INVOCATION_ROLES),
    purpose: z.enum(INVOCATION_PURPOSES),
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
    continuedFromInvocationId: idSchema("invocation").nullable(),
    taskIds: uniqueIds(idSchema("task")),
    allocation: allocationSchema,
    allocationSource: z.enum(INVOCATION_ALLOCATION_SOURCES).optional(),
    finalReserveUse: z.enum(FINAL_RESERVE_USES).nullable().optional(),
  })
  .refine((i) => PURPOSES_BY_ROLE[i.role].includes(i.purpose), {
    message: "purpose must belong to the Invocation's role",
    path: ["purpose"],
  })
  .refine((i) => i.allocation.attempts >= 1, {
    message: "an Invocation allocation permits at least one Attempt",
    path: ["allocation", "attempts"],
  })
  .refine((i) => invocationFundingDefects({ ...i, allocationSource: i.allocationSource ?? "plan_node", finalReserveUse: i.finalReserveUse ?? null }).length === 0, {
    message: "the Invocation's allocation source and final-reserve use agree with its role and purpose",
    path: ["finalReserveUse"],
  })
  .refine((i) => (i.allocationSource ?? "plan_node") === "plan_node" || i.taskIds.length === 0, {
    message: "a final-reserve Invocation executes no Task",
    path: ["taskIds"],
  });

export type InvocationTransition =
  | { to: "running" }
  | { to: "waiting"; waitReason: InvocationWaitReason }
  | { to: "blocked"; decisionId: DecisionId }
  | { to: "succeeded"; result: InvocationResult }
  | { to: "failed"; failureReason: InvocationFailureReason; result: InvocationResult | null }
  | { to: "cancelled" };

// ---------------------------------------------------------------------------
// Attempt
// ---------------------------------------------------------------------------

/** `initial` or `retry`; there is no other kind. */
export const ATTEMPT_KINDS = ["initial", "retry"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const ATTEMPT_START_MODES = ["fresh", "resumed"] as const;
export type AttemptStartMode = (typeof ATTEMPT_START_MODES)[number];

export const ATTEMPT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** The runtime's classification of an Attempt failure (execution-model §7.2). */
export const ATTEMPT_FAILURE_CLASSES = [
  "provider_transient",
  "provider_permanent",
  "result_invalid",
  "allocation_exhausted",
  "interrupted",
  "tool_failure",
] as const;
export type AttemptFailureClass = (typeof ATTEMPT_FAILURE_CLASSES)[number];

/**
 * A `pending` Attempt that never reached the provider (its process ended
 * first) is `interrupted` by recovery like a running one, keeping its
 * consumed Attempt; it never becomes `running` retroactively.
 */
export const ATTEMPT_MACHINE = defineStateMachine<AttemptStatus>("Attempt", ATTEMPT_STATUSES, {
  pending: ["running", "interrupted", "cancelled"],
  running: ["succeeded", "failed", "timed_out", "interrupted", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  interrupted: [],
  cancelled: [],
});

/** Statuses after which the runtime may create a `retry` Attempt (if allocation remains). */
export const RETRYABLE_ATTEMPT_STATUSES = ["failed", "timed_out", "interrupted"] as const satisfies readonly AttemptStatus[];

// ---------------------------------------------------------------------------
// Bounded failure detail and durable retry decision
// ---------------------------------------------------------------------------

export const ATTEMPT_FAILURE_MAX_MESSAGE_LENGTH = 500;

/**
 * The sanitized, bounded record of why an Attempt ended without a valid
 * result: enough to render a retry appendix after a restart, never a
 * transcript, raw provider message, complete tool output, secret, or stack
 * trace.
 */
export interface AttemptFailureDetail {
  message: string;
  /** The exact result-validation violations for `result_invalid`; empty otherwise. */
  violations: ResultViolation[];
  /** The capability tool concerned by a `tool_failure` or an approval-required outcome. */
  tool: string | null;
  /** True when the interruption was a cancellation, which forbids a retry. */
  cancelled: boolean;
}

export const attemptFailureDetailSchema: z.ZodType<AttemptFailureDetail> = z.strictObject({
  message: nonEmptyString.max(ATTEMPT_FAILURE_MAX_MESSAGE_LENGTH),
  violations: z.array(resultViolationSchema).max(RESULT_MAX_VIOLATIONS),
  tool: nonEmptyString.nullable(),
  cancelled: z.boolean(),
});

/** Why another Attempt is permitted after this one (execution-model §7.2, §14). */
export const RETRY_PERMITTED_REASONS = ["provider_transient", "result_invalid", "interrupted", "tool_failure"] as const;
/** Why no further Attempt is permitted after this one. */
export const RETRY_REFUSED_REASONS = [
  "provider_permanent",
  "allocation_exhausted",
  "attempts_exhausted",
  "wall_clock_exhausted",
  "cancelled",
  "tool_failure_retried",
  "approval_required",
] as const;
export const RETRY_DECISION_REASONS = [...RETRY_PERMITTED_REASONS, ...RETRY_REFUSED_REASONS] as const;
export type RetryPermittedReason = (typeof RETRY_PERMITTED_REASONS)[number];
export type RetryRefusedReason = (typeof RETRY_REFUSED_REASONS)[number];
export type RetryDecisionReason = (typeof RETRY_DECISION_REASONS)[number];

/**
 * The durable retry eligibility recorded on a terminal Attempt: whether the
 * Invocation may create another Attempt, why, and the earliest time. It is
 * persisted with the Attempt's terminal transition so that a restart reads
 * the exact decision rather than recomputing it from possibly changed
 * process configuration.
 */
export interface RetryDecision {
  permitted: boolean;
  reason: RetryDecisionReason;
  /** The deterministic backoff deadline for a permitted retry; `null` when the retry may start at once or none is permitted. */
  notBefore: Timestamp | null;
}

export const retryDecisionSchema: z.ZodType<RetryDecision> = z
  .strictObject({
    permitted: z.boolean(),
    reason: z.enum(RETRY_DECISION_REASONS),
    notBefore: timestampSchema.nullable(),
  })
  .refine((d) => d.permitted === (RETRY_PERMITTED_REASONS as readonly string[]).includes(d.reason), {
    message: "a permitted retry names a permitting reason; a refused one names a refusing reason",
    path: ["reason"],
  })
  .refine((d) => d.permitted || d.notBefore === null, {
    message: "only a permitted retry carries a notBefore time",
    path: ["notBefore"],
  });

/** Deterministic exponential backoff with no randomness: `base × 2^(attemptNumber − 1)`, capped. */
export function retryBackoffMs(attemptNumber: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/**
 * The one Invocation-wide wall-clock deadline (execution-model §7.6):
 * `Invocation.startedAt + Context Manifest.maxWallClockMs`, or `null` when
 * the Invocation is unbounded or has not started. Every Attempt of the
 * Invocation, every retry backoff, and every restart derives the same
 * absolute instant from these two persisted facts; nothing resets it.
 */
export function invocationDeadlineAt(startedAt: Timestamp | null, maxWallClockMs: number | null): Timestamp | null {
  if (startedAt === null || maxWallClockMs === null) return null;
  return new Date(Date.parse(startedAt) + maxWallClockMs).toISOString();
}

export interface Attempt {
  id: AttemptId;
  invocationId: InvocationId;
  runId: RunId;
  planNodeId: PlanNodeId;
  /** Numbered from 1 within the Invocation. */
  number: number;
  kind: AttemptKind;
  startMode: AttemptStartMode;
  resumedFromAttemptId: AttemptId | null;
  status: AttemptStatus;
  failureClass: AttemptFailureClass | null;
  failureDetail: AttemptFailureDetail | null;
  retryDecision: RetryDecision | null;
  transcriptArtifactId: ArtifactId | null;
  capacityLeaseId: CapacityLeaseId | null;
  result: InvocationResult | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export const attemptSchema: z.ZodType<Attempt> = z
  .strictObject({
    id: idSchema("attempt"),
    invocationId: idSchema("invocation"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    number: positiveCount,
    kind: z.enum(ATTEMPT_KINDS),
    startMode: z.enum(ATTEMPT_START_MODES),
    resumedFromAttemptId: idSchema("attempt").nullable(),
    status: z.enum(ATTEMPT_STATUSES),
    failureClass: z.enum(ATTEMPT_FAILURE_CLASSES).nullable(),
    failureDetail: attemptFailureDetailSchema.nullable(),
    retryDecision: retryDecisionSchema.nullable(),
    transcriptArtifactId: idSchema("artifact").nullable(),
    capacityLeaseId: idSchema("capacityLease").nullable(),
    result: invocationResultSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .refine((a) => (a.number === 1) === (a.kind === "initial"), {
    message: "Attempt 1 is the initial Attempt; every later Attempt is a retry",
    path: ["kind"],
  })
  .refine((a) => (a.startMode === "resumed") === (a.resumedFromAttemptId !== null), {
    message: "resumedFromAttemptId is set exactly for a resumed Attempt",
    path: ["resumedFromAttemptId"],
  })
  .refine((a) => a.id !== a.resumedFromAttemptId, { message: "an Attempt cannot resume itself", path: ["resumedFromAttemptId"] })
  .refine((a) => ATTEMPT_MACHINE.isTerminal(a.status) === (a.endedAt !== null), {
    message: "endedAt is set exactly when the Attempt is terminal",
    path: ["endedAt"],
  })
  .refine((a) => a.status !== "succeeded" || (a.result !== null && a.failureClass === null && a.failureDetail === null && a.retryDecision === null), {
    message: "a succeeded Attempt carries a result and no failure class, detail, or retry decision",
    path: ["result"],
  })
  .refine(
    (a) => !(a.status === "failed" || a.status === "timed_out" || a.status === "interrupted") || a.failureClass !== null,
    { message: "a failed, timed-out, or interrupted Attempt is classified", path: ["failureClass"] },
  )
  .refine((a) => a.retryDecision === null || (ATTEMPT_MACHINE.isTerminal(a.status) && a.status !== "succeeded"), {
    message: "a retry decision is recorded only on a terminal Attempt that did not succeed",
    path: ["retryDecision"],
  })
  .refine((a) => a.failureDetail === null || ATTEMPT_MACHINE.isTerminal(a.status), {
    message: "failure detail is recorded only on a terminal Attempt",
    path: ["failureDetail"],
  })
  .refine((a) => a.status !== "cancelled" || a.retryDecision === null || !a.retryDecision.permitted, {
    message: "a cancelled Attempt never permits a retry",
    path: ["retryDecision"],
  });

/**
 * Whether a prior Attempt ended in a state the provider can safely continue
 * from (execution-model §6.6): it completed, its result was invalid (the
 * provider finished and may correct it), or it was interrupted or hit a
 * transient provider error without being cancelled. Permanent failures,
 * tool failures, cancellations, and allocation exhaustion are never
 * continued.
 */
export function isContinuationSafeTermination(attempt: Pick<Attempt, "status" | "failureClass" | "failureDetail">): boolean {
  if (attempt.status === "succeeded") return true;
  if (attempt.status === "cancelled" || !ATTEMPT_MACHINE.isTerminal(attempt.status)) return false;
  if (attempt.failureDetail?.cancelled) return false;
  return attempt.failureClass === "result_invalid" || attempt.failureClass === "interrupted" || attempt.failureClass === "provider_transient";
}

export interface AttemptInput {
  invocationId: InvocationId;
  startMode: AttemptStartMode;
  resumedFromAttemptId: AttemptId | null;
}

export const attemptInputSchema: z.ZodType<AttemptInput> = z
  .strictObject({
    invocationId: idSchema("invocation"),
    startMode: z.enum(ATTEMPT_START_MODES),
    resumedFromAttemptId: idSchema("attempt").nullable(),
  })
  .refine((a) => (a.startMode === "resumed") === (a.resumedFromAttemptId !== null), {
    message: "resumedFromAttemptId is set exactly for a resumed Attempt",
    path: ["resumedFromAttemptId"],
  });

/** The bounded failure record and durable retry decision a terminal-failure transition carries. */
export interface AttemptFailureRecord {
  failureDetail?: AttemptFailureDetail | null;
  retryDecision?: RetryDecision | null;
}

export type AttemptTransition =
  | { to: "running"; capacityLeaseId: CapacityLeaseId | null }
  | { to: "succeeded"; result: InvocationResult; transcriptArtifactId: ArtifactId | null }
  | ({ to: "failed"; failureClass: Exclude<AttemptFailureClass, "interrupted">; transcriptArtifactId: ArtifactId | null } & AttemptFailureRecord)
  | ({ to: "timed_out"; transcriptArtifactId: ArtifactId | null } & AttemptFailureRecord)
  | ({ to: "interrupted"; transcriptArtifactId: ArtifactId | null } & AttemptFailureRecord)
  | ({ to: "cancelled"; transcriptArtifactId: ArtifactId | null } & AttemptFailureRecord);

/** The failure class each terminal-failure status implies. */
export function failureClassForTransition(transition: AttemptTransition): AttemptFailureClass | null {
  switch (transition.to) {
    case "failed":
      return transition.failureClass;
    case "timed_out":
      return "interrupted";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Context Manifest
// ---------------------------------------------------------------------------

/** The runtime tools (execution-model §6.4), the same for every role and restricted by role. */
export const RUNTIME_TOOLS = [
  "read_requirements",
  "read_decisions",
  "read_tasks",
  "read_artifact",
  "read_execution_plan",
  "read_agent_definitions",
  "write_artifact",
  "update_task",
  "create_tasks",
  "propose_tasks",
  "request_decision",
  "record_decision",
  "propose_requirements",
  "revise_execution_plan",
  "request_completion",
  "return_result",
] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

const READ_RUNTIME_TOOLS = ["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "write_artifact"] as const;

/** The role matrix of execution-model §6.4; no role receives peer messaging, scheduling control, compiled-plan writes, or transcript access. */
export const RUNTIME_TOOLS_BY_ROLE: Readonly<Record<InvocationRole, readonly RuntimeTool[]>> = {
  orchestrator: [...READ_RUNTIME_TOOLS, "update_task", "create_tasks", "request_decision", "record_decision", "propose_requirements", "revise_execution_plan", "request_completion", "return_result"],
  coordinator: [...READ_RUNTIME_TOOLS, "update_task", "propose_tasks", "request_decision", "return_result"],
  worker: [...READ_RUNTIME_TOOLS, "update_task", "request_decision", "return_result"],
  evaluator: [...READ_RUNTIME_TOOLS, "return_result"],
};

export interface ManifestRequirement {
  requirementId: RequirementId;
  statement: string;
  status: RequirementStatus;
  acceptanceCriterionIds: AcceptanceCriterionId[];
}

export interface ManifestAcceptanceCriterion {
  acceptanceCriterionId: AcceptanceCriterionId;
  requirementId: RequirementId | null;
  taskId: TaskId | null;
  check: AcceptanceCheck;
}

export interface ManifestDecision {
  decisionId: DecisionId;
  kind: DecisionKind;
  /** The answer, or `null` while the Decision is open. */
  chosenOptionId: string | null;
  /** True when the Decision was resolved after the `continuedFromInvocationId` Invocation's manifest was assembled. */
  resolvedSincePrevious: boolean;
}

export interface ManifestTask {
  taskId: TaskId;
  subject: string;
}

/** Routing metadata of a Handoff delivered to the Invocation (never free-form state). */
export interface ManifestHandoff {
  handoffId: HandoffId;
  source: HandoffEndpoint;
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  summary: string;
}

/** Bounded metadata of an Artifact the Invocation may read through `read_artifact`; content is never embedded. */
export interface ManifestArtifact {
  artifactId: ArtifactId;
  mediaType: string;
  byteSize: number;
  title: string | null;
}

/**
 * A queued logical input the runtime created the Invocation to receive
 * (execution-model §4.6): the operator's message for `operator_input`, a
 * Plan Node outcome for `node_result`, and so on. Each kind carries ids
 * and closed-set facts only.
 */
export type ManifestInput =
  | { kind: "operator_message"; conversationMessageId: ConversationMessageId; content: string }
  | { kind: "node_result"; planNodeId: PlanNodeId; status: PlanNodeStatus; outputArtifactIds: ArtifactId[] }
  | { kind: "decision_resolution"; decisionId: DecisionId }
  | {
      /** The resolved `side_effect_approval` Decision that ended the predecessor `blocked`: the successor's typed logical input. */
      kind: "side_effect_approval_resolution";
      decisionId: DecisionId;
      blockedInvocationId: InvocationId;
      attemptId: AttemptId;
      tool: string;
      callDigest: string;
      callArtifactId: ArtifactId;
      outcome: SideEffectApprovalOption;
    }
  | { kind: "gate_result"; gateId: GateId; passed: boolean }
  | { kind: "plan_revision"; accepted: boolean; revisionNumber: number | null; reasons: PlanRejectionReason[] }
  | { kind: "publication_result"; publicationId: PublicationId; outcome: PublicationOutcome };

export const manifestInputSchema: z.ZodType<ManifestInput> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator_message"), conversationMessageId: idSchema("conversationMessage"), content: z.string().min(1) }),
  z.strictObject({ kind: z.literal("node_result"), planNodeId: idSchema("planNode"), status: z.enum(PLAN_NODE_STATUSES), outputArtifactIds: uniqueIds(idSchema("artifact")) }),
  z.strictObject({ kind: z.literal("decision_resolution"), decisionId: idSchema("decision") }),
  z.strictObject({
    kind: z.literal("side_effect_approval_resolution"),
    decisionId: idSchema("decision"),
    blockedInvocationId: idSchema("invocation"),
    attemptId: idSchema("attempt"),
    tool: nonEmptyString,
    callDigest: sha256Hex,
    callArtifactId: idSchema("artifact"),
    outcome: z.enum(SIDE_EFFECT_APPROVAL_OPTIONS),
  }),
  z.strictObject({ kind: z.literal("gate_result"), gateId: idSchema("gate"), passed: z.boolean() }),
  z.strictObject({ kind: z.literal("plan_revision"), accepted: z.boolean(), revisionNumber: positiveCount.nullable(), reasons: z.array(planRejectionReasonSchema) }),
  z.strictObject({ kind: z.literal("publication_result"), publicationId: idSchema("publication"), outcome: z.enum(PUBLICATION_OUTCOMES) }),
]);

/**
 * The explicit, complete list of inputs an Invocation receives
 * (execution-model §6.2). Exactly one per Invocation, persisted before the
 * initial Attempt and never changed. Every collection is in canonical order
 * (Requirements in scope order, everything else by id), so the deterministic
 * renderer is a pure projection of this value. It never contains another
 * Invocation's transcript, a provider continuation payload or storage key,
 * provider messages, narrative status, or Artifact content.
 */
export interface ContextManifestContent {
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  agentDefinitionContentHash: string;
  instructions: string;
  /** The effective model policy of the Agent Definition revision. */
  modelPolicy: ModelPolicy;
  role: InvocationRole;
  purpose: InvocationPurpose;
  patternPosition: string | null;
  continuedFromInvocationId: InvocationId | null;
  runId: RunId;
  planNodeId: PlanNodeId;
  tasks: ManifestTask[];
  /** The pinned revision of a scoped node, or the current revision for the root node; `null` when the Conversation has none. */
  requirementRevisionId: RequirementRevisionId | null;
  requirements: ManifestRequirement[];
  acceptanceCriteria: ManifestAcceptanceCriterion[];
  decisions: ManifestDecision[];
  inputs: ManifestInput[];
  handoffs: ManifestHandoff[];
  artifacts: ManifestArtifact[];
  startingSnapshotId: SnapshotId | null;
  worktreePath: string | null;
  allocation: Allocation;
  allocationSource: InvocationAllocationSource;
  finalReserveUse: FinalReserveUse | null;
  maxWallClockMs: number | null;
  /** The effective capability set: Agent Definition ∩ role policy ∩ Workspace policy. */
  capabilities: AgentCapabilities;
  /** The effective Tool Policy over every declared tool, denied ones included. */
  toolPolicy: ToolPolicy;
  runtimeTools: RuntimeTool[];
  /**
   * Calls the operator approved once for this Invocation (from its
   * `side_effect_approval_resolution` inputs), by Decision, tool, and
   * canonical digest, ordered by digest. They widen no Tool Policy: the
   * provider boundary permits exactly these calls once and nothing else.
   */
  approvedCalls: ApprovedToolCall[];
}

const sortedIds = <T extends { [K in keyof T]: unknown }>(key: keyof T) => (items: T[]) => items.every((item, i) => i === 0 || String(items[i - 1]![key]) < String(item[key]));

export const contextManifestContentSchema: z.ZodType<ContextManifestContent> = z
  .strictObject({
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
    agentDefinitionContentHash: sha256Hex,
    instructions: z.string(),
    modelPolicy: modelPolicySchema,
    role: z.enum(INVOCATION_ROLES),
    purpose: z.enum(INVOCATION_PURPOSES),
    patternPosition: nonEmptyString.nullable(),
    continuedFromInvocationId: idSchema("invocation").nullable(),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    tasks: z.array(z.strictObject({ taskId: idSchema("task"), subject: nonEmptyString })).refine(sortedIds("taskId"), { message: "tasks are ordered by id" }),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    requirements: z.array(
      z.strictObject({
        requirementId: idSchema("requirement"),
        statement: nonEmptyString,
        status: z.enum(REQUIREMENT_STATUSES),
        acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
      }),
    ),
    acceptanceCriteria: z
      .array(
        z.strictObject({
          acceptanceCriterionId: idSchema("acceptanceCriterion"),
          requirementId: idSchema("requirement").nullable(),
          taskId: idSchema("task").nullable(),
          check: acceptanceCheckSchema,
        }),
      )
      .refine(sortedIds("acceptanceCriterionId"), { message: "acceptance criteria are ordered by id" }),
    decisions: z
      .array(z.strictObject({ decisionId: idSchema("decision"), kind: z.enum(DECISION_KINDS), chosenOptionId: nonEmptyString.nullable(), resolvedSincePrevious: z.boolean() }))
      .refine(sortedIds("decisionId"), { message: "decisions are ordered by id" }),
    inputs: z.array(manifestInputSchema),
    handoffs: z
      .array(
        z.strictObject({
          handoffId: idSchema("handoff"),
          source: handoffEndpointSchema,
          taskIds: uniqueIds(idSchema("task")),
          artifactIds: uniqueIds(idSchema("artifact")),
          summary: z.string().max(HANDOFF_MAX_SUMMARY_LENGTH),
        }),
      )
      .refine(sortedIds("handoffId"), { message: "handoffs are ordered by id" }),
    artifacts: z
      .array(z.strictObject({ artifactId: idSchema("artifact"), mediaType: nonEmptyString, byteSize: count, title: nonEmptyString.nullable() }))
      .refine(sortedIds("artifactId"), { message: "artifacts are ordered by id" }),
    startingSnapshotId: idSchema("snapshot").nullable(),
    worktreePath: nonEmptyString.nullable(),
    allocation: allocationSchema,
    allocationSource: z.enum(INVOCATION_ALLOCATION_SOURCES),
    finalReserveUse: z.enum(FINAL_RESERVE_USES).nullable(),
    maxWallClockMs: positiveCount.nullable(),
    capabilities: agentCapabilitiesSchema,
    toolPolicy: toolPolicySchema,
    runtimeTools: z.array(z.enum(RUNTIME_TOOLS)).refine((t) => new Set(t).size === t.length, { message: "runtime tools are unique" }),
    approvedCalls: z.array(approvedToolCallSchema).refine(sortedIds("callDigest"), { message: "approved calls are ordered by digest" }),
  })
  .refine((m) => PURPOSES_BY_ROLE[m.role].includes(m.purpose), { message: "purpose must belong to the role", path: ["purpose"] })
  .refine(
    (m) =>
      m.approvedCalls.every((call) =>
        m.inputs.some((i) => i.kind === "side_effect_approval_resolution" && i.outcome === "approve_once" && i.decisionId === call.decisionId && i.tool === call.tool && i.callDigest === call.callDigest),
      ),
    { message: "every approved call comes from an approve_once resolution among the inputs", path: ["approvedCalls"] },
  )
  .refine((m) => (m.allocationSource === "run_final_reserve") === (m.finalReserveUse !== null), {
    message: "a final-reserve manifest names its use and an ordinary one names none",
    path: ["finalReserveUse"],
  })
  .refine((m) => m.capabilities.tools.every((tool) => m.toolPolicy[tool] !== undefined && m.toolPolicy[tool] !== "denied"), {
    message: "every effective capability tool carries a non-denied disposition",
    path: ["capabilities"],
  })
  .refine((m) => m.runtimeTools.every((tool) => RUNTIME_TOOLS_BY_ROLE[m.role].includes(tool)), {
    message: "runtime tools are restricted by role",
    path: ["runtimeTools"],
  });

/** The version of the deterministic renderer contract a manifest was assembled for. */
export const MANIFEST_RENDERER_VERSION = 1;

export interface ContextManifest {
  id: ContextManifestId;
  invocationId: InvocationId;
  runId: RunId;
  content: ContextManifestContent;
  digest: string;
  /** Which rendering contract applies; a retry after a restart renders with exactly this version. */
  rendererVersion: number;
  createdAt: Timestamp;
}

export const contextManifestSchema: z.ZodType<ContextManifest> = z.strictObject({
  id: idSchema("contextManifest"),
  invocationId: idSchema("invocation"),
  runId: idSchema("run"),
  content: contextManifestContentSchema,
  digest: sha256Hex,
  rendererVersion: positiveCount,
  createdAt: timestampSchema,
});

// ---------------------------------------------------------------------------
// Provider continuation index row
// ---------------------------------------------------------------------------

/**
 * A non-canonical pointer to an opaque provider payload held by the adapter's
 * payload store. Never a payload, never in a manifest, Event, or response.
 */
export interface ProviderContinuation {
  attemptId: AttemptId;
  provider: string;
  storageKey: string;
  digest: string;
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
}

export const providerContinuationSchema: z.ZodType<ProviderContinuation> = z.strictObject({
  attemptId: idSchema("attempt"),
  provider: nonEmptyString,
  storageKey: nonEmptyString,
  digest: sha256Hex,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
});

export function isContinuationExpired(row: Pick<ProviderContinuation, "expiresAt">, now: Timestamp): boolean {
  return row.expiresAt !== null && row.expiresAt <= now;
}
