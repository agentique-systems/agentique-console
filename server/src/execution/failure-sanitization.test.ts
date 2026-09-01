/**
 * The data-access failure boundary (execution-model §6.4, §13, §14): an
 * infrastructure failure of a read or a `write_artifact` call reaches the
 * provider outcome and the execution diagnostic as the tool, the caller's
 * ids, the call digest, and the closed failure kind — never the thrown
 * text, which may embed Artifact content, a filesystem path, a storage
 * key, or raw call input; truncating such text would not make it safe.
 * Missing and corrupt content stay distinct typed refusals, and a failed
 * blob cleanup is reported beside the canonical failure without replacing
 * it and without claiming that no orphan remains.
 */
import { ConflictError, FAILURE_KINDS } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { BlobCorruptedError, BlobMissingError } from "../persistence/blob-store.ts";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { readArtifact, readDecisions, readTasks, rejectionCodes, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { rootPort } from "./decision-test-support.ts";
import { openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";
import type { ExecutionDiagnostic } from "./workspace-cleanup.ts";

const CONTENT = "MARKER-artifact-content-sentinel-9f3c";
const PATH = "C:/data/console/blobs/9f/9f3c1e-storage-key";
const KEY = "blobs/9f/9f3c1e0000000000000000000000000000000000000000000000000000000000";
const RAW_INPUT = '{"input":{"content":"MARKER-raw-call-input","title":"x"},"tool":"write_artifact"}';
const TOKEN_SECRET = "SecretArtifactBytes";
const SECRETS = [CONTENT, PATH, KEY, RAW_INPUT, "MARKER", TOKEN_SECRET];

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  return SECRETS.filter((secret) => text.includes(secret));
}

/** The closed kind a `failed` outcome or diagnostic message names, asserting it is one of `FAILURE_KINDS`. */
function kindOf(message: string): string {
  const kind = message.slice(message.lastIndexOf(": ") + 2);
  expect(FAILURE_KINDS as readonly string[]).toContain(kind);
  return kind;
}

describe("data-access failure sanitization", () => {
  it("read failures: an underlying exception carrying content, a path, a storage key, or raw input reaches neither the outcome nor the diagnostic — only the tool, ids, digest, and failure kind do", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { invocation, attempt } = await rootPort(h, s);
      const diagnostics: ExecutionDiagnostic[] = [];
      const port = portFor(h, invocation, attempt, (d) => diagnostics.push(d));
      const written = writtenArtifact(await port.call(writeArtifact({ title: "x", content: "bytes" })));
      const cases: [string, () => void, string][] = [
        ["a storage read naming a path and content", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw Object.assign(new Error(`EACCES: permission denied, open '${PATH}' while reading ${CONTENT}`), { code: "EACCES", errno: -13, syscall: "open" }); }), "read_artifact failed: filesystem:EACCES"],
        ["a metadata read naming a storage key", () => vi.spyOn(h.stores.artifacts, "get").mockImplementationOnce(() => { throw Object.assign(new Error(`database disk image is malformed at ${KEY}`), { name: "SqliteError", code: "SQLITE_CORRUPT" }); }), "read_artifact failed: sqlite:corrupt"],
        // Token-shaped secrets in `name` and `code`, a forged known-looking prefix, an unknown subclass, and a throwing accessor: the fixed fallback.
        ["a sentinel class name", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw Object.assign(new Error("x"), { name: TOKEN_SECRET }); }), "read_artifact failed: unknown"],
        ["a sentinel code", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw Object.assign(new Error("x"), { code: TOKEN_SECRET, syscall: "read" }); }), "read_artifact failed: filesystem:other"],
        ["a forged SQLite code", () => vi.spyOn(h.stores.artifacts, "get").mockImplementationOnce(() => { throw Object.assign(new Error("x"), { name: "SqliteError", code: `SQLITE_${TOKEN_SECRET}` }); }), "read_artifact failed: sqlite:other"],
        ["an unknown Error subclass", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw new (class SecretArtifactBytes extends Error {})(CONTENT); }), "read_artifact failed: unknown"],
        ["a throwing accessor", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { const e = new Error("x"); Object.defineProperty(e, "code", { get: () => { throw new Error(TOKEN_SECRET); } }); throw e; }), "read_artifact failed: unknown"],
        ["a non-Error value", () => vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw `${CONTENT} ${PATH}`; }), "read_artifact failed: unknown"],
      ];
      for (const [label, inject, message] of cases) {
        diagnostics.length = 0;
        inject();
        const outcome = await port.call(readArtifact({ artifactId: written.artifactId }));
        expect(outcome, label).toEqual({ kind: "failed", tool: "read_artifact", message });
        expect(diagnostics, label).toEqual([{ kind: "runtime_tool_call_failed", invocationId: invocation.id, attemptId: attempt.id, tool: "read_artifact", callDigest: expect.stringMatching(/^[0-9a-f]{64}$/), message }]);
        kindOf(message);
        expect(leaks([outcome, diagnostics]), label).toEqual([]);
        vi.restoreAllMocks();
      }
      // A structured read whose store query throws with raw call input in the text: the same closed shape.
      diagnostics.length = 0;
      vi.spyOn(h.stores.decisions, "page").mockImplementationOnce(() => { throw new Error(`query failed for ${RAW_INPUT}`); });
      const decisions = await port.call(readDecisions());
      expect(decisions).toEqual({ kind: "failed", tool: "read_decisions", message: "read_decisions failed: unknown" });
      expect(leaks([decisions, diagnostics])).toEqual([]);
      vi.restoreAllMocks();
      // A domain error carries its class and closed code, nothing of its message.
      vi.spyOn(h.stores.tasks, "page").mockImplementationOnce(() => { throw new ConflictError(`Task ledger of ${PATH} is busy: ${CONTENT}`); });
      const tasks = await port.call(readTasks());
      expect(tasks).toEqual({ kind: "failed", tool: "read_tasks", message: "read_tasks failed: domain:conflict" });
      expect(leaks([tasks, diagnostics])).toEqual([]);
      vi.restoreAllMocks();
      // Missing and corrupt content remain distinct typed refusals (not failures), naming ids and digests only.
      vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw new BlobMissingError(written.digest); });
      const missing = await port.call(readArtifact({ artifactId: written.artifactId }));
      expect(rejectionCodes(missing)).toEqual(["artifact_content_missing"]);
      vi.spyOn(h.blobs, "get").mockImplementationOnce(() => { throw new BlobCorruptedError(written.digest, "f".repeat(64)); });
      const corrupt = await port.call(readArtifact({ artifactId: written.artifactId }));
      expect(rejectionCodes(corrupt)).toEqual(["artifact_content_corrupt"]);
      expect(leaks([missing, corrupt])).toEqual([]);
      // The Artifact still reads once the store recovers: no failure was recorded as state.
      vi.restoreAllMocks();
      expect((await port.call(readArtifact({ artifactId: written.artifactId }))).kind).toBe("read");
      expect(h.ctx.journal.read({ runId: s.created.run.id }).map((e) => e.type)).not.toContain("runtime_tool_call.failed");
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("write failures: the canonical failure's kind is reported, a cleanup failure is reported beside it without replacing it or claiming the blob was removed, and no path, key, content, or input travels", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { invocation, attempt } = await rootPort(h, s);
      const diagnostics: ExecutionDiagnostic[] = [];
      const port = portFor(h, invocation, attempt, (d) => diagnostics.push(d));
      // The blob store fails with a path in its message: nothing persisted, the failure kind is the errno code.
      vi.spyOn(h.blobs, "put").mockImplementationOnce(() => { throw Object.assign(new Error(`ENOSPC: no space left on device, write '${PATH}.tmp'`), { code: "ENOSPC", errno: -28, syscall: "write" }); });
      const noSpace = await port.call(writeArtifact({ title: "t", content: CONTENT }));
      expect(noSpace).toEqual({ kind: "failed", tool: "write_artifact", message: "write_artifact failed: filesystem:ENOSPC" });
      expect(diagnostics.at(-1)).toEqual({ kind: "runtime_tool_call_failed", invocationId: invocation.id, attemptId: attempt.id, tool: "write_artifact", callDigest: expect.stringMatching(/^[0-9a-f]{64}$/), message: "write_artifact failed: filesystem:ENOSPC" });
      // A write failing with a sentinel-named error class and a sentinel code: the fallback, nothing echoed.
      vi.restoreAllMocks();
      vi.spyOn(h.blobs, "put").mockImplementationOnce(() => { throw Object.assign(new (class SecretArtifactBytes extends Error {})(CONTENT), { code: TOKEN_SECRET }); });
      const sentinel = await port.call(writeArtifact({ title: "t", content: CONTENT }));
      expect(sentinel).toEqual({ kind: "failed", tool: "write_artifact", message: "write_artifact failed: unknown" });
      expect(leaks([sentinel, diagnostics])).toEqual([]);
      expect(leaks([noSpace, diagnostics, h.diagnostics])).toEqual([]);
      expect(h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "invocation")).toEqual([]);
      vi.restoreAllMocks();
      // The call row fails after the blob was written and its cleanup fails too: the outcome names the row failure; the persistence
      // diagnostic names the digest and the cleanup's kind; neither says the blob is gone — and it is not.
      vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw Object.assign(new Error(`UNIQUE constraint failed while recording ${RAW_INPUT}`), { name: "SqliteError", code: "SQLITE_CONSTRAINT" }); });
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => { throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${PATH}'`), { code: "EPERM", errno: -1, syscall: "unlink" }); });
      diagnostics.length = 0;
      h.diagnostics.length = 0;
      const failed = await port.call(writeArtifact({ title: "t", content: CONTENT }));
      expect(failed).toEqual({ kind: "failed", tool: "write_artifact", message: "write_artifact failed: sqlite:constraint" });
      const digest = h.stores.artifacts.listByRun(runId).find(() => false)?.digest;
      expect(digest).toBeUndefined();
      expect(h.diagnostics).toEqual([{ kind: "blob_cleanup_failed", digest: expect.stringMatching(/^[0-9a-f]{64}$/), message: "blob removal failed: filesystem:EPERM" }]);
      const orphan = (h.diagnostics[0] as { digest: string }).digest;
      expect(h.blobs.has(orphan)).toBe(true);
      expect(diagnostics).toEqual([{ kind: "runtime_tool_call_failed", invocationId: invocation.id, attemptId: attempt.id, tool: "write_artifact", callDigest: expect.stringMatching(/^[0-9a-f]{64}$/), message: "write_artifact failed: sqlite:constraint" }]);
      expect(leaks([failed, diagnostics, h.diagnostics])).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByInvocation(invocation.id).filter((c) => c.tool === "write_artifact")).toEqual([]);
      vi.restoreAllMocks();
      // The same window with sentinel-named failures on both the canonical operation and the cleanup: the outcome names the canonical
      // failure's fallback (never the cleanup's), the cleanup diagnostic names the digest and its own fallback, and the orphan is reported
      // as still present — nothing claims the blob was removed.
      vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw Object.assign(new (class SecretArtifactBytes extends Error {})(RAW_INPUT), { code: TOKEN_SECRET }); });
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => { throw Object.assign(new Error(PATH), { name: TOKEN_SECRET, code: TOKEN_SECRET, syscall: "unlink" }); });
      diagnostics.length = 0;
      h.diagnostics.length = 0;
      const doomed = await port.call(writeArtifact({ title: "t2", content: `${CONTENT} again` }));
      expect(doomed).toEqual({ kind: "failed", tool: "write_artifact", message: "write_artifact failed: unknown" });
      expect(h.diagnostics).toEqual([{ kind: "blob_cleanup_failed", digest: expect.stringMatching(/^[0-9a-f]{64}$/), message: "blob removal failed: filesystem:other" }]);
      expect(h.blobs.has((h.diagnostics[0] as { digest: string }).digest)).toBe(true);
      expect(h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "invocation")).toEqual([]);
      expect(leaks([doomed, diagnostics, h.diagnostics])).toEqual([]);
      for (const d of [...diagnostics, ...h.diagnostics]) kindOf((d as { message: string }).message);
      vi.restoreAllMocks();
      // The retried call reuses the orphaned blob (content-addressed) and succeeds from scratch; the outcome carries metadata only.
      const retried = writtenArtifact(await port.call(writeArtifact({ title: "t", content: CONTENT })));
      expect(retried).toMatchObject({ digest: orphan, replayed: false });
      expect(leaks([retried])).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });
});
