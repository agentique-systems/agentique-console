import { eq, lte } from "drizzle-orm";
import {
  isContinuationExpired,
  parseOrThrow,
  providerContinuationSchema,
  type AttemptId,
  type ProviderContinuation,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { attempts, providerContinuations } from "../schema.ts";
import { requireRow } from "./support.ts";

function toDomain(row: typeof providerContinuations.$inferSelect): ProviderContinuation {
  return parseOrThrow(providerContinuationSchema, row, "ProviderContinuation row");
}

export interface ProviderContinuationInput {
  attemptId: AttemptId;
  provider: string;
  storageKey: string;
  digest: string;
  expiresAt: string | null;
}

/**
 * The non-canonical continuation index. Rows are pointers owned by the
 * provider adapter; they are not journaled, never appear in Events, and may
 * be truncated at any time. Missing, expired, and digest-mismatched entries
 * all resolve to `null`, which the future runtime reads as "start fresh".
 */
export class ProviderContinuationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  put(input: ProviderContinuationInput): ProviderContinuation {
    return this.ctx.tx.write(() => {
      requireRow(this.ctx.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, input.attemptId)).get(), "Attempt", input.attemptId);
      const row: ProviderContinuation = { ...input, createdAt: this.ctx.clock() };
      parseOrThrow(providerContinuationSchema, row, "ProviderContinuation");
      this.ctx.db
        .insert(providerContinuations)
        .values(row)
        .onConflictDoUpdate({
          target: providerContinuations.attemptId,
          set: { provider: row.provider, storageKey: row.storageKey, digest: row.digest, createdAt: row.createdAt, expiresAt: row.expiresAt },
        })
        .run();
      return row;
    });
  }

  /** The index row, or `null` when absent or expired at `now`. */
  get(attemptId: AttemptId, now = this.ctx.clock()): ProviderContinuation | null {
    const row = this.ctx.db.select().from(providerContinuations).where(eq(providerContinuations.attemptId, attemptId)).get();
    if (!row) return null;
    const continuation = toDomain(row);
    return isContinuationExpired(continuation, now) ? null : continuation;
  }

  delete(attemptId: AttemptId): void {
    this.ctx.tx.write(() => {
      this.ctx.db.delete(providerContinuations).where(eq(providerContinuations.attemptId, attemptId)).run();
    });
  }

  deleteExpired(now = this.ctx.clock()): number {
    return this.ctx.tx.write(() => this.ctx.db.delete(providerContinuations).where(lte(providerContinuations.expiresAt, now)).run().changes);
  }

  truncate(): void {
    this.ctx.tx.write(() => {
      this.ctx.db.delete(providerContinuations).run();
    });
  }

  count(): number {
    return this.ctx.db.select({ attemptId: providerContinuations.attemptId }).from(providerContinuations).all().length;
  }
}
