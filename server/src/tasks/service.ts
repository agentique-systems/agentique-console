/**
 * The console-owned task ledger, written by the console MCP tools
 * (task_create/task_update) and the journal-driven auto-transitions.
 * Keyed (sdkSessionId, sdkTaskId) where the "session id" is the SYNTHETIC
 * per-agent-session list id — never a provider session id, which dies at
 * every rotation.
 */
import type { Task, TaskDependency, WorkspaceTasksResponse } from "@agentique-console/shared";
import type { TaskDependencyRow, TaskRow, TaskStore } from "../db/stores/task-store.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";

/**
 * The console-owned task list's synthetic SDK-session key. Frozen data format:
 * persisted in `tasks.sdk_session_id`, so the trailing literal never tracks a
 * rename.
 */
export function consoleTaskListId(agentSessionId: string): string {
  return `console:${agentSessionId}:orchestrator`;
}

export interface TaskAttribution {
  workspaceId: string;
  userSessionId: string;
  agentSessionId: string | null;
  agent: string | null;
}

function toWire(row: TaskRow, deps: readonly TaskDependencyRow[], allRows: readonly TaskRow[]): Task {
  const dependencyIds = deps.filter((d) => d.blockedTaskId === row.id).map((d) => d.blockerTaskId);
  const dependentIds = deps.filter((d) => d.blockerTaskId === row.id).map((d) => d.blockedTaskId);
  return {
    id: row.id,
    sdkSessionId: row.sdkSessionId,
    sdkTaskId: row.sdkTaskId,
    workspaceId: row.workspaceId,
    userSessionId: row.userSessionId,
    agentSessionId: row.agentSessionId,
    agent: row.participant,
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
  #onChange: ((task: Task) => void) | undefined;
  readonly #store: TaskStore;
  readonly #bus: EventBus;
  /** Throws NotFound on an unknown workspace; the workspaces table stays owned by its service. */
  readonly #assertWorkspace: (workspaceId: string) => void;

  constructor(store: TaskStore, bus: EventBus, assertWorkspace: (workspaceId: string) => void) {
    this.#store = store;
    this.#bus = bus;
    this.#assertWorkspace = assertWorkspace;
  }

  /** From the `task_create` console tool. Idempotent. */
  upsertFromCreate(input: {
    sdkSessionId: string;
    sdkTaskId: string;
    subject: string;
    description?: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
    /** The agent that will DO the work — not the agent writing the row. */
    owner?: string | null;
    attribution: TaskAttribution;
  }): void {
    const existing = this.#store.getByKey(input.sdkSessionId, input.sdkTaskId);
    const now = nowIso();
    if (existing) {
      this.#store.patchByKey(input.sdkSessionId, input.sdkTaskId, {
        subject: input.subject,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.activeForm === undefined
          ? {}
          : { activeForm: input.activeForm }),
        updatedAt: now,
      });
      const updated = this.#store.getByKey(input.sdkSessionId, input.sdkTaskId);
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
      participant: input.attribution.agent,
      subject: input.subject,
      description: input.description ?? "",
      activeForm: input.activeForm ?? null,
      status: "pending",
      // NOT the writer: the owner is who will DO the work, which is what the
      // roster, the final caveats and the run summary read.
      owner: input.owner ?? null,
      blocks: [],
      blockedBy: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#store.insert(row);
    this.#syncProviderDependencies(row);
    this.#syncProviderReferencesTo(row);
    this.#emit("task.created", row);
  }

  /** From the `task_update` console tool and the journal auto-transitions. */
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
    const existing = this.#store.getByKey(input.sdkSessionId, input.sdkTaskId);
    if (!existing) return;
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
    this.#store.patchByKey(input.sdkSessionId, input.sdkTaskId, merged);
    const updated = this.#store.getByKey(input.sdkSessionId, input.sdkTaskId);
    if (updated) {
      this.#syncProviderDependencies(updated);
      this.#emit(
        "task.updated",
        updated,
        input.updatedFields ?? Object.keys(patch),
      );
    }
  }

  markCompleted(sdkSessionId: string, sdkTaskId: string): void {
    this.applyUpdate({
      sdkSessionId,
      sdkTaskId,
      patch: { status: "completed" },
      updatedFields: ["status"],
    });
  }

  listForUserSession(userSessionId: string): Task[] {
    const rows = this.#store.listByUserSession(userSessionId);
    const deps = this.#store.listAllDependencies();
    const allRows = this.#store.listAll();
    return rows.map((row) => toWire(row, deps, allRows));
  }

  listForWorkspace(workspaceId: string, filter: { userSessionId?: string; agentSessionId?: string } = {}): Task[] {
    const rows = this.#store.listByWorkspace(workspaceId)
      .filter((row) => filter.userSessionId === undefined || row.userSessionId === filter.userSessionId)
      .filter((row) => filter.agentSessionId === undefined || row.agentSessionId === filter.agentSessionId);
    const deps = this.#store.listAllDependencies();
    const allRows = this.#store.listAll();
    return rows.map((row) => toWire(row, deps, allRows));
  }

  /** The workspace tasks view: tasks (optionally filtered) plus the dependency graph. */
  workspaceView(
    workspaceId: string,
    filter: { userSessionId?: string; agentSessionId?: string } = {},
  ): WorkspaceTasksResponse {
    this.#assertWorkspace(workspaceId);
    return {
      tasks: this.listForWorkspace(workspaceId, filter),
      dependencies: this.listDependencies(workspaceId),
    };
  }

  listDependencies(workspaceId: string): TaskDependency[] {
    const ids = new Set(this.#store.listIdsByWorkspace(workspaceId).map((r) => r.id));
    return this.#store.listAllDependencies().filter((d) => ids.has(d.blockerTaskId) || ids.has(d.blockedTaskId));
  }

  addDependency(blockedTaskId: string, blockerTaskId: string, source: TaskDependency["source"] = "console"): void {
    if (blockedTaskId === blockerTaskId) throw new Error("a task cannot block itself");
    const blocked = this.#store.getById(blockedTaskId); const blocker = this.#store.getById(blockerTaskId);
    if (!blocked || !blocker) throw new Error("unknown task dependency endpoint");
    if (blocked.workspaceId !== blocker.workspaceId) throw new Error("task dependencies cannot cross workspaces");
    if (this.#reachable(blockedTaskId, blockerTaskId)) throw new Error("task dependency would create a cycle");
    const row: TaskDependencyRow = { blockerTaskId, blockedTaskId, source, createdAt: nowIso() };
    this.#store.insertDependency(row);
    this.#bus.append({ type: "task.dependency.created", workspaceId: blocked.workspaceId, userSessionId: blocked.userSessionId,
      ...(blocked.agentSessionId ? { agentSessionId: blocked.agentSessionId } : {}), payload: { dependency: row } });
  }

  /** Compact lines for wake digests: the live tasks of one agent session. */
  linesForAgentSession(agentSessionId: string): string[] {
    return this.#store.listByAgentSession(agentSessionId)
      .filter((row) => row.status !== "deleted")
      .map(
        (row) =>
          `- [${row.status}] ${row.subject}${row.owner === null ? "" : ` (${row.owner})`}`,
      );
  }

  #reachable(from: string, target: string): boolean {
    const deps = this.#store.listAllDependencies(); const seen = new Set<string>(); const queue = [from];
    while (queue.length) { const id = queue.shift()!; if (id === target) return true; if (seen.has(id)) continue; seen.add(id);
      for (const edge of deps) if (edge.blockerTaskId === id) queue.push(edge.blockedTaskId); }
    return false;
  }

  #syncProviderDependencies(row: TaskRow): void {
    for (const raw of row.blockedBy) {
      const blocker = this.#store.getByKey(row.sdkSessionId, raw) ?? this.#store.getById(raw);
      if (!blocker || blocker.id === row.id) continue;
      if (!this.#store.findDependency(blocker.id, row.id)) this.addDependency(row.id, blocker.id, "provider");
    }
    for (const raw of row.blocks) {
      const blocked = this.#store.getByKey(row.sdkSessionId, raw) ?? this.#store.getById(raw);
      if (!blocked || blocked.id === row.id) continue;
      if (!this.#store.findDependency(row.id, blocked.id)) this.addDependency(blocked.id, row.id, "provider");
    }
  }

  #syncProviderReferencesTo(created: TaskRow): void {
    const candidates = this.#store.listBySdkSession(created.sdkSessionId);
    for (const candidate of candidates) {
      if (candidate.id === created.id) continue;
      if (candidate.blockedBy.includes(created.sdkTaskId) || candidate.blockedBy.includes(created.id) || candidate.blocks.includes(created.sdkTaskId) || candidate.blocks.includes(created.id)) this.#syncProviderDependencies(candidate);
    }
  }

  /**
   * Notified after every task write. An explicit callback rather than a bus
   * subscription: it is synchronous and testable without a spine, and the one
   * consumer — releasing assignments whose blocker just completed — has to run
   * before anything else observes the new state.
   */
  onChange(handler: (task: Task) => void): void {
    if (this.#onChange) throw new Error("onChange is already registered — wire callbacks once, in createApp");
    this.#onChange = handler;
  }

  #emit(type: "task.created" | "task.updated", row: TaskRow, changed?: string[]): void {
    const task = toWire(row, this.#store.listAllDependencies(), this.#store.listAll());
    this.#onChange?.(task);
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
