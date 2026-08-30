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
import { idSchema, nonEmptyString, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

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
  | { kind: "route_selection"; selectedLabel: string };

export const evaluationSubjectSchema: z.ZodType<EvaluationSubject> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("acceptance_criterion"), acceptanceCriterionId: idSchema("acceptanceCriterion") }),
  z.strictObject({ kind: z.literal("rubric"), rubric: nonEmptyString }),
  z.strictObject({ kind: z.literal("route_selection"), selectedLabel: nonEmptyString }),
]);

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
  verdict: Verdict;
  evidence: Evidence[];
  producedBy: EvaluationProducer;
  /** The Artifacts that were judged. */
  artifactIds: ArtifactId[];
  createdAt: Timestamp;
}

/** A route-selection Evaluation names its route node, no Gate, and no judged Artifact: the selection is the whole fact. */
function routeSelectionShape(evaluation: Pick<Evaluation, "subject" | "planNodeId" | "gateId" | "verdict">, ctx: z.RefinementCtx): void {
  if (evaluation.subject.kind !== "route_selection") return;
  if (evaluation.planNodeId === null) ctx.addIssue({ code: "custom", path: ["planNodeId"], message: "a route_selection Evaluation belongs to its route Plan Node" });
  if (evaluation.gateId !== null) ctx.addIssue({ code: "custom", path: ["gateId"], message: "a route_selection Evaluation belongs to no Gate" });
  if (evaluation.verdict !== "pass") ctx.addIssue({ code: "custom", path: ["verdict"], message: "a route_selection Evaluation records a selection that was made; an unmade selection is never recorded" });
}

export const evaluationSchema: z.ZodType<Evaluation> = z
  .strictObject({
    id: idSchema("evaluation"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    gateId: idSchema("gate").nullable(),
    subject: evaluationSubjectSchema,
    verdict: z.enum(VERDICTS),
    evidence: z.array(evidenceSchema),
    producedBy: evaluationProducerSchema,
    artifactIds: uniqueIds(idSchema("artifact")),
    createdAt: timestampSchema,
  })
  .superRefine(routeSelectionShape);

export interface EvaluationInput {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  gateId: GateId | null;
  subject: EvaluationSubject;
  verdict: Verdict;
  evidence: Evidence[];
  producedBy: EvaluationProducer;
  artifactIds: ArtifactId[];
}

export const evaluationInputSchema: z.ZodType<EvaluationInput> = z
  .strictObject({
    runId: idSchema("run"),
    planNodeId: idSchema("planNode").nullable(),
    gateId: idSchema("gate").nullable(),
    subject: evaluationSubjectSchema,
    verdict: z.enum(VERDICTS),
    evidence: z.array(evidenceSchema),
    producedBy: evaluationProducerSchema,
    artifactIds: uniqueIds(idSchema("artifact")),
  })
  .superRefine(routeSelectionShape);

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
