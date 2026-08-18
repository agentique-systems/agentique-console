/** workspaces rows. Path resolution and validation stay in WorkspaceService. */
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { workspaces } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type WorkspaceRow = typeof workspaces.$inferSelect;

export class WorkspaceStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): WorkspaceRow[] {
    return this.#db.select().from(workspaces).all();
  }

  get(id: string): WorkspaceRow | undefined {
    return this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
  }

  findIdByRootPath(rootPath: string): { id: string } | undefined {
    return this.#db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.rootPath, rootPath))
      .get();
  }

  insert(row: WorkspaceRow): void {
    this.#db.insert(workspaces).values(row).run();
  }

  patch(id: string, patch: Partial<Pick<WorkspaceRow, "name">>): void {
    this.#db
      .update(workspaces)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(workspaces.id, id))
      .run();
  }
}
