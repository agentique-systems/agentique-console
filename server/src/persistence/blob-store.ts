import { createHash } from "node:crypto";
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
  /** False when identical bytes were already stored and were reused. */
  written: boolean;
}

/**
 * Content-addressed storage for Artifact bytes. Blobs are keyed by SHA-256
 * digest, so identical content is stored once; a read verifies the digest
 * before returning bytes.
 */
export interface BlobStore {
  put(bytes: Uint8Array): BlobWrite;
  has(digest: string): boolean;
  /** Bytes for `digest`; throws `BlobMissingError` or `BlobCorruptedError`. */
  get(digest: string): Uint8Array;
}

const DIGEST = /^[0-9a-f]{64}$/;

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new TypeError(`not a SHA-256 hex digest: ${digest}`);
}

/**
 * Blobs on disk as `<root>/<first two hex chars>/<digest>`, written to a
 * temporary file and renamed into place so a reader never sees a partial
 * blob and a repeated write of existing content is a no-op.
 */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(digest: string): string {
    return path.join(this.root, digest.slice(0, 2), digest);
  }

  put(bytes: Uint8Array): BlobWrite {
    const digest = sha256Hex(bytes);
    const target = this.pathFor(digest);
    if (fs.existsSync(target)) {
      return { digest, byteSize: bytes.byteLength, written: false };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, bytes);
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      // A concurrent writer of the same content won the rename; that is fine.
      if (fs.existsSync(target)) return { digest, byteSize: bytes.byteLength, written: false };
      throw error;
    }
    return { digest, byteSize: bytes.byteLength, written: true };
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
}

/** An in-memory store for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): BlobWrite {
    const digest = sha256Hex(bytes);
    if (this.#blobs.has(digest)) return { digest, byteSize: bytes.byteLength, written: false };
    this.#blobs.set(digest, Uint8Array.from(bytes));
    return { digest, byteSize: bytes.byteLength, written: true };
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

  /** Test hook: overwrite stored bytes without touching the key. */
  corrupt(digest: string, bytes: Uint8Array): void {
    this.#blobs.set(digest, bytes);
  }

  delete(digest: string): void {
    this.#blobs.delete(digest);
  }
}
