/**
 * The publication Workspace port: the final boundary between the publication
 * service and the Workspace provider that prepares, applies, and releases
 * one authorized Publication (execution-model §9.4).
 *
 * Ownership rule: the execution runtime authorizes, selects what is
 * published, verifies the candidate, and records every outcome canonically;
 * the port inspects, constructs, and atomically swaps, and nothing else. It
 * receives exactly the facts in each request — identities, the Target, the
 * requested strategy, and a content source bound to the verified final
 * Changeset — and never a store, a database handle, a Blob Store, an
 * Artifact lookup, a transcript, or a credential object. An implementation
 * imports no persistence module and cannot enumerate or retrieve arbitrary
 * Artifacts. Every operation runs outside every database transaction.
 *
 * Contract for implementations:
 *
 * - `prepare` is idempotent by Publication id and never modifies the
 *   Target. It inspects the Target's current state, reads and applies the
 *   final Changeset's verified bytes into an isolated publication
 *   workspace/ref, selects the strategy under the request (`automatic`
 *   selects `fast_forward` when the Target still equals the Run's base
 *   Snapshot, otherwise a clean `merge` where supported; an `exact` request
 *   is honored exactly or refused, never silently widened or replaced), and
 *   returns the Target-before identity, the candidate identity, the
 *   selected strategy, and the verification workspace location. A replay
 *   for the same Publication returns the same prepared result. A
 *   deterministic refusal (`refused`) is terminal for the Publication; an
 *   `unavailable` outcome is retryable infrastructure state and commits the
 *   Publication to nothing.
 * - `apply` is idempotent by Publication id. It compares the Target against
 *   the expected (persisted Target-before) identity and atomically updates
 *   the Target to the candidate **and** writes a durable provider-owned
 *   receipt keyed by the Publication id, as one atomic provider operation —
 *   for git, an atomic reference transaction updating the Target ref and a
 *   publication receipt ref together. A replay whose receipt exists returns
 *   `applied` with `alreadyApplied: true` and the receipt's resulting
 *   identity, even when the Target has since moved again; success is never
 *   inferred from the Target merely equalling or containing the candidate.
 *   A failed compare-and-swap is the definite `target_changed` outcome and
 *   modified nothing; `unavailable` means the result is unknown and the
 *   runtime stays `applying`. There is no force update.
 * - `release` is idempotent, runs only after a terminal Publication, and
 *   removes the Publication's staging resources (never the Run's
 *   Integration Workspace and never the Target). Releasing staging that was
 *   never created is `released`. A failure is a bounded diagnostic; the
 *   runtime retries until released and never alters the Publication
 *   outcome.
 *
 * The provider implementation arrives in the Workspace phase; tests use a
 * deterministic fake that models the atomic update-plus-receipt guarantee
 * durably across process lifetimes.
 */
import type { PublicationId, PublicationStrategy, PublicationStrategyRequest, RunId, RunTarget, SnapshotIdentity, WorkspaceId } from "@agentique-console/core";
import type { ArtifactContentSource } from "./integration-workspace.ts";

/** The identities every publication operation names; never a path to content, a store, or a credential. */
export interface PublicationWorkspaceIdentity {
  publicationId: PublicationId;
  runId: RunId;
  workspaceId: WorkspaceId;
  /** The Workspace root the provider operates in. */
  workspaceRootPath: string;
  /** The operator-controlled Target the Publication is authorized for. */
  target: RunTarget;
}

export interface PublicationPrepareRequest extends PublicationWorkspaceIdentity {
  /** The Run's base Snapshot: what `automatic` compares the Target against for `fast_forward`. */
  baseSnapshot: SnapshotIdentity;
  requestedStrategy: PublicationStrategyRequest;
  /** The Run's accepted final Changeset, resolved and verified by the runtime. */
  changeset: {
    /** The Run's base Snapshot: where the final diff starts. */
    beforeSnapshot: SnapshotIdentity;
    /** The Run's accepted final Snapshot: where the final diff ends. */
    afterSnapshot: SnapshotIdentity;
    /** The exact verified diff bytes; a zero-byte diff is a valid, empty final Changeset. */
    diff: ArtifactContentSource;
  };
}

/** The deterministic prepare refusals; each is a terminal Publication failure of the same name. */
export const PUBLICATION_PREPARE_REFUSALS = ["strategy_unsupported", "fast_forward_unavailable", "candidate_conflict", "candidate_invalid"] as const;
export type PublicationPrepareRefusal = (typeof PUBLICATION_PREPARE_REFUSALS)[number];

export type PublicationPrepareOutcome =
  /** The candidate exists in an isolated publication workspace/ref; the Target was not modified. A replay returns the same result with `alreadyPrepared: true`. */
  | { kind: "prepared"; targetBeforeSnapshot: SnapshotIdentity; candidateSnapshot: SnapshotIdentity; strategy: PublicationStrategy; verificationWorkspacePath: string | null; alreadyPrepared: boolean }
  /** A deterministic refusal: the strategy cannot be honored or the candidate cannot be constructed cleanly. A `strategy_unsupported` refusal names the refused strategy; nothing staged survives; `message` is bounded and never output bytes. */
  | { kind: "refused"; refusal: PublicationPrepareRefusal; strategy: PublicationStrategy | null; message: string }
  /** Infrastructure failure: nothing is known to have happened; the Publication stays requested and a later pass retries. */
  | { kind: "unavailable"; message: string };

export interface PublicationApplyRequest extends PublicationWorkspaceIdentity {
  /** The persisted Target-before identity the compare-and-swap expects. */
  expectedTargetSnapshot: SnapshotIdentity;
  /** The persisted prepared candidate the Target is updated to. */
  candidateSnapshot: SnapshotIdentity;
  /** The persisted selected strategy. */
  strategy: PublicationStrategy;
}

export type PublicationApplyOutcome =
  /**
   * The Target holds the candidate and the durable receipt exists — either this call performed the atomic
   * update-plus-receipt, or a receipt from an earlier call was found (`alreadyApplied: true`), whose recorded
   * resulting identity is returned even when the Target has since moved again.
   */
  | { kind: "applied"; targetSnapshot: SnapshotIdentity; alreadyApplied: boolean }
  /** The definite not-applied result: the Target no longer holds the expected identity and was not modified. */
  | { kind: "target_changed"; currentTargetSnapshot: SnapshotIdentity }
  /** The result of the Target update is unknown; nothing may be concluded and the runtime stays `applying`. */
  | { kind: "unavailable"; message: string };

export type PublicationReleaseRequest = PublicationWorkspaceIdentity;

export type PublicationReleaseOutcome =
  /** The Publication's staging resources are gone (or never existed). */
  | { kind: "released" }
  /** Cleanup failed; the obligation stays pending and is retried. `message` is bounded. */
  | { kind: "failed"; message: string };

export interface PublicationWorkspacePort {
  prepare(request: PublicationPrepareRequest): Promise<PublicationPrepareOutcome>;
  apply(request: PublicationApplyRequest): Promise<PublicationApplyOutcome>;
  release(request: PublicationReleaseRequest): Promise<PublicationReleaseOutcome>;
}
