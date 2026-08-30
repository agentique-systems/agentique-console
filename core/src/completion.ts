import { z } from "zod";
import { FINAL_RESERVE_USES, type FinalReserveUse } from "./budgets.ts";
import type {
  AcceptanceCriterionId,
  ArtifactId,
  ChangesetId,
  CompletionRequestId,
  DecisionId,
  GateId,
  InvocationId,
  PlanNodeId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  RuntimeToolCallId,
  SnapshotId,
  TaskId,
} from "./ids.ts";
import { CHANGESET_INTEGRATION_STATUSES, type ChangesetIntegrationStatus } from "./workspace-state.ts";
import { PLAN_NODE_STATUSES, type PlanNodeStatus } from "./plans.ts";
import { REQUIREMENT_STATUSES, type RequirementStatus } from "./requirements.ts";
import { TASK_STATUSES, type TaskStatus } from "./tasks.ts";
import { defineStateMachine } from "./transitions.ts";
import { canonicalJson, idSchema, nonEmptyString, positiveCount, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/**
 * Run completion (execution-model §3, §10 `run_completion`). Completion
 * begins only from an accepted `request_completion` runtime-tool call of the
 * root Orchestrator, never from prose or a `return_result`; the accepted
 * call creates one canonical **Completion Request**, whose closed lifecycle
 * is the record the scheduler, the `run_completion` Gate, the final
 * synthesis, and the `operator_signoff` boundary derive from. Nothing here
 * is inferred from Events or transcripts.
 */

// ---------------------------------------------------------------------------
// Preflight (the runtime-tool call's refusal reasons)
// ---------------------------------------------------------------------------

/**
 * Why a `request_completion` call is refused before any row is written, or
 * why an accepted request is cancelled when the Run drifted before its
 * verification began. Every code names a canonical fact of the Run.
 */
export const COMPLETION_PREFLIGHT_CODES = [
  "completion_request_active",
  "run_not_running",
  "node_active",
  "node_failed",
  "changeset_unintegrated",
  "gate_open",
  "gate_remediation_unresolved",
  "invocation_active",
  "task_unfinished",
  "decision_unresolved",
  "no_integration_snapshot",
  "no_deterministic_completion_criterion",
  "evaluator_unavailable",
  "final_reserve_insufficient",
  "run_completion_cycles_exhausted",
] as const;
export type CompletionPreflightCode = (typeof COMPLETION_PREFLIGHT_CODES)[number];

// ---------------------------------------------------------------------------
// Structural completion conditions
// ---------------------------------------------------------------------------

/**
 * One structural reason a `run_completion` Gate cannot pass after its
 * criteria were judged and the Requirement statuses derived (execution-model
 * §10): ids and closed statuses only, never narrative.
 */
export type CompletionCondition =
  | { kind: "requirement_unsatisfied"; requirementId: RequirementId; status: RequirementStatus }
  | { kind: "task_unfinished"; taskId: TaskId; status: TaskStatus }
  | { kind: "decision_unresolved"; decisionId: DecisionId }
  | { kind: "changeset_unintegrated"; changesetId: ChangesetId; status: ChangesetIntegrationStatus }
  | { kind: "node_gate_open"; gateId: GateId; planNodeId: PlanNodeId }
  | { kind: "node_unfinished"; planNodeId: PlanNodeId; status: PlanNodeStatus }
  | { kind: "criterion_unjudged"; acceptanceCriterionId: AcceptanceCriterionId }
  | { kind: "snapshot_moved"; pinnedSnapshotId: SnapshotId; currentSnapshotId: SnapshotId | null };

export const completionConditionSchema: z.ZodType<CompletionCondition> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("requirement_unsatisfied"), requirementId: idSchema("requirement"), status: z.enum(REQUIREMENT_STATUSES) }),
  z.strictObject({ kind: z.literal("task_unfinished"), taskId: idSchema("task"), status: z.enum(TASK_STATUSES) }),
  z.strictObject({ kind: z.literal("decision_unresolved"), decisionId: idSchema("decision") }),
  z.strictObject({ kind: z.literal("changeset_unintegrated"), changesetId: idSchema("changeset"), status: z.enum(CHANGESET_INTEGRATION_STATUSES) }),
  z.strictObject({ kind: z.literal("node_gate_open"), gateId: idSchema("gate"), planNodeId: idSchema("planNode") }),
  z.strictObject({ kind: z.literal("node_unfinished"), planNodeId: idSchema("planNode"), status: z.enum(PLAN_NODE_STATUSES) }),
  z.strictObject({ kind: z.literal("criterion_unjudged"), acceptanceCriterionId: idSchema("acceptanceCriterion") }),
  z.strictObject({ kind: z.literal("snapshot_moved"), pinnedSnapshotId: idSchema("snapshot"), currentSnapshotId: idSchema("snapshot").nullable() }),
]);

// ---------------------------------------------------------------------------
// Completion Request
// ---------------------------------------------------------------------------

export const COMPLETION_REQUEST_STATUSES = ["requested", "verifying", "passed", "failed", "cancelled"] as const;
export type CompletionRequestStatus = (typeof COMPLETION_REQUEST_STATUSES)[number];

/**
 * `requested` while the requesting Orchestrator turn is still settling;
 * `verifying` once the Run entered `verifying` and the `run_completion` Gate
 * opened; `passed` with the final-report Artifact once the Gate passed and
 * the `operator_signoff` boundary exists; `failed` with the closed outcome
 * once the Gate closed `failed`; `cancelled` with the closed outcome when
 * verification never began (the requesting turn did not complete, or the
 * Run drifted). Terminal statuses are historical; a later attempt is a new
 * Completion Request.
 */
export const COMPLETION_REQUEST_MACHINE = defineStateMachine<CompletionRequestStatus>("CompletionRequest", COMPLETION_REQUEST_STATUSES, {
  requested: ["verifying", "cancelled"],
  verifying: ["passed", "failed"],
  passed: [],
  failed: [],
  cancelled: [],
});

/** The closed terminal outcome of a failed or cancelled Completion Request. */
export type CompletionRequestOutcome =
  /** Deterministic or evaluated completion criteria did not pass. */
  | { kind: "criteria_failed"; acceptanceCriterionIds: AcceptanceCriterionId[] }
  /** The run-completion Gate Evaluator ended without a valid verdict after its permitted Attempts; no verdict was invented. */
  | { kind: "evaluator_failed"; invocationId: InvocationId }
  /** Every criterion passed but the Run's structural completion conditions did not hold. */
  | { kind: "conditions_unmet"; conditions: CompletionCondition[] }
  /** The final-synthesis Orchestrator Invocation ended without a valid report after its permitted Attempts; no report was fabricated. */
  | { kind: "final_synthesis_failed"; invocationId: InvocationId }
  /** The Run's final reserve cannot fund the next completion Invocation; ordinary capacity is never a fallback. */
  | { kind: "final_reserve_exhausted"; use: FinalReserveUse }
  /** The Run's `maxRunCompletionCycles` permits no further `run_completion` Gate. */
  | { kind: "run_completion_cycles_exhausted"; maxRunCompletionCycles: number }
  /** The completion preconditions no longer held when verification was to begin. */
  | { kind: "preconditions_changed"; codes: CompletionPreflightCode[] }
  /** The requesting Orchestrator turn ended without completing (failed, cancelled, or blocked without a resolution). */
  | { kind: "requesting_turn_failed"; invocationId: InvocationId };

export const completionRequestOutcomeSchema: z.ZodType<CompletionRequestOutcome> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("criteria_failed"), acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")).min(1) }),
  z.strictObject({ kind: z.literal("evaluator_failed"), invocationId: idSchema("invocation") }),
  z.strictObject({ kind: z.literal("conditions_unmet"), conditions: z.array(completionConditionSchema).min(1) }),
  z.strictObject({ kind: z.literal("final_synthesis_failed"), invocationId: idSchema("invocation") }),
  z.strictObject({ kind: z.literal("final_reserve_exhausted"), use: z.enum(FINAL_RESERVE_USES) }),
  z.strictObject({ kind: z.literal("run_completion_cycles_exhausted"), maxRunCompletionCycles: positiveCount }),
  z.strictObject({ kind: z.literal("preconditions_changed"), codes: z.array(z.enum(COMPLETION_PREFLIGHT_CODES)).min(1) }),
  z.strictObject({ kind: z.literal("requesting_turn_failed"), invocationId: idSchema("invocation") }),
]);

/** The outcomes a `failed` request may carry; every other outcome belongs to `cancelled`. */
export const COMPLETION_FAILURE_OUTCOME_KINDS = ["criteria_failed", "evaluator_failed", "conditions_unmet", "final_synthesis_failed", "final_reserve_exhausted"] as const satisfies readonly CompletionRequestOutcome["kind"][];

export interface CompletionRequest {
  id: CompletionRequestId;
  runId: RunId;
  /** The root Orchestrator Invocation whose accepted `request_completion` call created the request. */
  invocationId: InvocationId;
  /** The accepted runtime-tool call the request was created with; a replay of that call returns this request. */
  runtimeToolCallId: RuntimeToolCallId;
  status: CompletionRequestStatus;
  /** The one `run_completion` Gate of this request, set when verification began; immutable afterwards. */
  gateId: GateId | null;
  /** The canonical final-report Artifact, set exactly when the request passed. */
  reportArtifactId: ArtifactId | null;
  /** The closed terminal outcome; set exactly when the request failed or was cancelled. */
  outcome: CompletionRequestOutcome | null;
  createdAt: Timestamp;
  /** When the Run entered `verifying` for this request. */
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export const completionRequestSchema: z.ZodType<CompletionRequest> = z
  .strictObject({
    id: idSchema("completionRequest"),
    runId: idSchema("run"),
    invocationId: idSchema("invocation"),
    runtimeToolCallId: idSchema("runtimeToolCall"),
    status: z.enum(COMPLETION_REQUEST_STATUSES),
    gateId: idSchema("gate").nullable(),
    reportArtifactId: idSchema("artifact").nullable(),
    outcome: completionRequestOutcomeSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .refine((r) => (r.status === "verifying" || r.status === "passed" || r.status === "failed") === (r.gateId !== null), {
    message: "a request names its Gate from verifying on; a requested or cancelled request names none",
    path: ["gateId"],
  })
  .refine((r) => (r.status === "verifying" || r.status === "passed" || r.status === "failed") === (r.startedAt !== null), { message: "startedAt is set exactly once verification began", path: ["startedAt"] })
  .refine((r) => (r.status === "passed") === (r.reportArtifactId !== null), { message: "the report Artifact is set exactly when the request passed", path: ["reportArtifactId"] })
  .refine((r) => (r.status === "failed" || r.status === "cancelled") === (r.outcome !== null), { message: "the outcome is set exactly when the request failed or was cancelled", path: ["outcome"] })
  .refine((r) => r.status !== "failed" || (r.outcome !== null && (COMPLETION_FAILURE_OUTCOME_KINDS as readonly string[]).includes(r.outcome.kind)), {
    message: "a failed request carries a verification failure outcome",
    path: ["outcome"],
  })
  .refine((r) => r.status !== "cancelled" || (r.outcome !== null && !(COMPLETION_FAILURE_OUTCOME_KINDS as readonly string[]).includes(r.outcome.kind)), {
    message: "a cancelled request carries a cancellation outcome",
    path: ["outcome"],
  })
  .refine((r) => COMPLETION_REQUEST_MACHINE.isTerminal(r.status) === (r.endedAt !== null), { message: "endedAt is set exactly when the request is terminal", path: ["endedAt"] });

export interface CompletionRequestInput {
  runId: RunId;
  invocationId: InvocationId;
  runtimeToolCallId: RuntimeToolCallId;
}

export const completionRequestInputSchema: z.ZodType<CompletionRequestInput> = z.strictObject({
  runId: idSchema("run"),
  invocationId: idSchema("invocation"),
  runtimeToolCallId: idSchema("runtimeToolCall"),
});

export type CompletionRequestTransition =
  | { to: "verifying"; gateId: GateId }
  | { to: "passed"; reportArtifactId: ArtifactId }
  | { to: "failed"; outcome: CompletionRequestOutcome }
  | { to: "cancelled"; outcome: CompletionRequestOutcome };

// ---------------------------------------------------------------------------
// Final synthesis
// ---------------------------------------------------------------------------

export const FINAL_SYNTHESIS_MAX_SUMMARY_LENGTH = 2_000;
export const FINAL_SYNTHESIS_MAX_ITEMS = 20;
export const FINAL_SYNTHESIS_MAX_ITEM_LENGTH = 300;

/**
 * The bounded typed result only an Orchestrator `final_synthesis` Invocation
 * returns (execution-model §10): what was completed, how it was verified,
 * the risks, and the follow-ups, as short strings. It is separate from the
 * ordinary result summary and is the only source of the final report; the
 * runtime serializes it into the canonical final-report Artifact.
 */
export interface FinalSynthesisResult {
  summary: string;
  completed: string[];
  verification: string[];
  risks: string[];
  followUps: string[];
}

const items = z.array(nonEmptyString.max(FINAL_SYNTHESIS_MAX_ITEM_LENGTH)).max(FINAL_SYNTHESIS_MAX_ITEMS);

export const finalSynthesisResultSchema: z.ZodType<FinalSynthesisResult> = z.strictObject({
  summary: nonEmptyString.max(FINAL_SYNTHESIS_MAX_SUMMARY_LENGTH),
  completed: items,
  verification: items,
  risks: items,
  followUps: items,
});

/** The media type of the canonical final-report Artifact; the version is part of the type, never a compatibility flag. */
export const FINAL_REPORT_MEDIA_TYPE = "application/vnd.agentique.final-report.v1+json";
export const FINAL_REPORT_VERSION = 1;

/**
 * The canonical final report: the validated synthesis result bound to the
 * exact completion facts it reports on. Its bytes are the canonical JSON of
 * this value (keys sorted, no whitespace), stored once as the final-report
 * Artifact; Events and manifests carry the Artifact id only.
 */
export interface FinalReport {
  version: typeof FINAL_REPORT_VERSION;
  runId: RunId;
  completionRequestId: CompletionRequestId;
  gateId: GateId;
  snapshotId: SnapshotId;
  requirementRevisionId: RequirementRevisionId;
  report: FinalSynthesisResult;
}

export const finalReportSchema: z.ZodType<FinalReport> = z.strictObject({
  version: z.literal(FINAL_REPORT_VERSION),
  runId: idSchema("run"),
  completionRequestId: idSchema("completionRequest"),
  gateId: idSchema("gate"),
  snapshotId: idSchema("snapshot"),
  requirementRevisionId: idSchema("requirementRevision"),
  report: finalSynthesisResultSchema,
});

/** The deterministic bytes of a final report: equal reports serialize identically. */
export function canonicalFinalReport(report: FinalReport): string {
  return canonicalJson(report);
}
