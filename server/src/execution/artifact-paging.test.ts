/**
 * The serialized ceiling of `read_artifact` (execution-model §6.4): four
 * quantities stay distinct — decoded Artifact bytes (what `offset`,
 * `byteCount`, and `nextOffset` measure), encoded content length (UTF-8
 * text or base64), serialized JSON bytes (the content with its escaping
 * inside the result), and the provider-facing outcome envelope. The 64 KiB
 * ceiling is enforced on the last, measured in UTF-8 bytes; `maxBytes` is
 * an upper bound and a page holds the largest complete range that fits:
 * base64 represents exactly the returned range, UTF-8 pages never split a
 * sequence, JSON escaping cannot bypass the ceiling, every non-final page
 * makes progress, and the digest and total size always describe the whole
 * Artifact. Large fixtures are runtime Artifacts listed on a node's
 * operation input — a canonical manifest route — never an enlarged write.
 */
import { READ_ARTIFACT_BOUNDS, RUNTIME_READ_BOUNDS, type ReadArtifactResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { listedArtifactWorker, readArtifact, readResult, rejectionCodes, runArtifact } from "./data-access-test-support.ts";
import { escapedBytes, readOutcomeBytes } from "./runtime-reads.ts";
import { openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const CEILING = RUNTIME_READ_BOUNDS.maxResponseBytes;
const MAX = READ_ARTIFACT_BOUNDS.maxMaxBytes;
const encode = (text: string) => new TextEncoder().encode(text);

/** Reads the whole Artifact page by page under `input`, checking every page's invariants, and returns the pages and the reassembled bytes. */
async function readAll(port: { call: (r: never) => Promise<unknown> }, artifactId: string, bytes: Uint8Array, input: { maxBytes?: number; encoding?: "utf8" | "base64" }) {
  const pages: ReadArtifactResult[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = readResult((await port.call(readArtifact({ artifactId: artifactId as never, offset, ...input }) as never)) as never, "read_artifact");
    pages.push(page);
    // Digest and total size always describe the whole Artifact; the page lies inside it and its serialized envelope fits the ceiling.
    expect(page.digest).toBe(sha256Hex(bytes));
    expect(page.byteSize).toBe(bytes.byteLength);
    expect(page.offset).toBe(offset);
    expect(page.byteCount).toBeLessThanOrEqual(input.maxBytes ?? READ_ARTIFACT_BOUNDS.defaultMaxBytes);
    expect(readOutcomeBytes(page)).toBeLessThanOrEqual(CEILING);
    const decoded = page.encoding === "base64" ? Uint8Array.from(Buffer.from(page.content, "base64")) : encode(page.content);
    expect(decoded.byteLength).toBe(page.byteCount);
    expect(decoded).toEqual(bytes.subarray(offset, offset + page.byteCount));
    chunks.push(decoded);
    if (page.eof) {
      expect(page.nextOffset).toBeNull();
      expect(offset + page.byteCount).toBe(bytes.byteLength);
      break;
    }
    expect(page.byteCount).toBeGreaterThan(0);
    expect(page.nextOffset).toBe(offset + page.byteCount);
    offset = page.nextOffset!;
  }
  const assembled = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, at);
    at += chunk.byteLength;
  }
  return { pages, assembled };
}

/** The next unit's cost when this non-final page were extended by one more base64 group or one more code point. */
function extendedBy(page: ReadArtifactResult, bytes: Uint8Array): ReadArtifactResult {
  const end = page.offset + page.byteCount;
  if (page.encoding === "base64") {
    const next = Math.min(end + 3, bytes.byteLength);
    return { ...page, byteCount: next - page.offset, content: Buffer.from(bytes.subarray(page.offset, next)).toString("base64"), nextOffset: next };
  }
  const lead = bytes[end]!;
  const length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  const next = end + length;
  return { ...page, byteCount: next - page.offset, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(page.offset, next)), nextOffset: next };
}

async function listed(h: RuntimeHarness, bytes: Uint8Array, mediaType = "application/octet-stream") {
  const s = seedPlanningRuntime(h);
  const artifact = runArtifact(h, s, bytes, "large fixture", mediaType);
  const w = await listedArtifactWorker(h, s, [artifact.id]);
  return { artifact, port: w.port };
}

describe("read_artifact serialized ceiling", () => {
  it("binary of 64 KiB and more as base64: a maximum page is the largest whole-group range that keeps the outcome within 64 KiB, and the pages reassemble the exact bytes", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const bytes = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7919 + (i >> 8)) % 256);
      const { artifact, port } = await listed(h, bytes);
      const { pages, assembled } = await readAll(port, artifact.id, bytes, { maxBytes: MAX, encoding: "base64" });
      expect(assembled).toEqual(bytes);
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages.slice(0, -1)) {
        // A whole number of groups, fewer than the requested 64 KiB, and exactly maximal: one more group would exceed the ceiling.
        expect(page.byteCount % 3).toBe(0);
        expect(page.byteCount).toBeLessThan(MAX);
        expect(page.byteCount).toBeGreaterThan(48_000);
        expect(readOutcomeBytes(extendedBy(page, bytes))).toBeGreaterThan(CEILING);
      }
      // A small request is honored exactly; the zero-byte and end-of-Artifact pages are empty eof pages under both encodings.
      expect(readResult(await port.call(readArtifact({ artifactId: artifact.id, offset: 3, maxBytes: 300, encoding: "base64" })), "read_artifact")).toMatchObject({ byteCount: 300, nextOffset: 303, eof: false });
      expect(readResult(await port.call(readArtifact({ artifactId: artifact.id, offset: bytes.byteLength, encoding: "base64" })), "read_artifact")).toMatchObject({ byteCount: 0, content: "", eof: true, nextOffset: null });
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifact.id, offset: bytes.byteLength + 1 })))).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifact.id, maxBytes: MAX + 1 })))).toEqual(["invalid_input"]);
    } finally {
      h.close();
    }
  });

  it("large ASCII text as utf8: a maximum page fills the ceiling to the byte, every non-final page makes progress, and the text reassembles exactly", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const text = Array.from({ length: 2_000 }, (_, i) => `line ${i}: ${"lorem ipsum dolor sit amet ".repeat(3)}`).join("\n");
      const bytes = encode(text);
      expect(bytes.byteLength).toBeGreaterThan(2 * MAX);
      const { artifact, port } = await listed(h, bytes, "text/plain");
      const { pages, assembled } = await readAll(port, artifact.id, bytes, { maxBytes: MAX, encoding: "utf8" });
      expect(new TextDecoder().decode(assembled)).toBe(text);
      for (const page of pages.slice(0, -1)) {
        expect(page.byteCount).toBeLessThan(MAX);
        expect(page.byteCount).toBeGreaterThan(60_000);
        // Exact boundary: the page fits, one more code point does not.
        expect(readOutcomeBytes(page)).toBeLessThanOrEqual(CEILING);
        expect(readOutcomeBytes(extendedBy(page, bytes))).toBeGreaterThan(CEILING);
      }
      // The default page (16 KiB) is far below the ceiling and comes back complete.
      const first = readResult(await port.call(readArtifact({ artifactId: artifact.id })), "read_artifact");
      expect(first).toMatchObject({ byteCount: READ_ARTIFACT_BOUNDS.defaultMaxBytes, offset: 0, eof: false });
      expect(readOutcomeBytes(first)).toBeLessThan(CEILING / 2);
    } finally {
      h.close();
    }
  });

  it("multibyte Unicode as utf8: pages never split a sequence, each is the largest whole-code-point range within the ceiling, and the text reassembles exactly", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // 1-, 2-, 3-, and 4-byte sequences (10 bytes per repetition), past 64 KiB.
      const text = "aé€𝄞".repeat(9_000);
      const bytes = encode(text);
      expect(bytes.byteLength).toBe(90_000);
      const { artifact, port } = await listed(h, bytes, "text/plain");
      const { pages, assembled } = await readAll(port, artifact.id, bytes, { maxBytes: MAX, encoding: "utf8" });
      expect(new TextDecoder().decode(assembled)).toBe(text);
      for (const page of pages.slice(0, -1)) {
        expect(readOutcomeBytes(extendedBy(page, bytes))).toBeGreaterThan(CEILING);
        // The page end is a UTF-8 boundary: the byte after it is never a continuation byte.
        expect(bytes[page.offset + page.byteCount]! & 0xc0).not.toBe(0x80);
      }
      // An awkward small page size exercises the boundary pull-back without touching the ceiling; the pages still reassemble.
      const shortText = "aé€𝄞".repeat(100);
      const short = await listed(h, encode(shortText), "text/plain");
      const small = await readAll(short.port, short.artifact.id, encode(shortText), { maxBytes: 7, encoding: "utf8" });
      expect(new TextDecoder().decode(small.assembled)).toBe(shortText);
      expect(small.pages.some((p) => p.byteCount < 7 && !p.eof)).toBe(true);
      // Undersized requests: an offset inside a sequence is refused for utf8 (served for base64); a maxBytes too small for the next sequence is refused.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifact.id, offset: 2 })))).toEqual(["artifact_content_not_utf8"]);
      expect(readResult(await port.call(readArtifact({ artifactId: artifact.id, offset: 2, maxBytes: 4, encoding: "base64" })), "read_artifact").byteCount).toBe(4);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifact.id, offset: 6, maxBytes: 3 })))).toEqual(["invalid_input"]);
    } finally {
      h.close();
    }
  });

  it("quotes, backslashes, and control characters expand under JSON escaping: the page shrinks so the serialized outcome stays within the ceiling and nothing is truncated", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // Every byte escapes: quotes and backslashes to two bytes, NUL to six; 80,000 decoded bytes serialize to far more.
      const text = `${'"\\'.repeat(30_000)}${"\u0000".repeat(10_000)}${"\t\n".repeat(5_000)}`;
      const bytes = encode(text);
      expect(bytes.byteLength).toBe(80_000);
      const { artifact, port } = await listed(h, bytes, "text/plain");
      const { pages, assembled } = await readAll(port, artifact.id, bytes, { maxBytes: MAX, encoding: "utf8" });
      expect(new TextDecoder().decode(assembled)).toBe(text);
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages.slice(0, -1)) {
        // The page holds far fewer decoded bytes than the 64 KiB requested, its content serializes to the ceiling, one more code point would exceed it.
        expect(page.byteCount).toBeLessThan(MAX / 2 + 1);
        expect(readOutcomeBytes(page)).toBeLessThanOrEqual(CEILING);
        expect(readOutcomeBytes(extendedBy(page, bytes))).toBeGreaterThan(CEILING);
        const escaped = [...page.content].reduce((n, c) => n + escapedBytes(c.codePointAt(0)!), 0);
        expect(escaped).toBeLessThanOrEqual(CEILING);
        expect(JSON.parse(JSON.stringify(page)).content).toBe(page.content);
      }
      // The same bytes as base64 spend nothing on escaping: a page carries more of the Artifact (3 bytes per 4 characters, never 1 per 2 or 1 per 6).
      const raw = readResult(await port.call(readArtifact({ artifactId: artifact.id, maxBytes: MAX, encoding: "base64" })), "read_artifact");
      expect(raw.byteCount).toBeGreaterThan(pages[0]!.byteCount);
      expect(raw.byteCount).toBeGreaterThan(48_000);
    } finally {
      h.close();
    }
  });

  it("maximum bounded metadata (a 200-byte media type) is accounted for in the envelope, and the zero-byte Artifact reads as one empty eof page", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const mediaType = `application/${"x".repeat(200 - "application/".length)}`;
      expect(mediaType.length).toBe(200);
      const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
      const { artifact, port } = await listed(h, bytes, mediaType);
      const page = readResult(await port.call(readArtifact({ artifactId: artifact.id, maxBytes: MAX, encoding: "base64" })), "read_artifact");
      expect(page.mediaType).toBe(mediaType);
      expect(readOutcomeBytes(page)).toBeLessThanOrEqual(CEILING);
      expect(readOutcomeBytes(extendedBy(page, bytes))).toBeGreaterThan(CEILING);
      // The wider media type costs the page exactly what it adds to the envelope, compared with a short one over the same bytes.
      const plain = await listed(h, bytes);
      const plainPage = readResult(await plain.port.call(readArtifact({ artifactId: plain.artifact.id, maxBytes: MAX, encoding: "base64" })), "read_artifact");
      expect(plainPage.byteCount).toBeGreaterThan(page.byteCount);
      expect(plainPage.byteCount - page.byteCount).toBeLessThanOrEqual(Math.ceil((mediaType.length - "application/octet-stream".length) / 4) * 3 + 3);
      // The zero-byte Artifact reads as one empty eof page under both encodings, through the same manifest route.
      const empty = await listed(h, new Uint8Array(0), "text/plain");
      for (const encoding of ["utf8", "base64"] as const) {
        expect(readResult(await empty.port.call(readArtifact({ artifactId: empty.artifact.id, encoding })), "read_artifact")).toMatchObject({ byteSize: 0, byteCount: 0, content: "", eof: true, nextOffset: null });
      }
    } finally {
      h.close();
    }
  });

  it("malformed UTF-8 is a typed refusal recommending base64 — never a replacement character, never truncated content", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // A valid prefix, then a truncated 3-byte sequence, then more text: invalid in the requested range.
      const bytes = Uint8Array.from([...encode("prefix "), 0xe2, 0x82, ...encode(" suffix")]);
      const { artifact, port } = await listed(h, bytes, "text/plain");
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifact.id })))).toEqual(["artifact_content_not_utf8"]);
      // The valid prefix alone reads; the raw bytes read as base64 exactly.
      expect(readResult(await port.call(readArtifact({ artifactId: artifact.id, maxBytes: 7 })), "read_artifact").content).toBe("prefix ");
      const raw = readResult(await port.call(readArtifact({ artifactId: artifact.id, encoding: "base64" })), "read_artifact");
      expect(Uint8Array.from(Buffer.from(raw.content, "base64"))).toEqual(bytes);
      expect(JSON.stringify(raw)).not.toContain("\ufffd");
    } finally {
      h.close();
    }
  });
});
