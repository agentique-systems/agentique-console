/**
 * The adapter-owned, replaceable store for opaque provider continuation
 * payloads. The canonical database holds only an index row per Attempt
 * (`provider_continuations`: storage key, digest, times); the bytes live
 * here and may be deleted at any time. A missing, expired, or
 * digest-mismatched payload is indistinguishable from "start fresh".
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
