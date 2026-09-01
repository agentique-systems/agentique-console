import { InvariantViolationError, NotFoundError, ValidationError, type ArtifactInput } from "@agentique-console/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobCorruptedError, BlobMissingError, MemoryBlobStore, sha256Hex } from "../blob-store.ts";
import { emptyPendingBlobReconciliation, PENDING_BLOB_REPORT_LIMIT } from "./artifacts.ts";
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

describe("pending-write markers", () => {
  it("a new blob's marker is published before the blob and cleared after COMMIT; a reused blob publishes none", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("marked content");
      const digest = sha256Hex(bytes);
      const seen: { pending: string[]; inTransaction: boolean }[] = [];
      const append = h.ctx.journal.append.bind(h.ctx.journal);
      vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
        // At the Event append the marker and the blob both exist and the transaction is open.
        seen.push({ pending: h.blobs.pendingDigests(), inTransaction: h.ctx.tx.inTransaction });
        return append(input);
      });
      const artifact = h.stores.artifacts.create(runtimeInput(s), bytes);
      expect(seen).toEqual([{ pending: [digest], inTransaction: true }]);
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.stores.artifacts.read(artifact.id).bytes).toEqual(bytes);
      expect(h.diagnostics).toEqual([]);
      // The second write reuses the blob: no marker at any point.
      seen.length = 0;
      h.stores.artifacts.create(runtimeInput(s), bytes);
      expect(seen).toEqual([{ pending: [], inTransaction: true }]);
      expect(h.blobs.pendingDigests()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("rollback compensation removes the new blob and then the marker; a reused blob keeps both its bytes and, on the reuse path, no marker", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("rolled back");
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("injected");
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow("injected");
      expect(h.blobs.has(sha256Hex(bytes))).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([]);
      const committed = seedArtifact(h, s, "kept bytes");
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("injected again");
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), encode("kept bytes"))).toThrow("injected again");
      expect(h.stores.artifacts.read(committed.id).bytes).toEqual(encode("kept bytes"));
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.diagnostics).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a blob-removal failure during rollback leaves the marker for the next recovery; a marker-removal failure is reported beside the canonical error", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("stuck");
      const digest = sha256Hex(bytes);
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("database failure");
      });
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, unlink '/var/lib/console/blobs/ab/abcdef'"), { code: "EPERM", errno: -1, syscall: "unlink" });
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow("database failure");
      // The blob stayed and so did its marker: the obligation is durable for the next recovery.
      expect(h.blobs.has(digest)).toBe(true);
      expect(h.blobs.pendingDigests()).toEqual([digest]);
      expect(h.diagnostics).toEqual([{ kind: "blob_cleanup_failed", digest, message: "blob removal failed: filesystem:EPERM" }]);
      expect(JSON.stringify(h.diagnostics)).not.toContain("/var/lib");
      // That recovery resolves it: unreferenced, so the blob goes and the marker with it.
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 1, removedBlobs: 1 });
      expect(h.blobs.has(digest)).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([]);

      h.diagnostics.length = 0;
      vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => {
        throw new Error("database failure 2");
      });
      vi.spyOn(h.blobs, "clearPending").mockImplementationOnce(() => {
        throw Object.assign(new Error("EROFS"), { code: "EROFS", errno: -30, syscall: "unlink" });
      });
      let caught: unknown;
      try {
        h.stores.artifacts.create(runtimeInput(s), bytes);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("database failure 2");
      expect((caught as { blobCleanupFailure?: unknown }).blobCleanupFailure).toEqual({ digest, message: "marker removal failed: filesystem:EROFS" });
      expect(h.diagnostics).toEqual([{ kind: "blob_marker_cleanup_failed", digest, message: "marker removal failed: filesystem:EROFS" }]);
      expect(h.blobs.has(digest)).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([digest]);
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 1 });
    } finally {
      h.close();
    }
  });

  it("a marker-removal failure after COMMIT never affects the committed Artifact; the next reconciliation keeps the referenced blob and removes the marker alone", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("committed but marked");
      const digest = sha256Hex(bytes);
      vi.spyOn(h.blobs, "clearPending").mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES: permission denied, unlink '/srv/blobs/.pending/x'"), { code: "EACCES", errno: -13, syscall: "unlink" });
      });
      const artifact = h.stores.artifacts.create(runtimeInput(s), bytes);
      expect(h.stores.artifacts.read(artifact.id).bytes).toEqual(bytes);
      expect(h.blobs.pendingDigests()).toEqual([digest]);
      expect(h.diagnostics).toEqual([{ kind: "blob_marker_cleanup_failed", digest, message: "marker removal failed: filesystem:EACCES" }]);
      expect(JSON.stringify(h.diagnostics)).not.toContain("/srv");
      expect(h.ctx.tx.inTransaction).toBe(false);
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 1 });
      expect(h.blobs.has(digest)).toBe(true);
      expect(h.stores.artifacts.read(artifact.id).bytes).toEqual(bytes);
    } finally {
      h.close();
    }
  });

  it("the store's own put failure withdraws the marker, and a marker the store could not withdraw is resolved by reconciliation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("never written");
      const digest = sha256Hex(bytes);
      vi.spyOn(h.blobs, "put").mockImplementationOnce(() => {
        // A store whose write failed after marking and whose withdrawal failed too: the marker outlives the call.
        h.blobs.markPending(digest);
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC", errno: -28, syscall: "write" });
      });
      expect(() => h.stores.artifacts.create(runtimeInput(s), bytes)).toThrow("ENOSPC");
      expect(h.blobs.has(digest)).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([digest]);
      expect(h.diagnostics).toEqual([]);
      expect(h.stores.artifacts.listByRun(s.run.id)).toEqual([]);
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 1 });
      expect(h.blobs.pendingDigests()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("multiple same-digest writes in one transaction share one marker owned by the first create's hooks", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const bytes = encode("thrice");
      const digest = sha256Hex(bytes);
      const puts: { written: boolean; pending: boolean }[] = [];
      const put = h.blobs.put.bind(h.blobs);
      vi.spyOn(h.blobs, "put").mockImplementation((b) => {
        const outcome = put(b);
        puts.push({ written: outcome.written, pending: outcome.pending });
        return outcome;
      });
      const [a, b, c] = h.ctx.tx.write(() => [h.stores.artifacts.create(runtimeInput(s), bytes), h.stores.artifacts.create(runtimeInput(s), bytes), h.stores.artifacts.create(runtimeInput(s), bytes)]);
      expect(puts).toEqual([{ written: true, pending: true }, { written: false, pending: false }, { written: false, pending: false }]);
      expect(new Set([a!.id, b!.id, c!.id]).size).toBe(3);
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.blobs.size).toBe(1);
      // The same three in a rolled-back transaction: one blob removal, one marker removal, no diagnostic.
      puts.length = 0;
      const removals = vi.spyOn(h.blobs, "remove");
      const clears = vi.spyOn(h.blobs, "clearPending");
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.artifacts.create(runtimeInput(s), encode("again"));
          h.stores.artifacts.create(runtimeInput(s), encode("again"));
          h.stores.artifacts.create(runtimeInput(s), encode("again"));
          throw new Error("abort");
        }),
      ).toThrow("abort");
      expect(puts).toEqual([{ written: true, pending: true }, { written: false, pending: false }, { written: false, pending: false }]);
      expect(removals).toHaveBeenCalledTimes(1);
      expect(clears).toHaveBeenCalledTimes(1);
      expect(h.blobs.has(sha256Hex(encode("again")))).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.diagnostics).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("pending-blob reconciliation", () => {
  /** A committed Artifact of another Run referencing `text`, with its blob present. */
  function foreignReference(h: Harness, text: string) {
    const other = seedRun(h);
    return seedArtifact(h, other, text);
  }

  const cases: { name: string; arrange: (h: Harness, s: Seeded) => { digest: string; expectBlob: boolean; report: Partial<ReturnType<typeof emptyPendingBlobReconciliation>> } }[] = [
    {
      name: "a stale marker of an unreferenced blob (death before COMMIT): blob removed, marker removed",
      arrange: (h) => {
        const { digest } = h.blobs.put(encode("uncommitted"));
        return { digest, expectBlob: false, report: { resolvedMarkers: 1, removedBlobs: 1 } };
      },
    },
    {
      name: "a stale marker with no blob (death before the temporary file): marker removed",
      arrange: (h) => {
        const digest = sha256Hex(encode("never reached"));
        h.blobs.markPending(digest);
        return { digest, expectBlob: false, report: { resolvedMarkers: 1 } };
      },
    },
    {
      name: "a stale marker whose blob a committed Artifact of this Run references (death after COMMIT): blob kept, marker removed",
      arrange: (h, s) => {
        const artifact = seedArtifact(h, s, "committed");
        h.blobs.markPending(artifact.digest);
        return { digest: artifact.digest, expectBlob: true, report: { resolvedMarkers: 1 } };
      },
    },
    {
      name: "a stale marker whose blob a committed Artifact of another Run references: blob kept, marker removed",
      arrange: (h) => {
        const artifact = foreignReference(h, "shared across runs");
        h.blobs.markPending(artifact.digest);
        return { digest: artifact.digest, expectBlob: true, report: { resolvedMarkers: 1 } };
      },
    },
    {
      name: "a restored blob of a committed Artifact under a stale marker (death after the restoring write): blob kept, marker removed",
      arrange: (h, s) => {
        const artifact = seedArtifact(h, s, "lost and restored");
        h.blobs.remove(artifact.digest);
        expect(h.blobs.put(encode("lost and restored"))).toMatchObject({ written: true, pending: true });
        return { digest: artifact.digest, expectBlob: true, report: { resolvedMarkers: 1 } };
      },
    },
    {
      name: "a marker whose blob was already removed by an interrupted cleanup: marker removed, nothing else",
      arrange: (h) => {
        const { digest } = h.blobs.put(encode("half cleaned"));
        h.blobs.remove(digest);
        return { digest, expectBlob: false, report: { resolvedMarkers: 1 } };
      },
    },
    {
      name: "a pre-existing unmarked, unreferenced blob: outside the protocol, untouched",
      arrange: (h) => {
        const { digest } = h.blobs.put(encode("historical orphan"));
        h.blobs.clearPending(digest);
        return { digest, expectBlob: true, report: {} };
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const h = openHarness();
      try {
        const s = seedRun(h);
        const { digest, expectBlob, report } = c.arrange(h, s);
        const artifactsBefore = h.database.sqlite.prepare("SELECT count(*) AS n FROM artifacts").get();
        const first = h.stores.artifacts.reconcilePendingBlobs();
        expect(first).toEqual({ ...emptyPendingBlobReconciliation(), ...report });
        expect(first.complete).toBe(true);
        expect(h.blobs.has(digest)).toBe(expectBlob);
        expect(h.blobs.pendingDigests()).toEqual([]);
        // Idempotent: the second pass finds nothing and changes nothing.
        expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual(emptyPendingBlobReconciliation());
        expect(h.blobs.has(digest)).toBe(expectBlob);
        expect(h.database.sqlite.prepare("SELECT count(*) AS n FROM artifacts").get()).toEqual(artifactsBefore);
        expect(h.diagnostics).toEqual([]);
        expect(h.ctx.tx.inTransaction).toBe(false);
      } finally {
        h.close();
      }
    });
  }

  it("resolves several markers in one pass by their own references, removing only the unreferenced blobs", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const kept = seedArtifact(h, s, "kept");
      h.blobs.markPending(kept.digest);
      const gone = h.blobs.put(encode("gone")).digest;
      const foreign = foreignReference(h, "foreign kept");
      h.blobs.markPending(foreign.digest);
      const never = sha256Hex(encode("never"));
      h.blobs.markPending(never);
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 4, removedBlobs: 1 });
      expect([kept.digest, foreign.digest].map((d) => h.blobs.has(d))).toEqual([true, true]);
      expect(h.blobs.has(gone)).toBe(false);
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.stores.artifacts.read(kept.id).bytes).toEqual(encode("kept"));
      expect(h.stores.artifacts.read(foreign.id).bytes).toEqual(encode("foreign kept"));
    } finally {
      h.close();
    }
  });

  it("reports every unresolved obligation truthfully and resolves it on a later pass: reference-query, blob-removal, marker-removal, temporary-removal, and enumeration failures, unsafe and unrecognized entries", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const kept = seedArtifact(h, s, "kept");
      h.blobs.markPending(kept.digest);
      const orphan = h.blobs.put(encode("orphan")).digest;
      const stuck = h.blobs.put(encode("stuck")).digest;
      const unlisted = h.blobs.put(encode("unlisted")).digest;
      // The digests sort the markers; the failures below are injected per digest.
      const select = h.ctx.db.select.bind(h.ctx.db);
      let queries = 0;
      vi.spyOn(h.ctx.db, "select").mockImplementation(((...args: unknown[]) => {
        queries += 1;
        if (queries === 1) throw Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { name: "SqliteError", code: "SQLITE_IOERR" });
        return (select as (...a: unknown[]) => unknown)(...args);
      }) as typeof h.ctx.db.select);
      vi.spyOn(h.blobs, "remove").mockImplementation((digest) => {
        if (digest === stuck) throw Object.assign(new Error("EPERM: operation not permitted, unlink 'C:\\blobs\\st\\stuck'"), { code: "EPERM", errno: -1, syscall: "unlink" });
        return MemoryBlobStore.prototype.remove.call(h.blobs, digest);
      });
      vi.spyOn(h.blobs, "clearPending").mockImplementation((digest) => {
        if (digest === unlisted) throw Object.assign(new Error("EBUSY"), { code: "EBUSY", errno: -16, syscall: "unlink" });
        return MemoryBlobStore.prototype.clearPending.call(h.blobs, digest);
      });
      const listPending = h.blobs.listPending.bind(h.blobs);
      const temporary = `${orphan}.${process.pid}.1.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`;
      vi.spyOn(h.blobs, "listPending").mockImplementation(() => [
        ...listPending(),
        { kind: "temporary", digest: orphan, name: temporary },
        { kind: "temporary", digest: orphan, name: temporary.replace(".1.", ".2.") },
        { kind: "unsafe", entry: "0".repeat(64) },
        { kind: "unrecognized", entry: "notes.txt" },
      ]);
      vi.spyOn(h.blobs, "removeTemporary").mockImplementation((name) => {
        if (name === temporary) throw Object.assign(new Error("EACCES"), { code: "EACCES", errno: -13, syscall: "unlink" });
        return true;
      });
      const sorted = [kept.digest, orphan, stuck, unlisted].sort();
      // The digest whose reference query fails never reaches its removal, so an injected removal failure on it is not observed.
      const expectedFailures = 6 - (sorted[0] === stuck || sorted[0] === unlisted ? 1 : 0);
      const first = h.stores.artifacts.reconcilePendingBlobs();
      expect(first.complete).toBe(false);
      expect(first.failureCount).toBe(expectedFailures);
      expect(first.failures).toHaveLength(expectedFailures);
      expect(first.removedTemporaries).toBe(1);
      // The first reference query failed for whichever marker sorted first; every other obligation reports its own kind.
      const byKind = Object.fromEntries(first.failures.map((f) => [f.kind, f]));
      expect(byKind.reference_query_failed).toEqual({ kind: "reference_query_failed", digest: sorted[0], entry: null, failureKind: "sqlite:ioerr" });
      expect(byKind.temporary_removal_failed).toEqual({ kind: "temporary_removal_failed", digest: orphan, entry: null, failureKind: "filesystem:EACCES" });
      expect(byKind.unsafe_entry).toEqual({ kind: "unsafe_entry", digest: null, entry: "0".repeat(64), failureKind: null });
      expect(byKind.unrecognized_entry).toEqual({ kind: "unrecognized_entry", digest: null, entry: "notes.txt", failureKind: null });
      const kinds = first.failures.map((f) => f.kind).sort();
      // Exactly one of the two injected removal failures is reached besides the query failure (the query-failed digest skips its removal).
      expect(kinds.filter((k) => k === "blob_removal_failed" || k === "marker_removal_failed")).toHaveLength(sorted[0] === stuck || sorted[0] === unlisted ? 1 : 2);
      expect(JSON.stringify(first)).not.toMatch(/blobs\\|C:\\|\/var/);
      expect(h.diagnostics.map((d) => d.kind)).toEqual(Array(first.failures.length).fill("blob_reconciliation_failed"));
      expect(JSON.stringify(h.diagnostics)).not.toMatch(/blobs\\|C:\\|\/var/);
      // The referenced blob survived every failure; the marker of the query-failed digest is still there.
      expect(h.blobs.has(kept.digest)).toBe(true);
      expect(h.blobs.pendingDigests()).toContain(sorted[0]);

      // A later pass with the failures gone resolves everything that is resolvable.
      vi.restoreAllMocks();
      h.diagnostics.length = 0;
      const second = h.stores.artifacts.reconcilePendingBlobs();
      expect(second.complete).toBe(true);
      expect(second.failureCount).toBe(0);
      expect(h.blobs.pendingDigests()).toEqual([]);
      expect(h.blobs.has(kept.digest)).toBe(true);
      expect([orphan, stuck, unlisted].map((d) => h.blobs.has(d))).toEqual([false, false, false]);
      expect(h.stores.artifacts.read(kept.id).bytes).toEqual(encode("kept"));
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual(emptyPendingBlobReconciliation());

      // An enumeration failure is one unresolved obligation and nothing is touched.
      h.blobs.markPending(orphan);
      vi.spyOn(h.blobs, "listPending").mockImplementationOnce(() => {
        throw Object.assign(new Error("EIO"), { code: "EIO", errno: -5, syscall: "scandir" });
      });
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), failures: [{ kind: "enumeration_failed", digest: null, entry: null, failureKind: "filesystem:EIO" }], failureCount: 1, complete: false });
      expect(h.blobs.pendingDigests()).toEqual([orphan]);
      expect(h.stores.artifacts.reconcilePendingBlobs()).toEqual({ ...emptyPendingBlobReconciliation(), resolvedMarkers: 1 });
    } finally {
      h.close();
    }
  });

  it("bounds the listed failures and diagnostics while counting every one, and refuses to run inside a transaction", () => {
    const h = openHarness();
    try {
      const entries = Array.from({ length: PENDING_BLOB_REPORT_LIMIT + 5 }, (_, i) => ({ kind: "unrecognized" as const, entry: `foreign-${i}` }));
      vi.spyOn(h.blobs, "listPending").mockImplementationOnce(() => entries);
      const report = h.stores.artifacts.reconcilePendingBlobs();
      expect(report.failureCount).toBe(PENDING_BLOB_REPORT_LIMIT + 5);
      expect(report.failures).toHaveLength(PENDING_BLOB_REPORT_LIMIT);
      expect(report.complete).toBe(false);
      expect(h.diagnostics).toHaveLength(PENDING_BLOB_REPORT_LIMIT);
      expect(() => h.ctx.tx.write(() => h.stores.artifacts.reconcilePendingBlobs())).toThrow(/never runs inside a transaction/);
    } finally {
      h.close();
    }
  });
});
