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
import { BlobCorruptedError } from "../blob-store.ts";
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
 * Immutable, content-addressed Artifacts. Bytes go to the blob store first
 * (idempotent by digest); metadata is then written with its Event in one
 * transaction. If the metadata write fails the blob remains as an orphan
 * with no metadata pointing at it, which is harmless and reusable. Reads
 * verify the digest and the byte size before returning content.
 */
export class ArtifactStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: ArtifactInput, bytes: Uint8Array, options?: WriteOptions): Artifact {
    const valid = parseOrThrow(artifactInputSchema, input, "Artifact input");
    const blob = this.ctx.blobs.put(bytes);
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
        byteSize: blob.byteSize,
        digest: blob.digest,
        producer: valid.producer,
        taskId: valid.taskId,
        title: valid.title,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(artifactSchema, artifact, "Artifact");
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
