import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Workspace } from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { workspaces } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { InvalidInputError, ConflictError, NotFoundError } from "../errors.ts";
import { BrowseError, resolveNewPath } from "./fs-browse.ts";

type WorkspaceRow = typeof workspaces.$inferSelect;

function toWire(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class WorkspaceService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #roots: readonly string[];

  constructor(db: Db, bus: EventBus, roots: readonly string[]) {
    this.#db = db;
    this.#bus = bus;
    this.#roots = roots;
  }

  list(): Workspace[] {
    return this.#db.select().from(workspaces).all().map(toWire);
  }

  get(id: string): Workspace {
    const row = this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    if (!row) throw new NotFoundError(`no workspace ${id}`);
    return toWire(row);
  }

  async create(input: {
    name: string;
    rootPath: string;
    create?: boolean;
  }): Promise<Workspace> {
    const name = input.name.trim();
    if (name === "") throw new InvalidInputError("workspace name is required");

    let rootPath: string;
    try {
      rootPath = await resolveNewPath(input.rootPath, this.#roots);
    } catch (error) {
      if (error instanceof BrowseError) {
        throw new InvalidInputError(`rootPath: ${error.message}`);
      }
      throw error;
    }
    if (!existsSync(rootPath)) {
      if (input.create !== true) {
        throw new InvalidInputError("rootPath does not exist (pass create: true)");
      }
      await mkdir(rootPath, { recursive: true });
    }

    const existing = this.#db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.rootPath, rootPath))
      .get();
    if (existing) throw new ConflictError(`a workspace already uses ${rootPath}`);

    const now = nowIso();
    const row: WorkspaceRow = {
      id: newId("ws"),
      name,
      rootPath,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(workspaces).values(row).run();
    const workspace = toWire(row);
    this.#bus.append({
      type: "workspace.created",
      workspaceId: workspace.id,
      payload: { workspace },
    });
    return workspace;
  }

  patch(id: string, patch: { name?: string }): Workspace {
    const current = this.get(id);
    const name = patch.name?.trim();
    if (name !== undefined && name === "") {
      throw new InvalidInputError("workspace name cannot be empty");
    }
    this.#db
      .update(workspaces)
      .set({ ...(name !== undefined ? { name } : {}), updatedAt: nowIso() })
      .where(eq(workspaces.id, id))
      .run();
    const updated = this.get(id);
    this.#bus.append({
      type: "workspace.updated",
      workspaceId: id,
      payload: {
        workspaceId: id,
        patch: { ...(name !== undefined ? { name } : {}) },
      },
    });
    return updated ?? current;
  }
}
