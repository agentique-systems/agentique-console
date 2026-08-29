import { z } from "zod";
import { allocationSchema, type Allocation } from "./budgets.ts";
import { ValidationError } from "./errors.ts";
import type {
  AgentDefinitionRevisionId,
  ArtifactId,
  AttemptId,
  CapacityLeaseId,
  ContextManifestId,
  DecisionId,
  HandoffId,
  InvocationId,
  PlanNodeId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  SnapshotId,
  TaskId,
} from "./ids.ts";
import { evidenceSchema, type Evidence } from "./requirements.ts";
import { toolPolicySchema, type ToolPolicy } from "./agents.ts";
import { defineStateMachine } from "./transitions.ts";
import {
  idSchema,
  nonEmptyString,
  positiveCount,
  sha256Hex,
  timestampSchema,
  uniqueIds,
  type Timestamp,
} from "./validation.ts";

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
// Invocation
// ---------------------------------------------------------------------------

export const INVOCATION_STATUSES = ["pending", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
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
  /** The explicit allocation reserved from the Plan Node before the Invocation starts. */
  allocation: Allocation;
  status: InvocationStatus;
  waitReason: InvocationWaitReason | null;
  failureReason: InvocationFailureReason | null;
  result: InvocationResult | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export const INVOCATION_MACHINE = defineStateMachine<InvocationStatus>("Invocation", INVOCATION_STATUSES, {
  pending: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "succeeded", "failed", "cancelled"],
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
    status: z.enum(INVOCATION_STATUSES),
    waitReason: z.enum(INVOCATION_WAIT_REASONS).nullable(),
    failureReason: z.enum(INVOCATION_FAILURE_REASONS).nullable(),
    result: invocationResultSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .refine((i) => PURPOSES_BY_ROLE[i.role].includes(i.purpose), {
    message: "purpose must belong to the Invocation's role",
    path: ["purpose"],
  })
  .refine((i) => (i.status === "waiting") === (i.waitReason !== null), {
    message: "waitReason is set exactly when the Invocation is waiting",
    path: ["waitReason"],
  })
  .refine((i) => (i.status === "failed") === (i.failureReason !== null), {
    message: "failureReason is set exactly when the Invocation failed",
    path: ["failureReason"],
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
  })
  .refine((i) => PURPOSES_BY_ROLE[i.role].includes(i.purpose), {
    message: "purpose must belong to the Invocation's role",
    path: ["purpose"],
  })
  .refine((i) => i.allocation.attempts >= 1, {
    message: "an Invocation allocation permits at least one Attempt",
    path: ["allocation", "attempts"],
  });

export type InvocationTransition =
  | { to: "running" }
  | { to: "waiting"; waitReason: InvocationWaitReason }
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

export const ATTEMPT_MACHINE = defineStateMachine<AttemptStatus>("Attempt", ATTEMPT_STATUSES, {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "timed_out", "interrupted", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  interrupted: [],
  cancelled: [],
});

/** Statuses after which the runtime may create a `retry` Attempt (if allocation remains). */
export const RETRYABLE_ATTEMPT_STATUSES = ["failed", "timed_out", "interrupted"] as const satisfies readonly AttemptStatus[];

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
  .refine((a) => a.status !== "succeeded" || (a.result !== null && a.failureClass === null), {
    message: "a succeeded Attempt carries a result and no failure class",
    path: ["result"],
  })
  .refine(
    (a) => !(a.status === "failed" || a.status === "timed_out" || a.status === "interrupted") || a.failureClass !== null,
    { message: "a failed, timed-out, or interrupted Attempt is classified", path: ["failureClass"] },
  );

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

export type AttemptTransition =
  | { to: "running"; capacityLeaseId: CapacityLeaseId | null }
  | { to: "succeeded"; result: InvocationResult; transcriptArtifactId: ArtifactId | null }
  | { to: "failed"; failureClass: Exclude<AttemptFailureClass, "interrupted">; transcriptArtifactId: ArtifactId | null }
  | { to: "timed_out"; transcriptArtifactId: ArtifactId | null }
  | { to: "interrupted"; transcriptArtifactId: ArtifactId | null }
  | { to: "cancelled"; transcriptArtifactId: ArtifactId | null };

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

export interface ManifestRequirement {
  requirementId: RequirementId;
  statement: string;
  acceptanceCriterionIds: string[];
}

export interface ManifestDecision {
  decisionId: DecisionId;
  chosenOptionId: string | null;
}

export interface ManifestTask {
  taskId: TaskId;
  subject: string;
}

/**
 * The explicit, complete list of inputs an Invocation receives. Exactly one
 * per Invocation, persisted before the initial Attempt and never changed.
 * It never contains a provider continuation payload.
 */
export interface ContextManifestContent {
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  agentDefinitionContentHash: string;
  instructions: string;
  role: InvocationRole;
  purpose: InvocationPurpose;
  patternPosition: string | null;
  continuedFromInvocationId: InvocationId | null;
  runId: RunId;
  planNodeId: PlanNodeId;
  tasks: ManifestTask[];
  requirementRevisionId: RequirementRevisionId | null;
  requirements: ManifestRequirement[];
  decisions: ManifestDecision[];
  handoffIds: HandoffId[];
  readableArtifactIds: ArtifactId[];
  startingSnapshotId: SnapshotId | null;
  worktreePath: string | null;
  allocation: Allocation;
  maxWallClockMs: number | null;
  toolPolicy: ToolPolicy;
  runtimeTools: string[];
}

export const contextManifestContentSchema: z.ZodType<ContextManifestContent> = z.strictObject({
  agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
  agentDefinitionContentHash: sha256Hex,
  instructions: z.string(),
  role: z.enum(INVOCATION_ROLES),
  purpose: z.enum(INVOCATION_PURPOSES),
  patternPosition: nonEmptyString.nullable(),
  continuedFromInvocationId: idSchema("invocation").nullable(),
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  tasks: z.array(z.strictObject({ taskId: idSchema("task"), subject: nonEmptyString })),
  requirementRevisionId: idSchema("requirementRevision").nullable(),
  requirements: z.array(
    z.strictObject({
      requirementId: idSchema("requirement"),
      statement: nonEmptyString,
      acceptanceCriterionIds: z.array(idSchema("acceptanceCriterion")),
    }),
  ),
  decisions: z.array(z.strictObject({ decisionId: idSchema("decision"), chosenOptionId: nonEmptyString.nullable() })),
  handoffIds: uniqueIds(idSchema("handoff")),
  readableArtifactIds: uniqueIds(idSchema("artifact")),
  startingSnapshotId: idSchema("snapshot").nullable(),
  worktreePath: nonEmptyString.nullable(),
  allocation: allocationSchema,
  maxWallClockMs: positiveCount.nullable(),
  toolPolicy: toolPolicySchema,
  runtimeTools: z.array(nonEmptyString),
});

export interface ContextManifest {
  id: ContextManifestId;
  invocationId: InvocationId;
  runId: RunId;
  content: ContextManifestContent;
  digest: string;
  createdAt: Timestamp;
}

export const contextManifestSchema: z.ZodType<ContextManifest> = z.strictObject({
  id: idSchema("contextManifest"),
  invocationId: idSchema("invocation"),
  runId: idSchema("run"),
  content: contextManifestContentSchema,
  digest: sha256Hex,
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
