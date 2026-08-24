/**
 * change_impacts — persistence for the change-impact ledger.
 *
 * Split of labor with ChangeImpactService: the SERVICE computes the affected
 * set, derives open/reconciled, and validates dispositions; this store applies
 * row operations. The (project, source_kind, source_ref) unique index is the
 * idempotency substrate: re-recording the same source event is a no-op that
 * returns the existing row.
 */
import { and, eq } from "drizzle-orm";
import type { ChangeImpactAffected, ChangeImpactDispositionEntry, ChangeImpactSourceKind } from "@agentique-console/shared";
import type { Db } from "../client.ts";
import { changeImpacts } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type ChangeImpactRow = typeof changeImpacts.$inferSelect;

export class ChangeImpactStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Insert one impact; the unique source index makes duplicates return the existing row. */
  insert(input: {
    projectId: string;
    userSessionId: string;
    sourceKind: ChangeImpactSourceKind;
    sourceRef: string;
    atRevision: number;
    computedAtOrd: number;
    note?: string | null;
    affected: ChangeImpactAffected;
  }): { row: ChangeImpactRow; inserted: boolean } {
    const now = nowIso();
    const row: ChangeImpactRow = {
      id: newId("chg"),
      projectId: input.projectId,
      userSessionId: input.userSessionId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      atRevision: input.atRevision,
      computedAtOrd: input.computedAtOrd,
      note: input.note ?? null,
      affected: input.affected,
      dispositions: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = this.#db.insert(changeImpacts).values(row).onConflictDoNothing().run();
    if (result.changes > 0) return { row, inserted: true };
    const existing = this.#db.select().from(changeImpacts)
      .where(and(
        eq(changeImpacts.projectId, input.projectId),
        eq(changeImpacts.sourceKind, input.sourceKind),
        eq(changeImpacts.sourceRef, input.sourceRef),
      )).get()!;
    return { row: existing, inserted: false };
  }

  get(id: string): ChangeImpactRow | undefined {
    return this.#db.select().from(changeImpacts).where(eq(changeImpacts.id, id)).get();
  }

  listByProject(projectId: string): ChangeImpactRow[] {
    return this.#db.select().from(changeImpacts)
      .where(eq(changeImpacts.projectId, projectId))
      .orderBy(changeImpacts.createdAt).all();
  }

  setDispositions(id: string, dispositions: ChangeImpactDispositionEntry[]): void {
    this.#db.update(changeImpacts)
      .set({ dispositions, updatedAt: nowIso() })
      .where(eq(changeImpacts.id, id)).run();
  }
}
