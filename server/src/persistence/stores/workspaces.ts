import { eq } from "drizzle-orm";
import { keysetOrder, keysetWhere, type KeysetQuery } from "./paging.ts";
import {
  parseOrThrow,
  workspaceInputSchema,
  workspaceSchema,
  type Workspace,
  type WorkspaceId,
  type WorkspaceInput,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { workspaces } from "../schema.ts";
import { OPERATOR_ACTOR, requireRow, workspaceScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof workspaces.$inferSelect): Workspace {
  return parseOrThrow(workspaceSchema, row, "Workspace row");
}

export class WorkspaceStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: WorkspaceInput, options?: WriteOptions): Workspace {
    const valid = parseOrThrow(workspaceInputSchema, input, "Workspace input");
    return this.ctx.tx.write(() => {
      const now = this.ctx.clock();
      const workspace: Workspace = { id: this.ctx.ids("workspace"), ...valid, createdAt: now, updatedAt: now };
      this.ctx.journal.append({
        type: "workspace.created",
        scope: workspaceScope(workspace.id),
        subjectType: "workspace",
        subjectId: workspace.id,
        payload: workspace,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.insert(workspaces).values(workspace).run();
      return workspace;
    });
  }

  get(id: WorkspaceId): Workspace {
    return toDomain(requireRow(this.ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get(), "Workspace", id));
  }

  list(): Workspace[] {
    return this.ctx.db.select().from(workspaces).all().map(toDomain);
  }

  /** One keyset page of every Workspace by `(createdAt, id)`. */
  page(query: KeysetQuery): Workspace[] {
    const key = [workspaces.createdAt, workspaces.id];
    return this.ctx.db.select().from(workspaces).where(keysetWhere(key, query)).orderBy(...keysetOrder(key, query)).limit(query.limit).all().map(toDomain);
  }

  update(id: WorkspaceId, patch: { name?: string }, options?: WriteOptions): Workspace {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      const updated: Workspace = { ...current, name: patch.name ?? current.name, updatedAt: this.ctx.clock() };
      parseOrThrow(workspaceSchema, updated, "Workspace");
      this.ctx.journal.append({
        type: "workspace.updated",
        scope: workspaceScope(id),
        subjectType: "workspace",
        subjectId: id,
        payload: updated,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.update(workspaces).set({ name: updated.name, updatedAt: updated.updatedAt }).where(eq(workspaces.id, id)).run();
      return updated;
    });
  }
}
