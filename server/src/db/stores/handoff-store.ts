/** handoff_records — the lossless handoff ledger. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { agents, handoffRecords, userSessions } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type HandoffRecordRow = typeof handoffRecords.$inferSelect;

export class HandoffStore {
  readonly #db: Db;
  readonly #sqlite: { transaction<T>(fn: () => T): () => T };

  constructor(db: Db, sqlite: { transaction<T>(fn: () => T): () => T }) {
    this.#db = db;
    this.#sqlite = sqlite;
  }

  /**
   * A checkpoint has no message anchor, so the latest-handoff pointer bump
   * rides this insert's transaction. The branch is structural, not a domain
   * sentinel: a null agentSessionId IS the main lane's checkpoint.
   */
  insertCheckpointHandoff(row: HandoffRecordRow): void {
    this.#sqlite.transaction(() => {
      this.#db.insert(handoffRecords).values(row).run();
      if (row.agentSessionId === null) {
        this.#db.update(userSessions).set({ latestHandoffId: row.id, updatedAt: nowIso() }).where(eq(userSessions.id, row.userSessionId)).run();
      } else {
        this.#db.update(agents).set({ latestHandoffId: row.id }).where(and(
          eq(agents.agentSessionId, row.agentSessionId),
          eq(agents.name, row.recipient),
        )).run();
      }
    })();
  }

  getHandoff(id: string): HandoffRecordRow | undefined {
    return this.#db.select().from(handoffRecords).where(eq(handoffRecords.id, id)).get();
  }

  /**
   * `recipient` matches the RECIPIENT — "the last handoff addressed to X".
   * `sender` matches the AUTHOR — "the last thing X itself reported". Rotation
   * recovery must use `sender`: an agent's inheritance is its own last report,
   * never the last message someone else sent it.
   */
  latestHandoff(input: { userSessionId: string; agentSessionId?: string | null; recipient?: string; sender?: string; excludeCheckpoints?: boolean; excludeSynthetic?: boolean }): HandoffRecordRow | undefined {
    const filters = [eq(handoffRecords.userSessionId, input.userSessionId)];
    if (input.agentSessionId === null) filters.push(sql`${handoffRecords.agentSessionId} is null`);
    else if (input.agentSessionId !== undefined) filters.push(eq(handoffRecords.agentSessionId, input.agentSessionId));
    if (input.recipient !== undefined) filters.push(eq(handoffRecords.recipient, input.recipient));
    if (input.sender !== undefined) filters.push(eq(handoffRecords.sender, input.sender));
    if (input.excludeCheckpoints === true) filters.push(eq(handoffRecords.checkpoint, false));
    // Console-authored (synthetic) notices are not reports.
    if (input.excludeSynthetic === true) filters.push(eq(handoffRecords.synthetic, false));
    // rowid breaks createdAt ties: handoffs written in the same millisecond are
    // ordinary (an ack and its follow-up), and "latest" must not be a coin flip
    // when a rotation checkpoint depends on it.
    return this.#db.select().from(handoffRecords).where(and(...filters))
      .orderBy(desc(handoffRecords.createdAt), desc(sql`rowid`)).get();
  }

  /** Same filters as latestHandoff, EVERY row, oldest first — the commission read-model needs "the FIRST", not "the latest". */
  listHandoffs(input: Parameters<HandoffStore["latestHandoff"]>[0]): HandoffRecordRow[] {
    const filters = [eq(handoffRecords.userSessionId, input.userSessionId)];
    if (input.agentSessionId === null) filters.push(sql`${handoffRecords.agentSessionId} is null`);
    else if (input.agentSessionId !== undefined) filters.push(eq(handoffRecords.agentSessionId, input.agentSessionId));
    if (input.recipient !== undefined) filters.push(eq(handoffRecords.recipient, input.recipient));
    if (input.sender !== undefined) filters.push(eq(handoffRecords.sender, input.sender));
    if (input.excludeCheckpoints === true) filters.push(eq(handoffRecords.checkpoint, false));
    if (input.excludeSynthetic === true) filters.push(eq(handoffRecords.synthetic, false));
    return this.#db.select().from(handoffRecords).where(and(...filters))
      .orderBy(handoffRecords.createdAt, sql`rowid`).all();
  }
}
