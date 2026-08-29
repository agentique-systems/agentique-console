import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type {
  ArtifactId,
  ConversationId,
  DecisionId,
  InvocationId,
  PlanNodeId,
  RequirementId,
  RunId,
  TaskId,
} from "./ids.ts";
import { idSchema, nonEmptyString, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

export const DECISION_KINDS = [
  "operator_choice",
  "orchestrator_choice",
  "requirement_waiver",
  "side_effect_approval",
  "signoff",
  "publish",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Kinds that resolve only when the operator answers; never delegated or auto-resolved. */
export const OPERATOR_ONLY_DECISION_KINDS = [
  "requirement_waiver",
  "side_effect_approval",
  "signoff",
  "publish",
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
    supersedesDecisionId: idSchema("decision").nullable(),
  })
  .superRefine((request, ctx) => {
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
    resolution: decisionResolutionSchema.nullable(),
    supersedesDecisionId: idSchema("decision").nullable(),
    supersededByDecisionId: idSchema("decision").nullable(),
    createdAt: timestampSchema,
  })
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

export function isOperatorOnlyDecisionKind(kind: DecisionKind): boolean {
  return (OPERATOR_ONLY_DECISION_KINDS as readonly DecisionKind[]).includes(kind);
}
