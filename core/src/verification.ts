import { z } from "zod";
import type {
  AcceptanceCriterionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  EvaluationId,
  GateId,
  InvocationId,
  PlanNodeId,
  RunId,
  SnapshotId,
} from "./ids.ts";
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
 * The machine-readable context of an Evaluation recorded inside an
 * `evaluator_optimizer` round (execution-model §5.6): which round of how many
 * it belongs to, and whether it judges one Acceptance Criterion of the round
 * (`optimizer_criterion`, subject `acceptance_criterion`) or is the overall
 * round verdict (`optimizer_verdict`, subject `optimizer_round`). Round
 * identity lives here and nowhere else — never in a rubric string, a
 * summary, or a Handoff. `null` for every other Evaluation.
 */
export type EvaluationContext =
  | { kind: "optimizer_criterion"; round: number; maxRounds: number }
  | { kind: "optimizer_verdict"; round: number; maxRounds: number };

const roundContext = <K extends string>(kind: K) =>
  z
    .strictObject({ kind: z.literal(kind), round: positiveCount, maxRounds: positiveCount })
    .refine((c) => c.round <= c.maxRounds, { message: "round is within maxRounds", path: ["round"] });

export const evaluationContextSchema: z.ZodType<EvaluationContext> = z.discriminatedUnion("kind", [roundContext("optimizer_criterion"), roundContext("optimizer_verdict")]);

export const OPTIMIZER_EVALUATION_CONTEXT_KINDS = ["optimizer_criterion", "optimizer_verdict"] as const;

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

type EvaluationShape = Pick<Evaluation, "subject" | "context" | "planNodeId" | "gateId" | "verdict" | "snapshotId">;

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
  if (evaluation.planNodeId === null) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "an optimizer-round Evaluation belongs to its evaluator_optimizer Plan Node" });
  if (evaluation.gateId !== null) ctx.addIssue({ code: "custom", path: ["gateId"], message: "an optimizer-round Evaluation belongs to no Gate" });
  if (evaluation.snapshotId === null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "an optimizer-round Evaluation names the judged Snapshot" });
  if (context.kind === "optimizer_verdict" && subject.kind !== "optimizer_round") ctx.addIssue({ code: "custom", path: ["subject"], message: "the overall optimizer verdict judges the round (subject optimizer_round)" });
  if (context.kind === "optimizer_criterion" && subject.kind !== "acceptance_criterion") ctx.addIssue({ code: "custom", path: ["subject"], message: "an optimizer criterion Evaluation judges one Acceptance Criterion" });
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
  .superRefine(optimizerShape);

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
  .superRefine(optimizerShape);

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
 * A runtime checkpoint. It lists the Acceptance Criteria it requires in the
 * order they are checked: deterministic first, then evaluated, then (for
 * `operator_signoff`) the operator's acceptance.
 */
export interface Gate {
  id: GateId;
  runId: RunId;
  planNodeId: PlanNodeId | null;
  kind: GateKind;
  status: GateStatus;
  acceptanceCriterionIds: AcceptanceCriterionId[];
  /** The integration Snapshot the Gate was checked against. */
  snapshotId: SnapshotId | null;
  openedAt: Timestamp;
  closedAt: Timestamp | null;
}

export const gateSchema: z.ZodType<Gate> = z
  .strictObject({
    id: idSchema("gate"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    kind: z.enum(GATE_KINDS),
    status: z.enum(GATE_STATUSES),
    acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    snapshotId: idSchema("snapshot").nullable(),
    openedAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .refine((g) => (g.kind === "node_exit") === (g.planNodeId !== null), {
    message: "a node_exit Gate belongs to a Plan Node; Run Gates do not",
    path: ["planNodeId"],
  })
  .refine((g) => (g.status === "open") === (g.closedAt === null), {
    message: "closedAt is set exactly when the Gate is closed",
    path: ["closedAt"],
  });

export interface GateInput {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  kind: GateKind;
  acceptanceCriterionIds: AcceptanceCriterionId[];
  snapshotId: SnapshotId | null;
}

export const gateInputSchema: z.ZodType<GateInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    kind: z.enum(GATE_KINDS),
    acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    snapshotId: idSchema("snapshot").nullable(),
  })
  .refine((g) => (g.kind === "node_exit") === (g.planNodeId !== null), {
    message: "a node_exit Gate belongs to a Plan Node; Run Gates do not",
    path: ["planNodeId"],
  });
