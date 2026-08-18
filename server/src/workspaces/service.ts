import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Workspace } from "@agentique-console/shared";
import type { WorkspaceRow, WorkspaceStore } from "../db/stores/workspace-store.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { InvalidInputError, ConflictError, NotFoundError } from "../errors.ts";
import { BrowseError, resolveNewPath } from "./fs-browse.ts";

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
  readonly #store: WorkspaceStore;
  readonly #bus: EventBus;
  readonly #roots: readonly string[];

  constructor(store: WorkspaceStore, bus: EventBus, roots: readonly string[]) {
    this.#store = store;
    this.#bus = bus;
    this.#roots = roots;
  }

  list(): Workspace[] {
    return this.#store.list().map(toWire);
  }

  get(id: string): Workspace {
    const row = this.#store.get(id);
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

    const existing = this.#store.findIdByRootPath(rootPath);
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
    this.#store.insert(row);
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
    this.#store.patch(id, name !== undefined ? { name } : {});
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
