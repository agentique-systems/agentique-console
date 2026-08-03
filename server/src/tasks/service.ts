/**
 * The task mirror: every SDK session's TaskCreate/TaskUpdate tool traffic
 * lands here via hooks, giving the per-UserSession global view the SDK cannot
 * provide across sessions. Keyed (sdkSessionId, sdkTaskId); attribution
 * (workspace/user session/agent session/participant) rides in from the hook
 * closure.
 */
import { and, eq } from "drizzle-orm";
import type { Task } from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";

export interface TaskAttribution {
  workspaceId: string;
  userSessionId: string;
  agentSessionId: string | null;
  participant: string | null;
}

type TaskRow = typeof tasks.$inferSelect;

function toWire(row: TaskRow): Task {
  return {
    sdkSessionId: row.sdkSessionId,
    sdkTaskId: row.sdkTaskId,
    workspaceId: row.workspaceId,
    userSessionId: row.userSessionId,
    agentSessionId: row.agentSessionId,
    participant: row.participant,
    subject: row.subject,
    description: row.description,
    activeForm: row.activeForm,
    status: row.status,
    owner: row.owner,
    blocks: row.blocks,
    blockedBy: row.blockedBy,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TaskService {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  /** From TaskCreated hooks and PostToolUse(TaskCreate). Idempotent. */
  upsertFromCreate(input: {
    sdkSessionId: string;
    sdkTaskId: string;
    subject: string;
    description?: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
    attribution: TaskAttribution;
  }): void {
    const existing = this.#get(input.sdkSessionId, input.sdkTaskId);
    const now = nowIso();
    if (existing) {
      this.#db
        .update(tasks)
        .set({
          subject: input.subject,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.activeForm === undefined
            ? {}
            : { activeForm: input.activeForm }),
          updatedAt: now,
        })
        .where(this.#key(input.sdkSessionId, input.sdkTaskId))
        .run();
      const updated = this.#get(input.sdkSessionId, input.sdkTaskId);
      if (updated) this.#emit("task.updated", updated, ["subject"]);
      return;
    }
    const row: TaskRow = {
      sdkSessionId: input.sdkSessionId,
      sdkTaskId: input.sdkTaskId,
      workspaceId: input.attribution.workspaceId,
      userSessionId: input.attribution.userSessionId,
      agentSessionId: input.attribution.agentSessionId,
      participant: input.attribution.participant,
      subject: input.subject,
      description: input.description ?? "",
      activeForm: input.activeForm ?? null,
      status: "pending",
      owner: input.attribution.participant,
      blocks: [],
      blockedBy: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(tasks).values(row).run();
    this.#emit("task.created", row);
  }

  /** From PostToolUse(TaskUpdate): the input carries every changed field. */
  applyUpdate(input: {
    sdkSessionId: string;
    sdkTaskId: string;
    patch: {
      subject?: string;
      description?: string;
      activeForm?: string;
      status?: "pending" | "in_progress" | "completed" | "deleted";
      owner?: string;
      addBlocks?: string[];
      addBlockedBy?: string[];
      metadata?: Record<string, unknown>;
    };
    updatedFields?: string[];
  }): void {
    const existing = this.#get(input.sdkSessionId, input.sdkTaskId);
    if (!existing) return; // unknown task — TaskList reconciliation will repair
    const patch = input.patch;
    const merged: Partial<TaskRow> = { updatedAt: nowIso() };
    if (patch.subject !== undefined) merged.subject = patch.subject;
    if (patch.description !== undefined) merged.description = patch.description;
    if (patch.activeForm !== undefined) merged.activeForm = patch.activeForm;
    if (patch.status !== undefined) merged.status = patch.status;
    if (patch.owner !== undefined) merged.owner = patch.owner;
    if (patch.addBlocks !== undefined && patch.addBlocks.length > 0) {
      merged.blocks = [...new Set([...existing.blocks, ...patch.addBlocks])];
    }
    if (patch.addBlockedBy !== undefined && patch.addBlockedBy.length > 0) {
      merged.blockedBy = [
        ...new Set([...existing.blockedBy, ...patch.addBlockedBy]),
      ];
    }
    if (patch.metadata !== undefined) {
      const metadata = { ...existing.metadata };
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      merged.metadata = metadata;
    }
    this.#db
      .update(tasks)
      .set(merged)
      .where(this.#key(input.sdkSessionId, input.sdkTaskId))
      .run();
    const updated = this.#get(input.sdkSessionId, input.sdkTaskId);
    if (updated) {
      this.#emit(
        "task.updated",
        updated,
        input.updatedFields ?? Object.keys(patch),
      );
    }
  }

  /** From TaskCompleted hooks. */
  markCompleted(sdkSessionId: string, sdkTaskId: string): void {
    this.applyUpdate({
      sdkSessionId,
      sdkTaskId,
      patch: { status: "completed" },
      updatedFields: ["status"],
    });
  }

  /** Opportunistic drift repair from TaskList/TaskGet outputs. */
  reconcileFromList(
    sdkSessionId: string,
    listed: {
      id: string;
      subject: string;
      status: "pending" | "in_progress" | "completed";
      owner?: string;
      blockedBy?: string[];
    }[],
    attribution: TaskAttribution,
  ): void {
    for (const item of listed) {
      const existing = this.#get(sdkSessionId, item.id);
      if (!existing) {
        this.upsertFromCreate({
          sdkSessionId,
          sdkTaskId: item.id,
          subject: item.subject,
          attribution,
        });
        this.applyUpdate({
          sdkSessionId,
          sdkTaskId: item.id,
          patch: {
            status: item.status,
            ...(item.owner === undefined ? {} : { owner: item.owner }),
            ...(item.blockedBy === undefined
              ? {}
              : { addBlockedBy: item.blockedBy }),
          },
        });
        continue;
      }
      const drift =
        existing.status !== item.status ||
        existing.subject !== item.subject ||
        (item.owner !== undefined && existing.owner !== item.owner);
      if (drift) {
        this.applyUpdate({
          sdkSessionId,
          sdkTaskId: item.id,
          patch: {
            status: item.status,
            subject: item.subject,
            ...(item.owner === undefined ? {} : { owner: item.owner }),
          },
        });
      }
    }
  }

  listForUserSession(userSessionId: string): Task[] {
    return this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.userSessionId, userSessionId))
      .all()
      .map(toWire);
  }

  /** Compact lines for wake digests: the live tasks of one agent session. */
  linesForAgentSession(agentSessionId: string): string[] {
    return this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.agentSessionId, agentSessionId))
      .all()
      .filter((row) => row.status !== "deleted")
      .map(
        (row) =>
          `- [${row.status}] ${row.subject}${row.owner === null ? "" : ` (${row.owner})`}`,
      );
  }

  #get(sdkSessionId: string, sdkTaskId: string): TaskRow | undefined {
    return this.#db
      .select()
      .from(tasks)
      .where(this.#key(sdkSessionId, sdkTaskId))
      .get();
  }

  #key(sdkSessionId: string, sdkTaskId: string) {
    return and(eq(tasks.sdkSessionId, sdkSessionId), eq(tasks.sdkTaskId, sdkTaskId));
  }

  #emit(type: "task.created" | "task.updated", row: TaskRow, changed?: string[]): void {
    const task = toWire(row);
    this.#bus.append({
      type,
      workspaceId: row.workspaceId,
      userSessionId: row.userSessionId,
      ...(row.agentSessionId === null
        ? {}
        : { agentSessionId: row.agentSessionId }),
      payload:
        type === "task.created" ? { task } : { task, changed: changed ?? [] },
    } as Parameters<EventBus["append"]>[0]);
  }
}
