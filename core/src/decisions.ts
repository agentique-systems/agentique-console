import { z } from "zod";
import { addedAllocationSchema, BUDGET_INCREASE_PARTITIONS, type Allocation, type BudgetIncreasePartition } from "./budgets.ts";
import { ValidationError } from "./errors.ts";
import type {
  ArtifactId,
  AttemptId,
  CompletionRequestId,
  ConversationId,
  DecisionId,
  GateId,
  InvocationId,
  PlanNodeId,
  RequirementId,
  RunId,
  SnapshotId,
  TaskId,
  WorkspaceId,
} from "./ids.ts";
import type { ChangesetId } from "./ids.ts";
import { runTargetSchema, type RunTarget } from "./runs.ts";
import { SIDE_EFFECT_APPROVAL_OPTIONS } from "./tool-calls.ts";
import { publicationStrategyRequestSchema, type PublicationStrategyRequest } from "./workspace-state.ts";
import { idSchema, nonEmptyString, sha256Hex, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

export const DECISION_KINDS = [
  "operator_choice",
  "orchestrator_choice",
  "requirement_waiver",
  "side_effect_approval",
  "signoff",
  "publish",
  "budget_increase",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Kinds that resolve only when the operator answers; never delegated or auto-resolved. */
export const OPERATOR_ONLY_DECISION_KINDS = [
  "requirement_waiver",
  "side_effect_approval",
  "signoff",
  "publish",
  "budget_increase",
] as const satisfies readonly DecisionKind[];

export const RESOLUTION_POLICIES = ["operator_required", "use_default_after_deadline"] as const;
export type ResolutionPolicy = (typeof RESOLUTION_POLICIES)[number];

export const DECISION_STATUSES = ["open", "resolved", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_RESOLVERS = ["operator", "orchestrator", "policy:use_default_after_deadline"] as const;
export type DecisionResolver = (typeof DECISION_RESOLVERS)[number];

export type DecisionRequester =
  | { kind: "operator" }
  | { kind: "runtime" }
  | { kind: "invocation"; invocationId: InvocationId };

export const decisionRequesterSchema: z.ZodType<DecisionRequester> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator") }),
  z.strictObject({ kind: z.literal("runtime") }),
  z.strictObject({ kind: z.literal("invocation"), invocationId: idSchema("invocation") }),
]);

export interface DecisionOption {
  id: string;
  label: string;
  description: string | null;
}

export const decisionOptionSchema: z.ZodType<DecisionOption> = z.strictObject({
  id: nonEmptyString,
  label: nonEmptyString,
  description: nonEmptyString.nullable(),
});

export interface DecisionAffects {
  requirementIds: RequirementId[];
  taskIds: TaskId[];
  planNodeIds: PlanNodeId[];
}

export const decisionAffectsSchema: z.ZodType<DecisionAffects> = z.strictObject({
  requirementIds: uniqueIds(idSchema("requirement")),
  taskIds: uniqueIds(idSchema("task")),
  planNodeIds: uniqueIds(idSchema("planNode")),
});

/** A deterministic condition that activates a `use_default_after_deadline` resolution. */
export type ActivationCondition = { kind: "plan_node_ready"; planNodeId: PlanNodeId };

export const activationConditionSchema: z.ZodType<ActivationCondition> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan_node_ready"), planNodeId: idSchema("planNode") }),
]);

/** The two stable options of a `signoff` Decision (execution-model §10 `operator_signoff`). */
export const SIGNOFF_OPTIONS = ["accept", "request_changes"] as const;
export type SignoffOption = (typeof SIGNOFF_OPTIONS)[number];

/** The two stable options of a `publish` Decision (execution-model §9.4). */
export const PUBLISH_OPTIONS = ["publish", "cancel"] as const;
export type PublishOption = (typeof PUBLISH_OPTIONS)[number];

/** The two stable options of a `budget_increase` Decision (execution-model §7.6). */
export const BUDGET_INCREASE_OPTIONS = ["approve", "deny"] as const;
export type BudgetIncreaseOption = (typeof BUDGET_INCREASE_OPTIONS)[number];

/** Decision kinds whose canonical subject is a typed record (`subject.kind` equals the Decision kind). */
export const SUBJECT_DECISION_KINDS = ["side_effect_approval", "signoff", "publish", "budget_increase"] as const satisfies readonly DecisionKind[];

/**
 * The canonical subject of a Decision that concerns one exact runtime fact.
 * A `side_effect_approval` names the intercepted call by tool name and
 * canonical digest, the Artifact holding its canonical bytes, and the
 * originating Run, Plan Node, Invocation, and Attempt; the raw call lives
 * only in the Artifact. A `signoff` names the Run, the open
 * `operator_signoff` Gate it resolves, the passed `run_completion` Gate and
 * Completion Request it presents, the verified integration Snapshot, and the
 * final-report Artifact; it carries no publish authority. A `publish` names
 * exactly what an authorized Publication would apply where (execution-model
 * §9.4): the completed Run, its Workspace, the exact Target, the accepted
 * final Snapshot and final Changeset, and the requested strategy; resolving
 * it with `publish` authorizes exactly one Publication of exactly those
 * facts. A `budget_increase` names the exact operator-authorized growth of
 * one Run's Budget (execution-model §7.6): the Run, the partition, and the
 * exact added cost, tokens, and Attempts; resolving it with `approve`
 * records exactly one Budget Increase of exactly those quantities. Subjects
 * carry ids, digests, and closed values only, so they may travel in Events
 * and views.
 */
export type DecisionSubject =
  | {
      kind: "side_effect_approval";
      tool: string;
      callDigest: string;
      callArtifactId: ArtifactId;
      runId: RunId;
      planNodeId: PlanNodeId;
      invocationId: InvocationId;
      attemptId: AttemptId;
    }
  | {
      kind: "signoff";
      runId: RunId;
      gateId: GateId;
      completionGateId: GateId;
      completionRequestId: CompletionRequestId;
      snapshotId: SnapshotId;
      reportArtifactId: ArtifactId;
    }
  | {
      kind: "publish";
      runId: RunId;
      workspaceId: WorkspaceId;
      target: RunTarget;
      finalSnapshotId: SnapshotId;
      finalChangesetId: ChangesetId;
      requestedStrategy: PublicationStrategyRequest;
    }
  | {
      kind: "budget_increase";
      runId: RunId;
      partition: BudgetIncreasePartition;
      /** The exact quantities the increase adds; non-negative, at least one positive. */
      added: Allocation;
    };

export const decisionSubjectSchema: z.ZodType<DecisionSubject> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("side_effect_approval"),
    tool: nonEmptyString,
    callDigest: sha256Hex,
    callArtifactId: idSchema("artifact"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    invocationId: idSchema("invocation"),
    attemptId: idSchema("attempt"),
  }),
  z
    .strictObject({
      kind: z.literal("signoff"),
      runId: idSchema("run"),
      gateId: idSchema("gate"),
      completionGateId: idSchema("gate"),
      completionRequestId: idSchema("completionRequest"),
      snapshotId: idSchema("snapshot"),
      reportArtifactId: idSchema("artifact"),
    })
    .refine((s) => s.gateId !== s.completionGateId, { message: "the signoff Gate and the completion Gate are distinct", path: ["completionGateId"] }),
  z.strictObject({
    kind: z.literal("publish"),
    runId: idSchema("run"),
    workspaceId: idSchema("workspace"),
    target: runTargetSchema,
    finalSnapshotId: idSchema("snapshot"),
    finalChangesetId: idSchema("changeset"),
    requestedStrategy: publicationStrategyRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("budget_increase"),
    runId: idSchema("run"),
    partition: z.enum(BUDGET_INCREASE_PARTITIONS),
    added: addedAllocationSchema,
  }),
]);

const OPTIONS_BY_SUBJECT_KIND: Readonly<Record<(typeof SUBJECT_DECISION_KINDS)[number], readonly string[]>> = {
  side_effect_approval: SIDE_EFFECT_APPROVAL_OPTIONS,
  signoff: SIGNOFF_OPTIONS,
  publish: PUBLISH_OPTIONS,
  budget_increase: BUDGET_INCREASE_OPTIONS,
};

/** A `side_effect_approval`, `signoff`, `publish`, or `budget_increase` Decision has exactly its typed subject, exactly its two stable options, and a Run; no other kind has a subject. */
function subjectShape(decision: { kind: DecisionKind; subject: DecisionSubject | null; options: DecisionOption[]; runId: RunId | null; resolutionPolicy: ResolutionPolicy }, ctx: z.RefinementCtx): void {
  if ((SUBJECT_DECISION_KINDS as readonly DecisionKind[]).includes(decision.kind)) {
    const expected = OPTIONS_BY_SUBJECT_KIND[decision.kind as (typeof SUBJECT_DECISION_KINDS)[number]];
    if (decision.subject === null || decision.subject.kind !== decision.kind) ctx.addIssue({ code: "custom", path: ["subject"], message: `a ${decision.kind} names its ${decision.kind} subject` });
    const ids = decision.options.map((o) => o.id).sort();
    if (ids.join(",") !== [...expected].sort().join(",")) {
      ctx.addIssue({ code: "custom", path: ["options"], message: `a ${decision.kind} offers exactly ${expected.join(" and ")}` });
    }
    if (decision.runId === null) ctx.addIssue({ code: "custom", path: ["runId"], message: `a ${decision.kind} belongs to a Run` });
    if ((decision.kind === "signoff" || decision.kind === "publish" || decision.kind === "budget_increase") && decision.resolutionPolicy !== "operator_required") {
      ctx.addIssue({ code: "custom", path: ["resolutionPolicy"], message: `a ${decision.kind} is always operator_required` });
    }
    if (decision.subject !== null && decision.subject.kind !== "side_effect_approval" && decision.subject.kind === decision.kind && decision.subject.runId !== decision.runId) {
      ctx.addIssue({ code: "custom", path: ["subject"], message: `a ${decision.kind} subject names the Decision's own Run` });
    }
  } else if (decision.subject !== null) {
    ctx.addIssue({ code: "custom", path: ["subject"], message: `a ${decision.kind} Decision has no subject` });
  }
}

export interface DecisionResolution {
  resolvedBy: DecisionResolver;
  chosenOptionId: string;
  rationale: string | null;
  artifactIds: ArtifactId[];
  resolvedAt: Timestamp;
}

export const decisionResolutionSchema: z.ZodType<DecisionResolution> = z.strictObject({
  resolvedBy: z.enum(DECISION_RESOLVERS),
  chosenOptionId: nonEmptyString,
  rationale: nonEmptyString.nullable(),
  artifactIds: uniqueIds(idSchema("artifact")),
  resolvedAt: timestampSchema,
});

export interface Decision {
  id: DecisionId;
  conversationId: ConversationId;
  runId: RunId | null;
  kind: DecisionKind;
  resolutionPolicy: ResolutionPolicy;
  status: DecisionStatus;
  requestedBy: DecisionRequester;
  question: string;
  options: DecisionOption[];
  recommendedOptionId: string | null;
  rationale: string | null;
  affects: DecisionAffects;
  deadlineAt: Timestamp | null;
  activationCondition: ActivationCondition | null;
  /** The canonical subject; present exactly for `side_effect_approval`. */
  subject: DecisionSubject | null;
  resolution: DecisionResolution | null;
  /** The earlier Decision this one supersedes, when it was recorded as a supersession. */
  supersedesDecisionId: DecisionId | null;
  supersededByDecisionId: DecisionId | null;
  createdAt: Timestamp;
}

export interface DecisionRequest {
  conversationId: ConversationId;
  runId: RunId | null;
  kind: DecisionKind;
  resolutionPolicy: ResolutionPolicy;
  requestedBy: DecisionRequester;
  question: string;
  options: DecisionOption[];
  recommendedOptionId: string | null;
  rationale: string | null;
  affects: DecisionAffects;
  deadlineAt: Timestamp | null;
  activationCondition: ActivationCondition | null;
  subject: DecisionSubject | null;
  supersedesDecisionId: DecisionId | null;
}

export const decisionRequestSchema: z.ZodType<DecisionRequest> = z
  .strictObject({
    conversationId: idSchema("conversation"),
    runId: idSchema("run").nullable(),
    kind: z.enum(DECISION_KINDS),
    resolutionPolicy: z.enum(RESOLUTION_POLICIES),
    requestedBy: decisionRequesterSchema,
    question: nonEmptyString,
    options: z.array(decisionOptionSchema).min(1).refine((o) => new Set(o.map((x) => x.id)).size === o.length, {
      message: "option ids must be unique",
    }),
    recommendedOptionId: nonEmptyString.nullable(),
    rationale: nonEmptyString.nullable(),
    affects: decisionAffectsSchema,
    deadlineAt: timestampSchema.nullable(),
    activationCondition: activationConditionSchema.nullable(),
    subject: decisionSubjectSchema.nullable(),
    supersedesDecisionId: idSchema("decision").nullable(),
  })
  .superRefine((request, ctx) => {
    subjectShape(request, ctx);
    if (request.recommendedOptionId !== null && !request.options.some((o) => o.id === request.recommendedOptionId)) {
      ctx.addIssue({ code: "custom", path: ["recommendedOptionId"], message: "recommended option must be one of the options" });
    }
    if (request.kind === "requirement_waiver") {
      if (request.resolutionPolicy !== "operator_required") {
        ctx.addIssue({ code: "custom", path: ["resolutionPolicy"], message: "a requirement_waiver is always operator_required" });
      }
      if (request.affects.requirementIds.length !== 1) {
        ctx.addIssue({ code: "custom", path: ["affects", "requirementIds"], message: "a requirement_waiver names exactly one Requirement" });
      }
    }
    if (request.resolutionPolicy === "use_default_after_deadline") {
      if (request.kind !== "operator_choice") {
        ctx.addIssue({ code: "custom", path: ["resolutionPolicy"], message: "only operator_choice may use use_default_after_deadline" });
      }
      if (request.recommendedOptionId === null) {
        ctx.addIssue({ code: "custom", path: ["recommendedOptionId"], message: "use_default_after_deadline requires a recommended option" });
      }
      if (request.deadlineAt === null && request.activationCondition === null) {
        ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "use_default_after_deadline requires a deadline or an activation condition" });
      }
      if (request.rationale === null) {
        ctx.addIssue({ code: "custom", path: ["rationale"], message: "use_default_after_deadline requires a rationale" });
      }
      const { requirementIds, taskIds, planNodeIds } = request.affects;
      if (requirementIds.length + taskIds.length + planNodeIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["affects"], message: "use_default_after_deadline requires affected ids" });
      }
    } else if (request.deadlineAt !== null || request.activationCondition !== null) {
      ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "only use_default_after_deadline carries a deadline or condition" });
    }
  });

export const decisionSchema: z.ZodType<Decision> = z
  .strictObject({
    id: idSchema("decision"),
    conversationId: idSchema("conversation"),
    runId: idSchema("run").nullable(),
    kind: z.enum(DECISION_KINDS),
    resolutionPolicy: z.enum(RESOLUTION_POLICIES),
    status: z.enum(DECISION_STATUSES),
    requestedBy: decisionRequesterSchema,
    question: nonEmptyString,
    options: z.array(decisionOptionSchema).min(1),
    recommendedOptionId: nonEmptyString.nullable(),
    rationale: nonEmptyString.nullable(),
    affects: decisionAffectsSchema,
    deadlineAt: timestampSchema.nullable(),
    activationCondition: activationConditionSchema.nullable(),
    subject: decisionSubjectSchema.nullable(),
    resolution: decisionResolutionSchema.nullable(),
    supersedesDecisionId: idSchema("decision").nullable(),
    supersededByDecisionId: idSchema("decision").nullable(),
    createdAt: timestampSchema,
  })
  .superRefine(subjectShape)
  .refine((d) => (d.status === "open") === (d.resolution === null), {
    message: "an open Decision has no resolution; a resolved or superseded one does",
    path: ["resolution"],
  })
  .refine((d) => (d.status === "superseded") === (d.supersededByDecisionId !== null), {
    message: "supersededByDecisionId is set exactly when the Decision is superseded",
    path: ["supersededByDecisionId"],
  });

export type DecisionResolutionInput = Omit<DecisionResolution, "resolvedAt">;

export const decisionResolutionInputSchema: z.ZodType<DecisionResolutionInput> = z.strictObject({
  resolvedBy: z.enum(DECISION_RESOLVERS),
  chosenOptionId: nonEmptyString,
  rationale: nonEmptyString.nullable(),
  artifactIds: uniqueIds(idSchema("artifact")),
});

/**
 * Who may resolve which Decision, independent of any store: the operator may
 * resolve any kind; the Orchestrator only `orchestrator_choice`; the policy
 * resolver only a `use_default_after_deadline` Decision, and only to its
 * recorded recommendation. A waiver additionally needs a rationale.
 */
export function assertDecisionResolutionRules(
  decision: Pick<Decision, "kind" | "resolutionPolicy" | "options" | "recommendedOptionId" | "status">,
  resolution: DecisionResolutionInput,
): void {
  if (decision.status !== "open") {
    throw new ValidationError(`a ${decision.status} Decision cannot be resolved`, { status: decision.status });
  }
  if (!decision.options.some((o) => o.id === resolution.chosenOptionId)) {
    throw new ValidationError("chosen option must be one of the Decision's options", {
      chosenOptionId: resolution.chosenOptionId,
    });
  }
  switch (resolution.resolvedBy) {
    case "operator":
      if (decision.kind === "orchestrator_choice") {
        throw new ValidationError("an orchestrator_choice is recorded by the Orchestrator, not resolved by the operator");
      }
      if (decision.kind === "requirement_waiver" && resolution.rationale === null) {
        throw new ValidationError("a requirement_waiver resolution records the operator's rationale");
      }
      return;
    case "orchestrator":
      if (decision.kind !== "orchestrator_choice") {
        throw new ValidationError(`the Orchestrator cannot resolve a ${decision.kind} Decision`, { kind: decision.kind });
      }
      return;
    case "policy:use_default_after_deadline":
      if (decision.resolutionPolicy !== "use_default_after_deadline") {
        throw new ValidationError("only a use_default_after_deadline Decision resolves by policy", {
          kind: decision.kind,
          resolutionPolicy: decision.resolutionPolicy,
        });
      }
      if (resolution.chosenOptionId !== decision.recommendedOptionId) {
        throw new ValidationError("a policy resolution chooses the recorded recommended option");
      }
      return;
  }
}

/** The typed subject of a `side_effect_approval` Decision; a Decision of another kind (or without one) is an invariant violation. */
export function approvalSubjectOf(decision: Pick<Decision, "id" | "kind" | "subject">): Extract<DecisionSubject, { kind: "side_effect_approval" }> {
  if (decision.kind !== "side_effect_approval" || decision.subject === null || decision.subject.kind !== "side_effect_approval") {
    throw new ValidationError(`Decision ${decision.id} is not a side_effect_approval with its subject`, { decisionId: decision.id, kind: decision.kind });
  }
  return decision.subject;
}

/** The typed subject of a `signoff` Decision; a Decision of another kind (or without one) is an invariant violation. */
export function signoffSubjectOf(decision: Pick<Decision, "id" | "kind" | "subject">): Extract<DecisionSubject, { kind: "signoff" }> {
  if (decision.kind !== "signoff" || decision.subject === null || decision.subject.kind !== "signoff") {
    throw new ValidationError(`Decision ${decision.id} is not a signoff with its subject`, { decisionId: decision.id, kind: decision.kind });
  }
  return decision.subject;
}

/** The typed subject of a `publish` Decision; a Decision of another kind (or without one) is an invariant violation. */
export function publishSubjectOf(decision: Pick<Decision, "id" | "kind" | "subject">): Extract<DecisionSubject, { kind: "publish" }> {
  if (decision.kind !== "publish" || decision.subject === null || decision.subject.kind !== "publish") {
    throw new ValidationError(`Decision ${decision.id} is not a publish Decision with its subject`, { decisionId: decision.id, kind: decision.kind });
  }
  return decision.subject;
}

/** The typed subject of a `budget_increase` Decision; a Decision of another kind (or without one) is an invariant violation. */
export function budgetIncreaseSubjectOf(decision: Pick<Decision, "id" | "kind" | "subject">): Extract<DecisionSubject, { kind: "budget_increase" }> {
  if (decision.kind !== "budget_increase" || decision.subject === null || decision.subject.kind !== "budget_increase") {
    throw new ValidationError(`Decision ${decision.id} is not a budget_increase Decision with its subject`, { decisionId: decision.id, kind: decision.kind });
  }
  return decision.subject;
}

export function isOperatorOnlyDecisionKind(kind: DecisionKind): boolean {
  return (OPERATOR_ONLY_DECISION_KINDS as readonly DecisionKind[]).includes(kind);
}
