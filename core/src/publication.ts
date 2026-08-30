import { z } from "zod";
import { DomainError } from "./errors.ts";
import type { AcceptanceCriterionId, ArtifactId, ChangesetId, DecisionId, EvaluationId, PublicationId, RunId, SnapshotId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { canonicalJson, idSchema, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";
import { publicationStrategyRequestSchema, publicationStrategySchema, type PublicationStrategy, type PublicationStrategyRequest } from "./workspace-state.ts";

/**
 * Publication (execution-model §9.4): the one runtime boundary that may
 * modify a Run's Target. Every Publication is authorized by its own resolved
 * `publish` Decision of a `completed` Run and applies exactly the Run's
 * `final` Changeset. The runtime prepares and verifies the prospective
 * post-publication state without modifying the Target, then performs one
 * atomic compare-and-swap Target update with a durable provider receipt;
 * every crash window converges from these rows without duplicating or
 * ambiguously repeating the Target mutation. A completed Run stays
 * `completed` whatever the Publication's outcome.
 */

export const PUBLICATION_STATUSES = ["requested", "prepared", "verified", "applying", "succeeded", "failed"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * `requested` until the candidate is prepared; `prepared` until every
 * deterministic Acceptance Criterion of the accepted completion boundary
 * passed on the candidate; `verified` until the runtime durably committed to
 * calling the Target update; `applying` until the atomic compare-and-swap
 * either applied (with its durable receipt) or definitely did not.
 * Infrastructure uncertainty never becomes a terminal state: a failed
 * preparation attempt leaves `requested`, a failed check attempt leaves
 * `prepared`, an unknown Target-update result leaves `applying`, and
 * recovery retries or reconciles from these rows. `verified → applying` has
 * no failure edge: it is the durable commitment boundary, written before the
 * external call so a crash after it is reconciled through the idempotent
 * apply. Terminal rows are immutable history.
 */
export const PUBLICATION_MACHINE = defineStateMachine<PublicationStatus>("Publication", PUBLICATION_STATUSES, {
  requested: ["prepared", "failed"],
  prepared: ["verified", "failed"],
  verified: ["applying"],
  applying: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
});

/**
 * Why a Publication terminally failed: closed structured facts, never
 * arbitrary strings. Every one means the Target was not modified by this
 * Publication. An infrastructure failure (a provider that could not be
 * reached, a lost view, an unknown apply result) is retryable nonterminal
 * state and is never one of these.
 */
export type PublicationFailure =
  /** The exact requested strategy is not supported by the Workspace provider for this Target. */
  | { kind: "strategy_unsupported"; strategy: PublicationStrategy }
  /** `fast_forward` was requested (or selected) but the Target no longer equals the Run's base Snapshot. */
  | { kind: "fast_forward_unavailable" }
  /** The candidate could not be constructed cleanly (a merge conflict); diagnostics live in the report's diagnostic Artifact. */
  | { kind: "candidate_conflict" }
  /** A deterministic Acceptance Criterion failed on the prepared candidate; the Target is unchanged. */
  | { kind: "verification_failed"; acceptanceCriterionIds: AcceptanceCriterionId[] }
  /** The Target changed between preparation and the compare-and-swap; the apply definitely did not happen. */
  | { kind: "target_changed" }
  /** The candidate state is structurally invalid for publication. */
  | { kind: "candidate_invalid" };

export const PUBLICATION_FAILURE_KINDS = ["strategy_unsupported", "fast_forward_unavailable", "candidate_conflict", "verification_failed", "target_changed", "candidate_invalid"] as const;

export const publicationFailureSchema: z.ZodType<PublicationFailure> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("strategy_unsupported"), strategy: publicationStrategySchema }),
  z.strictObject({ kind: z.literal("fast_forward_unavailable") }),
  z.strictObject({ kind: z.literal("candidate_conflict") }),
  z.strictObject({ kind: z.literal("verification_failed"), acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")).min(1) }),
  z.strictObject({ kind: z.literal("target_changed") }),
  z.strictObject({ kind: z.literal("candidate_invalid") }),
]);

/** The failure kinds a preparation refusal may record (a terminal failure from `requested`). */
export const PREPARE_FAILURE_KINDS = ["strategy_unsupported", "fast_forward_unavailable", "candidate_conflict", "candidate_invalid"] as const satisfies readonly PublicationFailure["kind"][];

/**
 * The durable cleanup state of a Publication's staging resources (the
 * isolated publication workspace/ref its candidate was constructed in):
 * `pending` from creation — release is idempotent and releasing staging that
 * was never created is a no-op — and `released` only after the external
 * release ran for a terminal Publication. A cleanup failure never alters the
 * Publication outcome; recovery retries until `released`.
 */
export const PUBLICATION_STAGING_CLEANUP_STATES = ["pending", "released"] as const;
export type PublicationStagingCleanup = (typeof PUBLICATION_STAGING_CLEANUP_STATES)[number];

/**
 * One authorized publication of a `completed` Run's accepted final Changeset
 * to its Target. Identity (the Run, the `publish` Decision, the final
 * Changeset, the requested strategy) is immutable from creation; the
 * prepared facts (selected strategy, Target-before Snapshot, candidate
 * Snapshot) are recorded once when preparation persists; on success the
 * Target-after reference is exactly the candidate Snapshot row — succeeded
 * means the Target now holds the prepared, verified candidate. Terminal rows
 * carry the closed failure (for `failed`), the publication-report Artifact,
 * and their terminal time, and never change again.
 */
export interface Publication {
  id: PublicationId;
  runId: RunId;
  /** The resolved `publish` Decision that authorized exactly this Publication; one Publication per Decision. */
  decisionId: DecisionId;
  /** The Run's `final` Changeset (`Run.finalChangesetId`): the only content a Publication applies. */
  changesetId: ChangesetId;
  requestedStrategy: PublicationStrategyRequest;
  /** The concrete strategy the provider selected or honored; recorded once, when prepared. */
  strategy: PublicationStrategy | null;
  /** The Target as preparation found it; the compare-and-swap expects exactly this state. */
  targetBeforeSnapshotId: SnapshotId | null;
  /** The prospective post-publication state, constructed without modifying the Target. */
  candidateSnapshotId: SnapshotId | null;
  /** On success, exactly the candidate Snapshot: the state the Target was atomically updated to. */
  targetAfterSnapshotId: SnapshotId | null;
  status: PublicationStatus;
  /** The closed structured failure; set exactly when the Publication failed. */
  failure: PublicationFailure | null;
  /** The canonical publication-report Artifact; set exactly when the Publication is terminal. */
  reportArtifactId: ArtifactId | null;
  stagingCleanup: PublicationStagingCleanup;
  createdAt: Timestamp;
  preparedAt: Timestamp | null;
  /** When candidate verification completed (`prepared → verified`). */
  verifiedAt: Timestamp | null;
  /** When the runtime durably committed to the Target update (`verified → applying`), before the external call. */
  applyingAt: Timestamp | null;
  endedAt: Timestamp | null;
  stagingReleasedAt: Timestamp | null;
}

const PREPARED_STATUSES: readonly PublicationStatus[] = ["prepared", "verified", "applying", "succeeded"];
const VERIFIED_STATUSES: readonly PublicationStatus[] = ["verified", "applying", "succeeded"];
const APPLYING_STATUSES: readonly PublicationStatus[] = ["applying", "succeeded"];

type PublicationShape = Pick<Publication, "status" | "strategy" | "targetBeforeSnapshotId" | "candidateSnapshotId" | "targetAfterSnapshotId" | "failure" | "reportArtifactId" | "stagingCleanup" | "preparedAt" | "verifiedAt" | "applyingAt" | "endedAt" | "stagingReleasedAt">;

function publicationShape(p: PublicationShape, ctx: z.RefinementCtx): void {
  const prepared = p.preparedAt !== null;
  if ((p.strategy !== null) !== prepared || (p.targetBeforeSnapshotId !== null) !== prepared || (p.candidateSnapshotId !== null) !== prepared) {
    ctx.addIssue({ code: "custom", path: ["strategy"], message: "the selected strategy, Target-before Snapshot, and candidate Snapshot are recorded together, exactly when preparation persisted" });
  }
  if (PREPARED_STATUSES.includes(p.status) && !prepared) ctx.addIssue({ code: "custom", path: ["preparedAt"], message: `a ${p.status} Publication has persisted its prepared facts` });
  if (p.status === "requested" && prepared) ctx.addIssue({ code: "custom", path: ["preparedAt"], message: "a requested Publication has no prepared facts yet" });
  if (VERIFIED_STATUSES.includes(p.status) !== (p.verifiedAt !== null) && p.status !== "failed") {
    ctx.addIssue({ code: "custom", path: ["verifiedAt"], message: "verifiedAt is set exactly once verification completed" });
  }
  if (APPLYING_STATUSES.includes(p.status) !== (p.applyingAt !== null) && p.status !== "failed") {
    ctx.addIssue({ code: "custom", path: ["applyingAt"], message: "applyingAt is set exactly once the runtime committed to the Target update" });
  }
  if (p.verifiedAt !== null && p.preparedAt === null) ctx.addIssue({ code: "custom", path: ["verifiedAt"], message: "verification follows preparation" });
  if (p.applyingAt !== null && p.verifiedAt === null) ctx.addIssue({ code: "custom", path: ["applyingAt"], message: "the Target update follows verification" });
  if ((p.status === "failed") !== (p.failure !== null)) ctx.addIssue({ code: "custom", path: ["failure"], message: "failure is set exactly when the Publication failed" });
  const terminal = p.status === "succeeded" || p.status === "failed";
  if (terminal !== (p.endedAt !== null)) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt is set exactly when the Publication is terminal" });
  if (terminal !== (p.reportArtifactId !== null)) ctx.addIssue({ code: "custom", path: ["reportArtifactId"], message: "the publication report is recorded exactly when the Publication is terminal" });
  if (p.status === "succeeded" && (p.targetAfterSnapshotId === null || p.targetAfterSnapshotId !== p.candidateSnapshotId)) {
    ctx.addIssue({ code: "custom", path: ["targetAfterSnapshotId"], message: "succeeded means the Target holds exactly the prepared candidate" });
  }
  if (p.status !== "succeeded" && p.targetAfterSnapshotId !== null) ctx.addIssue({ code: "custom", path: ["targetAfterSnapshotId"], message: "only a succeeded Publication records a Target-after Snapshot; a failed one left the Target unchanged" });
  if (p.failure !== null) {
    if (p.failure.kind === "verification_failed" && !prepared) ctx.addIssue({ code: "custom", path: ["failure"], message: "verification_failed judges a prepared candidate" });
    if (p.failure.kind === "target_changed" && p.applyingAt === null) ctx.addIssue({ code: "custom", path: ["failure"], message: "target_changed is the definite not-applied result of the compare-and-swap" });
    if ((PREPARE_FAILURE_KINDS as readonly string[]).includes(p.failure.kind) && p.verifiedAt !== null) {
      ctx.addIssue({ code: "custom", path: ["failure"], message: `${p.failure.kind} fails preparation, before verification completed` });
    }
  }
  if ((p.stagingCleanup === "released") !== (p.stagingReleasedAt !== null)) ctx.addIssue({ code: "custom", path: ["stagingReleasedAt"], message: "stagingReleasedAt is set exactly when the staging resources were released" });
  if (p.stagingCleanup === "released" && !terminal) ctx.addIssue({ code: "custom", path: ["stagingCleanup"], message: "staging resources are released only after the Publication is terminal" });
}

export const publicationSchema: z.ZodType<Publication> = z
  .strictObject({
    id: idSchema("publication"),
    runId: idSchema("run"),
    decisionId: idSchema("decision"),
    changesetId: idSchema("changeset"),
    requestedStrategy: publicationStrategyRequestSchema,
    strategy: publicationStrategySchema.nullable(),
    targetBeforeSnapshotId: idSchema("snapshot").nullable(),
    candidateSnapshotId: idSchema("snapshot").nullable(),
    targetAfterSnapshotId: idSchema("snapshot").nullable(),
    status: z.enum(PUBLICATION_STATUSES),
    failure: publicationFailureSchema.nullable(),
    reportArtifactId: idSchema("artifact").nullable(),
    stagingCleanup: z.enum(PUBLICATION_STAGING_CLEANUP_STATES),
    createdAt: timestampSchema,
    preparedAt: timestampSchema.nullable(),
    verifiedAt: timestampSchema.nullable(),
    applyingAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    stagingReleasedAt: timestampSchema.nullable(),
  })
  .superRefine(publicationShape);

/** What creates a `requested` Publication: the resolving `publish` Decision's own facts, in its resolving transaction. */
export interface PublicationInput {
  runId: RunId;
  decisionId: DecisionId;
  changesetId: ChangesetId;
  requestedStrategy: PublicationStrategyRequest;
}

export const publicationInputSchema: z.ZodType<PublicationInput> = z.strictObject({
  runId: idSchema("run"),
  decisionId: idSchema("decision"),
  changesetId: idSchema("changeset"),
  requestedStrategy: publicationStrategyRequestSchema,
});

export type PublicationTransition =
  | { to: "prepared"; strategy: PublicationStrategy; targetBeforeSnapshotId: SnapshotId; candidateSnapshotId: SnapshotId }
  | { to: "verified" }
  | { to: "applying" }
  | { to: "succeeded"; reportArtifactId: ArtifactId }
  | { to: "failed"; failure: PublicationFailure; reportArtifactId: ArtifactId };

// ---------------------------------------------------------------------------
// Publication report
// ---------------------------------------------------------------------------

/** The media type of the canonical publication-report Artifact; the version is part of the type, never a compatibility flag. */
export const PUBLICATION_REPORT_MEDIA_TYPE = "application/vnd.agentique.publication-report.v1+json";
export const PUBLICATION_REPORT_VERSION = 1;

/**
 * The canonical terminal report of one Publication: bounded canonical facts
 * only — ids, the strategies, the Snapshot references, the closed outcome
 * and failure, and the candidate-verification Evaluation ids. Raw provider
 * or command output never enters it; when retained it lives in the separate
 * diagnostic Artifact the report references by id.
 */
export interface PublicationReport {
  version: typeof PUBLICATION_REPORT_VERSION;
  publicationId: PublicationId;
  runId: RunId;
  decisionId: DecisionId;
  changesetId: ChangesetId;
  requestedStrategy: PublicationStrategyRequest;
  strategy: PublicationStrategy | null;
  targetBeforeSnapshotId: SnapshotId | null;
  candidateSnapshotId: SnapshotId | null;
  targetAfterSnapshotId: SnapshotId | null;
  outcome: "succeeded" | "failed";
  failure: PublicationFailure | null;
  /** The candidate-verification Evaluations, in canonical id order. */
  evaluationIds: EvaluationId[];
  /** Bounded raw diagnostics (a conflict report, a provider message), stored separately; never inlined. */
  diagnosticArtifactId: ArtifactId | null;
}

export const publicationReportSchema: z.ZodType<PublicationReport> = z
  .strictObject({
    version: z.literal(PUBLICATION_REPORT_VERSION),
    publicationId: idSchema("publication"),
    runId: idSchema("run"),
    decisionId: idSchema("decision"),
    changesetId: idSchema("changeset"),
    requestedStrategy: publicationStrategyRequestSchema,
    strategy: publicationStrategySchema.nullable(),
    targetBeforeSnapshotId: idSchema("snapshot").nullable(),
    candidateSnapshotId: idSchema("snapshot").nullable(),
    targetAfterSnapshotId: idSchema("snapshot").nullable(),
    outcome: z.enum(["succeeded", "failed"]),
    failure: publicationFailureSchema.nullable(),
    evaluationIds: uniqueIds(idSchema("evaluation")).refine((ids) => ids.every((id, i) => i === 0 || ids[i - 1]! < id), { message: "evaluation ids are in canonical order" }),
    diagnosticArtifactId: idSchema("artifact").nullable(),
  })
  .refine((r) => (r.outcome === "failed") === (r.failure !== null), { message: "the failure is reported exactly when the Publication failed", path: ["failure"] });

/** The deterministic bytes of a publication report: equal reports serialize identically. */
export function canonicalPublicationReport(report: PublicationReport): string {
  return canonicalJson(report);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why the publication service refuses an operation before writing anything.
 * Every code names a canonical fact; a refusal never resolves a Decision,
 * creates or transitions a Publication, or touches the Target.
 */
export const PUBLICATION_REFUSAL_CODES = [
  /** The Run is not `completed`; only a completed Run may have a Publication. */
  "run_not_completed",
  /** The named Decision is not the Run's `publish` Decision, or its subject disagrees with the Run's rows. */
  "decision_mismatch",
  /** The rows of the publication boundary disagree with one another. */
  "boundary_inconsistent",
  /** The Decision was already resolved with the other option, or a replay asked for different inputs. */
  "conflicting_resolution",
  /** The Run already has an open `publish` Decision asking for something else; only one open publish Decision exists per Run. */
  "publish_decision_open",
  /** The Run already has a nonterminal Publication; a further attempt needs its terminal outcome first. */
  "publication_active",
  /** The Run has a succeeded Publication; a succeeded Run is never published again. */
  "run_already_published",
] as const;
export type PublicationRefusalCode = (typeof PUBLICATION_REFUSAL_CODES)[number];

/** A refused publication operation: the closed code and bounded details (ids and closed facts only). */
export class PublicationRefusedError extends DomainError {
  readonly refusal: PublicationRefusalCode;

  constructor(refusal: PublicationRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, { refusal, ...details });
    this.refusal = refusal;
  }
}
