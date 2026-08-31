import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  ARTIFACT_CONTENT_ENCODINGS,
  READ_ARTIFACT_BOUNDS,
  readAgentDefinitionsInputSchema,
  readArtifactInputSchema,
  readArtifactResultSchema,
  readDecisionsInputSchema,
  readExecutionPlanInputSchema,
  readRequirementsInputSchema,
  readTasksInputSchema,
  planNodeRecordSchema,
  RUNTIME_READ_BOUNDS,
} from "./runtime-reads.ts";
import { canonicalRuntimeToolCall, runtimeToolCallRequestSchema, runtimeToolResultBlocksInvocation, runtimeToolResultSchema, WRITE_ARTIFACT_BOUNDS, WRITE_ARTIFACT_CALL_MAX_BYTES, WRITE_ARTIFACT_MAX_ENCODED_LENGTH, writeArtifactInputSchema } from "./runtime-tools.ts";
import { utf8ByteLength } from "./validation.ts";

describe("read contracts", () => {
  it("binds the common paging and response bounds exactly", () => {
    expect(RUNTIME_READ_BOUNDS).toMatchObject({ defaultLimit: 25, maxLimit: 100, maxResponseBytes: 65_536 });
    expect(READ_ARTIFACT_BOUNDS).toEqual({ defaultMaxBytes: 16_384, maxMaxBytes: 65_536 });
    expect(ARTIFACT_CONTENT_ENCODINGS).toEqual(["utf8", "base64"]);
  });

  it("parses every read input strictly: closed keys, bounded limits, typed ids, and no Conversation or Run selector anywhere", () => {
    expect(readRequirementsInputSchema.safeParse({}).success).toBe(true);
    expect(readRequirementsInputSchema.safeParse({ requirementId: newId("requirement"), includeAcceptanceCriteria: true, after: newId("requirement"), limit: 100 }).success).toBe(true);
    expect(readRequirementsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(readRequirementsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(readRequirementsInputSchema.safeParse({ after: "not-an-id" }).success).toBe(false);
    expect(readRequirementsInputSchema.safeParse({ conversationId: newId("conversation") }).success).toBe(false);
    expect(readDecisionsInputSchema.safeParse({ status: "resolved" }).success).toBe(true);
    expect(readDecisionsInputSchema.safeParse({ status: "answered" }).success).toBe(false);
    expect(readDecisionsInputSchema.safeParse({ runId: newId("run") }).success).toBe(false);
    expect(readTasksInputSchema.safeParse({ taskId: newId("task") }).success).toBe(true);
    expect(readTasksInputSchema.safeParse({ planNodeId: newId("planNode") }).success).toBe(false);
    expect(readExecutionPlanInputSchema.safeParse({ view: "nodes" }).success).toBe(true);
    expect(readExecutionPlanInputSchema.safeParse({ view: "edges", after: newId("planEdge"), limit: 1 }).success).toBe(true);
    expect(readExecutionPlanInputSchema.safeParse({ view: "nodes", after: newId("planEdge") }).success).toBe(false);
    expect(readExecutionPlanInputSchema.safeParse({ view: "everything" }).success).toBe(false);
    expect(readExecutionPlanInputSchema.safeParse({ view: "nodes", runId: newId("run") }).success).toBe(false);
    expect(readExecutionPlanInputSchema.safeParse({ view: "nodes", revisionNumber: 1 }).success).toBe(false);
    expect(readAgentDefinitionsInputSchema.safeParse({ agentDefinitionId: newId("agentDefinition") }).success).toBe(true);
    expect(readAgentDefinitionsInputSchema.safeParse({ workspaceId: newId("workspace") }).success).toBe(false);
  });

  it("bounds a read_artifact request: a typed Artifact id, a non-negative offset, 1..65536 maxBytes, and a closed encoding", () => {
    const artifactId = newId("artifact");
    expect(readArtifactInputSchema.safeParse({ artifactId }).success).toBe(true);
    expect(readArtifactInputSchema.safeParse({ artifactId, offset: 0, maxBytes: READ_ARTIFACT_BOUNDS.maxMaxBytes, encoding: "base64" }).success).toBe(true);
    expect(readArtifactInputSchema.safeParse({}).success).toBe(false);
    expect(readArtifactInputSchema.safeParse({ artifactId, offset: -1 }).success).toBe(false);
    expect(readArtifactInputSchema.safeParse({ artifactId, offset: 1.5 }).success).toBe(false);
    expect(readArtifactInputSchema.safeParse({ artifactId, maxBytes: 0 }).success).toBe(false);
    expect(readArtifactInputSchema.safeParse({ artifactId, maxBytes: READ_ARTIFACT_BOUNDS.maxMaxBytes + 1 }).success).toBe(false);
    expect(readArtifactInputSchema.safeParse({ artifactId, encoding: "hex" }).success).toBe(false);
    // The result ties eof to nextOffset and the page to the Artifact.
    const result = { tool: "read_artifact", artifactId, mediaType: "text/plain", digest: "a".repeat(64), byteSize: 10, offset: 0, byteCount: 10, encoding: "utf8", content: "0123456789", nextOffset: null, eof: true };
    expect(readArtifactResultSchema.safeParse(result).success).toBe(true);
    expect(readArtifactResultSchema.safeParse({ ...result, eof: false }).success).toBe(false);
    expect(readArtifactResultSchema.safeParse({ ...result, byteCount: 11 }).success).toBe(false);
    expect(readArtifactResultSchema.safeParse({ ...result, eof: false, nextOffset: 10, byteCount: 8 }).success).toBe(true);
  });

  it("ties a plan-node record's shape summary, allocation policy, and join policy to its kind", () => {
    const base = { planNodeId: newId("planNode"), status: "pending", waitReason: null, sourcePath: "e0", title: "work", requirementRevisionId: null, requirementIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 }, maxConcurrency: null, maxWallClockMs: null };
    const pattern = { ...base, kind: "pattern", pattern: "single", shape: { pattern: "single", operationTitle: "work" }, fanInPolicy: null, onAllocationExhausted: "fail" };
    const join = { ...base, kind: "join", pattern: null, shape: null, fanInPolicy: "require_all", onAllocationExhausted: null, allocation: { costUsd: 0, tokens: 0, attempts: 0 } };
    expect(planNodeRecordSchema.safeParse(pattern).success).toBe(true);
    expect(planNodeRecordSchema.safeParse(join).success).toBe(true);
    expect(planNodeRecordSchema.safeParse({ ...pattern, shape: null }).success).toBe(false);
    expect(planNodeRecordSchema.safeParse({ ...pattern, fanInPolicy: "require_all" }).success).toBe(false);
    expect(planNodeRecordSchema.safeParse({ ...join, fanInPolicy: null }).success).toBe(false);
    expect(planNodeRecordSchema.safeParse({ ...join, onAllocationExhausted: "fail" }).success).toBe(false);
  });
});

describe("write_artifact contract", () => {
  it("binds the exact bounds: 200-byte title and media type, 48 KiB decoded per call, 32 calls and 1 MiB per logical turn", () => {
    expect(WRITE_ARTIFACT_BOUNDS).toEqual({ titleMaxBytes: 200, mediaTypeMaxBytes: 200, maxContentBytes: 49_152, maxCallsPerTurn: 32, maxTotalContentBytes: 1_048_576 });
    expect(WRITE_ARTIFACT_MAX_ENCODED_LENGTH).toBe(65_536);
  });

  it("parses the input strictly: bounded title, normalized media type, closed encoding, bounded content, no runtime-owned field", () => {
    const ok = (input: unknown) => writeArtifactInputSchema.safeParse(input).success;
    const base = { title: "notes", mediaType: "text/markdown", encoding: "utf8", content: "# hi" };
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, title: "é".repeat(100) })).toBe(true);
    expect(ok({ ...base, title: "é".repeat(101) })).toBe(false);
    expect(ok({ ...base, title: " " })).toBe(false);
    expect(ok({ ...base, mediaType: "Text/Markdown" })).toBe(false);
    expect(ok({ ...base, mediaType: "markdown" })).toBe(false);
    expect(ok({ ...base, mediaType: `text/${"y".repeat(200)}` })).toBe(false);
    expect(ok({ ...base, encoding: "hex" })).toBe(false);
    expect(ok({ ...base, content: "x".repeat(WRITE_ARTIFACT_MAX_ENCODED_LENGTH) })).toBe(true);
    expect(ok({ ...base, content: "x".repeat(WRITE_ARTIFACT_MAX_ENCODED_LENGTH + 1) })).toBe(false);
    for (const field of ["artifactId", "digest", "byteSize", "runId", "planNodeId", "invocationId", "attemptId", "producer", "storageKey", "taskId"]) {
      expect(ok({ ...base, [field]: "anything" }), field).toBe(false);
    }
  });

  it("admits a maximal base64 payload within its own canonical call bound, and its safe result carries metadata only and never blocks the Invocation", () => {
    const maximal = { tool: "write_artifact" as const, input: { title: "t".repeat(50), mediaType: "application/octet-stream", encoding: "base64" as const, content: "A".repeat(WRITE_ARTIFACT_MAX_ENCODED_LENGTH) } };
    expect(runtimeToolCallRequestSchema.safeParse(maximal).success).toBe(true);
    expect(utf8ByteLength(canonicalRuntimeToolCall(maximal))).toBeLessThanOrEqual(WRITE_ARTIFACT_CALL_MAX_BYTES);
    const result = { tool: "write_artifact" as const, artifactId: newId("artifact"), mediaType: "text/plain", digest: "b".repeat(64), byteSize: 12, title: "notes" };
    expect(runtimeToolResultSchema.safeParse(result).success).toBe(true);
    expect(runtimeToolResultBlocksInvocation(result)).toBe(false);
    // The safe result never carries content, a storage key, or a path.
    expect(runtimeToolResultSchema.safeParse({ ...result, content: "hello" }).success).toBe(false);
    expect(runtimeToolResultSchema.safeParse({ ...result, storageKey: "ab/cd" }).success).toBe(false);
    expect(runtimeToolResultSchema.safeParse({ ...result, byteSize: WRITE_ARTIFACT_BOUNDS.maxContentBytes + 1 }).success).toBe(false);
  });
});
