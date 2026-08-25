/**
 * continuation_checkpoints — persistence for run-boundary continuation
 * checkpoints.
 *
 * Split of labor with ContinuationCheckpointService: the SERVICE derives the
 * facts and synthesis from the other aggregates' durable rows; this store
 * applies row operations. The unique source-session index is the idempotency
 * substrate: re-recording the same source session is a no-op that returns the
 * existing row — checkpoints are immutable once written.
 */
import { eq } from "drizzle-orm";
import type { ContinuationFacts, ContinuationSynthesis } from "@agentique-console/shared";
import type { Db } from "../client.ts";
import { continuationCheckpoints } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type ContinuationCheckpointRow = typeof continuationCheckpoints.$inferSelect;

export class ContinuationCheckpointStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Insert one checkpoint; the unique source index makes duplicates return the existing row. */
  insert(input: {
    projectId: string;
    sourceUserSessionId: string;
    atRevision: number;
    decisionCount: number;
    runState: ContinuationCheckpointRow["runState"];
    synthesis: ContinuationSynthesis | null;
    facts: ContinuationFacts;
  }): { row: ContinuationCheckpointRow; inserted: boolean } {
    const row: ContinuationCheckpointRow = {
      id: newId("ckpt"),
      projectId: input.projectId,
      sourceUserSessionId: input.sourceUserSessionId,
      atRevision: input.atRevision,
      decisionCount: input.decisionCount,
      runState: input.runState,
      synthesis: input.synthesis,
      facts: input.facts,
      createdAt: nowIso(),
    };
    const result = this.#db.insert(continuationCheckpoints).values(row).onConflictDoNothing().run();
    if (result.changes > 0) return { row, inserted: true };
    const existing = this.#db.select().from(continuationCheckpoints)
      .where(eq(continuationCheckpoints.sourceUserSessionId, input.sourceUserSessionId)).get()!;
    return { row: existing, inserted: false };
  }

  get(id: string): ContinuationCheckpointRow | undefined {
    return this.#db.select().from(continuationCheckpoints)
      .where(eq(continuationCheckpoints.id, id)).get();
  }

  getBySource(sourceUserSessionId: string): ContinuationCheckpointRow | undefined {
    return this.#db.select().from(continuationCheckpoints)
      .where(eq(continuationCheckpoints.sourceUserSessionId, sourceUserSessionId)).get();
  }

  /**
   * Every checkpoint in one project, insertion-ordered. Run order is the
   * SOURCE SESSION's creation order (a lazily backfilled checkpoint may be
   * INSERTED after a successor's) — the service orders by that join.
   */
  listByProject(projectId: string): ContinuationCheckpointRow[] {
    return this.#db.select().from(continuationCheckpoints)
      .where(eq(continuationCheckpoints.projectId, projectId))
      .orderBy(continuationCheckpoints.createdAt).all();
  }
}
