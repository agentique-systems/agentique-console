/** usage_samples — one row per settled provider turn. */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { usageSamples } from "../schema.ts";

export type UsageSampleRow = typeof usageSamples.$inferSelect;

export class UsageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insertUsage(row: UsageSampleRow): void { this.#db.insert(usageSamples).values(row).run(); }
  listUsage(userSessionId: string): UsageSampleRow[] { return this.#db.select().from(usageSamples).where(eq(usageSamples.userSessionId, userSessionId)).orderBy(asc(usageSamples.createdAt)).all(); }

  /**
   * Lifetime totals per participant, ACROSS generations. The `agents` row
   * columns are per-provider-session watermarks that reset on every rotation
   * — a live run's forensics summed them to $28 against a true $308. Readers
   * that want "what did this seat cost" must come here.
   */
  aggregateByParticipant(agentSessionId: string): Map<string, { costUsd: number; turns: number; outputTokens: number }> {
    const rows = this.#db.select().from(usageSamples).where(eq(usageSamples.agentSessionId, agentSessionId)).all();
    const totals = new Map<string, { costUsd: number; turns: number; outputTokens: number }>();
    for (const row of rows) {
      const entry = totals.get(row.participant) ?? { costUsd: 0, turns: 0, outputTokens: 0 };
      entry.costUsd += row.costUsd ?? 0;
      entry.turns += 1;
      entry.outputTokens += row.outputTokens;
      totals.set(row.participant, entry);
    }
    return totals;
  }
}
