import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FailureKind } from "@agentique-console/core";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class BlobMissingError extends Error {
  /** The closed kind a diagnostic reports for this failure (`failureKindOf`). */
  readonly failureKind: FailureKind = "storage:content_missing";

  constructor(readonly digest: string) {
    super(`artifact content ${digest} is missing from the blob store`);
    this.name = "BlobMissingError";
  }
}

export class BlobCorruptedError extends Error {
  /** The closed kind a diagnostic reports for this failure (`failureKindOf`). */
  readonly failureKind: FailureKind = "storage:content_corrupt";

  constructor(
    readonly digest: string,
    readonly actualDigest: string,
  ) {
    super(`artifact content ${digest} is corrupted (stored bytes hash to ${actualDigest})`);
    this.name = "BlobCorruptedError";
  }
}

/**
 * A path the store owns is not what the protocol expects (a symlink, a
 * directory, or another non-regular entry where a marker, temporary file,
 * blob, shard directory, or the pending directory itself should be). The
 * store never follows, removes, or writes through such an entry. The
 * message names the entry's protocol role and safe identifier only, never
 * a filesystem path.
 */
export class BlobUnsafeEntryError extends Error {
  /** The closed kind a diagnostic reports for this failure (`failureKindOf`). */
  readonly failureKind: FailureKind = "storage:unsafe_entry";

  constructor(
    readonly role: "pending_directory" | "shard_directory" | "marker" | "temporary" | "blob",
    readonly entry: string,
  ) {
    super(`blob store ${role} ${entry} is not a regular ${role.endsWith("directory") ? "directory" : "file"}`);
    this.name = "BlobUnsafeEntryError";
  }
}

export interface BlobWrite {
  digest: string;
  byteSize: number;
  /** False when identical, verified bytes were already stored and were reused. */
  written: boolean;
  /**
   * True when this call published a pending marker for the digest: it found
   * no blob and prepared to publish one, whether it then wrote the blob or
   * reused content that appeared meanwhile. The caller's transaction owns
   * the marker's removal (`clearPending`) once its outcome is settled; a
   * reuse of an already present blob publishes no marker.
   */
  pending: boolean;
}

/** One entry of the store's private pending area, as reconciliation sees it; names are protocol-formed or sanitized, never paths. */
export type PendingEntry =
  /** A pending marker: a blob of this digest may have been published by a transaction that has not cleared it. */
  | { kind: "marker"; digest: string }
  /** A protocol temporary file of a write that did not reach its rename; never referenced by any row. */
  | { kind: "temporary"; digest: string; name: string }
  /** A protocol-named entry that is not a regular file (a symlink, a directory); never removed, always reported. */
  | { kind: "unsafe"; entry: string }
  /** An entry the protocol did not create; never removed, always reported. */
  | { kind: "unrecognized"; entry: string };

/**
 * Content-addressed storage for Artifact bytes. Blobs are keyed by SHA-256
 * digest, so identical content is stored once. `put` verifies existing
 * content before reusing it and `get` verifies content before returning
 * it; corrupted content is never silently accepted.
 *
 * Pending-write protocol. Before a blob of a digest that is not yet stored
 * is published, `put` records a **pending marker** for the digest in the
 * store's private pending area; the marker is storage housekeeping, not a
 * domain object, and it names nothing but the digest. The transaction that
 * owns the write clears the marker (`clearPending`) once it has committed
 * or compensated, so a marker that survives a process names a digest whose
 * blob may be unreferenced. Startup reconciliation (`listPending`, the
 * reference check, `remove`, `removeTemporary`, `clearPending`) resolves
 * every surviving entry under the exclusive ownership of one process.
 */
export interface BlobStore {
  put(bytes: Uint8Array): BlobWrite;
  has(digest: string): boolean;
  /** Bytes for `digest`; throws `BlobMissingError` or `BlobCorruptedError`. */
  get(digest: string): Uint8Array;
  /**
   * Compensating removal, used only by persistence consistency handling
   * (rollback compensation and startup reconciliation) to discard a blob
   * the protocol published when no committed Artifact references the
   * digest. Removes a regular file only; throws `BlobUnsafeEntryError` for
   * anything else at the blob's or its shard's path. Returns whether a blob
   * was removed; a missing blob is not an error.
   */
  remove(digest: string): boolean;
  /** Publishes the pending marker for `digest` (idempotent). `put` calls this itself before writing; exposed for reconciliation fixtures. */
  markPending(digest: string): void;
  /** Removes the pending marker for `digest`; returns whether one existed. Throws `BlobUnsafeEntryError` for a non-regular entry. */
  clearPending(digest: string): boolean;
  /** Every entry of the pending area, deterministically ordered; throws `BlobUnsafeEntryError` when the area itself is unsafe. */
  listPending(): PendingEntry[];
  /** Removes one recognized protocol temporary file by its validated name; returns whether it existed. */
  removeTemporary(name: string): boolean;
}

const DIGEST = /^[0-9a-f]{64}$/;
/** `<digest>.<pid>.<counter>.<uuid>.tmp`: the only temporary-file shape the protocol creates or removes. */
const TEMPORARY = /^([0-9a-f]{64})\.\d{1,10}\.\d{1,20}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const PENDING_DIRECTORY = ".pending";
/** Bounded, character-restricted identifier of a foreign entry name for a report; never the name as found. */
const SAFE_ENTRY_ID_LIMIT = 96;

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new TypeError(`not a SHA-256 hex digest: ${digest}`);
}

function assertTemporaryName(name: string): string {
  const match = TEMPORARY.exec(name);
  if (match === null) throw new TypeError("not a protocol temporary-file name");
  return match[1]!;
}

function safeEntryId(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, SAFE_ENTRY_ID_LIMIT);
}

/** Throws `BlobCorruptedError` unless `stored` has the expected size and digest. */
function verifyStored(stored: Uint8Array, digest: string, expectedSize: number): void {
  const actual = sha256Hex(stored);
  if (actual !== digest || stored.byteLength !== expectedSize) {
    throw new BlobCorruptedError(digest, stored.byteLength === expectedSize ? actual : `${actual} (${stored.byteLength} bytes)`);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

let temporaryCounter = 0;

/**
 * Blobs on disk as `<root>/<first two hex chars>/<digest>`, with the
 * private pending area at `<root>/.pending/`: the marker of a digest is the
 * empty regular file `<root>/.pending/<digest>` (its name is its whole
 * meaning) and every temporary file of an in-flight write is
 * `<root>/.pending/<digest>.<pid>.<counter>.<uuid>.tmp`, renamed into its
 * shard once complete, so a reader never observes a partial blob and every
 * in-flight file lives under the one directory reconciliation enumerates.
 * An existing target is read and verified before it is reused, and a
 * concurrent writer of the same digest is tolerated only when the content
 * it left behind verifies.
 *
 * The root is the owning process's configured directory. Inside it the store
 * refuses to write through, remove, or enumerate anything but regular files
 * and regular directories at the paths the protocol computes from a
 * validated digest or temporary name: a symlink or foreign entry at the
 * pending directory, a shard directory, a marker, a temporary file, or a
 * blob is reported, never followed. Nothing here calls `fsync`: the
 * ordering holds for abrupt process termination (every returned operation
 * has reached the kernel), not for power loss.
 */
export class FileBlobStore implements BlobStore {
  private readonly pendingDir: string;

  constructor(private readonly root: string) {
    this.pendingDir = path.join(root, PENDING_DIRECTORY);
  }

  private pathFor(digest: string): string {
    return path.join(this.root, digest.slice(0, 2), digest);
  }

  private markerFor(digest: string): string {
    return path.join(this.pendingDir, digest);
  }

  /** `lstat` of an owned path, or `null` when absent; never follows a symlink. */
  private entryAt(target: string): fs.Stats | null {
    try {
      return fs.lstatSync(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Creates the directory when absent and refuses anything but a regular directory at its path. */
  private ensureDirectory(dir: string, role: "pending_directory" | "shard_directory", entry: string): void {
    const existing = this.entryAt(dir);
    if (existing === null) fs.mkdirSync(dir, { recursive: true });
    else if (!existing.isDirectory()) throw new BlobUnsafeEntryError(role, entry);
    // A path that appeared as a directory through a symlink is refused too.
    const created = this.entryAt(dir);
    if (created === null || !created.isDirectory()) throw new BlobUnsafeEntryError(role, entry);
  }

  /** The directory when it is a regular directory, `null` when absent; refuses a symlink or a file at its path. */
  private directoryIfPresent(dir: string, role: "pending_directory" | "shard_directory", entry: string): boolean {
    const existing = this.entryAt(dir);
    if (existing === null) return false;
    if (!existing.isDirectory()) throw new BlobUnsafeEntryError(role, entry);
    return true;
  }

  /** Removes the regular file at an owned path; `false` when absent; refuses anything else. */
  private unlinkRegular(target: string, role: "marker" | "temporary" | "blob", entry: string): boolean {
    const existing = this.entryAt(target);
    if (existing === null) return false;
    if (!existing.isFile()) throw new BlobUnsafeEntryError(role, entry);
    fs.unlinkSync(target);
    return true;
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
      return { digest, byteSize, written: false, pending: false };
    }
    // The marker exists before any byte of a new blob does; the temporary file lives beside it.
    this.markPending(digest);
    temporaryCounter += 1;
    const temp = path.join(this.pendingDir, `${digest}.${process.pid}.${temporaryCounter}.${randomUUID()}.tmp`);
    try {
      this.ensureDirectory(path.dirname(target), "shard_directory", digest.slice(0, 2));
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
    } catch (error) {
      let failure: unknown = error;
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // A temporary file that cannot be removed now is a recognized protocol entry; reconciliation removes it.
      }
      // Another writer may have created the target meanwhile; reuse it only if it verifies. The marker stays with the caller.
      if (fs.existsSync(target)) {
        try {
          this.verifyExisting(target, digest, byteSize);
          return { digest, byteSize, written: false, pending: true };
        } catch (verifyError) {
          failure = verifyError;
        }
      }
      // Nothing was published: the marker this call created is withdrawn best-effort (a marker that stays is resolved by reconciliation).
      try {
        this.clearPending(digest);
      } catch {
        // Reported by the next reconciliation as an unreferenced digest with no blob.
      }
      throw failure;
    }
    return { digest, byteSize, written: true, pending: true };
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
      if (isMissing(error)) throw new BlobMissingError(digest);
      throw error;
    }
    const actual = sha256Hex(bytes);
    if (actual !== digest) throw new BlobCorruptedError(digest, actual);
    return bytes;
  }

  remove(digest: string): boolean {
    assertDigest(digest);
    const target = this.pathFor(digest);
    if (!this.directoryIfPresent(path.dirname(target), "shard_directory", digest.slice(0, 2))) return false;
    return this.unlinkRegular(target, "blob", digest);
  }

  markPending(digest: string): void {
    assertDigest(digest);
    this.ensureDirectory(this.pendingDir, "pending_directory", PENDING_DIRECTORY);
    const marker = this.markerFor(digest);
    const existing = this.entryAt(marker);
    if (existing !== null) {
      if (!existing.isFile()) throw new BlobUnsafeEntryError("marker", digest);
      return;
    }
    // Exclusive creation: the marker is never written through an entry that appeared meanwhile.
    fs.closeSync(fs.openSync(marker, "wx"));
  }

  clearPending(digest: string): boolean {
    assertDigest(digest);
    if (!this.directoryIfPresent(this.pendingDir, "pending_directory", PENDING_DIRECTORY)) return false;
    return this.unlinkRegular(this.markerFor(digest), "marker", digest);
  }

  listPending(): PendingEntry[] {
    if (!this.directoryIfPresent(this.pendingDir, "pending_directory", PENDING_DIRECTORY)) return [];
    const entries: PendingEntry[] = [];
    for (const entry of fs.readdirSync(this.pendingDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (DIGEST.test(entry.name)) entries.push(entry.isFile() ? { kind: "marker", digest: entry.name } : { kind: "unsafe", entry: entry.name });
      else if (TEMPORARY.test(entry.name)) entries.push(entry.isFile() ? { kind: "temporary", digest: entry.name.slice(0, 64), name: entry.name } : { kind: "unsafe", entry: entry.name });
      else entries.push({ kind: "unrecognized", entry: safeEntryId(entry.name) });
    }
    return entries;
  }

  removeTemporary(name: string): boolean {
    assertTemporaryName(name);
    if (!this.directoryIfPresent(this.pendingDir, "pending_directory", PENDING_DIRECTORY)) return false;
    return this.unlinkRegular(path.join(this.pendingDir, name), "temporary", name);
  }
}

/** An in-memory store for tests, with the same verification behaviour and the same marker protocol over an in-memory pending set. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #pending = new Set<string>();

  put(bytes: Uint8Array): BlobWrite {
    const digest = sha256Hex(bytes);
    const byteSize = bytes.byteLength;
    const existing = this.#blobs.get(digest);
    if (existing) {
      verifyStored(existing, digest, byteSize);
      return { digest, byteSize, written: false, pending: false };
    }
    this.markPending(digest);
    this.#blobs.set(digest, Uint8Array.from(bytes));
    return { digest, byteSize, written: true, pending: true };
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

  markPending(digest: string): void {
    assertDigest(digest);
    this.#pending.add(digest);
  }

  clearPending(digest: string): boolean {
    assertDigest(digest);
    return this.#pending.delete(digest);
  }

  listPending(): PendingEntry[] {
    return [...this.#pending].sort().map((digest) => ({ kind: "marker", digest }));
  }

  removeTemporary(name: string): boolean {
    assertTemporaryName(name);
    return false;
  }

  get size(): number {
    return this.#blobs.size;
  }

  /** Test hook: the digests whose markers are pending, sorted. */
  pendingDigests(): string[] {
    return [...this.#pending].sort();
  }

  /** Test hook: overwrite stored bytes without touching the key. */
  corrupt(digest: string, bytes: Uint8Array): void {
    this.#blobs.set(digest, bytes);
  }
}
