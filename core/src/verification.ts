import { z } from "zod";
import { FINAL_RESERVE_USES, type FinalReserveUse } from "./budgets.ts";
import { completionConditionSchema, type CompletionCondition } from "./completion.ts";
import type {
  AcceptanceCriterionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  CompletionRequestId,
  DecisionId,
  EvaluationId,
  GateId,
  InvocationId,
  PlanNodeId,
  PublicationId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  SnapshotId,
} from "./ids.ts";
import { ValidationError } from "./errors.ts";
import { evidenceSchema, type Evidence } from "./requirements.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, positiveCount, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

export const VERDICTS = ["pass", "fail", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * What an Evaluation judged: an Acceptance Criterion, a rubric, or a route
 * selection. A `route_selection` Evaluation is the one canonical fact that a
 * `route` Plan Node selected `selectedLabel` (execution-model §5.3): exactly
 * one exists per route node, it always names a label of the node's branch
 * bindings, and readiness reads it as an explicit condition fact — never a
 * transcript, Handoff summary, or Invocation order.
 */
export type EvaluationSubject =
  | { kind: "acceptance_criterion"; acceptanceCriterionId: AcceptanceCriterionId }
  | { kind: "rubric"; rubric: string }
  | { kind: "route_selection"; selectedLabel: string }
  /** One `evaluator_optimizer` round's candidate output as a whole; the round is named by the Evaluation's `optimizer_verdict` context. */
  | { kind: "optimizer_round" };

export const evaluationSubjectSchema: z.ZodType<EvaluationSubject> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("acceptance_criterion"), acceptanceCriterionId: idSchema("acceptanceCriterion") }),
  z.strictObject({ kind: z.literal("rubric"), rubric: nonEmptyString }),
  z.strictObject({ kind: z.literal("route_selection"), selectedLabel: nonEmptyString }),
  z.strictObject({ kind: z.literal("optimizer_round") }),
]);

/**
 * The machine-readable context of an Evaluation recorded outside a Gate. An
 * `evaluator_optimizer` round's Evaluation (execution-model §5.6) names which
 * round of how many it belongs to, and whether it judges one Acceptance
 * Criterion of the round (`optimizer_criterion`, subject
 * `acceptance_criterion`) or is the overall round verdict
 * (`optimizer_verdict`, subject `optimizer_round`). A `publication` context
 * (execution-model §9.4) is the canonical ownership of one candidate
 * verification check: it names the exact Publication whose prepared
 * candidate Snapshot the deterministic criterion was checked against —
 * runtime producer only, no Gate, no Plan Node, one Evaluation per
 * Publication and criterion. Identity lives here and nowhere else — never in
 * a rubric string, a summary, or a Handoff. `null` for every other
 * Evaluation.
 */
export type EvaluationContext =
  | { kind: "optimizer_criterion"; round: number; maxRounds: number }
  | { kind: "optimizer_verdict"; round: number; maxRounds: number }
  | { kind: "publication"; publicationId: PublicationId };

const roundContext = <K extends string>(kind: K) =>
  z
    .strictObject({ kind: z.literal(kind), round: positiveCount, maxRounds: positiveCount })
    .refine((c) => c.round <= c.maxRounds, { message: "round is within maxRounds", path: ["round"] });

export const evaluationContextSchema: z.ZodType<EvaluationContext> = z.discriminatedUnion("kind", [
  roundContext("optimizer_criterion"),
  roundContext("optimizer_verdict"),
  z.strictObject({ kind: z.literal("publication"), publicationId: idSchema("publication") }),
]);

export const OPTIMIZER_EVALUATION_CONTEXT_KINDS = ["optimizer_criterion", "optimizer_verdict"] as const;

/** The round of an optimizer Evaluation's context; an Evaluation without an optimizer context is an invariant violation. */
export function optimizerRoundOf(evaluation: { id: EvaluationId; context: EvaluationContext | null }): number {
  const context = evaluation.context;
  if (context === null || context.kind === "publication") {
    throw new ValidationError(`Evaluation ${evaluation.id} carries no optimizer round context`, { evaluationId: evaluation.id });
  }
  return context.round;
}

/** `runtime` for a deterministic check; otherwise the Evaluator Invocation and its definition revision. */
export type EvaluationProducer =
  | { kind: "runtime" }
  | { kind: "evaluator"; invocationId: InvocationId; agentDefinitionRevisionId: AgentDefinitionRevisionId };

export const evaluationProducerSchema: z.ZodType<EvaluationProducer> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("runtime") }),
  z.strictObject({
    kind: z.literal("evaluator"),
    invocationId: idSchema("invocation"),
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
  }),
]);

export interface Evaluation {
  id: EvaluationId;
  runId: RunId;
  planNodeId: PlanNodeId | null;
  gateId: GateId | null;
  subject: EvaluationSubject;
  /** The optimizer round context, or `null` outside an `evaluator_optimizer` round. */
  context: EvaluationContext | null;
  verdict: Verdict;
  evidence: Evidence[];
  producedBy: EvaluationProducer;
  /** The Artifacts that were judged. */
  artifactIds: ArtifactId[];
  /** The integration Snapshot the judgment was made against; required for an optimizer round, so a later Gate can decide whether to reuse it. */
  snapshotId: SnapshotId | null;
  createdAt: Timestamp;
}

type EvaluationShape = Pick<Evaluation, "subject" | "context" | "planNodeId" | "gateId" | "verdict" | "snapshotId" | "producedBy">;

/** A route-selection Evaluation names its route node, no Gate, no context, and no judged Artifact: the selection is the whole fact. */
function routeSelectionShape(evaluation: EvaluationShape, ctx: z.RefinementCtx): void {
  if (evaluation.subject.kind !== "route_selection") return;
  if (evaluation.planNodeId === null) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "a route_selection Evaluation belongs to its route Plan Node" });
  if (evaluation.gateId !== null) ctx.addIssue({ code: "custom", path: ["gateId"], message: "a route_selection Evaluation belongs to no Gate" });
  if (evaluation.context !== null) ctx.addIssue({ code: "custom", path: ["context"], message: "a route_selection Evaluation carries no optimizer context" });
  if (evaluation.verdict !== "pass") ctx.addIssue({ code: "custom", path: ["verdict"], message: "a route_selection Evaluation records a selection that was made; an unmade selection is never recorded" });
}

/**
 * An optimizer-round Evaluation belongs to its Plan Node and no Gate, names
 * the judged Snapshot, and pairs its context with its subject: the overall
 * verdict judges the round (`optimizer_round`), a criterion Evaluation judges
 * one Acceptance Criterion. The `optimizer_round` subject exists only with
 * the `optimizer_verdict` context.
 */
function optimizerShape(evaluation: EvaluationShape, ctx: z.RefinementCtx): void {
  const { context, subject } = evaluation;
  if (context === null) {
    if (subject.kind === "optimizer_round") ctx.addIssue({ code: "custom", path: ["context"], message: "an optimizer_round subject carries the optimizer_verdict context" });
    return;
  }
  if (context.kind === "publication") return;
  if (evaluation.planNodeId === null) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "an optimizer-round Evaluation belongs to its evaluator_optimizer Plan Node" });
  if (evaluation.gateId !== null) ctx.addIssue({ code: "custom", path: ["gateId"], message: "an optimizer-round Evaluation belongs to no Gate" });
  if (evaluation.snapshotId === null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "an optimizer-round Evaluation names the judged Snapshot" });
  if (context.kind === "optimizer_verdict" && subject.kind !== "optimizer_round") ctx.addIssue({ code: "custom", path: ["subject"], message: "the overall optimizer verdict judges the round (subject optimizer_round)" });
  if (context.kind === "optimizer_criterion" && subject.kind !== "acceptance_criterion") ctx.addIssue({ code: "custom", path: ["subject"], message: "an optimizer criterion Evaluation judges one Acceptance Criterion" });
}

/**
 * A publication-verification Evaluation (context `publication`) is the
 * runtime's deterministic check of one Acceptance Criterion against the
 * exact prepared candidate Snapshot of one Publication: no Plan Node, no
 * Gate, the candidate Snapshot named, subject `acceptance_criterion`,
 * runtime producer only — no Evaluator Invocation and no model call.
 */
function publicationShape(evaluation: EvaluationShape, ctx: z.RefinementCtx): void {
  if (evaluation.context?.kind !== "publication") return;
  if (evaluation.planNodeId !== null) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "a publication Evaluation belongs to no Plan Node" });
  if (evaluation.gateId !== null) ctx.addIssue({ code: "custom", path: ["gateId"], message: "a publication Evaluation belongs to no Gate" });
  if (evaluation.snapshotId === null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "a publication Evaluation names the judged candidate Snapshot" });
  if (evaluation.subject.kind !== "acceptance_criterion") ctx.addIssue({ code: "custom", path: ["subject"], message: "a publication Evaluation judges one Acceptance Criterion" });
  if (evaluation.producedBy.kind !== "runtime") ctx.addIssue({ code: "custom", path: ["producedBy"], message: "publication verification is deterministic; only the runtime records it" });
}

export const evaluationSchema: z.ZodType<Evaluation> = z
  .strictObject({
    id: idSchema("evaluation"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    gateId: idSchema("gate").nullable(),
    subject: evaluationSubjectSchema,
    context: evaluationContextSchema.nullable(),
    verdict: z.enum(VERDICTS),
    evidence: z.array(evidenceSchema),
    producedBy: evaluationProducerSchema,
    artifactIds: uniqueIds(idSchema("artifact")),
    snapshotId: idSchema("snapshot").nullable(),
    createdAt: timestampSchema,
  })
  .superRefine(routeSelectionShape)
  .superRefine(optimizerShape)
  .superRefine(publicationShape);

export interface EvaluationInput {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  gateId: GateId | null;
  subject: EvaluationSubject;
  context: EvaluationContext | null;
  verdict: Verdict;
  evidence: Evidence[];
  producedBy: EvaluationProducer;
  artifactIds: ArtifactId[];
  snapshotId: SnapshotId | null;
}

export const evaluationInputSchema: z.ZodType<EvaluationInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    gateId: idSchema("gate").nullable(),
    subject: evaluationSubjectSchema,
    context: evaluationContextSchema.nullable(),
    verdict: z.enum(VERDICTS),
    evidence: z.array(evidenceSchema),
    producedBy: evaluationProducerSchema,
    artifactIds: uniqueIds(idSchema("artifact")),
    snapshotId: idSchema("snapshot").nullable(),
  })
  .superRefine(routeSelectionShape)
  .superRefine(optimizerShape)
  .superRefine(publicationShape);

export const GATE_KINDS = ["node_exit", "run_completion", "operator_signoff"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const GATE_STATUSES = ["open", "passed", "failed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const GATE_MACHINE = defineStateMachine<GateStatus>("Gate", GATE_STATUSES, {
  open: ["passed", "failed"],
  passed: [],
  failed: [],
});

/**
 * Why a Gate closed `failed` (execution-model §10): one or more of its
 * Acceptance Criteria recorded `fail` or `inconclusive`; its Evaluator
 * Invocation ended without a valid verdict after its permitted Attempts —
 * an execution failure that fabricates no criterion verdict; or, for a
 * `run_completion` Gate, the Run's structural completion conditions did not
 * hold, its final synthesis ended without a valid report, or the Run's final
 * reserve could not fund the next completion Invocation; or, for an
 * `operator_signoff` Gate, the operator resolved its `signoff` Decision with
 * `request_changes` (`changes_requested`, naming that Decision). The failure
 * is a closed fact of the Gate row, never inferred from Events.
 */
export type GateFailure =
  | { kind: "criteria_failed"; acceptanceCriterionIds: AcceptanceCriterionId[] }
  | { kind: "evaluator_failed"; invocationId: InvocationId }
  | { kind: "conditions_unmet"; conditions: CompletionCondition[] }
  | { kind: "final_synthesis_failed"; invocationId: InvocationId }
  | { kind: "final_reserve_exhausted"; use: FinalReserveUse }
  | { kind: "changes_requested"; decisionId: DecisionId };

export const GATE_FAILURE_KINDS = ["criteria_failed", "evaluator_failed", "conditions_unmet", "final_synthesis_failed", "final_reserve_exhausted", "changes_requested"] as const;

/** The one failure kind an `operator_signoff` Gate may record, and the only Gate kind that may record it. */
export const OPERATOR_SIGNOFF_GATE_FAILURE_KINDS = ["changes_requested"] as const satisfies readonly GateFailure["kind"][];

/** The failure kinds only a `run_completion` Gate may record. */
export const RUN_COMPLETION_GATE_FAILURE_KINDS = ["conditions_unmet", "final_synthesis_failed", "final_reserve_exhausted"] as const satisfies readonly GateFailure["kind"][];

export const gateFailureSchema: z.ZodType<GateFailure> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("criteria_failed"), acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")).min(1) }),
  z.strictObject({ kind: z.literal("evaluator_failed"), invocationId: idSchema("invocation") }),
  z.strictObject({ kind: z.literal("conditions_unmet"), conditions: z.array(completionConditionSchema).min(1) }),
  z.strictObject({ kind: z.literal("final_synthesis_failed"), invocationId: idSchema("invocation") }),
  z.strictObject({ kind: z.literal("final_reserve_exhausted"), use: z.enum(FINAL_RESERVE_USES) }),
  z.strictObject({ kind: z.literal("changes_requested"), decisionId: idSchema("decision") }),
]);

const sortedIds = (ids: readonly string[]): boolean => ids.every((id, i) => i === 0 || ids[i - 1]! < id);

/**
 * A runtime checkpoint. A Gate identifies canonically what it judges: the
 * Run, the Plan Node (for `node_exit`), its kind, its verification cycle
 * (`ordinal`, from 1 per node and kind, or per Run and kind for a Run
 * Gate), the exact integration Snapshot pinned when it opened, the exact
 * candidate Artifact ids, and its Acceptance Criteria in canonical (id)
 * order — deterministic ones are checked first, then evaluated ones, then
 * (for `operator_signoff`) the operator's acceptance. A `run_completion`
 * Gate additionally names its Completion Request, the pinned Requirement
 * revision, and the exact current leaf Requirement ids it judges; an
 * `operator_signoff` Gate names the Completion Request, the passed
 * `run_completion` Gate, the same verified Snapshot and Requirement
 * revision, and the final-report Artifact. Criteria, Snapshot, candidate,
 * and every named id are immutable once the Gate is open; a closed Gate is
 * append-only history and a later verification cycle opens a new Gate with
 * the next ordinal.
 */
export interface Gate {
  id: GateId;
  runId: RunId;
  planNodeId: PlanNodeId | null;
  kind: GateKind;
  /** The verification cycle of this node (or Run) and kind, from 1; never inferred from timestamps or Event order. */
  ordinal: number;
  status: GateStatus;
  acceptanceCriterionIds: AcceptanceCriterionId[];
  /** The integration Snapshot the Gate judges, pinned at opening; required for every kind but declared nullable for the row. */
  snapshotId: SnapshotId | null;
  /** The exact candidate output Artifact ids the Gate judges, pinned at opening. */
  candidateArtifactIds: ArtifactId[];
  /** The Completion Request a `run_completion` or `operator_signoff` Gate belongs to; `null` for a `node_exit` Gate. */
  completionRequestId: CompletionRequestId | null;
  /** The Requirement revision a Run Gate pins; `null` for a `node_exit` Gate. */
  requirementRevisionId: RequirementRevisionId | null;
  /** The exact current leaf Requirement ids a Run Gate judges, in canonical id order; empty for a `node_exit` Gate. */
  requirementIds: RequirementId[];
  /** The passed `run_completion` Gate an `operator_signoff` Gate presents; `null` otherwise. */
  completionGateId: GateId | null;
  /** The canonical final-report Artifact: set when a `run_completion` Gate closes `passed`, at opening for an `operator_signoff` Gate. */
  reportArtifactId: ArtifactId | null;
  /** Why the Gate failed; set exactly when `status` is `failed`. */
  failure: GateFailure | null;
  openedAt: Timestamp;
  closedAt: Timestamp | null;
}

type GateShape = Pick<Gate, "kind" | "planNodeId" | "snapshotId" | "acceptanceCriterionIds" | "completionRequestId" | "requirementRevisionId" | "requirementIds" | "completionGateId">;

function gateShape(gate: GateShape, ctx: z.RefinementCtx): void {
  if ((gate.kind === "node_exit") !== (gate.planNodeId !== null)) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "a node_exit Gate belongs to a Plan Node; Run Gates do not" });
  if (gate.snapshotId === null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "a Gate pins the integration Snapshot it judges" });
  if (!sortedIds(gate.acceptanceCriterionIds)) ctx.addIssue({ code: "custom", path: ["acceptanceCriterionIds"], message: "Gate criteria are in canonical id order" });
  if (!sortedIds(gate.requirementIds)) ctx.addIssue({ code: "custom", path: ["requirementIds"], message: "Gate Requirement ids are in canonical id order" });
  const runGate = gate.kind !== "node_exit";
  if (runGate !== (gate.completionRequestId !== null)) ctx.addIssue({ code: "custom", path: ["completionRequestId"], message: "a Run Gate names its Completion Request; a node_exit Gate names none" });
  if (runGate !== (gate.requirementRevisionId !== null)) ctx.addIssue({ code: "custom", path: ["requirementRevisionId"], message: "a Run Gate pins the Requirement revision it judges; a node_exit Gate pins none" });
  if (!runGate && gate.requirementIds.length > 0) ctx.addIssue({ code: "custom", path: ["requirementIds"], message: "a node_exit Gate names no Requirements" });
  if ((gate.kind === "operator_signoff") !== (gate.completionGateId !== null)) ctx.addIssue({ code: "custom", path: ["completionGateId"], message: "an operator_signoff Gate names the passed run_completion Gate; no other Gate does" });
  if (gate.kind === "operator_signoff" && gate.acceptanceCriterionIds.length > 0) ctx.addIssue({ code: "custom", path: ["acceptanceCriterionIds"], message: "an operator_signoff Gate asks the operator, not a criterion" });
}

export const gateSchema: z.ZodType<Gate> = z
  .strictObject({
    id: idSchema("gate"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    kind: z.enum(GATE_KINDS),
    ordinal: positiveCount,
    status: z.enum(GATE_STATUSES),
    acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    snapshotId: idSchema("snapshot").nullable(),
    candidateArtifactIds: uniqueIds(idSchema("artifact")),
    completionRequestId: idSchema("completionRequest").nullable(),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    requirementIds: uniqueIds(idSchema("requirement")),
    completionGateId: idSchema("gate").nullable(),
    reportArtifactId: idSchema("artifact").nullable(),
    failure: gateFailureSchema.nullable(),
    openedAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .superRefine(gateShape)
  .refine((g) => (g.status === "open") === (g.closedAt === null), {
    message: "closedAt is set exactly when the Gate is closed",
    path: ["closedAt"],
  })
  .refine((g) => (g.status === "failed") === (g.failure !== null), {
    message: "failure is set exactly when the Gate failed",
    path: ["failure"],
  })
  .refine((g) => g.failure === null || g.failure.kind !== "criteria_failed" || g.failure.acceptanceCriterionIds.every((id) => g.acceptanceCriterionIds.includes(id)), {
    message: "a Gate fails only on its own criteria",
    path: ["failure"],
  })
  .refine((g) => g.failure === null || g.kind === "run_completion" || !(RUN_COMPLETION_GATE_FAILURE_KINDS as readonly string[]).includes(g.failure.kind), {
    message: "only a run_completion Gate fails on completion conditions, final synthesis, or the final reserve",
    path: ["failure"],
  })
  .refine((g) => g.failure === null || (g.kind === "operator_signoff") === (OPERATOR_SIGNOFF_GATE_FAILURE_KINDS as readonly string[]).includes(g.failure.kind), {
    message: "an operator_signoff Gate fails only on changes_requested, and no other Gate does",
    path: ["failure"],
  })
  .refine((g) => sortedIds(g.candidateArtifactIds), {
    message: "the candidate Artifact ids are in canonical id order",
    path: ["candidateArtifactIds"],
  })
  .refine((g) => g.kind !== "operator_signoff" || g.reportArtifactId !== null, {
    message: "an operator_signoff Gate presents the final-report Artifact",
    path: ["reportArtifactId"],
  })
  .refine((g) => g.kind !== "run_completion" || (g.status === "passed") === (g.reportArtifactId !== null), {
    message: "a run_completion Gate records the final-report Artifact exactly when it passed",
    path: ["reportArtifactId"],
  })
  .refine((g) => g.kind !== "node_exit" || g.reportArtifactId === null, {
    message: "a node_exit Gate has no final report",
    path: ["reportArtifactId"],
  })
  .refine((g) => g.id !== g.completionGateId, { message: "a Gate cannot present itself", path: ["completionGateId"] });

/** What opens a Gate; the store assigns the ordinal from the Gates that already exist. The Run-Gate fields default to their `node_exit` values. */
export interface GateInput {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  kind: GateKind;
  acceptanceCriterionIds: AcceptanceCriterionId[];
  snapshotId: SnapshotId | null;
  candidateArtifactIds: ArtifactId[];
  completionRequestId?: CompletionRequestId | null;
  requirementRevisionId?: RequirementRevisionId | null;
  requirementIds?: RequirementId[];
  completionGateId?: GateId | null;
  /** The final-report Artifact an `operator_signoff` Gate presents; never given for another kind. */
  reportArtifactId?: ArtifactId | null;
}

export const gateInputSchema: z.ZodType<GateInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    kind: z.enum(GATE_KINDS),
    acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    snapshotId: idSchema("snapshot").nullable(),
    candidateArtifactIds: uniqueIds(idSchema("artifact")),
    completionRequestId: idSchema("completionRequest").nullable().optional(),
    requirementRevisionId: idSchema("requirementRevision").nullable().optional(),
    requirementIds: uniqueIds(idSchema("requirement")).optional(),
    completionGateId: idSchema("gate").nullable().optional(),
    reportArtifactId: idSchema("artifact").nullable().optional(),
  })
  .superRefine((g, ctx) => gateShape({ ...g, completionRequestId: g.completionRequestId ?? null, requirementRevisionId: g.requirementRevisionId ?? null, requirementIds: g.requirementIds ?? [], completionGateId: g.completionGateId ?? null }, ctx))
  .refine((g) => sortedIds(g.candidateArtifactIds), {
    message: "the candidate Artifact ids are in canonical id order",
    path: ["candidateArtifactIds"],
  })
  .refine((g) => (g.kind === "operator_signoff") === ((g.reportArtifactId ?? null) !== null), {
    message: "an operator_signoff Gate opens with the final-report Artifact; no other Gate opens with one",
    path: ["reportArtifactId"],
  });

/** The verdict of a closed Gate from its criterion verdicts: `passed` only when every criterion passed. */
export function gateVerdictOf(verdicts: readonly Verdict[]): "passed" | "failed" {
  return verdicts.every((v) => v === "pass") ? "passed" : "failed";
}
