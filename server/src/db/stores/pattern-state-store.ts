/** pattern_state — the pattern engine's per-session counters and joins. */
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { patternState } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type PatternStateRow = typeof patternState.$inferSelect;

export class PatternStateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  getPatternState(agentSessionId: string): PatternStateRow | undefined {
    return this.#db.select().from(patternState).where(eq(patternState.agentSessionId, agentSessionId)).get();
  }

  /** Creates the row on first touch; merges the patch into the existing one after. */
  upsertPatternState(agentSessionId: string, patch: Partial<Omit<PatternStateRow, "agentSessionId" | "createdAt" | "updatedAt">>): PatternStateRow {
    const now = nowIso();
    const existing = this.getPatternState(agentSessionId);
    if (!existing) {
      const row: PatternStateRow = {
        agentSessionId, rounds: 0, handoffCount: 0, lastProgressAt: null,
        recentEdges: [], joins: {}, tripped: null, createdAt: now, updatedAt: now,
        ...patch,
      };
      this.#db.insert(patternState).values(row).run();
      return row;
    }
    this.#db.update(patternState).set({ ...patch, updatedAt: now }).where(eq(patternState.agentSessionId, agentSessionId)).run();
    return { ...existing, ...patch, updatedAt: now };
  }
}
