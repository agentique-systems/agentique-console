import { and, asc, eq } from "drizzle-orm";
import {
  artifactInputSchema,
  artifactSchema,
  InvariantViolationError,
  parseOrThrow,
  type Artifact,
  type ArtifactId,
  type ArtifactInput,
  type RunId,
} from "@agentique-console/core";
import { BlobCorruptedError, sha256Hex } from "../blob-store.ts";
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

/** Attached (non-enumerably) to a database error whose compensating blob cleanup also failed. */
export interface BlobCleanupFailure {
  digest: string;
  message: string;
}

/**
 * Immutable, content-addressed Artifacts.
 *
 * `create` validates everything it can — input shape, Run, producer
 * Invocation and Attempt ownership, Task ownership, the final metadata —
 * inside the write transaction before a single byte is stored. Only then
 * are the bytes put in the blob store (which verifies any existing blob of
 * the same digest), and the Event and metadata row are written in the same
 * transaction. When the blob was newly written, compensation is registered
 * on the root transaction: if the root later rolls back for any reason —
 * including a failure in a composing operation after `create` returned —
 * the blob is removed unless a committed Artifact references its digest.
 * A reused, pre-existing blob registers no compensation and is never
 * removed. Reads verify the digest and the byte size before returning
 * content.
 *
 * Guarantee, stated exactly: SQLite and the blob store do not form a
 * crash-atomic distributed transaction. Validation failures and ordinary
 * synchronous transaction failures are compensated; metadata never commits
 * before the blob exists; a process or machine crash between the blob
 * write and the database commit can leave a safe, unreferenced blob behind
 * but never committed metadata pointing at content this operation did not
 * write. The database file and its blob store are owned by one runtime
 * process at a time; compensation is not multi-process safe.
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

      // Every validation has passed; only now are bytes stored. A newly
      // written blob is compensated by the root transaction on rollback;
      // a reused blob registers nothing destructive.
      const blob = this.ctx.blobs.put(bytes);
      if (blob.written) {
        this.ctx.tx.afterRollback((cause) => this.discardUnreferencedBlob(digest, cause));
      }

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

  /**
   * Rollback compensation: runs after the root transaction has rolled back,
   * outside any transaction, so the reference check sees committed rows
   * only. Removes the blob this `create` newly wrote unless a committed
   * Artifact references its digest (for example one whose missing blob this
   * transaction restored). Removal is idempotent, so identical content
   * written once and referenced by several rolled-back rows is handled by
   * the single hook its one write registered. A cleanup failure never
   * replaces the transaction error: it is reported to the diagnostics sink
   * as `blob_cleanup_failed` (digest and message only, never bytes) and
   * attached to the error as the non-enumerable `blobCleanupFailure`.
   */
  private discardUnreferencedBlob(digest: string, cause: unknown): void {
    try {
      const referenced = this.ctx.db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.digest, digest)).get();
      if (!referenced) this.ctx.blobs.remove(digest);
    } catch (cleanupError) {
      const failure: BlobCleanupFailure = { digest, message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) };
      this.ctx.diagnostics({ kind: "blob_cleanup_failed", ...failure });
      if (cause !== null && typeof cause === "object") {
        Object.defineProperty(cause, "blobCleanupFailure", { value: failure, enumerable: false, configurable: true });
      }
    }
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
    const bytes = this.ctx.blobs.get(artifact.digest);
    if (bytes.byteLength !== artifact.byteSize) {
      throw new BlobCorruptedError(artifact.digest, `${bytes.byteLength} bytes`);
    }
    return { artifact, bytes };
  }
}
