import { InvariantViolationError, NotFoundError, ValidationError, type ArtifactInput } from "@agentique-console/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobCorruptedError, BlobMissingError, sha256Hex } from "../blob-store.ts";
import { openHarness, seedArtifact, seedInvocation, seedManifest, seedRun, seedWorkerNode, type Harness, type Seeded } from "../test-support.ts";

afterEach(() => vi.restoreAllMocks());

const encode = (text: string) => new TextEncoder().encode(text);

function runtimeInput(s: Seeded, overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return { runId: s.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null, ...overrides };
}

/** Deterministic metadata-insert failure: the next Artifact id collides with an existing row. */
function collideNextArtifactId(h: Harness, existingId: string): void {
  const original = h.ctx.ids;
  h.ctx.ids = ((kind) => (kind === "artifact" ? existingId : original(kind))) as typeof h.ctx.ids;
}

describe("artifacts", () => {
  it("writes content-addressed metadata and deduplicates identical bytes into one blob", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("same content");
      const first = seedArtifact(h, s, "same content");
      const second = seedArtifact(h, s, "same content");
      expect(first.id).not.toBe(second.id);
      expect(first.digest).toBe(sha256Hex(bytes));
      expect(second.digest).toBe(first.digest);
      expect(first.byteSize).toBe(bytes.byteLength);
      expect(h.blobs.size).toBe(1);
      expect(h.stores.artifacts.findByDigest(s.run.id, first.digest).map((a) => a.id)).toEqual([first.id, second.id]);
      expect(h.stores.artifacts.read(second.id).bytes).toEqual(bytes);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "artifact.created" })).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("writes no blob for invalid input", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("never stored");
      expect(() => h.stores.artifacts.create(runtimeInput(s, { mediaType: "not a media type" }), bytes)).toThrow(ValidationError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { producer: { kind: "runtime", component: "mailbox" as never } }), bytes)).toThrow(ValidationError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { title: "" }), bytes)).toThrow(ValidationError);
      expect(h.blobs.size).toBe(0);
      expect(h.blobs.has(sha256Hex(bytes))).toBe(false);
    } finally {
      h.close();
    }
  });

  it("writes no blob when the Run, Invocation, Attempt, or Task is foreign or missing", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const other = seedRun(h);
      const bytes = encode("never stored either");
      const foreignInvocation = seedInvocation(h, other);
      seedManifest(h, other, foreignInvocation);
      const foreignAttempt = h.stores.invocations.createAttempt({ invocationId: foreignInvocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const ownInvocation = seedInvocation(h, s);
      const foreignTask = h.stores.tasks.create({ runId: other.run.id, planNodeId: null, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });

      expect(() => h.stores.artifacts.create(runtimeInput(s, { runId: "run_000000000000000000000000" }), bytes)).toThrow(NotFoundError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { producer: { kind: "invocation", invocationId: foreignInvocation.id, attemptId: null } }), bytes)).toThrow(InvariantViolationError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { producer: { kind: "invocation", invocationId: ownInvocation.id, attemptId: foreignAttempt.id } }), bytes)).toThrow(InvariantViolationError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { producer: { kind: "invocation", invocationId: ownInvocation.id, attemptId: "att_000000000000000000000000" } }), bytes)).toThrow(NotFoundError);
      expect(() => h.stores.artifacts.create(runtimeInput(s, { taskId: foreignTask.id }), bytes)).toThrow(InvariantViolationError);
      expect(h.blobs.size).toBe(0);
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a failed Event append after a new blob write leaves no row, no Event, and no blob", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("injected journal failure");
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), encode("orphan candidate"))).toThrow("injected journal failure");
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.blobs.size).toBe(0);
      expect(h.diagnostics).toEqual([]);
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("a failed metadata insert after a new blob write performs the same cleanup", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const existing = seedArtifact(h, s, "existing");
      const before = h.ctx.journal.lastSeq();
      collideNextArtifactId(h, existing.id);
      const bytes = encode("new content");
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.artifacts.listByRun(s.run.id).map((a) => a.id)).toEqual([existing.id]);
      expect(h.blobs.has(sha256Hex(bytes))).toBe(false);
      expect(h.blobs.has(existing.digest)).toBe(true);
      expect(h.stores.artifacts.read(existing.id).bytes).toEqual(encode("existing"));
    } finally {
      h.close();
    }
  });

  it("never deletes a shared, pre-existing blob when a later metadata creation for the same content fails", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const first = seedArtifact(h, s, "shared bytes");
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("injected");
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), encode("shared bytes"))).toThrow("injected");
      expect(h.blobs.has(first.digest)).toBe(true);
      expect(h.stores.artifacts.read(first.id).bytes).toEqual(encode("shared bytes"));
      expect(h.stores.artifacts.listByRun(s.run.id).map((a) => a.id)).toEqual([first.id]);
    } finally {
      h.close();
    }
  });

  it("does not remove a blob that another committed Artifact references, even if cleanup would otherwise run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("referenced elsewhere");
      // The first create fails after writing the blob; its cleanup removes the blob (unreferenced).
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("injected");
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow("injected");
      expect(h.blobs.has(sha256Hex(bytes))).toBe(false);
      // A committed Artifact now references the digest; a second failure must keep the blob.
      const committed = h.stores.artifacts.create(runtimeInput(s), bytes);
      h.blobs.remove(committed.digest);
      expect(h.blobs.size).toBe(0);
      collideNextArtifactId(h, committed.id);
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow(/UNIQUE|PRIMARY KEY/);
      // The put re-wrote the blob (written: true) but the committed row references it, so it stays.
      expect(h.blobs.has(committed.digest)).toBe(true);
      expect(h.stores.artifacts.read(committed.id).bytes).toEqual(bytes);
    } finally {
      h.close();
    }
  });

  it("rejects corrupted existing content during put and creates no metadata for it", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const first = seedArtifact(h, s, "payload");
      h.blobs.corrupt(first.digest, encode("payloadX"));
      const before = h.ctx.journal.lastSeq();
      expect(() => h.stores.artifacts.create(runtimeInput(s), encode("payload"))).toThrow(BlobCorruptedError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.artifacts.listByRun(s.run.id).map((a) => a.id)).toEqual([first.id]);
      expect(() => h.stores.artifacts.read(first.id)).toThrow(BlobCorruptedError);
      h.blobs.remove(first.digest);
      expect(() => h.stores.artifacts.read(first.id)).toThrow(BlobMissingError);
      expect(h.stores.artifacts.get(first.id)).toEqual(first);
    } finally {
      h.close();
    }
  });

  it("a cleanup failure is reported as a diagnostic and attached, and the database error is rethrown", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("original database failure");
      });
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => {
        throw Object.assign(new Error("EROFS: read-only file system, unlink '/var/lib/console/blobs/ab/abcdef'"), { code: "EROFS", errno: -30, syscall: "unlink" });
      });
      const bytes = encode("stuck orphan");
      let caught: unknown;
      try {
        h.stores.artifacts.create(runtimeInput(s), bytes);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("original database failure");
      // The cleanup failure is the closed kind and the digest: never the filesystem path the exception named.
      expect((caught as { blobCleanupFailure?: { digest: string; message: string } }).blobCleanupFailure).toEqual({ digest: sha256Hex(bytes), message: "blob removal failed: filesystem:EROFS" });
      expect(h.diagnostics).toEqual([{ kind: "blob_cleanup_failed", digest: sha256Hex(bytes), message: "blob removal failed: filesystem:EROFS" }]);
      expect(JSON.stringify(h.diagnostics)).not.toContain("/var/lib");
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
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

  it("records producer provenance for an Invocation and its Attempt", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const artifact = h.stores.artifacts.create(runtimeInput(s, { producer: { kind: "invocation", invocationId: invocation.id, attemptId: attempt.id }, title: "report" }), encode("x"));
      expect(artifact.producer).toEqual({ kind: "invocation", invocationId: invocation.id, attemptId: attempt.id });
      const event = h.ctx.journal.read({ runId: s.run.id, type: "artifact.created" })[0]!;
      expect(event.scope.attemptId).toBe(attempt.id);
      expect(event.actor).toEqual({ kind: "invocation", invocationId: invocation.id });
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
      const node = seedWorkerNode(h, s);
      const input = { runId: s.run.id, route: { kind: "sequence" as const, sourceNodeId: node.id, targetNodeId: s.root.id }, source: { kind: "plan_node" as const, planNodeId: node.id }, target: { kind: "plan_node" as const, planNodeId: s.root.id }, taskIds: [], artifactIds: [artifact.id], summary: "results ready" };
      const handoff = h.stores.handoffs.create(input);
      expect(handoff.status).toBe("pending");
      expect(handoff.handoffKey).toBe(`sequence:${node.id}:${s.root.id}`);
      expect(Object.keys(handoff).sort()).toEqual(["artifactIds", "createdAt", "deliveredAt", "handoffKey", "id", "runId", "source", "status", "summary", "target", "taskIds"]);
      expect(() => h.stores.handoffs.create({ ...input, summary: "x".repeat(501) })).toThrow(ValidationError);
      const other = seedRun(h);
      expect(() => h.stores.handoffs.create({ runId: s.run.id, route: { kind: "sequence", sourceNodeId: other.root.id, targetNodeId: s.root.id }, source: { kind: "plan_node", planNodeId: other.root.id }, target: { kind: "plan_node", planNodeId: s.root.id }, taskIds: [], artifactIds: [], summary: "" })).toThrow(InvariantViolationError);
      const delivered = h.stores.handoffs.transition(handoff.id, "delivered");
      expect(delivered.deliveredAt).not.toBeNull();
      expect(() => h.stores.handoffs.transition(handoff.id, "cancelled")).toThrow(/cannot transition/);
      expect(() => h.database.sqlite.prepare("UPDATE handoffs SET summary = 'edited' WHERE id = ?").run(handoff.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });
});

describe("artifact composition inside an outer transaction", () => {
  it("a later failure in the composing transaction leaves no Artifact row, Event, or blob", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      const bytes = encode("composed content");
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.artifacts.create(runtimeInput(s), bytes);
          throw new Error("later composed operation failed");
        }),
      ).toThrow("later composed operation failed");
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.blobs.has(sha256Hex(bytes))).toBe(false);
      expect(h.blobs.size).toBe(0);
      expect(h.diagnostics).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("an Artifact created two levels down is cleaned up when the top-level operation fails", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const nested = seedWorkerNode(h, s);
      const bytes = encode("deeply nested");
      const composedService = () =>
        h.ctx.tx.write(() => {
          const artifact = h.stores.artifacts.create(runtimeInput(s), bytes);
          return h.stores.handoffs.create({ runId: s.run.id, route: { kind: "sequence", sourceNodeId: nested.id, targetNodeId: s.root.id }, source: { kind: "plan_node", planNodeId: nested.id }, target: { kind: "plan_node", planNodeId: s.root.id }, taskIds: [], artifactIds: [artifact.id], summary: "nested" });
        });
      expect(() =>
        h.ctx.tx.write(() => {
          composedService();
          h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: "snap_000000000000000000000000", finalChangesetId: "cs_000000000000000000000000" });
        }),
      ).toThrow(/cannot transition/);
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.stores.handoffs.listByRun(s.run.id)).toEqual([]);
      expect(h.blobs.size).toBe(0);
    } finally {
      h.close();
    }
  });

  it("two rows for identical newly written bytes in one outer transaction are both rolled back and the blob removed", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("twice in one transaction");
      expect(() =>
        h.ctx.tx.write(() => {
          const first = h.stores.artifacts.create(runtimeInput(s), bytes);
          const second = h.stores.artifacts.create(runtimeInput(s), bytes);
          expect(first.digest).toBe(second.digest);
          expect(h.blobs.size).toBe(1);
          throw new Error("abort both");
        }),
      ).toThrow("abort both");
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.blobs.size).toBe(0);
      expect(h.diagnostics).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a reused pre-existing blob survives outer rollback", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const committed = seedArtifact(h, s, "already here");
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.artifacts.create(runtimeInput(s), encode("already here"));
          throw new Error("outer failure");
        }),
      ).toThrow("outer failure");
      expect(h.stores.artifacts.listByRun(s.run.id).map((a) => a.id)).toEqual([committed.id]);
      expect(h.stores.artifacts.read(committed.id).bytes).toEqual(encode("already here"));
      expect(h.blobs.size).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a blob restored for an already committed Artifact survives outer rollback", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const committed = seedArtifact(h, s, "lost and found");
      h.blobs.remove(committed.digest);
      expect(() => h.stores.artifacts.read(committed.id)).toThrow(BlobMissingError);
      expect(() =>
        h.ctx.tx.write(() => {
          const restored = h.stores.artifacts.create(runtimeInput(s), encode("lost and found"));
          expect(restored.digest).toBe(committed.digest);
          throw new Error("outer failure");
        }),
      ).toThrow("outer failure");
      expect(h.stores.artifacts.listByRun(s.run.id).map((a) => a.id)).toEqual([committed.id]);
      expect(h.stores.artifacts.read(committed.id).bytes).toEqual(encode("lost and found"));
    } finally {
      h.close();
    }
  });

  it("a cleanup failure during outer rollback reports a diagnostic while the outer error remains thrown", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("stuck in composition");
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => {
        throw new Error("filesystem is read-only");
      });
      let caught: unknown;
      try {
        h.ctx.tx.write(() => {
          h.stores.artifacts.create(runtimeInput(s), bytes);
          throw new Error("outer failure");
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("outer failure");
      expect((caught as { blobCleanupFailure?: unknown }).blobCleanupFailure).toEqual({ digest: sha256Hex(bytes), message: "blob removal failed: unknown" });
      expect(h.diagnostics).toEqual([{ kind: "blob_cleanup_failed", digest: sha256Hex(bytes), message: "blob removal failed: unknown" }]);
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });
});
