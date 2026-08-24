/**
 * workstream_links — persistence for project-portfolio dependency claims.
 *
 * Split of labor with WorkstreamService: the SERVICE validates endpoints,
 * derives each link's status from session facts, and journals; this store
 * applies row operations. The partial unique index on the live
 * (consumer, producer, subject) triple is the idempotency substrate:
 * re-declaring an identical live link returns the existing row.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { workstreamLinks } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type WorkstreamLinkRow = typeof workstreamLinks.$inferSelect;

export class WorkstreamStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Insert one link; the live-pair unique index makes duplicates return the existing live row. */
  insert(input: {
    projectId: string;
    userSessionId: string;
    consumerAgentSessionId: string;
    producerAgentSessionId: string;
    subject: string;
    createdBy: string;
    note?: string | null;
  }): { row: WorkstreamLinkRow; inserted: boolean } {
    const row: WorkstreamLinkRow = {
      id: newId("wl"),
      projectId: input.projectId,
      userSessionId: input.userSessionId,
      consumerAgentSessionId: input.consumerAgentSessionId,
      producerAgentSessionId: input.producerAgentSessionId,
      subject: input.subject,
      createdBy: input.createdBy,
      note: input.note ?? null,
      createdAt: nowIso(),
      releasedAt: null,
      releasedBy: null,
      releaseNote: null,
    };
    const result = this.#db.insert(workstreamLinks).values(row).onConflictDoNothing().run();
    if (result.changes > 0) return { row, inserted: true };
    const existing = this.#db.select().from(workstreamLinks)
      .where(and(
        eq(workstreamLinks.consumerAgentSessionId, input.consumerAgentSessionId),
        eq(workstreamLinks.producerAgentSessionId, input.producerAgentSessionId),
        eq(workstreamLinks.subject, input.subject),
        isNull(workstreamLinks.releasedAt),
      )).get()!;
    return { row: existing, inserted: false };
  }

  get(id: string): WorkstreamLinkRow | undefined {
    return this.#db.select().from(workstreamLinks).where(eq(workstreamLinks.id, id)).get();
  }

  listByProject(projectId: string): WorkstreamLinkRow[] {
    return this.#db.select().from(workstreamLinks)
      .where(eq(workstreamLinks.projectId, projectId))
      .orderBy(workstreamLinks.createdAt).all();
  }

  /** Live (unreleased) links whose producer is the given session. */
  listLiveByProducer(producerAgentSessionId: string): WorkstreamLinkRow[] {
    return this.#db.select().from(workstreamLinks)
      .where(and(
        eq(workstreamLinks.producerAgentSessionId, producerAgentSessionId),
        isNull(workstreamLinks.releasedAt),
      ))
      .orderBy(workstreamLinks.createdAt).all();
  }

  release(id: string, by: string, note: string): void {
    this.#db.update(workstreamLinks)
      .set({ releasedAt: nowIso(), releasedBy: by, releaseNote: note })
      .where(eq(workstreamLinks.id, id)).run();
  }
}
