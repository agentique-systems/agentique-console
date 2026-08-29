/**
 * Provider continuation handling (execution-model §6.6): the adapter-owned
 * payload store plus the canonical `provider_continuations` index, composed
 * into one service that stores a payload for an Attempt and resolves a
 * verified payload for a possible `resumed` Attempt.
 *
 * Nothing here is canonical. A missing, expired, corrupt, or truncated
 * payload resolves to `null`, which the runtime reads as "start fresh"; the
 * payload bytes and storage keys never leave this module except as the
 * opaque `continuation` member of a provider request.
 */
import { createHash } from "node:crypto";
import type { AttemptId, Timestamp } from "@agentique-console/core";
import type { ProviderContinuationStore } from "../persistence/stores/continuations.ts";
import type { ContinuationPayloadStore } from "./continuation-store.ts";

export function continuationDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ContinuationServiceOptions {
  /** How long a stored payload stays resumable; `null` never expires. */
  ttlMs: number | null;
  clock: () => Timestamp;
}

export class ContinuationService {
  constructor(
    private readonly index: ProviderContinuationStore,
    private readonly payloads: ContinuationPayloadStore,
    private readonly options: ContinuationServiceOptions,
  ) {}

  /** Stores the opaque payload an Attempt's provider execution left behind and indexes it by Attempt. */
  async store(attemptId: AttemptId, provider: string, bytes: Uint8Array): Promise<void> {
    const storageKey = `${provider}/${attemptId}`;
    const digest = await this.payloads.put(storageKey, bytes);
    const now = this.options.clock();
    const expiresAt = this.options.ttlMs === null ? null : new Date(Date.parse(now) + this.options.ttlMs).toISOString();
    this.index.put({ attemptId, provider, storageKey, digest, expiresAt });
  }

  /** True when an unexpired index row exists for the Attempt; says nothing about the payload's presence. */
  indexed(attemptId: AttemptId, now: Timestamp = this.options.clock()): boolean {
    return this.index.get(attemptId, now) !== null;
  }

  /**
   * The verified payload bytes for `attemptId`, or `null` when the index row
   * is missing or expired, the payload is absent, or its bytes do not match
   * the recorded digest. A stale or mismatched entry is removed so it is not
   * consulted again.
   */
  async resolve(attemptId: AttemptId, provider: string, now: Timestamp = this.options.clock()): Promise<Uint8Array | null> {
    const continuation = this.index.get(attemptId, now);
    if (!continuation || continuation.provider !== provider) return null;
    const bytes = await this.payloads.get(continuation.storageKey);
    if (!bytes || continuationDigest(bytes) !== continuation.digest) {
      this.index.delete(attemptId);
      await this.payloads.delete(continuation.storageKey);
      return null;
    }
    return bytes;
  }

  /** Removes every index row and every payload; changes no Run's outcome. */
  async truncate(): Promise<void> {
    this.index.truncate();
    await this.payloads.truncate();
  }
}
