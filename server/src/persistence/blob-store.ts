import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class BlobMissingError extends Error {
  constructor(readonly digest: string) {
    super(`artifact content ${digest} is missing from the blob store`);
    this.name = "BlobMissingError";
  }
}

export class BlobCorruptedError extends Error {
  constructor(
    readonly digest: string,
    readonly actualDigest: string,
  ) {
    super(`artifact content ${digest} is corrupted (stored bytes hash to ${actualDigest})`);
    this.name = "BlobCorruptedError";
  }
}

export interface BlobWrite {
  digest: string;
  byteSize: number;
  /** False when identical, verified bytes were already stored and were reused. */
  written: boolean;
}

/**
 * Content-addressed storage for Artifact bytes. Blobs are keyed by SHA-256
 * digest, so identical content is stored once. `put` verifies existing
 * content before reusing it and `get` verifies content before returning
 * it; corrupted content is never silently accepted.
 */
export interface BlobStore {
  put(bytes: Uint8Array): BlobWrite;
  has(digest: string): boolean;
  /** Bytes for `digest`; throws `BlobMissingError` or `BlobCorruptedError`. */
  get(digest: string): Uint8Array;
  /**
   * Compensating removal, used only by persistence consistency handling to
   * discard a blob that `put` newly wrote when the metadata transaction it
   * belonged to failed and no committed Artifact references the digest.
   * Returns whether a blob was removed; a missing blob is not an error.
   */
  remove(digest: string): boolean;
}

const DIGEST = /^[0-9a-f]{64}$/;

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new TypeError(`not a SHA-256 hex digest: ${digest}`);
}

/** Throws `BlobCorruptedError` unless `stored` has the expected size and digest. */
function verifyStored(stored: Uint8Array, digest: string, expectedSize: number): void {
  const actual = sha256Hex(stored);
  if (actual !== digest || stored.byteLength !== expectedSize) {
    throw new BlobCorruptedError(digest, stored.byteLength === expectedSize ? actual : `${actual} (${stored.byteLength} bytes)`);
  }
}

let temporaryCounter = 0;

/**
 * Blobs on disk as `<root>/<first two hex chars>/<digest>`. Content is
 * written to a per-process-unique temporary file and renamed into place,
 * so a reader never observes a partial blob; the temporary file is removed
 * on every failure path. An existing target is read and verified before it
 * is reused, and a concurrent writer of the same digest is tolerated only
 * when the content it left behind verifies.
 */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(digest: string): string {
    return path.join(this.root, digest.slice(0, 2), digest);
  }

  private verifyExisting(target: string, digest: string, expectedSize: number): void {
    verifyStored(fs.readFileSync(target), digest, expectedSize);
  }

  put(bytes: Uint8Array): BlobWrite {
    const digest = sha256Hex(bytes);
    const byteSize = bytes.byteLength;
    const target = this.pathFor(digest);
    if (fs.existsSync(target)) {
      this.verifyExisting(target, digest, byteSize);
      return { digest, byteSize, written: false };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    temporaryCounter += 1;
    const temp = `${target}.${process.pid}.${temporaryCounter}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      // Another writer may have created the target meanwhile; reuse it only if it verifies.
      if (fs.existsSync(target)) {
        this.verifyExisting(target, digest, byteSize);
        return { digest, byteSize, written: false };
      }
      throw error;
    }
    return { digest, byteSize, written: true };
  }

  has(digest: string): boolean {
    assertDigest(digest);
    return fs.existsSync(this.pathFor(digest));
  }

  get(digest: string): Uint8Array {
    assertDigest(digest);
    const target = this.pathFor(digest);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BlobMissingError(digest);
      throw error;
    }
    const actual = sha256Hex(bytes);
    if (actual !== digest) throw new BlobCorruptedError(digest, actual);
    return bytes;
  }

  remove(digest: string): boolean {
    assertDigest(digest);
    const target = this.pathFor(digest);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    return true;
  }
}

/** An in-memory store for tests, with the same verification behaviour. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): BlobWrite {
    const digest = sha256Hex(bytes);
    const byteSize = bytes.byteLength;
    const existing = this.#blobs.get(digest);
    if (existing) {
      verifyStored(existing, digest, byteSize);
      return { digest, byteSize, written: false };
    }
    this.#blobs.set(digest, Uint8Array.from(bytes));
    return { digest, byteSize, written: true };
  }

  has(digest: string): boolean {
    assertDigest(digest);
    return this.#blobs.has(digest);
  }

  get(digest: string): Uint8Array {
    assertDigest(digest);
    const bytes = this.#blobs.get(digest);
    if (!bytes) throw new BlobMissingError(digest);
    const actual = sha256Hex(bytes);
    if (actual !== digest) throw new BlobCorruptedError(digest, actual);
    return Uint8Array.from(bytes);
  }

  remove(digest: string): boolean {
    assertDigest(digest);
    return this.#blobs.delete(digest);
  }

  get size(): number {
    return this.#blobs.size;
  }

  /** Test hook: overwrite stored bytes without touching the key. */
  corrupt(digest: string, bytes: Uint8Array): void {
    this.#blobs.set(digest, bytes);
  }
}
