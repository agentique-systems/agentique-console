/**
 * worktree_landings — persistence for canonical-landing truth.
 *
 * Split of labor with LandingLedger (workspaces/landings.ts): the SERVICE
 * asks git whether a landed merge commit is still reachable and journals the
 * transitions; this store applies row operations. `landedAt`/`mergeCommit`
 * are the immutable historical fact; `invalidatedAt` (+ reason + salvage
 * ref) is the current-truth marker the ledger flips both ways.
 */
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { worktreeLandings } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type WorktreeLandingRow = typeof worktreeLandings.$inferSelect;

export class LandingStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: {
    userSessionId: string;
    agentSessionId: string;
    agent: string;
    branch: string;
    baseCommit: string;
    mergeCommit: string;
    filesChanged: number;
    artifactId: string | null;
  }): WorktreeLandingRow {
    const row: WorktreeLandingRow = {
      id: newId("land"),
      ...input,
      landedAt: nowIso(),
      invalidatedAt: null,
      invalidatedReason: null,
      salvageRef: null,
    };
    this.#db.insert(worktreeLandings).values(row).run();
    return row;
  }

  get(id: string): WorktreeLandingRow | undefined {
    return this.#db.select().from(worktreeLandings).where(eq(worktreeLandings.id, id)).get();
  }

  listByUserSession(userSessionId: string): WorktreeLandingRow[] {
    return this.#db.select().from(worktreeLandings)
      .where(eq(worktreeLandings.userSessionId, userSessionId))
      .orderBy(worktreeLandings.landedAt).all();
  }

  /** Landings currently held as reachable — the ones verification re-asks git about. */
  listCurrent(userSessionId: string): WorktreeLandingRow[] {
    return this.#db.select().from(worktreeLandings)
      .where(and(eq(worktreeLandings.userSessionId, userSessionId), isNull(worktreeLandings.invalidatedAt)))
      .orderBy(worktreeLandings.landedAt).all();
  }

  /** Landings whose merge commit is currently NOT reachable from workspace HEAD. */
  listInvalidated(userSessionId: string): WorktreeLandingRow[] {
    return this.#db.select().from(worktreeLandings)
      .where(and(eq(worktreeLandings.userSessionId, userSessionId), isNotNull(worktreeLandings.invalidatedAt)))
      .orderBy(worktreeLandings.landedAt).all();
  }

  invalidate(id: string, reason: string, salvageRef: string | null): void {
    this.#db.update(worktreeLandings)
      .set({ invalidatedAt: nowIso(), invalidatedReason: reason, salvageRef })
      .where(eq(worktreeLandings.id, id)).run();
  }

  /** Reachability came back (reset undone, salvage re-merged): current truth recovers. The salvage ref stays recorded. */
  restore(id: string): void {
    this.#db.update(worktreeLandings)
      .set({ invalidatedAt: null, invalidatedReason: null })
      .where(eq(worktreeLandings.id, id)).run();
  }
}
