/**
 * `write_artifact` (execution-model §6.4): canonical Artifact creation
 * through the mutating runtime-tool path. The runtime derives the id,
 * digest, byte size, producer, Run, and storage; the model supplies only a
 * bounded title, media type, encoding, and content. An identical call of
 * one logical turn replays the same Artifact id; distinct calls create
 * distinct metadata over safely deduplicated content-addressed blobs; a
 * callback, Event, insert, or COMMIT failure leaves no Artifact row, no
 * Event, no `runtime_tool_calls` row, and no unreferenced blob; and raw
 * content never reaches an Event, a diagnostic, or the call record.
 */
import { canonicalJson, canonicalRuntimeToolCall, ConflictError, RUNTIME_TOOL_CALL_MAX_BYTES, utf8ByteLength, WRITE_ARTIFACT_BOUNDS, WRITE_ARTIFACT_CALL_MAX_BYTES, type RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { decomposePort, portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { evaluatorPort, readArtifact, readResult, rejectionCodes, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { rootPort, workerPort } from "./decision-test-support.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";
import type { ExecutionDiagnostic } from "./workspace-cleanup.ts";

const artifactsOf = (h: RuntimeHarness, runId: RunId) => h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "invocation");

describe("write_artifact", () => {
  it("creates one canonical Artifact per accepted call for every permitted role, with runtime-derived ownership the model cannot supply", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const root = await rootPort(h, s);
      const seq = h.ctx.journal.lastSeq();
      const written = writtenArtifact(await root.port.call(writeArtifact({ title: "root notes", content: "from the root" })));
      const artifact = h.stores.artifacts.get(written.artifactId);
      // Ownership and provenance are the runtime's: Run, producer Invocation, committing Attempt, digest, and size derive from rows.
      expect(artifact).toMatchObject({
        runId: s.created.run.id,
        mediaType: "text/plain",
        byteSize: 13,
        digest: sha256Hex(new TextEncoder().encode("from the root")),
        producer: { kind: "invocation", invocationId: root.invocation.id, attemptId: root.attempt.id },
        taskId: null,
        title: "root notes",
      });
      expect(written).toMatchObject({ mediaType: artifact.mediaType, digest: artifact.digest, byteSize: artifact.byteSize, title: "root notes", replayed: false });
      // One transaction: the Artifact Event, then the committed call Event; the row names the call's digest and safe result only.
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["artifact.created", "runtime_tool_call.committed"]);
      const call = h.stores.runtimeToolCalls.listByInvocation(root.invocation.id)[0]!;
      expect(call).toMatchObject({ tool: "write_artifact", attemptId: root.attempt.id, result: { tool: "write_artifact", artifactId: written.artifactId } });
      expect(canonicalJson(call)).not.toContain("from the root");
      // The model cannot supply ownership: unknown fields are strict-schema rejections.
      for (const field of [{ artifactId: written.artifactId }, { digest: artifact.digest }, { byteSize: 13 }, { runId: s.created.run.id }, { producer: { kind: "runtime", component: "command" } }, { storageKey: "/tmp/blob" }]) {
        expect(rejectionCodes(await root.port.call({ tool: "write_artifact", input: { title: "x", mediaType: "text/plain", encoding: "utf8", content: "x", ...field } } as never))).toEqual(["invalid_input"]);
      }
      // A Coordinator, a Worker, and an Evaluator create Artifacts the same way (the Evaluator's Evidence path is covered with its scope).
      const d = await decomposePort(h, s);
      expect(writtenArtifact(await d.port.call(writeArtifact({ title: "coordination", content: "c" }))).artifactId).toMatch(/^art_/);
      const w = await workerPort(h, s);
      expect(writtenArtifact(await w.port.call(writeArtifact({ title: "work", content: "w" }))).artifactId).toMatch(/^art_/);
    } finally {
      h.close();
    }
  });

  it("rejects malformed content and metadata typed, writing nothing: bad or non-canonical base64, lone surrogates, an invalid or non-normalized media type, an oversized title or content", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { invocation, port } = await rootPort(h, s);
      const seq = h.ctx.journal.lastSeq();
      const cases: [Parameters<typeof writeArtifact>[0], string][] = [
        [{ encoding: "base64", content: "not base64!!" }, "malformed base64"],
        [{ encoding: "base64", content: "abc" }, "incomplete base64 group"],
        [{ encoding: "base64", content: "aa==" }, "non-canonical padding bits"],
        [{ content: "broken \ud800 surrogate" }, "lone surrogate"],
        [{ mediaType: "not-a-media-type" }, "malformed media type"],
        [{ mediaType: "Text/Plain" }, "non-normalized media type"],
        [{ mediaType: `text/${"x".repeat(200)}` }, "oversized media type"],
        [{ title: "t".repeat(WRITE_ARTIFACT_BOUNDS.titleMaxBytes + 1) }, "oversized title"],
        [{ title: "  " }, "blank title"],
        [{ content: "x".repeat(WRITE_ARTIFACT_MAX_ENCODED + 1) }, "content beyond the encoded bound"],
        [{ encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes + 3).toString("base64") }, "base64 beyond the encoded bound"],
      ];
      for (const [input, label] of cases) {
        expect(rejectionCodes(await port.call(writeArtifact(input))), label).toEqual(["invalid_input"]);
      }
      // Decoded size overflow: within the encoded character bound but beyond 48 KiB decoded (multi-byte UTF-8).
      expect(rejectionCodes(await port.call(writeArtifact({ content: "é".repeat(30_000) })))).toEqual(["invalid_bounds"]);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(artifactsOf(h, runId)).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByInvocation(invocation.id)).toEqual([]);
      // Exactly 48 KiB decoded is accepted.
      const exact = writtenArtifact(await port.call(writeArtifact({ encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, 7).toString("base64") })));
      expect(exact.byteSize).toBe(WRITE_ARTIFACT_BOUNDS.maxContentBytes);
    } finally {
      h.close();
    }
  });

  it("bounds one logical turn: at most 32 accepted calls and 1 MiB of decoded content, counted from rows so replays consume nothing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { port } = await rootPort(h, s);
      // 21 distinct 48 KiB writes: 1,032,192 bytes. A 16 KiB write then fills the pool to exactly 1 MiB.
      for (let i = 0; i < 21; i += 1) {
        const outcome = await port.call(writeArtifact({ title: `chunk ${i}`, encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, i + 1).toString("base64") }));
        expect(writtenArtifact(outcome).replayed).toBe(false);
      }
      // Another full chunk would exceed the cumulative bound; a replay of an accepted call still succeeds and consumes nothing.
      expect(rejectionCodes(await port.call(writeArtifact({ title: "over", encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, 99).toString("base64") })))).toEqual(["artifact_bytes_exceeded"]);
      expect(writtenArtifact(await port.call(writeArtifact({ title: "chunk 0", encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, 1).toString("base64") }))).replayed).toBe(true);
      const filler = writtenArtifact(await port.call(writeArtifact({ title: "filler", encoding: "base64", content: Buffer.alloc(16_384, 200).toString("base64") })));
      expect(filler.byteSize).toBe(16_384);
      expect(rejectionCodes(await port.call(writeArtifact({ title: "one more byte", content: "x" })))).toEqual(["artifact_bytes_exceeded"]);
      // The call-count bound is independent: 22 accepted so far, 10 zero-byte writes reach 32, the 33rd distinct call is refused.
      for (let i = 0; i < 10; i += 1) expect(writtenArtifact(await port.call(writeArtifact({ title: `tiny ${i}`, content: "" }))).byteSize).toBe(0);
      expect(rejectionCodes(await port.call(writeArtifact({ title: "beyond the turn bound", content: "" })))).toEqual(["artifact_count_exceeded"]);
      const h2 = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s2 = seedPlanningRuntime(h2);
        const p2 = (await rootPort(h2, s2)).port;
        for (let i = 0; i < WRITE_ARTIFACT_BOUNDS.maxCallsPerTurn; i += 1) expect(writtenArtifact(await p2.call(writeArtifact({ title: `n${i}`, content: `n${i}` }))).replayed).toBe(false);
        expect(rejectionCodes(await p2.call(writeArtifact({ title: "n33", content: "n33" })))).toEqual(["artifact_count_exceeded"]);
        // An identical replay is still served after the bound; nothing new is created.
        expect(writtenArtifact(await p2.call(writeArtifact({ title: "n0", content: "n0" }))).replayed).toBe(true);
        expect(artifactsOf(h2, s2.created.run.id)).toHaveLength(WRITE_ARTIFACT_BOUNDS.maxCallsPerTurn);
      } finally {
        h2.close();
      }
    } finally {
      h.close();
    }
  });

  it("replays identically, converges concurrent identical calls, keeps distinct calls distinct, and deduplicates content-addressed blobs safely", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { invocation, port } = await rootPort(h, s);
      const first = writtenArtifact(await port.call(writeArtifact({ title: "report", content: "same bytes" })));
      // Exact replay: the same Artifact id, no second row, no second Event.
      const seq = h.ctx.journal.lastSeq();
      const replay = writtenArtifact(await port.call(writeArtifact({ title: "report", content: "same bytes" })));
      expect(replay).toEqual({ ...first, replayed: true });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // Concurrent identical calls converge on one Artifact.
      const both = await Promise.all([port.call(writeArtifact({ title: "concurrent", content: "c" })), port.call(writeArtifact({ title: "concurrent", content: "c" }))]);
      expect(both.map((o) => writtenArtifact(o).replayed).sort()).toEqual([false, true]);
      expect(new Set(both.map((o) => writtenArtifact(o).artifactId)).size).toBe(1);
      // Distinct metadata over identical bytes: distinct Artifacts, one shared blob.
      const blobs = h.blobs.size;
      const second = writtenArtifact(await port.call(writeArtifact({ title: "duplicate content", content: "same bytes" })));
      expect(second.artifactId).not.toBe(first.artifactId);
      expect(second.digest).toBe(first.digest);
      expect(h.blobs.size).toBe(blobs);
      expect(artifactsOf(h, runId)).toHaveLength(3);
      expect(h.stores.runtimeToolCalls.listByInvocation(invocation.id)).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("commits the Artifact, its Event, the call row, and the blob together or not at all: an Event, insert, or COMMIT failure leaves nothing — no row, no Event, no unreferenced blob — and a cleanup failure never replaces the canonical error", async () => {
    const failures: [string, (h: RuntimeHarness) => void][] = [
      ["at the call row", (h) => vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw new Error("injected: row"); })],
      ["at an Event append", (h) => {
        const append = h.ctx.journal.append.bind(h.ctx.journal);
        const spy = vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
          if (input.type === "runtime_tool_call.committed") {
            spy.mockRestore();
            throw new Error("injected: event");
          }
          return append(input);
        });
      }],
      ["at COMMIT", (h) => {
        const exec = h.ctx.sqlite.exec.bind(h.ctx.sqlite);
        const spy = vi.spyOn(h.ctx.sqlite, "exec").mockImplementation((sql: string) => {
          if (sql === "COMMIT") {
            spy.mockRestore();
            throw new Error("injected: COMMIT failed");
          }
          return exec(sql);
        });
      }],
    ];
    for (const [label, inject] of failures) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedPlanningRuntime(h);
        const runId = s.created.run.id;
        const diagnostics: ExecutionDiagnostic[] = [];
        const r = await rootPort(h, s);
        const port = new RuntimeToolExecutor(h.ctx, h.stores, { runId, planNodeId: s.created.root.id, invocationId: r.invocation.id, attemptId: r.attempt.id, role: "orchestrator", purpose: "operator_input", manifestTools: h.stores.invocations.getManifest(r.invocation.id).content.runtimeTools }, {}, (d) => diagnostics.push(d));
        const marker = `MARKER-${label.replaceAll(" ", "-")}-must-not-persist`;
        const digest = sha256Hex(new TextEncoder().encode(marker));
        const seq = h.ctx.journal.lastSeq();
        inject(h);
        const failed = await port.call(writeArtifact({ title: "doomed", content: marker }));
        expect(failed, label).toMatchObject({ kind: "failed", tool: "write_artifact" });
        // Nothing persisted, and the blob written mid-transaction was compensated away.
        expect(h.ctx.tx.inTransaction, label).toBe(false);
        expect(h.ctx.journal.lastSeq(), label).toBe(seq);
        expect(artifactsOf(h, runId), label).toEqual([]);
        expect(h.stores.runtimeToolCalls.listByInvocation(r.invocation.id), label).toEqual([]);
        expect(h.blobs.has(digest), label).toBe(false);
        expect(diagnostics.map((d) => d.kind), label).toEqual(["runtime_tool_call_failed"]);
        expect(canonicalJson(diagnostics), label).not.toContain(marker);
        vi.restoreAllMocks();
        // The retried identical call succeeds from scratch: one Artifact, one blob, one row.
        const retried = writtenArtifact(await port.call(writeArtifact({ title: "doomed", content: marker })));
        expect(retried.replayed, label).toBe(false);
        expect(h.blobs.has(digest), label).toBe(true);
        expect(artifactsOf(h, runId), label).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
    // A rollback whose blob cleanup itself fails reports the bounded diagnostic and keeps the canonical error.
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw new ConflictError("injected: canonical failure"); });
      vi.spyOn(h.blobs, "remove").mockImplementationOnce(() => { throw new Error("injected: cleanup failed"); });
      const failed = await r.port.call(writeArtifact({ title: "doomed", content: "cleanup fails" }));
      // The outcome names the canonical failure's closed kind (the call row, not the cleanup) and no exception text at all.
      expect(failed).toEqual({ kind: "failed", tool: "write_artifact", message: "write_artifact failed: ConflictError:conflict" });
      expect(h.diagnostics.map((d) => d.kind)).toContain("blob_cleanup_failed");
      expect(JSON.stringify([failed, h.diagnostics])).not.toContain("injected");
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("keeps the 96 KiB request ceiling distinct from the 48 KiB decoded ceiling: maximal base64 with maximal metadata fits, heavily escaped text beyond the request ceiling is refused without a write, the same bytes as base64 succeed, and a refusal consumes no allowance", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { invocation, port } = await rootPort(h, s);
      const title = "t".repeat(WRITE_ARTIFACT_BOUNDS.titleMaxBytes);
      const mediaType = `application/${"m".repeat(WRITE_ARTIFACT_BOUNDS.mediaTypeMaxBytes - "application/".length)}`;
      // 48 KiB decoded as base64 (65,536 characters) with a 200-byte title and a 200-byte media type: within the 96 KiB request ceiling.
      const maximal = writeArtifact({ title, mediaType, encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, 0xff).toString("base64") });
      const canonical = utf8ByteLength(canonicalRuntimeToolCall(maximal));
      expect(canonical).toBeGreaterThan(RUNTIME_TOOL_CALL_MAX_BYTES);
      expect(canonical).toBeLessThanOrEqual(WRITE_ARTIFACT_CALL_MAX_BYTES);
      expect(writtenArtifact(await port.call(maximal))).toMatchObject({ byteSize: WRITE_ARTIFACT_BOUNDS.maxContentBytes, mediaType, title });
      // Heavily escaped text: 49,152 quotes decode to exactly 48 KiB (within the decoded ceiling) but serialize to 98,304 bytes of
      // escaped content — beyond the request ceiling. Refused typed before any transaction; nothing written, no allowance consumed.
      const quotes = '"'.repeat(WRITE_ARTIFACT_BOUNDS.maxContentBytes);
      const escaped = writeArtifact({ title: "escaped", content: quotes });
      expect(utf8ByteLength(canonicalRuntimeToolCall(escaped))).toBeGreaterThan(WRITE_ARTIFACT_CALL_MAX_BYTES);
      const before = { artifacts: artifactsOf(h, runId).length, calls: h.stores.runtimeToolCalls.listByInvocation(invocation.id).length, seq: h.ctx.journal.lastSeq(), blobs: h.blobs.size };
      const refused = await port.call(escaped);
      expect(refused).toMatchObject({ kind: "rejected", tool: "write_artifact", reasons: [{ code: "invalid_input", path: null }] });
      expect((refused as { reasons: { message: string }[] }).reasons[0]!.message).toMatch(/canonical bound/);
      // 16 KiB of NUL characters escape to six bytes each: refused likewise.
      const controls = writeArtifact({ title: "controls", content: "\u0000".repeat(16_384) });
      expect(utf8ByteLength(canonicalRuntimeToolCall(controls))).toBeGreaterThan(WRITE_ARTIFACT_CALL_MAX_BYTES);
      expect(rejectionCodes(await port.call(controls))).toEqual(["invalid_input"]);
      expect({ artifacts: artifactsOf(h, runId).length, calls: h.stores.runtimeToolCalls.listByInvocation(invocation.id).length, seq: h.ctx.journal.lastSeq(), blobs: h.blobs.size }).toEqual(before);
      // The same permitted bytes submitted as base64 succeed: the decoded ceiling, not the escaping, is what bounds content.
      const asBase64 = writtenArtifact(await port.call(writeArtifact({ title: "escaped", encoding: "base64", content: Buffer.from(quotes, "utf8").toString("base64") })));
      expect(asBase64.byteSize).toBe(WRITE_ARTIFACT_BOUNDS.maxContentBytes);
      expect(readResult(await port.call(readArtifact({ artifactId: asBase64.artifactId, maxBytes: 16 })), "read_artifact").content).toBe('"'.repeat(16));
      const nulls = writtenArtifact(await port.call(writeArtifact({ title: "controls", encoding: "base64", content: Buffer.alloc(16_384, 0).toString("base64") })));
      expect(nulls.byteSize).toBe(16_384);
      // Decoded size, accepted-call count, and cumulative bytes stay independent: the two refusals counted toward none of them.
      const accepted = h.stores.runtimeToolCalls.listByInvocation(invocation.id).filter((c) => c.tool === "write_artifact");
      expect(accepted).toHaveLength(3);
      expect(accepted.reduce((sum, c) => sum + (c.result.tool === "write_artifact" ? c.result.byteSize : 0), 0)).toBe(2 * WRITE_ARTIFACT_BOUNDS.maxContentBytes + 16_384);
    } finally {
      h.close();
    }
  });

  it("a same-Invocation Artifact is immediately readable and admissible as result Evidence; an Evaluator writes without any Workspace mutation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const e = await evaluatorPort(h);
      const written = writtenArtifact(await e.port.call(writeArtifact({ title: "evaluation evidence", content: "findings" })));
      expect(readResult(await e.port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe("findings");
      // No Changeset, no Task mutation, no Decision, no Workspace side effect: only the Artifact and its call record exist.
      expect(h.stores.changesets.listByRun(e.runId).filter((c) => c.invocationId === e.invocation.id)).toEqual([]);
      expect(h.stores.tasks.listByRun(e.runId)).toEqual([]);
      expect(h.stores.decisions.listByRun(e.runId)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

const WRITE_ARTIFACT_MAX_ENCODED = Math.ceil(WRITE_ARTIFACT_BOUNDS.maxContentBytes / 3) * 4;
