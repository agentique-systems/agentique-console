import { InvariantViolationError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { BlobCorruptedError, BlobMissingError, sha256Hex } from "../blob-store.ts";
import { openHarness, seedArtifact, seedInvocation, seedRun } from "../test-support.ts";

describe("artifacts", () => {
  it("writes content-addressed metadata and deduplicates identical bytes", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = new TextEncoder().encode("same content");
      const first = seedArtifact(h, s, "same content");
      const second = seedArtifact(h, s, "same content");
      expect(first.id).not.toBe(second.id);
      expect(first.digest).toBe(sha256Hex(bytes));
      expect(second.digest).toBe(first.digest);
      expect(first.byteSize).toBe(bytes.byteLength);
      expect(h.stores.artifacts.findByDigest(s.run.id, first.digest).map((a) => a.id)).toEqual([first.id, second.id]);
      expect(h.blobs.put(bytes).written).toBe(false);
      expect(h.stores.artifacts.read(second.id).bytes).toEqual(bytes);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "artifact.created" })).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("verifies digest and size on read and reports missing or corrupted blobs", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const artifact = seedArtifact(h, s, "payload");
      h.blobs.corrupt(artifact.digest, new TextEncoder().encode("payloadX"));
      expect(() => h.stores.artifacts.read(artifact.id)).toThrow(BlobCorruptedError);
      h.blobs.delete(artifact.digest);
      expect(() => h.stores.artifacts.read(artifact.id)).toThrow(BlobMissingError);
      expect(h.stores.artifacts.get(artifact.id)).toEqual(artifact);
    } finally {
      h.close();
    }
  });

  it("metadata is immutable and never duplicates content", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const artifact = seedArtifact(h, s, "immutable");
      expect(() => h.database.sqlite.prepare("UPDATE artifacts SET title = 'x' WHERE id = ?").run(artifact.id)).toThrow(/immutable/);
      expect(() => h.database.sqlite.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id)).toThrow(/immutable/);
      const columns = (h.database.sqlite.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain("content");
      expect(columns).not.toContain("bytes");
    } finally {
      h.close();
    }
  });

  it("validates provenance: producing Invocations, Attempts, and Tasks belong to the Run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const other = seedRun(h);
      const foreignInvocation = seedInvocation(h, other);
      const bytes = new TextEncoder().encode("x");
      expect(() => h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: foreignInvocation.id, attemptId: null }, taskId: null, title: null }, bytes)).toThrow(InvariantViolationError);
      expect(() => h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "mailbox" as never }, taskId: null, title: null }, bytes)).toThrow(ValidationError);
      expect(() => h.stores.artifacts.create({ runId: s.run.id, mediaType: "not a media type", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, bytes)).toThrow(ValidationError);
      const foreignTask = h.stores.tasks.create({ runId: other.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      expect(() => h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: foreignTask.id, title: null }, bytes)).toThrow(InvariantViolationError);
      const invocation = seedInvocation(h, s);
      const artifact = h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId: null, title: "report" }, bytes);
      expect(artifact.producer).toEqual({ kind: "invocation", invocationId: invocation.id, attemptId: null });
    } finally {
      h.close();
    }
  });
});

describe("handoffs", () => {
  it("carries routing metadata only, bounded summary, endpoints and ids of the Run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const artifact = seedArtifact(h, s);
      const invocation = seedInvocation(h, s);
      const handoff = h.stores.handoffs.create({ runId: s.run.id, source: { kind: "invocation", invocationId: invocation.id }, target: { kind: "plan_node", planNodeId: s.root.id }, taskIds: [], artifactIds: [artifact.id], summary: "results ready" });
      expect(handoff.status).toBe("pending");
      expect(Object.keys(handoff).sort()).toEqual(["artifactIds", "createdAt", "deliveredAt", "id", "runId", "source", "status", "summary", "target", "taskIds"]);
      expect(() => h.stores.handoffs.create({ ...handoff, summary: "x".repeat(501) })).toThrow(ValidationError);
      const other = seedRun(h);
      expect(() => h.stores.handoffs.create({ runId: s.run.id, source: { kind: "plan_node", planNodeId: other.root.id }, target: { kind: "plan_node", planNodeId: s.root.id }, taskIds: [], artifactIds: [], summary: "" })).toThrow(InvariantViolationError);
      const delivered = h.stores.handoffs.transition(handoff.id, "delivered");
      expect(delivered.deliveredAt).not.toBeNull();
      expect(() => h.stores.handoffs.transition(handoff.id, "cancelled")).toThrow(/cannot transition/);
      expect(() => h.database.sqlite.prepare("UPDATE handoffs SET summary = 'edited' WHERE id = ?").run(handoff.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });
});
