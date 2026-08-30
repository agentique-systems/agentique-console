import { z } from "zod";
import type { ArtifactId, AttemptId, InvocationId, RunId, TaskId } from "./ids.ts";
import { idSchema, nonEmptyString, sha256Hex, timestampSchema, type Timestamp } from "./validation.ts";

/** Media type of an Attempt transcript Artifact (a diagnostic record, never canonical state). */
export const TRANSCRIPT_MEDIA_TYPE = "application/x-agent-transcript";

/** The deterministic runtime components that produce Artifacts. */
export const RUNTIME_ARTIFACT_PRODUCERS = [
  "join",
  "parallel_index",
  "gate",
  "changeset",
  "publication",
  "transcript",
  "command",
  "tool_call",
] as const;
export type RuntimeArtifactProducer = (typeof RUNTIME_ARTIFACT_PRODUCERS)[number];

/** Who produced an Artifact: an Invocation (optionally a specific Attempt) or the runtime. */
export type ArtifactProducer =
  | { kind: "invocation"; invocationId: InvocationId; attemptId: AttemptId | null }
  | { kind: "runtime"; component: RuntimeArtifactProducer };

export const artifactProducerSchema: z.ZodType<ArtifactProducer> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("invocation"),
    invocationId: idSchema("invocation"),
    attemptId: idSchema("attempt").nullable(),
  }),
  z.strictObject({ kind: z.literal("runtime"), component: z.enum(RUNTIME_ARTIFACT_PRODUCERS) }),
]);

const mediaType = z
  .string()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, "expected a media type such as text/plain");

/**
 * Immutable, content-addressed metadata. The bytes live in the blob store
 * under `digest`; identical bytes share one blob.
 */
export interface Artifact {
  id: ArtifactId;
  runId: RunId;
  mediaType: string;
  byteSize: number;
  digest: string;
  producer: ArtifactProducer;
  taskId: TaskId | null;
  title: string | null;
  createdAt: Timestamp;
}

export const artifactSchema: z.ZodType<Artifact> = z.strictObject({
  id: idSchema("artifact"),
  runId: idSchema("run"),
  mediaType,
  byteSize: z.number().int().min(0),
  digest: sha256Hex,
  producer: artifactProducerSchema,
  taskId: idSchema("task").nullable(),
  title: nonEmptyString.nullable(),
  createdAt: timestampSchema,
});

export interface ArtifactInput {
  runId: RunId;
  mediaType: string;
  producer: ArtifactProducer;
  taskId: TaskId | null;
  title: string | null;
}

export const artifactInputSchema: z.ZodType<ArtifactInput> = z.strictObject({
  runId: idSchema("run"),
  mediaType,
  producer: artifactProducerSchema,
  taskId: idSchema("task").nullable(),
  title: nonEmptyString.nullable(),
});
