/**
 * projects — the durable identity a requirement graph, its ids, and the
 * decision ledger belong to. A UserSession attaches to exactly one project at
 * creation; continuation is sequential (one open session per project), which
 * the session service enforces at attach time.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { projects } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type ProjectRow = typeof projects.$inferSelect;

export class ProjectStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(id: string): ProjectRow | undefined {
    return this.#db.select().from(projects).where(eq(projects.id, id)).get();
  }

  insert(input: { workspaceId: string; title?: string | null }): ProjectRow {
    const row: ProjectRow = {
      id: newId("proj"),
      workspaceId: input.workspaceId,
      title: input.title ?? null,
      intentDocument: null,
      createdAt: nowIso(),
    };
    this.#db.insert(projects).values(row).run();
    return row;
  }

  /** The operator-approved intent prose; written at full/intent approvals only. */
  setIntentDocument(id: string, intentDocument: string): void {
    this.#db.update(projects).set({ intentDocument }).where(eq(projects.id, id)).run();
  }
}
