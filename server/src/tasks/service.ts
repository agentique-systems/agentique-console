/**
 * The console-owned task ledger, written by the console MCP tools
 * (task_create/task_update) and the journal-driven auto-transitions.
 * Keyed (sdkSessionId, sdkTaskId) where the "session id" is the SYNTHETIC
 * per-agent-session list id — never a provider session id, which dies at
 * every rotation.
 */
import type { Task, TaskDependency, TaskStatus, WorkspaceTasksResponse } from "@agentique-console/shared";
import { toWireScheduledAssignment } from "../api/wire.ts";
import type { AssignmentStore, ScheduledAssignmentRow } from "../db/stores/assignment-store.ts";
import type { TaskDependencyRow, TaskRow, TaskStore } from "../db/stores/task-store.ts";
import type { EventBus } from "../events/bus.ts";
import { InvalidInputError } from "../errors.ts";
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

function toWire(
  row: TaskRow,
  deps: readonly TaskDependencyRow[],
  allRows: readonly TaskRow[],
  liveAssignments: ReadonlyMap<string, ScheduledAssignmentRow>,
): Task {
  const dependencyIds = deps.filter((d) => d.blockedTaskId === row.id).map((d) => d.blockerTaskId);
  const dependentIds = deps.filter((d) => d.blockerTaskId === row.id).map((d) => d.blockedTaskId);
  const live = liveAssignments.get(row.id);
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
    requirementId: row.requirementId,
    blocks: row.blocks,
    blockedBy: row.blockedBy,
    dependencyIds,
    dependentIds,
    // Readiness is over the durable EDGES only — a raw blockedBy ref that
    // never resolved to a task cannot hold work hostage.
    ready: row.status === "pending"
      && dependencyIds.every((id) => allRows.find((candidate) => candidate.id === id)?.status === "completed"),
    scheduledAssignment: live === undefined
      ? null
      : { id: live.id, sender: live.sender, recipient: live.recipient, createdAt: live.createdAt },
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TaskService {
  #onChange: ((task: Task) => void) | undefined;
  readonly #store: TaskStore;
  readonly #assignments: AssignmentStore;
  readonly #bus: EventBus;
  /** Throws NotFound on an unknown workspace; the workspaces table stays owned by its service. */
  readonly #assertWorkspace: (workspaceId: string) => void;

  constructor(store: TaskStore, assignments: AssignmentStore, bus: EventBus, assertWorkspace: (workspaceId: string) => void) {
    this.#store = store;
    this.#assignments = assignments;
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
    /** Ledger ids this task depends on; forward references back-fill on creation. */
    blockedBy?: string[];
    /** The requirement this unit discharges. */
    requirementId?: string | null;
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
        ...(input.blockedBy === undefined || input.blockedBy.length === 0
          ? {}
          : { blockedBy: [...new Set([...existing.blockedBy, ...input.blockedBy])] }),
        ...(input.requirementId === undefined ? {} : { requirementId: input.requirementId }),
        updatedAt: now,
      });
      const updated = this.#store.getByKey(input.sdkSessionId, input.sdkTaskId);
      if (updated) {
        this.#syncProviderDependencies(updated);
        this.#emit("task.updated", updated, ["subject"]);
      }
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
      requirementId: input.requirementId ?? null,
      blocks: [],
      blockedBy: input.blockedBy ?? [],
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
      requirementId?: string | null;
      addBlocks?: string[];
      addBlockedBy?: string[];
      removeBlockedBy?: string[];
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
    if (patch.requirementId !== undefined) merged.requirementId = patch.requirementId;
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
    if (patch.removeBlockedBy !== undefined) {
      for (const ref of patch.removeBlockedBy) this.#removeBlockedByRef(input.sdkSessionId, existing.id, ref);
    }
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
    return this.#wireAll(this.#store.listByUserSession(userSessionId));
  }

  listForWorkspace(workspaceId: string, filter: { userSessionId?: string; agentSessionId?: string } = {}): Task[] {
    const rows = this.#store.listByWorkspace(workspaceId)
      .filter((row) => filter.userSessionId === undefined || row.userSessionId === filter.userSessionId)
      .filter((row) => filter.agentSessionId === undefined || row.agentSessionId === filter.agentSessionId);
    return this.#wireAll(rows);
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
      scheduledAssignments: this.#assignments.listScheduledByWorkspace(workspaceId).map(toWireScheduledAssignment),
    };
  }

  listDependencies(workspaceId: string): TaskDependency[] {
    const ids = new Set(this.#store.listIdsByWorkspace(workspaceId).map((r) => r.id));
    return this.#store.listAllDependencies().filter((d) => ids.has(d.blockerTaskId) || ids.has(d.blockedTaskId));
  }

  addDependency(blockedTaskId: string, blockerTaskId: string, source: TaskDependency["source"] = "console"): void {
    if (blockedTaskId === blockerTaskId) throw new InvalidInputError("a task cannot block itself");
    const blocked = this.#store.getById(blockedTaskId); const blocker = this.#store.getById(blockerTaskId);
    if (!blocked || !blocker) throw new InvalidInputError("unknown task dependency endpoint");
    // Same list only: the scheduler releases on THIS session's ledger, and a
    // cross-session edge would couple sessions no dispatcher watches together.
    if (blocked.sdkSessionId !== blocker.sdkSessionId) throw new InvalidInputError("task dependencies cannot cross sessions");
    if (this.#reachable(blockedTaskId, blockerTaskId, blocked.workspaceId)) throw new InvalidInputError("task dependency would create a cycle");
    const row: TaskDependencyRow = { blockerTaskId, blockedTaskId, source, createdAt: nowIso() };
    this.#store.insertDependency(row);
    this.#bus.append({ type: "task.dependency.created", workspaceId: blocked.workspaceId, userSessionId: blocked.userSessionId,
      ...(blocked.agentSessionId ? { agentSessionId: blocked.agentSessionId } : {}), payload: { dependency: row } });
  }

  /**
   * Delete an edge and scrub both rows' provider-projection arrays so the
   * next sync cannot resurrect it; the release then rides the ordinary
   * `task.updated` choke point — the scheduler needs no second signal.
   */
  removeDependency(blockedTaskId: string, blockerTaskId: string): void {
    const blocked = this.#store.getById(blockedTaskId);
    const blocker = this.#store.getById(blockerTaskId);
    if (!blocked || !blocker) return;
    this.#deleteEdge(blocked, blocker);
    const updated = this.#store.getById(blockedTaskId);
    if (updated) this.#emit("task.updated", updated, ["blockedBy"]);
  }

  /** Resolve a tool-supplied ref (ledger id first, console id second) within one list. */
  resolveForList(sdkSessionId: string, ref: string): Task | undefined {
    const row = this.#store.getByKey(sdkSessionId, ref) ?? this.#store.getById(ref);
    if (!row || row.sdkSessionId !== sdkSessionId) return undefined;
    return this.#wireAll([row])[0];
  }

  getWire(taskId: string): Task | undefined {
    const row = this.#store.getById(taskId);
    if (!row) return undefined;
    return this.#wireAll([row])[0];
  }

  /** The incomplete blockers holding a task, in ledger vocabulary (sdkTaskId). */
  awaiting(task: Task): { taskId: string; subject: string; status: TaskStatus }[] {
    return task.dependencyIds
      .map((id) => this.#store.getById(id))
      .filter((row): row is TaskRow => row !== undefined && row.status !== "completed")
      .map((row) => ({ taskId: row.sdkTaskId, subject: row.subject, status: row.status }));
  }

  /** Compact lines for wake digests: the live tasks of one agent session. */
  linesForAgentSession(agentSessionId: string): string[] {
    return this.#store.listByAgentSession(agentSessionId)
      .filter((row) => row.status !== "deleted")
      .map(
        (row) =>
          `- [${row.status}] ${row.subject}${row.owner === null ? "" : ` (${row.owner})`}${row.requirementId === null ? "" : ` → ${row.requirementId}`}`,
      );
  }

  #wireAll(rows: readonly TaskRow[]): Task[] {
    const deps = this.#store.listAllDependencies();
    const allRows = this.#store.listAll();
    const live = new Map(this.#assignments.listScheduled().map((row) => [row.taskId, row]));
    return rows.map((row) => toWire(row, deps, allRows, live));
  }

  #deleteEdge(blocked: TaskRow, blocker: TaskRow): void {
    this.#store.patchById(blocked.id, {
      blockedBy: blocked.blockedBy.filter((ref) => ref !== blocker.id && ref !== blocker.sdkTaskId),
      updatedAt: nowIso(),
    });
    this.#store.patchById(blocker.id, {
      blocks: blocker.blocks.filter((ref) => ref !== blocked.id && ref !== blocked.sdkTaskId),
      updatedAt: nowIso(),
    });
    const edge = this.#store.findDependency(blocker.id, blocked.id);
    if (!edge) return;
    this.#store.deleteDependency(blocker.id, blocked.id);
    this.#bus.append({ type: "task.dependency.deleted", workspaceId: blocked.workspaceId, userSessionId: blocked.userSessionId,
      ...(blocked.agentSessionId ? { agentSessionId: blocked.agentSessionId } : {}), payload: { dependency: edge } });
  }

  /** One `removeBlockedBy` entry: scrub the raw ref, and delete the edge when it resolves. */
  #removeBlockedByRef(sdkSessionId: string, blockedTaskId: string, ref: string): void {
    const blocked = this.#store.getById(blockedTaskId);
    if (!blocked) return;
    const blocker = this.#store.getByKey(sdkSessionId, ref) ?? this.#store.getById(ref);
    if (blocker && blocker.id !== blocked.id && blocker.sdkSessionId === sdkSessionId) {
      this.#deleteEdge(blocked, blocker);
      return;
    }
    // A forward reference that never resolved: the raw ref is all there is.
    this.#store.patchById(blocked.id, {
      blockedBy: blocked.blockedBy.filter((existing) => existing !== ref),
      updatedAt: nowIso(),
    });
  }

  #reachable(from: string, target: string, workspaceId: string): boolean {
    const ids = new Set(this.#store.listIdsByWorkspace(workspaceId).map((r) => r.id));
    const deps = this.#store.listAllDependencies().filter((d) => ids.has(d.blockerTaskId) && ids.has(d.blockedTaskId));
    const seen = new Set<string>(); const queue = [from];
    while (queue.length) { const id = queue.shift()!; if (id === target) return true; if (seen.has(id)) continue; seen.add(id);
      for (const edge of deps) if (edge.blockerTaskId === id) queue.push(edge.blockedTaskId); }
    return false;
  }

  #syncProviderDependencies(row: TaskRow): void {
    for (const raw of row.blockedBy) {
      const blocker = this.#store.getByKey(row.sdkSessionId, raw) ?? this.#store.getById(raw);
      if (!blocker || blocker.id === row.id) continue;
      if (!this.#store.findDependency(blocker.id, row.id)) {
        // A bad projection ref (cycle, cross-session) must not fail the
        // ledger write that carried it.
        try { this.addDependency(row.id, blocker.id, "provider"); } catch { /* skip the edge */ }
      }
    }
    for (const raw of row.blocks) {
      const blocked = this.#store.getByKey(row.sdkSessionId, raw) ?? this.#store.getById(raw);
      if (!blocked || blocked.id === row.id) continue;
      if (!this.#store.findDependency(row.id, blocked.id)) {
        try { this.addDependency(blocked.id, row.id, "provider"); } catch { /* skip the edge */ }
      }
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
   * subscription: it is synchronous and testable without a spine. Invoked
   * AFTER the bus append, inside a catch — a throwing subscriber must not eat
   * the ledger transition or its event.
   */
  onChange(handler: (task: Task) => void): void {
    if (this.#onChange) throw new Error("onChange is already registered — wire callbacks once, in createApp");
    this.#onChange = handler;
  }

  #emit(type: "task.created" | "task.updated", row: TaskRow, changed?: string[]): void {
    const task = this.#wireAll([row])[0]!;
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
    try { this.#onChange?.(task); } catch { /* the subscriber's failure is its own */ }
  }
}
