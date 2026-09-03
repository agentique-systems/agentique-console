/**
 * Canonical Artifact creation through the mutating runtime-tool path
 * (execution-model §6.4 `write_artifact`): the model supplies a bounded
 * title, media type, encoding, and content, and the runtime derives
 * everything else — the Artifact id, digest, byte size, producer (this
 * Invocation and the committing Attempt), Run, and storage — through the
 * canonical Artifact Store inside the call's one root transaction. The
 * blob is written only after every validation passed; a callback, Event,
 * insert, or COMMIT failure rolls the metadata back and the store's
 * rollback hook removes the newly written, unreferenced blob;
 * content-addressed blobs still deduplicate safely. Raw content reaches
 * no Event, no diagnostic, and no `runtime_tool_calls` row: the safe
 * result and the record carry metadata only, and an identical call of the
 * same logical turn replays the same Artifact id by digest.
 *
 * Artifact creation mutates no Task, no orchestration state, and no
 * Workspace, which is why an Evaluator may call it for a bounded Evidence
 * report while remaining read-only with respect to the Workspace.
 */
import { WRITE_ARTIFACT_BOUNDS, type AttemptId, type InvocationId, type WriteArtifactInput } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";

/** Strict base64: complete groups, canonical padding; verified by re-encoding after decode. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A lone UTF-16 surrogate, which no UTF-8 encoding represents. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class ArtifactWriteService {
  constructor(private readonly stores: Stores) {}

  /**
   * Validates, decodes, and bounds the content, enforces the logical
   * turn's call-count and cumulative-byte bounds from the accepted
   * `runtime_tool_calls` rows, and creates the Artifact through
   * `ArtifactStore.create` inside the caller's transaction. Runs inside
   * the runtime-tool executor's root transaction only.
   */
  write(caller: RuntimeToolCaller, attemptId: AttemptId, turnInvocationIds: readonly InvocationId[], input: WriteArtifactInput, options: WriteOptions): HandlerOutcome {
    const decoded = decodeContent(input);
    if (decoded.kind === "rejected") return decoded;
    const bytes = decoded.bytes;
    if (bytes.byteLength > WRITE_ARTIFACT_BOUNDS.maxContentBytes) {
      return { kind: "rejected", reasons: [{ code: "invalid_bounds", message: `decoded content is ${bytes.byteLength} bytes; at most ${WRITE_ARTIFACT_BOUNDS.maxContentBytes} per call`, path: "content" }] };
    }
    // The logical turn's accepted writes bound further creation; a replayed identical call never reaches this handler.
    const accepted = turnInvocationIds.flatMap((id) => this.stores.runtimeToolCalls.listByInvocation(id)).filter((c) => c.tool === "write_artifact");
    if (accepted.length >= WRITE_ARTIFACT_BOUNDS.maxCallsPerTurn) {
      return { kind: "rejected", reasons: [{ code: "artifact_count_exceeded", message: `this logical turn already accepted ${accepted.length} write_artifact calls; at most ${WRITE_ARTIFACT_BOUNDS.maxCallsPerTurn}`, path: null }] };
    }
    const written = accepted.reduce((sum, call) => sum + (call.result.tool === "write_artifact" ? call.result.byteSize : 0), 0);
    if (written + bytes.byteLength > WRITE_ARTIFACT_BOUNDS.maxTotalContentBytes) {
      return {
        kind: "rejected",
        reasons: [{ code: "artifact_bytes_exceeded", message: `this logical turn already created ${written} Artifact bytes; ${bytes.byteLength} more would exceed the ${WRITE_ARTIFACT_BOUNDS.maxTotalContentBytes}-byte bound`, path: "content" }],
      };
    }
    const artifact = this.stores.artifacts.create(
      {
        runId: caller.invocation.runId,
        mediaType: input.mediaType,
        producer: { kind: "invocation", invocationId: caller.invocation.id, attemptId },
        taskId: null,
        title: input.title,
      },
      bytes,
      options,
    );
    return { kind: "applied", result: { tool: "write_artifact", artifactId: artifact.id, mediaType: artifact.mediaType, digest: artifact.digest, byteSize: artifact.byteSize, title: input.title } };
  }
}

function decodeContent(input: WriteArtifactInput): { kind: "decoded"; bytes: Uint8Array } | Extract<HandlerOutcome, { kind: "rejected" }> {
  if (input.encoding === "utf8") {
    if (LONE_SURROGATE.test(input.content)) {
      return { kind: "rejected", reasons: [{ code: "invalid_input", message: "content is not well-formed text; encode binary content as base64", path: "content" }] };
    }
    return { kind: "decoded", bytes: new TextEncoder().encode(input.content) };
  }
  if (!BASE64_PATTERN.test(input.content)) {
    return { kind: "rejected", reasons: [{ code: "invalid_input", message: "content is not canonical base64", path: "content" }] };
  }
  const bytes = Uint8Array.from(Buffer.from(input.content, "base64"));
  if (Buffer.from(bytes).toString("base64") !== input.content) {
    return { kind: "rejected", reasons: [{ code: "invalid_input", message: "content is not canonical base64 (non-zero padding bits)", path: "content" }] };
  }
  return { kind: "decoded", bytes };
}
