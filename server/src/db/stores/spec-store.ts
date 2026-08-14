/** spec_revisions — the living specification's append-only revision history. */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { specRevisions } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type SpecRevisionRow = typeof specRevisions.$inferSelect;

export class SpecStore {
  readonly #db: Db;
  readonly #sqlite: { transaction<T>(fn: () => T): () => T };

  constructor(db: Db, sqlite: { transaction<T>(fn: () => T): () => T }) {
    this.#db = db;
    this.#sqlite = sqlite;
  }

  get(id: string): SpecRevisionRow | undefined {
    return this.#db.select().from(specRevisions).where(eq(specRevisions.id, id)).get();
  }

  listForUserSession(userSessionId: string): SpecRevisionRow[] {
    return this.#db.select().from(specRevisions)
      .where(eq(specRevisions.userSessionId, userSessionId))
      .orderBy(specRevisions.revision).all();
  }

  latestApproved(userSessionId: string): SpecRevisionRow | undefined {
    return this.#db.select().from(specRevisions)
      .where(and(eq(specRevisions.userSessionId, userSessionId), eq(specRevisions.status, "approved")))
      .orderBy(desc(specRevisions.revision)).get();
  }

  nextRevision(userSessionId: string): number {
    const latest = this.#db.select().from(specRevisions)
      .where(eq(specRevisions.userSessionId, userSessionId))
      .orderBy(desc(specRevisions.revision)).get();
    return (latest?.revision ?? 0) + 1;
  }

  insertDraft(input: { userSessionId: string; document: string; changeNote?: string | null }): SpecRevisionRow {
    const row: SpecRevisionRow = {
      id: newId("spec"),
      userSessionId: input.userSessionId,
      revision: this.nextRevision(input.userSessionId),
      document: input.document,
      changeNote: input.changeNote ?? null,
      status: "draft",
      origin: "main",
      interactionId: null,
      createdAt: nowIso(),
      approvedAt: null,
    };
    this.#db.insert(specRevisions).values(row).run();
    return row;
  }

  /**
   * Approves one revision (with the operator's final text) and supersedes the
   * previous approved one in ONE transaction: a crash between the two writes
   * must never leave the session with zero approved revisions — digest()
   * would render empty and every prompt would silently lose the spec.
   */
  approve(id: string, input: { document: string; edited: boolean; interactionId?: string | null }): SpecRevisionRow {
    return this.#sqlite.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error(`no spec revision ${id}`);
      const previous = this.latestApproved(row.userSessionId);
      if (previous && previous.id !== id) {
        this.#db.update(specRevisions).set({ status: "superseded" }).where(eq(specRevisions.id, previous.id)).run();
      }
      this.#db.update(specRevisions).set({
        document: input.document,
        status: "approved",
        origin: input.edited ? "operator_edited" : "main",
        interactionId: input.interactionId ?? null,
        approvedAt: nowIso(),
      }).where(eq(specRevisions.id, id)).run();
      return this.get(id)!;
    })();
  }

  reject(id: string): void {
    this.#db.update(specRevisions).set({ status: "rejected" }).where(eq(specRevisions.id, id)).run();
  }
}
