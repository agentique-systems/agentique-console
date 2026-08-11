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
}
