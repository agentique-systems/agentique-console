import { and, asc, eq } from "drizzle-orm";
import {
  artifactInputSchema,
  artifactSchema,
  failureKindOf,
  InvariantViolationError,
  parseOrThrow,
  type Artifact,
  type ArtifactId,
  type ArtifactInput,
  type FailureKind,
  type RunId,
} from "@agentique-console/core";
import { BlobCorruptedError, sha256Hex, type PendingEntry } from "../blob-store.ts";
import type { PersistenceContext } from "../context.ts";
import { artifacts, attempts, invocations, tasks } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof artifacts.$inferSelect;

function toDomain(row: Row): Artifact {
  return parseOrThrow(
    artifactSchema,
    {
      id: row.id,
      runId: row.runId,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      digest: row.digest,
      producer: row.producer,
      taskId: row.taskId,
      title: row.title,
      createdAt: row.createdAt,
    },
    "Artifact row",
  );
}

/**
 * Attached (non-enumerably) to a database error whose compensating blob
 * cleanup also failed: the digest whose blob may remain unreferenced and
 * the closed kind of the cleanup failure (`failureKindOf`) — never the
 * cleanup exception's text, which may name a filesystem path.
 */
export interface BlobCleanupFailure {
  digest: string;
  message: string;
}

/** What one `create` left in the blob store, settled by the root transaction's hooks. */
interface PendingWrite {
  /** A pending marker for the digest was published by this create's `put`. */
  marked: boolean;
  /** This create's `put` newly wrote the blob (rather than reusing one). */
  written: boolean;
}

/** The closed kinds of an obligation the pending-blob reconciliation could not resolve. */
export const PENDING_BLOB_FAILURE_KINDS = ["enumeration_failed", "reference_query_failed", "blob_removal_failed", "temporary_removal_failed", "marker_removal_failed", "unsafe_entry", "unrecognized_entry"] as const;
export type PendingBlobFailureKind = (typeof PENDING_BLOB_FAILURE_KINDS)[number];

/** One unresolved obligation: its closed kind, the digest where the entry names one, the safe entry identifier otherwise, and the closed failure kind of the error where one was thrown. */
export interface PendingBlobFailure {
  kind: PendingBlobFailureKind;
  digest: string | null;
  entry: string | null;
  failureKind: FailureKind | null;
}

/** At most this many failures are listed and reported as diagnostics; `failureCount` carries the total. */
export const PENDING_BLOB_REPORT_LIMIT = 64;

/**
 * The outcome of one pending-blob reconciliation. `complete` is the
 * guarantee statement: true if and only if every in-scope obligation was
 * resolved — every marker resolved and removed, every recognized temporary
 * removed, no unsafe or unrecognized entry left in the pending area, and
 * no enumeration, reference query, or removal failed. A reconciliation
 * that found nothing pending is complete; one that could not remove an
 * orphan is not, whatever else it did.
 */
export interface PendingBlobReconciliation {
  /** Markers whose obligation was resolved (blob kept because referenced, or removed) and which were then removed. */
  resolvedMarkers: number;
  /** Unreferenced protocol-published blobs removed. */
  removedBlobs: number;
  /** Recognized protocol temporary files removed. */
  removedTemporaries: number;
  /** The unresolved obligations, at most `PENDING_BLOB_REPORT_LIMIT` of them, in resolution order. */
  failures: PendingBlobFailure[];
  /** Every unresolved obligation, counted. */
  failureCount: number;
  complete: boolean;
}

export function emptyPendingBlobReconciliation(): PendingBlobReconciliation {
  return { resolvedMarkers: 0, removedBlobs: 0, removedTemporaries: 0, failures: [], failureCount: 0, complete: true };
}

/**
 * Immutable, content-addressed Artifacts.
 *
 * `create` validates everything it can — input shape, Run, producer
 * Invocation and Attempt ownership, Task ownership, the final metadata —
 * inside the write transaction before a single byte is stored. Only then
 * are the bytes put in the blob store (which verifies any existing blob of
 * the same digest and, for a digest not yet stored, publishes a pending
 * marker before writing), and the Event and metadata row are written in
 * the same transaction. Compensation and completion are registered on the
 * root transaction before the marker or the blob exists, so no
 * failure-prone step runs uncovered: if the root later rolls back for any
 * reason — including a failure in a composing operation after `create`
 * returned — a blob this create newly wrote is removed unless a committed
 * Artifact anywhere references its digest, and the marker is removed
 * after that; once the root has committed, the marker is removed. A
 * reused, pre-existing blob is never removed by this create and carries
 * no marker unless the store published one while preparing to write.
 * Reads verify the digest and the byte size before returning content.
 *
 * Guarantee, stated exactly: SQLite and the blob store do not form a
 * crash-atomic distributed transaction. Validation failures and ordinary
 * synchronous transaction failures are compensated; metadata never commits
 * before the blob exists; an abrupt process termination between the
 * marker and the marker's removal can leave a marker, a temporary file,
 * or an unreferenced blob behind — never committed metadata pointing at
 * content this operation did not write — and the next exclusive recovery
 * (`reconcilePendingBlobs`) removes every unreferenced blob and temporary
 * the protocol published, keeps every blob a committed Artifact
 * references, and removes the resolved markers. Nothing is fsynced: the
 * guarantee covers process death (SIGKILL included), not power loss or
 * filesystem corruption. The database file and its blob store are owned
 * by one runtime process at a time; compensation and reconciliation are
 * not multi-process safe.
 */
export class ArtifactStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: ArtifactInput, bytes: Uint8Array, options?: WriteOptions): Artifact {
    const valid = parseOrThrow(artifactInputSchema, input, "Artifact input");
    const digest = sha256Hex(bytes);
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      let invocationId: string | null = null;
      let attemptId: string | null = null;
      if (valid.producer.kind === "invocation") {
        const invocation = requireRow(
          this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, valid.producer.invocationId)).get(),
          "Invocation",
          valid.producer.invocationId,
        );
        assertSameRun("Invocation", valid.producer.invocationId, invocation.runId, run.id);
        invocationId = valid.producer.invocationId;
        if (valid.producer.attemptId !== null) {
          const attempt = requireRow(
            this.ctx.db.select({ invocationId: attempts.invocationId }).from(attempts).where(eq(attempts.id, valid.producer.attemptId)).get(),
            "Attempt",
            valid.producer.attemptId,
          );
          if (attempt.invocationId !== valid.producer.invocationId) {
            throw new InvariantViolationError(`Attempt ${valid.producer.attemptId} does not belong to Invocation ${valid.producer.invocationId}`);
          }
          attemptId = valid.producer.attemptId;
        }
      }
      if (valid.taskId !== null) {
        const task = requireRow(this.ctx.db.select({ runId: tasks.runId }).from(tasks).where(eq(tasks.id, valid.taskId)).get(), "Task", valid.taskId);
        assertSameRun("Task", valid.taskId, task.runId, run.id);
      }
      const artifact: Artifact = {
        id: this.ctx.ids("artifact"),
        runId: run.id,
        mediaType: valid.mediaType,
        byteSize: bytes.byteLength,
        digest,
        producer: valid.producer,
        taskId: valid.taskId,
        title: valid.title,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(artifactSchema, artifact, "Artifact");

      // Every validation has passed; only now are bytes stored. Compensation
      // and completion are registered first, so the marker and the blob the
      // store is about to publish are covered whatever fails after this line.
      const pending: PendingWrite = { marked: false, written: false };
      this.ctx.tx.afterRollback((cause) => this.compensate(digest, pending, cause));
      this.ctx.tx.afterCommit(() => this.settleMarker(digest, pending));
      const blob = this.ctx.blobs.put(bytes);
      pending.marked = blob.pending;
      pending.written = blob.written;

      this.ctx.journal.append({
        type: "artifact.created",
        scope: runScope(run, { invocationId: invocationId as never, attemptId: attemptId as never }),
        subjectType: "artifact",
        subjectId: artifact.id,
        payload: artifact,
        ...writeMeta(options, invocationId ? { kind: "invocation", invocationId: invocationId as never } : undefined),
      });
      this.ctx.db
        .insert(artifacts)
        .values({ ...artifact, invocationId, attemptId })
        .run();
      return artifact;
    });
  }

  /** Whether any committed Artifact of any Run references the digest; runs outside every transaction so it sees committed rows only. */
  private referenced(digest: string): boolean {
    return this.ctx.db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.digest, digest)).get() !== undefined;
  }

  /**
   * Rollback compensation: runs after the root transaction has rolled back,
   * outside any transaction, so the reference check sees committed rows
   * only. Removes the blob this `create` newly wrote unless a committed
   * Artifact anywhere references its digest (for example one whose missing
   * blob this transaction restored, or one of another Run), then removes
   * the marker this create's `put` published; a reused blob is never
   * removed, marker or not. Removal is idempotent, so identical content
   * written once and referenced by several rolled-back rows is handled by
   * the hooks of the one create that wrote it. A cleanup failure never
   * replaces the transaction error: it is reported to the diagnostics sink
   * (`blob_cleanup_failed` for the blob, `blob_marker_cleanup_failed` for
   * the marker — the digest and the closed failure kind only, never bytes,
   * never a path) and attached to the error as the non-enumerable
   * `blobCleanupFailure`. After a blob failure the marker is left in place
   * so the next recovery retries the obligation; neither report claims
   * the blob was removed.
   */
  private compensate(digest: string, pending: PendingWrite, cause: unknown): void {
    const attach = (failure: BlobCleanupFailure): void => {
      if (cause !== null && typeof cause === "object") {
        Object.defineProperty(cause, "blobCleanupFailure", { value: failure, enumerable: false, configurable: true });
      }
    };
    try {
      if (pending.written && !this.referenced(digest)) this.ctx.blobs.remove(digest);
    } catch (cleanupError) {
      const failure: BlobCleanupFailure = { digest, message: `blob removal failed: ${failureKindOf(cleanupError)}` };
      this.ctx.diagnostics({ kind: "blob_cleanup_failed", ...failure });
      attach(failure);
      return;
    }
    try {
      if (pending.marked) this.ctx.blobs.clearPending(digest);
    } catch (cleanupError) {
      const failure: BlobCleanupFailure = { digest, message: `marker removal failed: ${failureKindOf(cleanupError)}` };
      this.ctx.diagnostics({ kind: "blob_marker_cleanup_failed", ...failure });
      attach(failure);
    }
  }

  /**
   * Commit completion: the metadata is durable and references the digest,
   * so the marker this create's `put` published has no further purpose.
   * Runs after the transactor has left the transaction. A removal failure
   * never affects the committed result: it is reported as
   * `blob_marker_cleanup_failed` (digest and closed kind) and the marker
   * stays for the next recovery, which finds the digest referenced and
   * removes the marker alone.
   */
  private settleMarker(digest: string, pending: PendingWrite): void {
    if (!pending.marked) return;
    try {
      this.ctx.blobs.clearPending(digest);
    } catch (cleanupError) {
      this.ctx.diagnostics({ kind: "blob_marker_cleanup_failed", digest, message: `marker removal failed: ${failureKindOf(cleanupError)}` });
    }
  }

  /**
   * Startup reconciliation of the pending-write protocol, under the
   * exclusive ownership of the database and blob store by this process and
   * before any new write is admitted. Enumerates only the store's pending
   * area, one entry at a time through the store's bounded iteration (work
   * and memory proportional to the entries left there, never to the store,
   * and never a materialized listing); for every marker, queries the
   * committed references of its digest across every Run, keeps the blob
   * when one exists, removes it when none does, and removes the marker
   * last; removes every recognized protocol temporary file; and leaves every
   * unsafe or unrecognized entry in place, reported. Never runs inside a
   * transaction. Blobs that carry no marker — an orphan left before the
   * protocol existed — are outside its scope and are never enumerated or
   * touched.
   *
   * Ordering contract: entries are resolved in the order the pending area
   * enumerates them — the pending directory's own order, which is not
   * sorted — and `failures` lists the first `PENDING_BLOB_REPORT_LIMIT`
   * unresolved obligations in that order. The canonical effect of a pass
   * does not depend on the order: every marker is resolved by its own
   * committed references and every temporary by its own name, so two passes
   * over the same area converge to the same store whatever order they read
   * it in. An enumeration failure part-way is reported as its own
   * obligation after the entries already processed, which keep their
   * effects; the directory handle is released on every path.
   *
   * Every failure is recorded by closed kind with the digest or the safe
   * entry identifier (never a path or file contents) up to
   * `PENDING_BLOB_REPORT_LIMIT` and counted in full; the report is
   * `complete` only when nothing failed. Every step is idempotent, so a
   * repeated reconciliation after a failure or a death resumes from the
   * remaining entries.
   */
  reconcilePendingBlobs(): PendingBlobReconciliation {
    if (this.ctx.tx.inTransaction) throw new Error("pending-blob reconciliation is an external side effect and never runs inside a transaction");
    const report = emptyPendingBlobReconciliation();
    const fail = (failure: PendingBlobFailure): void => {
      report.failureCount += 1;
      if (report.failures.length < PENDING_BLOB_REPORT_LIMIT) {
        report.failures.push(failure);
        this.ctx.diagnostics({ kind: "blob_reconciliation_failed", failure: failure.kind, digest: failure.digest, message: `${failure.kind}${failure.entry === null ? "" : ` (${failure.entry})`}${failure.failureKind === null ? "" : `: ${failure.failureKind}`}` });
      }
    };
    // The enumeration is consumed step by step: an entry is resolved before the next one is read, so nothing but the
    // report's bounded failure list grows with the area, and an enumeration failure is one obligation of its own
    // whatever was already processed.
    let entries: Iterator<PendingEntry>;
    try {
      entries = this.ctx.blobs.listPending()[Symbol.iterator]();
    } catch (error) {
      fail({ kind: "enumeration_failed", digest: null, entry: null, failureKind: failureKindOf(error) });
      report.complete = false;
      return report;
    }
    try {
      for (;;) {
        let step: IteratorResult<PendingEntry>;
        try {
          step = entries.next();
        } catch (error) {
          fail({ kind: "enumeration_failed", digest: null, entry: null, failureKind: failureKindOf(error) });
          break;
        }
        if (step.done === true) break;
        const entry = step.value;
        switch (entry.kind) {
          case "temporary":
            try {
              if (this.ctx.blobs.removeTemporary(entry.name)) report.removedTemporaries += 1;
            } catch (error) {
              fail({ kind: "temporary_removal_failed", digest: entry.digest, entry: null, failureKind: failureKindOf(error) });
            }
            break;
          case "marker": {
            let referenced: boolean;
            try {
              referenced = this.referenced(entry.digest);
            } catch (error) {
              fail({ kind: "reference_query_failed", digest: entry.digest, entry: null, failureKind: failureKindOf(error) });
              break;
            }
            if (!referenced) {
              try {
                if (this.ctx.blobs.remove(entry.digest)) report.removedBlobs += 1;
              } catch (error) {
                fail({ kind: "blob_removal_failed", digest: entry.digest, entry: null, failureKind: failureKindOf(error) });
                break;
              }
            }
            try {
              this.ctx.blobs.clearPending(entry.digest);
              report.resolvedMarkers += 1;
            } catch (error) {
              fail({ kind: "marker_removal_failed", digest: entry.digest, entry: null, failureKind: failureKindOf(error) });
            }
            break;
          }
          case "unsafe":
            fail({ kind: "unsafe_entry", digest: null, entry: entry.entry, failureKind: null });
            break;
          case "unrecognized":
            fail({ kind: "unrecognized_entry", digest: null, entry: entry.entry, failureKind: null });
            break;
        }
      }
    } finally {
      // The store's iteration releases its directory handle itself on completion and failure; an early exit returns it too.
      try {
        entries.return?.();
      } catch {
        // A handle that could not be released is not an obligation of the protocol; the next enumeration opens its own.
      }
    }
    report.complete = report.failureCount === 0;
    return report;
  }

  get(id: ArtifactId): Artifact {
    return toDomain(requireRow(this.ctx.db.select().from(artifacts).where(eq(artifacts.id, id)).get(), "Artifact", id));
  }

  listByRun(runId: RunId): Artifact[] {
    return this.ctx.db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt), asc(artifacts.id)).all().map(toDomain);
  }

  findByDigest(runId: RunId, digest: string): Artifact[] {
    return this.ctx.db.select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.digest, digest))).all().map(toDomain);
  }

  /** Metadata plus verified bytes; throws when the blob is missing or corrupted. */
  read(id: ArtifactId): { artifact: Artifact; bytes: Uint8Array } {
    const artifact = this.get(id);
    return { artifact, bytes: this.content(artifact) };
  }

  /**
   * The verified bytes of already-loaded metadata: the blob under the
   * Artifact's digest, verified against its digest by the blob store and
   * against its byte size here. A caller that must authorize before any
   * byte is loaded loads the metadata with `get`, decides, and only then
   * calls this. Throws `BlobMissingError` or `BlobCorruptedError`.
   */
  content(artifact: Artifact): Uint8Array {
    const bytes = this.ctx.blobs.get(artifact.digest);
    if (bytes.byteLength !== artifact.byteSize) {
      throw new BlobCorruptedError(artifact.digest, `${bytes.byteLength} bytes`);
    }
    return bytes;
  }
}
