/**
 * The task mirror: every SDK session's TaskCreate/TaskUpdate tool traffic
 * lands here via hooks, giving the per-UserSession global view the SDK cannot
 * provide across sessions. Keyed (sdkSessionId, sdkTaskId); attribution
 * (workspace/user session/agent session/participant) rides in from the hook
 * closure.
 */
import { and, eq } from "drizzle-orm";
import type { Task, TaskDependency } from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { taskDependencies, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";

export interface TaskAttribution {
  workspaceId: string;
  userSessionId: string;
  agentSessionId: string | null;
  participant: string | null;
}

type TaskRow = typeof tasks.$inferSelect;

type DependencyRow = typeof taskDependencies.$inferSelect;

function toWire(row: TaskRow, deps: readonly DependencyRow[], allRows: readonly TaskRow[]): Task {
  const dependencyIds = deps.filter((d) => d.blockedTaskId === row.id).map((d) => d.blockerTaskId);
  const dependentIds = deps.filter((d) => d.blockerTaskId === row.id).map((d) => d.blockedTaskId);
  return {
    id: row.id,
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
    dependencyIds,
    dependentIds,
    unresolvedDependencies: row.blockedBy.filter((raw) => {
      const canonical = allRows.find((candidate) => candidate.sdkSessionId === row.sdkSessionId && candidate.sdkTaskId === raw)?.id;
      return canonical === undefined || !deps.some((d) => d.blockedTaskId === row.id && d.blockerTaskId === canonical);
    }),
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
      id: newId("task"),
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
    this.#syncProviderDependencies(row);
    this.#syncProviderReferencesTo(row);
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
      this.#syncProviderDependencies(updated);
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
    const rows = this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.userSessionId, userSessionId))
      .all();
    const deps = this.#db.select().from(taskDependencies).all();
    const allRows = this.#db.select().from(tasks).all();
    return rows.map((row) => toWire(row, deps, allRows));
  }

  listForWorkspace(workspaceId: string, filter: { userSessionId?: string; agentSessionId?: string } = {}): Task[] {
    const rows = this.#db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId)).all()
      .filter((row) => filter.userSessionId === undefined || row.userSessionId === filter.userSessionId)
      .filter((row) => filter.agentSessionId === undefined || row.agentSessionId === filter.agentSessionId);
    const deps = this.#db.select().from(taskDependencies).all();
    const allRows = this.#db.select().from(tasks).all();
    return rows.map((row) => toWire(row, deps, allRows));
  }

  listDependencies(workspaceId: string): TaskDependency[] {
    const ids = new Set(this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, workspaceId)).all().map((r) => r.id));
    return this.#db.select().from(taskDependencies).all().filter((d) => ids.has(d.blockerTaskId) || ids.has(d.blockedTaskId));
  }

  addDependency(blockedTaskId: string, blockerTaskId: string, source: TaskDependency["source"] = "console"): void {
    if (blockedTaskId === blockerTaskId) throw new Error("a task cannot block itself");
    const blocked = this.#byId(blockedTaskId); const blocker = this.#byId(blockerTaskId);
    if (!blocked || !blocker) throw new Error("unknown task dependency endpoint");
    if (blocked.workspaceId !== blocker.workspaceId) throw new Error("task dependencies cannot cross workspaces");
    if (this.#reachable(blockedTaskId, blockerTaskId)) throw new Error("task dependency would create a cycle");
    const row: DependencyRow = { blockerTaskId, blockedTaskId, source, createdAt: nowIso() };
    this.#db.insert(taskDependencies).values(row).onConflictDoNothing().run();
    this.#bus.append({ type: "task_dependency.created", workspaceId: blocked.workspaceId, userSessionId: blocked.userSessionId,
      ...(blocked.agentSessionId ? { agentSessionId: blocked.agentSessionId } : {}), payload: { dependency: row } });
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

  #byId(id: string): TaskRow | undefined { return this.#db.select().from(tasks).where(eq(tasks.id, id)).get(); }

  #reachable(from: string, target: string): boolean {
    const deps = this.#db.select().from(taskDependencies).all(); const seen = new Set<string>(); const queue = [from];
    while (queue.length) { const id = queue.shift()!; if (id === target) return true; if (seen.has(id)) continue; seen.add(id);
      for (const edge of deps) if (edge.blockerTaskId === id) queue.push(edge.blockedTaskId); }
    return false;
  }

  #syncProviderDependencies(row: TaskRow): void {
    for (const raw of row.blockedBy) {
      const blocker = this.#get(row.sdkSessionId, raw) ?? this.#byId(raw);
      if (!blocker || blocker.id === row.id) continue;
      const exists = this.#db.select().from(taskDependencies).where(and(eq(taskDependencies.blockerTaskId, blocker.id), eq(taskDependencies.blockedTaskId, row.id))).get();
      if (!exists) this.addDependency(row.id, blocker.id, "provider");
    }
    for (const raw of row.blocks) {
      const blocked = this.#get(row.sdkSessionId, raw) ?? this.#byId(raw);
      if (!blocked || blocked.id === row.id) continue;
      const exists = this.#db.select().from(taskDependencies).where(and(eq(taskDependencies.blockerTaskId, row.id), eq(taskDependencies.blockedTaskId, blocked.id))).get();
      if (!exists) this.addDependency(blocked.id, row.id, "provider");
    }
  }

  #syncProviderReferencesTo(created: TaskRow): void {
    const candidates = this.#db.select().from(tasks).where(eq(tasks.sdkSessionId, created.sdkSessionId)).all();
    for (const candidate of candidates) {
      if (candidate.id === created.id) continue;
      if (candidate.blockedBy.includes(created.sdkTaskId) || candidate.blockedBy.includes(created.id) || candidate.blocks.includes(created.sdkTaskId) || candidate.blocks.includes(created.id)) this.#syncProviderDependencies(candidate);
    }
  }

  #key(sdkSessionId: string, sdkTaskId: string) {
    return and(eq(tasks.sdkSessionId, sdkSessionId), eq(tasks.sdkTaskId, sdkTaskId));
  }

  #emit(type: "task.created" | "task.updated", row: TaskRow, changed?: string[]): void {
    const task = toWire(row, this.#db.select().from(taskDependencies).all(), this.#db.select().from(tasks).all());
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
