/** crons — console-owned schedules and one-shot deadlines. */
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crons } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type CronRow = typeof crons.$inferSelect;

export class CronStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insertCron(row: CronRow): void {
    this.#db.insert(crons).values(row).run();
  }

  /** Console-owned one-shot deadlines whose absolute time has arrived. */
  listDueDeadlines(userSessionId: string, nowIsoTime: string): CronRow[] {
    return this.#db.select().from(crons)
      .where(and(eq(crons.userSessionId, userSessionId), eq(crons.status, "active"), isNotNull(crons.dueAt)))
      .all()
      .filter((row) => row.dueAt !== null && row.dueAt <= nowIsoTime);
  }

  /** Console-owned deadlines not yet due — so wake prompts can say "this wake is not it". */
  listPendingDeadlines(userSessionId: string, nowIsoTime: string): CronRow[] {
    return this.#db.select().from(crons)
      .where(and(eq(crons.userSessionId, userSessionId), eq(crons.status, "active"), isNotNull(crons.dueAt)))
      .all()
      .filter((row) => row.dueAt !== null && row.dueAt > nowIsoTime);
  }

  patchCron(id: string, patch: Partial<Pick<CronRow, "schedule" | "prompt" | "status">>): void {
    this.#db.update(crons).set({ ...patch, updatedAt: nowIso() }).where(eq(crons.id, id)).run();
  }
}
