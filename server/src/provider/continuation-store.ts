import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The adapter-owned, replaceable store for opaque provider continuation
 * payloads. The canonical database holds only an index row per Attempt
 * (`provider_continuations`: storage key, digest, times); the bytes live
 * here and may be deleted at any time. A missing, expired, or
 * digest-mismatched payload means the Attempt starts fresh.
 *
 * Payloads never enter Events, logs, Context Manifests, Artifacts, or API
 * response types; this interface is the only way to reach them.
 */
export interface ContinuationPayloadStore {
  /** Stores `bytes` under `storageKey` and returns their SHA-256 hex digest. */
  put(storageKey: string, bytes: Uint8Array): Promise<string>;
  /** The bytes under `storageKey`, or `null` when absent. */
  get(storageKey: string): Promise<Uint8Array | null>;
  /** Removes one payload; a missing key is not an error. */
  delete(storageKey: string): Promise<void>;
  /** Removes every payload. */
  truncate(): Promise<void>;
}

export const CONTINUATION_DIGEST_ALGORITHM = "sha256";

const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/;

/** Storage keys are opaque but bounded: no traversal segments, no absolute paths, no control characters. */
export function assertStorageKey(storageKey: string): void {
  if (!STORAGE_KEY.test(storageKey) || storageKey.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("invalid continuation storage key");
  }
}

/**
 * A file-backed payload store for adapters that keep continuations across
 * process restarts. Payloads live as `<root>/<first two hex>/<sha256 of key>`
 * so a key never becomes a path; bytes are written to a per-process unique
 * temporary file and renamed into place so a reader never observes a partial
 * payload. Nothing here verifies content — the continuation index carries
 * the digest and the resolving service checks it — and every operation
 * tolerates a payload that was deleted meanwhile.
 */
export class FileContinuationPayloadStore implements ContinuationPayloadStore {
  #counter = 0;

  constructor(
    private readonly root: string,
    private readonly digestOf: (bytes: Uint8Array) => string,
  ) {}

  private pathFor(storageKey: string): string {
    assertStorageKey(storageKey);
    const name = createHash("sha256").update(storageKey).digest("hex");
    return path.join(this.root, name.slice(0, 2), name);
  }

  async put(storageKey: string, bytes: Uint8Array): Promise<string> {
    const target = this.pathFor(storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    this.#counter += 1;
    const temp = `${target}.${process.pid}.${this.#counter}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return this.digestOf(bytes);
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.pathFor(storageKey)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(this.pathFor(storageKey), { force: true });
  }

  async truncate(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

/**
 * An in-memory implementation for tests and for adapters that do not
 * persist continuations across process restarts.
 */
export class MemoryContinuationPayloadStore implements ContinuationPayloadStore {
  readonly #payloads = new Map<string, Uint8Array>();

  constructor(private readonly digestOf: (bytes: Uint8Array) => string) {}

  async put(storageKey: string, bytes: Uint8Array): Promise<string> {
    this.#payloads.set(storageKey, Uint8Array.from(bytes));
    return this.digestOf(bytes);
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    const bytes = this.#payloads.get(storageKey);
    return bytes ? Uint8Array.from(bytes) : null;
  }

  async delete(storageKey: string): Promise<void> {
    this.#payloads.delete(storageKey);
  }

  async truncate(): Promise<void> {
    this.#payloads.clear();
  }

  get size(): number {
    return this.#payloads.size;
  }
}
