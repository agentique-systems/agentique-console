/**
 * Changeset integration (execution-model §9.2; glossary Changeset,
 * Integration Workspace): the smallest provider-neutral service that makes
 * sequential Patterns semantically correct. A completed writing Invocation's
 * pending Changeset is applied to the Run's Integration Workspace through
 * the integration-workspace port, outside any database transaction, and the
 * result is then recorded canonically in one transaction: the integration
 * Snapshot, the Changeset's `integrated` transition, and the Run's advanced
 * integration Snapshot. A Changeset is never marked integrated before the
 * external application succeeded, and a crash in between is closed by
 * reconciliation: the port is idempotent by Changeset id, so the next call
 * applies nothing new and records what already happened.
 *
 * A conflict is never applied, discarded, retried without bound, or
 * reported as success: it is recorded through the Changeset's conflict
 * lifecycle with a bounded conflict Artifact and one canonical conflict
 * Task on the affected node; a later call may integrate once that Task is
 * `completed`, and a Changeset that conflicts again afterwards, or whose
 * Task ended without completing, is reported unresolved for the node to
 * fail. Integration within one Run is serialized in this process, which is
 * the repository's single-runtime-process ownership assumption; the Target
 * is never touched.
 *
 * Content ownership: this service, not the Workspace provider, resolves the
 * Changeset's diff Artifact through the canonical Artifact Store, checks
 * that it belongs to the Run and has the Changeset diff media type, and
 * verifies its digest and byte size — all outside any transaction — before
 * the port is called. The port receives an `ArtifactContentSource` bound to
 * that one Artifact; it never receives a store, a blob, a key, or a path to
 * the content. Content that is missing, corrupted, or inconsistent is an
 * infrastructure failure (`ChangesetContentError`): the port is not called,
 * nothing is recorded, and no conflict is invented. Diff bytes never appear
 * in an Event, an outcome, a diagnostic, or an error message.
 */
import {
  CHANGESET_DIFF_MEDIA_TYPE,
  NotFoundError,
  TASK_MACHINE,
  type Artifact,
  type ArtifactId,
  type Changeset,
  type ChangesetId,
  type PlanNodeId,
  type RunId,
  type Snapshot,
  type Task,
} from "@agentique-console/core";
import { BlobCorruptedError, BlobMissingError } from "../persistence/blob-store.ts";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { ArtifactContentSource, IntegrationApplyRequest, IntegrationWorkspacePort } from "./ports/integration-workspace.ts";

/** The bound on a conflict report stored as the conflict Artifact. */
export const CONFLICT_REPORT_MAX_BYTES = 16_384;

export type ChangesetContentFailure =
  /** The Changeset names an Artifact that has no metadata row. */
  | "artifact_missing"
  /** The Artifact belongs to another Run. */
  | "foreign_artifact"
  /** The Artifact is not a Changeset diff. */
  | "media_type"
  /** The Artifact's metadata no longer agrees with the content the source was bound to. */
  | "metadata_changed"
  /** The blob store holds no content for the Artifact's digest. */
  | "content_missing"
  /** The stored content does not hash to the Artifact's digest or has another byte size. */
  | "content_corrupted"
  /** Reading the content failed for another reason. */
  | "read_failed";

/**
 * A Changeset whose diff content cannot be delivered as verified bytes. An
 * infrastructure failure, never an integration outcome: the message carries
 * ids, the failure kind, and the digest — never content.
 */
export class ChangesetContentError extends Error {
  constructor(
    readonly changesetId: ChangesetId,
    readonly artifactId: ArtifactId,
    readonly failure: ChangesetContentFailure,
    detail: string,
  ) {
    super(`Changeset ${changesetId} content is unavailable (${failure}): Artifact ${artifactId} ${detail}`);
    this.name = "ChangesetContentError";
  }
}

/**
 * The content source handed to the port: bound to one Artifact's identity,
 * digest, and size at construction; every read re-resolves the Artifact
 * through the store outside any transaction, checks the metadata still
 * agrees, and returns bytes the store verified against the digest and size.
 */
class VerifiedArtifactContent implements ArtifactContentSource {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
  readonly digest: string;
  readonly byteSize: number;
  // Private fields: the holder sees the four metadata fields and `read` and nothing of persistence, not even by enumeration or serialization.
  readonly #ctx: PersistenceContext;
  readonly #stores: Stores;
  readonly #changesetId: ChangesetId;
  readonly #runId: RunId;

  constructor(ctx: PersistenceContext, stores: Stores, changesetId: ChangesetId, runId: RunId, artifact: Artifact) {
    this.#ctx = ctx;
    this.#stores = stores;
    this.#changesetId = changesetId;
    this.#runId = runId;
    this.artifactId = artifact.id;
    this.mediaType = artifact.mediaType;
    this.digest = artifact.digest;
    this.byteSize = artifact.byteSize;
  }

  async read(): Promise<Uint8Array> {
    if (this.#ctx.tx.inTransaction) throw new Error("Changeset content is read outside any transaction");
    const { artifact, bytes } = readVerified(this.#stores, this.#changesetId, this.artifactId);
    if (artifact.digest !== this.digest || artifact.byteSize !== this.byteSize || artifact.runId !== this.#runId || artifact.mediaType !== this.mediaType) {
      throw new ChangesetContentError(this.#changesetId, this.artifactId, "metadata_changed", `no longer matches the bound digest ${this.digest} and size ${this.byteSize}`);
    }
    return bytes;
  }
}

/** Metadata plus bytes verified by the Artifact Store; every failure becomes a `ChangesetContentError` without content. */
function readVerified(stores: Stores, changesetId: ChangesetId, artifactId: ArtifactId): { artifact: Artifact; bytes: Uint8Array } {
  try {
    return stores.artifacts.read(artifactId);
  } catch (error) {
    if (error instanceof ChangesetContentError) throw error;
    if (error instanceof NotFoundError) throw new ChangesetContentError(changesetId, artifactId, "artifact_missing", "has no metadata");
    if (error instanceof BlobMissingError) throw new ChangesetContentError(changesetId, artifactId, "content_missing", `has no stored content for digest ${error.digest}`);
    if (error instanceof BlobCorruptedError) throw new ChangesetContentError(changesetId, artifactId, "content_corrupted", `stored content does not verify against digest ${error.digest}`);
    throw new ChangesetContentError(changesetId, artifactId, "read_failed", `could not be read: ${error instanceof Error ? error.name : "unknown error"}`);
  }
}

export type IntegrationOutcome =
  /** Applied now and recorded: the Run's integration Snapshot advanced to `snapshot`. */
  | { kind: "integrated"; changeset: Changeset; snapshot: Snapshot }
  /** Nothing to do: the Changeset was already integrated. */
  | { kind: "already_integrated"; changeset: Changeset }
  /** Recorded now: the Changeset conflicts; the node waits on `task`. */
  | { kind: "conflict"; changeset: Changeset; task: Task; artifact: Artifact }
  /** Recorded earlier: the conflict Task is not yet completed; nothing was applied. */
  | { kind: "conflict_pending"; changeset: Changeset; task: Task }
  /** The conflict cannot be resolved by reconciliation: the Task ended without completing, or the Changeset conflicted again after it completed. */
  | { kind: "conflict_unresolved"; changeset: Changeset; task: Task; cause: "task_failed" | "task_cancelled" | "conflicted_again" };

export class ChangesetIntegrationService {
  readonly #locks = new Map<RunId, Promise<unknown>>();

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly port: IntegrationWorkspacePort,
  ) {}

  /**
   * Integrates one Changeset, or reports why it cannot be integrated now.
   * Safe to call repeatedly; two calls for one Run run one after the other.
   */
  integrate(changesetId: ChangesetId, options: WriteOptions = {}): Promise<IntegrationOutcome> {
    if (this.ctx.tx.inTransaction) throw new Error("Changeset integration applies an external change and never runs inside a transaction");
    const runId = this.stores.changesets.get(changesetId).runId;
    const previous = this.#locks.get(runId) ?? Promise.resolve();
    const next = previous.then(
      () => this.#integrate(changesetId, options),
      () => this.#integrate(changesetId, options),
    );
    this.#locks.set(runId, next);
    next.finally(() => {
      if (this.#locks.get(runId) === next) this.#locks.delete(runId);
    }).catch(() => {});
    return next;
  }

  /** The Changesets of a Run still to integrate, in creation order: pending ones and conflicts whose Task completed. */
  outstanding(runId: RunId): Changeset[] {
    return this.stores.changesets.listByRun(runId).filter((c) => c.integrationStatus === "pending" || (c.integrationStatus === "conflict" && c.conflictTaskId !== null && this.stores.tasks.get(c.conflictTaskId).status === "completed"));
  }

  async #integrate(changesetId: ChangesetId, options: WriteOptions): Promise<IntegrationOutcome> {
    const changeset = this.stores.changesets.get(changesetId);
    if (changeset.integrationStatus === "integrated") return { kind: "already_integrated", changeset };
    let resolvedTask: Task | null = null;
    if (changeset.integrationStatus === "conflict") {
      const task = this.stores.tasks.get(changeset.conflictTaskId!);
      if (!TASK_MACHINE.isTerminal(task.status)) return { kind: "conflict_pending", changeset, task };
      if (task.status !== "completed") return { kind: "conflict_unresolved", changeset, task, cause: task.status === "failed" ? "task_failed" : "task_cancelled" };
      resolvedTask = task;
    }
    const diff = this.content(changeset);
    const outcome = await this.port.apply(this.request(changeset, diff));
    if (outcome.kind === "integrated") {
      return this.ctx.tx.write((): IntegrationOutcome => {
        const current = this.stores.changesets.get(changesetId);
        if (current.integrationStatus === "integrated") return { kind: "already_integrated", changeset: current };
        const run = this.stores.runs.get(current.runId);
        const snapshot = this.stores.snapshots.record({ workspaceId: run.workspaceId, runId: run.id, identity: outcome.snapshot, reason: "integration" }, options);
        const integrated = this.stores.changesets.transition(changesetId, { to: "integrated", integratedSnapshotId: snapshot.id }, options);
        this.stores.runs.recordIntegration(run.id, { changesetId, integrationSnapshotId: snapshot.id }, options);
        return { kind: "integrated", changeset: integrated, snapshot };
      });
    }
    if (resolvedTask !== null) return { kind: "conflict_unresolved", changeset, task: resolvedTask, cause: "conflicted_again" };
    return this.ctx.tx.write((): IntegrationOutcome => {
      const current = this.stores.changesets.get(changesetId);
      if (current.integrationStatus !== "pending") throw new Error(`Changeset ${changesetId} is ${current.integrationStatus}; a conflict is recorded for a pending Changeset`);
      const artifact = this.stores.artifacts.create(
        { runId: current.runId, mediaType: "text/plain", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: `integration conflict of ${changesetId}` },
        new TextEncoder().encode(boundedReport(outcome.report)),
        options,
      );
      const task = this.stores.tasks.create(
        {
          runId: current.runId,
          planNodeId: this.affectedNode(current),
          origin: "runtime",
          subject: `Resolve the integration conflict of Changeset ${changesetId}`,
          requirementIds: [],
          requirementRevisionId: null,
          inputArtifactIds: [artifact.id, current.diffArtifactId],
          requiredOutputs: [],
          replacesTaskId: null,
        },
        options,
      );
      const conflicted = this.stores.changesets.transition(changesetId, { to: "conflict", conflictTaskId: task.id }, options);
      return { kind: "conflict", changeset: conflicted, task, artifact };
    });
  }

  /**
   * Resolves and verifies the Changeset's diff Artifact — metadata, Run
   * ownership, media type, then the stored bytes against digest and size —
   * outside any transaction, and binds a content source to it. Throws
   * `ChangesetContentError` before the port is involved when any check
   * fails; an empty diff is a valid zero-byte Artifact like any other.
   */
  private content(changeset: Changeset): ArtifactContentSource {
    if (this.ctx.tx.inTransaction) throw new Error("Changeset content is resolved outside any transaction");
    let artifact: Artifact;
    try {
      artifact = this.stores.artifacts.get(changeset.diffArtifactId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new ChangesetContentError(changeset.id, changeset.diffArtifactId, "artifact_missing", "has no metadata");
      throw error;
    }
    if (artifact.runId !== changeset.runId) throw new ChangesetContentError(changeset.id, artifact.id, "foreign_artifact", `belongs to Run ${artifact.runId}, not ${changeset.runId}`);
    if (artifact.mediaType !== CHANGESET_DIFF_MEDIA_TYPE) throw new ChangesetContentError(changeset.id, artifact.id, "media_type", `is ${artifact.mediaType}, not ${CHANGESET_DIFF_MEDIA_TYPE}`);
    const verified = readVerified(this.stores, changeset.id, artifact.id);
    if (verified.artifact.digest !== artifact.digest || verified.artifact.byteSize !== artifact.byteSize) {
      throw new ChangesetContentError(changeset.id, artifact.id, "metadata_changed", "metadata changed while it was being verified");
    }
    return new VerifiedArtifactContent(this.ctx, this.stores, changeset.id, changeset.runId, artifact);
  }

  private request(changeset: Changeset, diff: ArtifactContentSource): IntegrationApplyRequest {
    const run = this.stores.runs.get(changeset.runId);
    const currentId = run.integrationSnapshotId ?? run.baseSnapshotId;
    if (currentId === null) throw new Error(`Run ${run.id} has no base Snapshot to integrate onto`);
    return {
      runId: run.id,
      changesetId: changeset.id,
      integrationWorkspacePath: run.integrationWorkspacePath,
      currentSnapshot: this.stores.snapshots.get(currentId).identity,
      changeset: {
        beforeSnapshot: this.stores.snapshots.get(changeset.beforeSnapshotId).identity,
        afterSnapshot: this.stores.snapshots.get(changeset.afterSnapshotId).identity,
        diff,
      },
    };
  }

  /** The node whose work conflicted: the writing Invocation's node (the Run's final Changeset has none). */
  private affectedNode(changeset: Changeset): PlanNodeId | null {
    return changeset.invocationId === null ? null : this.stores.invocations.get(changeset.invocationId).planNodeId;
  }
}

function boundedReport(report: string): string {
  const bytes = new TextEncoder().encode(report);
  if (bytes.byteLength <= CONFLICT_REPORT_MAX_BYTES) return report;
  return `${new TextDecoder().decode(bytes.slice(0, CONFLICT_REPORT_MAX_BYTES - 1))}…`;
}
