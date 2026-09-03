/**
 * `read_artifact` is byte-range retrieval, not text normalization
 * (execution-model §6.4): a UTF-8 byte order mark — at the start of an
 * Artifact, at a later page boundary, or embedded as ordinary U+FEFF — is
 * content. Every `utf8` page's text re-encodes to exactly the selected
 * source bytes, `byteCount` and `nextOffset` describe that range, every
 * non-final page advances, and the serialized ceiling, the
 * sequence-boundary handling, and the invalid-UTF-8 refusals are unchanged.
 * Every case runs through the bound runtime-tool port, and one runs the
 * same paging sequence again in a fresh process over the same file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ_ARTIFACT_BOUNDS, RUNTIME_READ_BOUNDS, type ArtifactId, type ReadArtifactResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { listedArtifactWorker, readArtifact, readResult, rejectionCodes, retriedAttempt, runArtifact } from "./data-access-test-support.ts";
import { readOutcomeBytes } from "./runtime-reads.ts";
import { openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const BOM = [0xef, 0xbb, 0xbf];
const bytesOf = (...parts: (number[] | string)[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const encode = (text: string) => new TextEncoder().encode(text);
const FEFF = "﻿";

type Port = { call: (request: never) => Promise<unknown> };

/** One page through the port, with every invariant of a `utf8` page checked against the source bytes. */
async function page(port: Port, artifactId: ArtifactId, bytes: Uint8Array, offset: number, maxBytes?: number): Promise<ReadArtifactResult> {
  const result = readResult((await port.call(readArtifact({ artifactId, offset, ...(maxBytes === undefined ? {} : { maxBytes }) }) as never)) as never, "read_artifact");
  expect(result).toMatchObject({ offset, byteSize: bytes.byteLength, digest: sha256Hex(bytes), encoding: "utf8" });
  // The text re-encodes to exactly the selected bytes; the counts describe that range; the ceiling holds.
  expect(encode(result.content)).toEqual(bytes.subarray(offset, offset + result.byteCount));
  expect(result.byteCount).toBeLessThanOrEqual(maxBytes ?? READ_ARTIFACT_BOUNDS.defaultMaxBytes);
  expect(result.nextOffset).toBe(result.eof ? null : offset + result.byteCount);
  expect(result.eof).toBe(offset + result.byteCount === bytes.byteLength);
  if (!result.eof) expect(result.byteCount).toBeGreaterThan(0);
  expect(readOutcomeBytes(result)).toBeLessThanOrEqual(RUNTIME_READ_BOUNDS.maxResponseBytes);
  return result;
}

/** Pages the whole Artifact at `maxBytes`, checking each page, and returns the pages plus the reconstructed bytes. */
async function readAll(port: Port, artifactId: ArtifactId, bytes: Uint8Array, maxBytes?: number) {
  const pages: ReadArtifactResult[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let guard = 0; guard < 5_000; guard += 1) {
    const p = await page(port, artifactId, bytes, offset, maxBytes);
    pages.push(p);
    chunks.push(encode(p.content));
    if (p.eof) break;
    offset = p.nextOffset!;
  }
  const assembled = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, at);
    at += chunk.byteLength;
  }
  expect(assembled).toEqual(bytes);
  return { pages, assembled };
}

async function listed(h: RuntimeHarness, fixtures: Record<string, Uint8Array>) {
  const s = seedPlanningRuntime(h);
  const artifacts = Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, runArtifact(h, s, bytes, name, "text/plain")]));
  const w = await listedArtifactWorker(h, s, Object.values(artifacts).map((a) => a.id));
  return { artifacts, port: w.port as Port, worker: w };
}

describe("read_artifact preserves exact UTF-8 bytes, BOMs included", () => {
  it("1–3: a BOM-only Artifact, a BOM before ASCII, and a BOM before multibyte text each read as their exact bytes in one advancing page", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const fixtures = { bom: bytesOf(BOM), bomAscii: bytesOf(BOM, "A"), bomMultibyte: bytesOf(BOM, "é€𝄞") };
      const { artifacts, port } = await listed(h, fixtures);
      // The reproducer: the whole BOM-only Artifact is one three-byte page of U+FEFF that is final — never an empty non-final page.
      const only = await page(port, artifacts.bom!.id, fixtures.bom, 0, READ_ARTIFACT_BOUNDS.maxMaxBytes);
      expect(only).toMatchObject({ content: FEFF, byteCount: 3, nextOffset: null, eof: true });
      const ascii = await page(port, artifacts.bomAscii!.id, fixtures.bomAscii, 0);
      expect(ascii).toMatchObject({ content: `${FEFF}A`, byteCount: 4, nextOffset: null, eof: true });
      const multibyte = await page(port, artifacts.bomMultibyte!.id, fixtures.bomMultibyte, 0);
      expect(multibyte).toMatchObject({ content: `${FEFF}é€𝄞`, byteCount: 3 + 2 + 3 + 4, eof: true });
      // The BOM alone as a page of exactly three bytes, then the rest from offset 3 — the second page never begins mid-sequence.
      const first = await page(port, artifacts.bomAscii!.id, fixtures.bomAscii, 0, 3);
      expect(first).toMatchObject({ content: FEFF, byteCount: 3, nextOffset: 3, eof: false });
      expect(await page(port, artifacts.bomAscii!.id, fixtures.bomAscii, 3, 3)).toMatchObject({ content: "A", byteCount: 1, eof: true });
    } finally {
      h.close();
    }
  });

  it("4–6, 8: an embedded U+FEFF, a page beginning exactly at it, repeated BOMs, and pages ending immediately before or after a BOM all preserve the bytes and advance", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const fixtures = { embedded: bytesOf("ab", BOM, "cd", BOM, "e"), repeated: bytesOf(BOM, BOM, BOM, "x", BOM) };
      const { artifacts, port } = await listed(h, fixtures);
      const embedded = artifacts.embedded!.id;
      // A page ending immediately before the embedded BOM (bytes 0..2), one beginning exactly at it (2..5), one ending right after it.
      expect(await page(port, embedded, fixtures.embedded, 0, 2)).toMatchObject({ content: "ab", byteCount: 2, nextOffset: 2 });
      expect(await page(port, embedded, fixtures.embedded, 2, 3)).toMatchObject({ content: FEFF, byteCount: 3, nextOffset: 5 });
      expect(await page(port, embedded, fixtures.embedded, 2, 4)).toMatchObject({ content: `${FEFF}c`, byteCount: 4, nextOffset: 6 });
      expect(await page(port, embedded, fixtures.embedded, 0, 5)).toMatchObject({ content: `ab${FEFF}`, byteCount: 5, nextOffset: 5 });
      // A page that would end inside the BOM is pulled back to the boundary before it, and the next page begins at the BOM.
      expect(await page(port, embedded, fixtures.embedded, 0, 4)).toMatchObject({ content: "ab", byteCount: 2, nextOffset: 2 });
      // Repeated BOMs: each is content; a 3-byte page yields one U+FEFF at a time; the whole reads as four U+FEFF and an x.
      const repeated = artifacts.repeated!.id;
      const threes = await readAll(port, repeated, fixtures.repeated, 3);
      expect(threes.pages.map((p) => p.content)).toEqual([FEFF, FEFF, FEFF, "x", FEFF]);
      expect(threes.pages.map((p) => p.byteCount)).toEqual([3, 3, 3, 1, 3]);
      expect(await page(port, repeated, fixtures.repeated, 0)).toMatchObject({ content: `${FEFF}${FEFF}${FEFF}x${FEFF}`, byteCount: 13, eof: true });
      // An offset inside a BOM is a split sequence: refused for utf8, served exactly for base64.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: repeated, offset: 1 }) as never) as never)).toEqual(["artifact_content_not_utf8"]);
      const raw = readResult((await port.call(readArtifact({ artifactId: repeated, offset: 1, maxBytes: 2, encoding: "base64" }) as never)) as never, "read_artifact");
      expect(Uint8Array.from(Buffer.from(raw.content, "base64"))).toEqual(Uint8Array.from([0xbb, 0xbf]));
    } finally {
      h.close();
    }
  });

  it("7: a request too small to hold the next complete sequence (a BOM, a 4-byte character) is refused, never served as an empty page or a split sequence", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const fixtures = { bom: bytesOf(BOM, "A"), wide: bytesOf("a", "𝄞") };
      const { artifacts, port } = await listed(h, fixtures);
      for (const maxBytes of [1, 2]) expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifacts.bom!.id, maxBytes }) as never) as never)).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifacts.wide!.id, offset: 1, maxBytes: 3 }) as never) as never)).toEqual(["invalid_input"]);
      expect(await page(port, artifacts.wide!.id, fixtures.wide, 1, 4)).toMatchObject({ content: "𝄞", byteCount: 4, eof: true });
      // A one-byte request over ASCII still advances one byte at a time.
      expect(await page(port, artifacts.bom!.id, fixtures.bom, 3, 1)).toMatchObject({ content: "A", byteCount: 1, eof: true });
    } finally {
      h.close();
    }
  });

  it("9: a large Artifact with BOMs at the start, at every page boundary, and inside reconstructs exactly across maximal pages, and the ceiling holds on each", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // 200 KB: a BOM, then lines of mixed text each beginning with U+FEFF, so BOMs land on page boundaries at many page sizes.
      const bytes = bytesOf(BOM, Array.from({ length: 4_000 }, (_, i) => `${FEFF}line ${i} — ünïcödé 𝄞 "quoted" \\ \t`).join("\n"));
      expect(bytes.byteLength).toBeGreaterThan(2 * READ_ARTIFACT_BOUNDS.maxMaxBytes);
      const { artifacts, port } = await listed(h, { big: bytes });
      const maximal = await readAll(port, artifacts.big!.id, bytes, READ_ARTIFACT_BOUNDS.maxMaxBytes);
      expect(maximal.pages.length).toBeGreaterThan(2);
      for (const p of maximal.pages.slice(0, -1)) expect(p.byteCount).toBeGreaterThan(48_000);
      // Every page's text is exactly its bytes (checked per page) and a leading U+FEFF of a later page is kept, not dropped.
      const startingOnBom = maximal.pages.filter((p) => bytes[p.offset] === 0xef);
      expect(startingOnBom.length).toBeGreaterThan(0);
      expect(maximal.pages.filter((p) => p.content.startsWith(FEFF)).map((p) => p.offset)).toEqual(startingOnBom.map((p) => p.offset));
      // Small pages of 7 bytes, where BOMs straddle boundaries constantly, over the first 700 bytes.
      const head = bytes.subarray(0, 700);
      const smallSet = await listed(h, { head });
      const small = await readAll(smallSet.port, smallSet.artifacts.head!.id, head, 7);
      expect(small.pages.some((p) => p.byteCount < 7 && !p.eof)).toBe(true);
      expect(small.pages.every((p) => p.byteCount > 0)).toBe(true);
    } finally {
      h.close();
    }
  });

  it("10: the same paging sequence yields byte-identical pages before and after a reopen (recovery, next Attempt of the same Invocation, fresh port)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-bom-reopen-"));
    const file = path.join(dir, "console.db");
    const bytes = bytesOf(BOM, "ab", BOM, "é𝄞", BOM, BOM, "end");
    let artifactId!: ArtifactId;
    let invocationId!: string;
    let before!: string;
    const blobs = openHarness(file).blobs;
    const first = openRuntimeHarness({ base: openHarness(file, { blobs }), governor: WIDE_GOVERNOR });
    try {
      const { artifacts, port, worker } = await listed(first, { seq: bytes });
      artifactId = artifacts.seq!.id;
      invocationId = worker.invocation.id;
      before = JSON.stringify((await readAll(port, artifactId, bytes, 4)).pages);
    } finally {
      first.close();
    }
    const again = openRuntimeHarness({ base: openHarness(file, { blobs }), governor: WIDE_GOVERNOR });
    try {
      again.recovery.recover();
      const { port } = await retriedAttempt(again, again.stores.invocations.get(invocationId as never));
      const after = JSON.stringify((await readAll(port as Port, artifactId, bytes, 4)).pages);
      expect(after).toBe(before);
      // Four-byte pages over BOM a b BOM é 𝄞 BOM BOM e n d: a page ends before a straddling sequence and begins exactly on it.
      expect(JSON.parse(after).map((p: ReadArtifactResult) => [p.offset, p.byteCount, p.content])).toEqual([
        [0, 4, `${FEFF}a`],
        [4, 4, `b${FEFF}`],
        [8, 2, "é"],
        [10, 4, "𝄞"],
        [14, 3, FEFF],
        [17, 4, `${FEFF}e`],
        [21, 2, "nd"],
      ]);
    } finally {
      again.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
