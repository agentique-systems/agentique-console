/**
 * `read_artifact` content behavior (execution-model §6.4 "Runtime read
 * tools"): the one runtime tool that returns Artifact content. Bytes are
 * loaded and verified through the canonical Artifact Store; paging is
 * explicit and boundary-safe (`utf8` never splits a sequence, `base64`
 * pages over decoded bytes); the digest and total size always describe the
 * whole Artifact; a missing or corrupt blob is a closed typed failure that
 * is never "not found"; and no byte of content reaches an Event, a
 * diagnostic, a manifest, a `runtime_tool_calls` row, or an error message.
 */
import { canonicalJson, READ_ARTIFACT_BOUNDS } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { readArtifact, readResult, rejectionCodes, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { rootPort } from "./decision-test-support.ts";
import { openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";
import type { ExecutionDiagnostic } from "./workspace-cleanup.ts";

describe("read_artifact", () => {
  it("reads complete text, pages UTF-8 without ever splitting a sequence, and reports offsets, byte counts, and eof exactly", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { port } = await rootPort(h, s);
      // "aé€𝄞" repeated: 1-, 2-, 3-, and 4-byte sequences (10 bytes per repetition).
      const text = "aé€𝄞".repeat(30);
      const total = new TextEncoder().encode(text).byteLength;
      const { artifactId, digest } = writtenArtifact(await port.call(writeArtifact({ title: "unicode", content: text })));
      // One complete read.
      const whole = readResult(await port.call(readArtifact({ artifactId, maxBytes: READ_ARTIFACT_BOUNDS.maxMaxBytes })), "read_artifact");
      expect(whole).toMatchObject({ content: text, byteSize: total, byteCount: total, offset: 0, eof: true, nextOffset: null, digest });
      // Multi-page read at an awkward page size: every page decodes cleanly, pages chain by nextOffset, and concatenation is exact.
      let offset = 0;
      let assembled = "";
      const pages: number[] = [];
      while (true) {
        const page = readResult(await port.call(readArtifact({ artifactId, offset, maxBytes: 7 })), "read_artifact");
        expect(page.digest).toBe(digest);
        expect(page.byteSize).toBe(total);
        expect(page.offset).toBe(offset);
        expect(page.byteCount).toBeGreaterThan(0);
        expect(page.byteCount).toBeLessThanOrEqual(7);
        expect(new TextEncoder().encode(page.content).byteLength).toBe(page.byteCount);
        assembled += page.content;
        pages.push(page.byteCount);
        if (page.eof) {
          expect(page.nextOffset).toBeNull();
          break;
        }
        expect(page.nextOffset).toBe(offset + page.byteCount);
        offset = page.nextOffset!;
      }
      expect(assembled).toBe(text);
      // The boundary was actually exercised: some pages returned fewer than 7 bytes to avoid splitting a sequence.
      expect(pages.some((count) => count < 7)).toBe(true);
      // An offset inside a UTF-8 sequence is refused for utf8 and served exactly for base64.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId, offset: 2 })))).toEqual(["artifact_content_not_utf8"]);
      const raw = readResult(await port.call(readArtifact({ artifactId, offset: 2, maxBytes: 4, encoding: "base64" })), "read_artifact");
      expect(Uint8Array.from(Buffer.from(raw.content, "base64"))).toEqual(new TextEncoder().encode(text).subarray(2, 6));
      // A maxBytes too small for the next sequence is refused rather than looping.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId, offset: 1 + 2 + 3, maxBytes: 2 })))).toEqual(["invalid_input"]);
    } finally {
      h.close();
    }
  });

  it("pages binary content as base64 over decoded bytes, serves the zero-byte Artifact, the maximum page, and the offset at the end, and refuses an offset beyond it", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { port } = await rootPort(h, s);
      const bytes = Uint8Array.from(Array.from({ length: 1_000 }, (_, i) => (i * 7 + 13) % 256));
      const binary = writtenArtifact(await port.call(writeArtifact({ title: "binary", mediaType: "application/octet-stream", encoding: "base64", content: Buffer.from(bytes).toString("base64") })));
      let offset = 0;
      const assembled: number[] = [];
      while (true) {
        const page = readResult(await port.call(readArtifact({ artifactId: binary.artifactId, offset, maxBytes: 256, encoding: "base64" })), "read_artifact");
        const decoded = Uint8Array.from(Buffer.from(page.content, "base64"));
        expect(decoded.byteLength).toBe(page.byteCount);
        expect(decoded).toEqual(bytes.subarray(offset, offset + page.byteCount));
        assembled.push(...decoded);
        if (page.eof) break;
        offset = page.nextOffset!;
      }
      expect(Uint8Array.from(assembled)).toEqual(bytes);
      // Invalid UTF-8 requested as utf8: a typed refusal recommending base64, never silent replacement characters.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: binary.artifactId })))).toEqual(["artifact_content_not_utf8"]);
      // The zero-byte Artifact reads as one empty eof page under both encodings.
      const empty = writtenArtifact(await port.call(writeArtifact({ title: "empty", encoding: "base64", content: "" })));
      for (const encoding of ["utf8", "base64"] as const) {
        expect(readResult(await port.call(readArtifact({ artifactId: empty.artifactId, encoding })), "read_artifact")).toMatchObject({ byteSize: 0, byteCount: 0, content: "", eof: true, nextOffset: null });
      }
      // The maximum page, an offset exactly at the end, and one beyond it.
      const max = readResult(await port.call(readArtifact({ artifactId: binary.artifactId, maxBytes: READ_ARTIFACT_BOUNDS.maxMaxBytes, encoding: "base64" })), "read_artifact");
      expect(max).toMatchObject({ byteCount: 1_000, eof: true });
      expect(readResult(await port.call(readArtifact({ artifactId: binary.artifactId, offset: 1_000, encoding: "base64" })), "read_artifact")).toMatchObject({ byteCount: 0, content: "", eof: true, nextOffset: null });
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: binary.artifactId, offset: 1_001, encoding: "base64" })))).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: binary.artifactId, maxBytes: READ_ARTIFACT_BOUNDS.maxMaxBytes + 1 })))).toEqual(["invalid_input"]);
    } finally {
      h.close();
    }
  });

  it("returns closed typed failures for missing and corrupt content — never 'not found', never bytes or paths — and no content ever reaches Events, diagnostics, manifests, rows, or errors", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const diagnostics: ExecutionDiagnostic[] = [];
      h.executionDiagnostics.length = 0;
      const { invocation, port } = await rootPort(h, s);
      const marker = "MARKER-2af9-artifact-content-must-not-leak";
      const written = writtenArtifact(await port.call(writeArtifact({ title: "sensitive", content: marker })));
      expect(readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe(marker);
      // Corrupt content (same length, then different length): a typed failure that names ids and digests only.
      const original = h.blobs.get(written.digest);
      h.blobs.corrupt(written.digest, new TextEncoder().encode(marker.replace("2af9", "0000")));
      const corrupt = await port.call(readArtifact({ artifactId: written.artifactId }));
      expect(rejectionCodes(corrupt)).toEqual(["artifact_content_corrupt"]);
      h.blobs.corrupt(written.digest, new TextEncoder().encode("short"));
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: written.artifactId })))).toEqual(["artifact_content_corrupt"]);
      // Missing content: its own closed failure, distinct from corruption and from an unreadable Artifact.
      h.blobs.remove(written.digest);
      const missing = await port.call(readArtifact({ artifactId: written.artifactId }));
      expect(rejectionCodes(missing)).toEqual(["artifact_content_missing"]);
      // Restore: the same call reads the same canonical content again — corruption was never recorded as state.
      h.blobs.put(original);
      expect(readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe(marker);
      // No byte of content anywhere but the store and the read response: Events, rows, diagnostics, manifests, errors.
      expect(canonicalJson(h.ctx.journal.read({ runId }))).not.toContain(marker);
      expect(canonicalJson(h.stores.runtimeToolCalls.listByInvocation(invocation.id))).not.toContain(marker);
      expect(canonicalJson([...diagnostics, ...h.executionDiagnostics])).not.toContain(marker);
      expect(canonicalJson(h.stores.invocations.listByRun(runId).map((i) => h.stores.invocations.getManifest(i.id)))).not.toContain(marker);
      expect(JSON.stringify([corrupt, missing])).not.toContain(marker);
      expect(JSON.stringify([corrupt, missing])).not.toMatch(/[\\/]blobs|[A-Za-z]:\\\\|\/tmp\//);
    } finally {
      h.close();
    }
  });
});
