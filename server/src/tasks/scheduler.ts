/**
 * Task-dependency scheduling, in the task layer — never in the transport.
 * A blocked assignment becomes a durable `scheduled_assignments` row; no
 * message, handoff or mailbox row exists until dispatch, so nothing can wedge
 * a lane on work that has not started. Dispatch is driven by the ledger's own
 * `task.updated` choke point (TaskService.onChange), re-armed by `boot()`.
 */
import type { HandoffDraft, ScheduledAssignment, Speaker, Task } from "@agentique-console/shared";
import { toWireScheduledAssignment } from "../api/wire.ts";
import type { AssignmentStore, ScheduledAssignmentRow } from "../db/stores/assignment-store.ts";
import type { MailboxDeliveryRow, MessageRow, MessageStore } from "../db/stores/message-store.ts";
import type { SessionStore } from "../db/stores/session-store.ts";
import type { EventBus } from "../events/bus.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { newId, nowIso } from "../ids.ts";
import { CONSOLE_SENDER, MAIN_RECIPIENT } from "../agent-sessions/names.ts";
import { speakerKindOf } from "../agent-sessions/topology.ts";
import { consoleTaskListId, type TaskService } from "./service.ts";

type Category = MailboxDeliveryRow["category"];

export interface AssignmentSchedulerDeps {
  store: AssignmentStore;
  tasks: TaskService;
  sessions: SessionStore;
  /** Read-only: the `sched:<id>` dedupe delivery is the proof a dispatch's post landed. */
  messages: MessageStore;
  bus: EventBus;
  /** Lazy over the host — the one transfer path; the scheduler never writes mailbox rows itself. */
  post: (input: {
    agentSessionId: string;
    speaker: Speaker;
    to: string;
    handoff: HandoffDraft;
    category?: Category;
    dedupeKey?: string;
  }) => MessageRow;
  /** The whole-system pause: a ready row stays `scheduled`; `redriveReady()` runs on resume. */
  paused?: () => boolean;
}

export interface InterceptResult {
  assignmentId: string;
  awaiting: { taskId: string; subject: string; status: Task["status"] }[];
}

type WorkItem = { kind: "task"; task: Task } | { kind: "dispatch"; assignmentId: string };

export class AssignmentScheduler {
  readonly #deps: AssignmentSchedulerDeps;
  /** Iterative drain: dispatch recurses through ledger-sync → task.updated → onChange. */
  readonly #queue: WorkItem[] = [];
  #draining = false;

  constructor(deps: AssignmentSchedulerDeps) {
    this.#deps = deps;
  }

  /**
   * Called by the assignment tool handlers, before `post` — never by `post`.
   * null = deliver normally. A re-send for the same task supersedes the live
   * row (the reassign path); the partial unique index backs the invariant.
   */
  intercept(input: { agentSessionId: string; sender: string; recipient: string; category: Category; handoff: HandoffDraft }): InterceptResult | null {
    if (input.category !== "assignment") return null;
    const ref = input.handoff.core.taskId;
    if (ref === null || ref === "") return null;
    const task = this.#deps.tasks.resolveForList(consoleTaskListId(input.agentSessionId), ref);
    if (!task || task.status !== "pending" || task.ready) return null;
    const prior = this.#deps.store.findScheduledByTask(task.id);
    if (prior) this.#cancelRow(prior, "replaced", { notice: false });
    const now = nowIso();
    const row: ScheduledAssignmentRow = {
      id: newId("sched"),
      workspaceId: task.workspaceId,
      userSessionId: task.userSessionId,
      agentSessionId: input.agentSessionId,
      taskId: task.id,
      sender: input.sender,
      recipient: input.recipient,
      category: "assignment",
      handoff: input.handoff,
      status: "scheduled",
      statusReason: null,
      dispatchedMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#deps.store.insert(row);
    this.#emit("task.assignment.scheduled", row);
    // A dependency may have completed between the readiness read and the
    // insert; the recheck closes that span.
    if (this.#deps.tasks.getWire(task.id)?.ready === true) this.#enqueue({ kind: "dispatch", assignmentId: row.id });
    return { assignmentId: row.id, awaiting: this.#deps.tasks.awaiting(task) };
  }

  /** Registered once, in createApp: `tasks.onChange(scheduler.onTaskChanged)`. */
  readonly onTaskChanged = (task: Task): void => {
    this.#enqueue({ kind: "task", task });
  };

  /** Tool/route cancel. Throws NotFound / Conflict; a settled row is never re-settled. */
  cancel(id: string, opts: { actor: string; agentSessionId?: string }): ScheduledAssignment {
    const row = this.#deps.store.getById(id);
    if (!row || (opts.agentSessionId !== undefined && row.agentSessionId !== opts.agentSessionId)) {
      throw new NotFoundError(`no scheduled assignment ${id}`);
    }
    if (row.status !== "scheduled" || !this.#deps.store.markCanceled(id, "canceled", nowIso())) {
      throw new ConflictError(`assignment ${id} is already ${this.#deps.store.getById(id)?.status ?? row.status}`);
    }
    const fresh = this.#deps.store.getById(id)!;
    this.#emit("task.assignment.canceled", fresh);
    if (opts.actor !== fresh.sender) {
      this.#notice(fresh, `sched-cancel:${fresh.id}`,
        `Scheduled assignment canceled by ${opts.actor}`,
        `Your assignment for task ${this.#taskRef(fresh)} (scheduled for ${fresh.recipient}) was canceled by ${opts.actor} before dispatch. The task itself is unchanged.`,
        "Re-assign the task if the work is still wanted.");
    }
    return toWireScheduledAssignment(fresh);
  }

  /**
   * Boot sweep over every live row: archived → cancel; task gone/terminal →
   * cancel + notice; ready → dispatch (post dedupe `sched:<id>` makes a crash
   * between post and mark exactly-once); stuck behind a deleted blocker →
   * re-notice (dedupe-safe); else leave. Returns the redriven-dispatch count.
   */
  boot(): number {
    let redriven = 0;
    for (const row of this.#deps.store.listScheduled()) {
      try {
        const session = this.#deps.sessions.getAgentSession(row.agentSessionId);
        if (!session || session.lifecycle !== "open") { this.#cancelRow(row, "session_archived", { notice: false }); continue; }
        // Crash between post and mark: the delivery exists, the row still
        // reads scheduled. Recover the mark before judging the task state.
        if (this.#priorDelivery(row)) { redriven += 1; this.#enqueue({ kind: "dispatch", assignmentId: row.id }); continue; }
        const task = this.#deps.tasks.getWire(row.taskId);
        if (!task || task.status === "deleted") { this.#cancelRow(row, "task_deleted", { notice: true }); continue; }
        if (task.status === "completed") { this.#cancelRow(row, "task_completed", { notice: true }); continue; }
        if (task.ready) { redriven += 1; this.#enqueue({ kind: "dispatch", assignmentId: row.id }); continue; }
        for (const dependencyId of task.dependencyIds) {
          const blocker = this.#deps.tasks.getWire(dependencyId);
          if (blocker?.status === "deleted") this.#noticeBlockerDeleted(row, blocker);
        }
      } catch (error) { this.#recordFailure(row, error); }
    }
    return redriven;
  }

  /**
   * Resume after a pause: every scheduled row whose task is ready dispatches
   * now (a subset of `boot()`; the post's `sched:<id>` dedupe keeps it
   * exactly-once). Returns the redriven count.
   */
  redriveReady(): number {
    let redriven = 0;
    for (const row of this.#deps.store.listScheduled()) {
      try {
        if (this.#priorDelivery(row) || this.#deps.tasks.getWire(row.taskId)?.ready === true) {
          redriven += 1;
          this.#enqueue({ kind: "dispatch", assignmentId: row.id });
        }
      } catch (error) { this.#recordFailure(row, error); }
    }
    return redriven;
  }

  /** Live rows for OPEN sessions only — the completion gate's clause. */
  countScheduled(userSessionId: string): number {
    return this.#deps.store.countScheduledForOpenSessions(userSessionId);
  }

  countScheduledForAgentSession(agentSessionId: string): number {
    return this.#deps.store.countScheduledByAgentSession(agentSessionId);
  }

  #enqueue(item: WorkItem): void {
    this.#queue.push(item);
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        try {
          if (next.kind === "task") this.#handleTaskChange(next.task);
          else this.#dispatchById(next.assignmentId);
        } catch (error) {
          this.#recordFailure(next.kind === "dispatch" ? this.#deps.store.getById(next.assignmentId) : next.task, error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #handleTaskChange(task: Task): void {
    if (task.status === "completed") {
      const own = this.#deps.store.findScheduledByTask(task.id);
      // Out-of-band completion: the work happened without the dispatch.
      if (own) this.#cancelRow(own, "task_completed", { notice: true });
      // Released dependents, FIFO by assignment creation.
      for (const row of this.#deps.store.listScheduledByTasks(task.dependentIds)) {
        this.#enqueue({ kind: "dispatch", assignmentId: row.id });
      }
      return;
    }
    if (task.status === "deleted") {
      const own = this.#deps.store.findScheduledByTask(task.id);
      if (own) this.#cancelRow(own, "task_deleted", { notice: true });
      // Deletion does not satisfy a dependency (complete-only): dependents
      // stay blocked, and each assigner is told why.
      for (const row of this.#deps.store.listScheduledByTasks(task.dependentIds)) {
        this.#noticeBlockerDeleted(row, task);
      }
      return;
    }
    // Edge removal (or the intercept recheck) may have made the task ready.
    if (task.status === "pending" && task.ready) {
      const own = this.#deps.store.findScheduledByTask(task.id);
      if (own) this.#enqueue({ kind: "dispatch", assignmentId: own.id });
    }
  }

  #dispatchById(assignmentId: string): void {
    const row = this.#deps.store.getById(assignmentId);
    if (!row || row.status !== "scheduled") return;
    // Paused: the row stays scheduled and the resume hook redrives it.
    if (this.#deps.paused?.()) return;
    const prior = this.#priorDelivery(row);
    if (prior) {
      if (this.#deps.store.markDispatched(row.id, prior.messageId, nowIso())) {
        this.#emit("task.assignment.dispatched", this.#deps.store.getById(row.id)!);
      }
      return;
    }
    const session = this.#deps.sessions.getAgentSession(row.agentSessionId);
    if (!session || session.lifecycle !== "open") { this.#cancelRow(row, "session_archived", { notice: false }); return; }
    const task = this.#deps.tasks.getWire(row.taskId);
    if (!task || task.status === "deleted") { this.#cancelRow(row, "task_deleted", { notice: true }); return; }
    if (task.status === "completed") { this.#cancelRow(row, "task_completed", { notice: true }); return; }
    if (task.status !== "pending") { this.#cancelRow(row, "canceled", { notice: true }); return; }
    if (!task.ready) return;
    const draft = row.handoff;
    const amended: HandoffDraft = {
      ...draft,
      core: {
        ...draft.core,
        state: {
          ...draft.core.state,
          summary: `Console: dispatched from the schedule — task ${task.sdkTaskId}'s dependencies are complete.\n\n${draft.core.state.summary}`,
        },
      },
    };
    // Attributed to the ORIGINAL assigner: the real contract edge is
    // validated, ledger sync fires normally, and the journal tells the truth.
    const message = this.#deps.post({
      agentSessionId: row.agentSessionId,
      speaker: this.#speakerFor(row),
      to: row.recipient,
      handoff: amended,
      category: row.category,
      dedupeKey: `sched:${row.id}`,
    });
    if (this.#deps.store.markDispatched(row.id, message.id, nowIso())) {
      this.#emit("task.assignment.dispatched", this.#deps.store.getById(row.id)!);
    }
  }

  #priorDelivery(row: ScheduledAssignmentRow): MailboxDeliveryRow | undefined {
    return this.#deps.messages.findDeliveryByDedupe(row.agentSessionId, row.sender, row.recipient, `sched:${row.id}`);
  }

  #speakerFor(row: ScheduledAssignmentRow): Speaker {
    if (row.sender === MAIN_RECIPIENT) return { kind: "orchestrator", name: MAIN_RECIPIENT };
    return { kind: speakerKindOf(this.#deps.sessions.getAgent(row.agentSessionId, row.sender)), name: row.sender };
  }

  #cancelRow(row: ScheduledAssignmentRow, reason: NonNullable<ScheduledAssignmentRow["statusReason"]>, opts: { notice: boolean }): void {
    if (!this.#deps.store.markCanceled(row.id, reason, nowIso())) return;
    const fresh = this.#deps.store.getById(row.id)!;
    this.#emit("task.assignment.canceled", fresh);
    if (!opts.notice) return;
    const why = reason === "task_completed"
      ? "its task completed before the assignment was dispatched — the work happened without it"
      : reason === "task_deleted"
        ? "its task was deleted"
        : "its task left the pending state out of band";
    this.#notice(fresh, `sched-cancel:${fresh.id}`,
      `Scheduled assignment canceled (${reason})`,
      `Your assignment for task ${this.#taskRef(fresh)} (scheduled for ${fresh.recipient}) was canceled: ${why}.`,
      "Verify the ledger reflects reality; re-assign only if work remains.");
  }

  #noticeBlockerDeleted(row: ScheduledAssignmentRow, blocker: Task): void {
    this.#notice(row, `sched-notice:${row.id}:${blocker.id}`,
      `Dependency deleted: "${blocker.subject}"`,
      `Task ${this.#taskRef(row)}'s assignment to ${row.recipient} is still scheduled: its dependency "${blocker.subject}" (${blocker.sdkTaskId}) was deleted, and deletion does not satisfy a dependency.`,
      `Remove the dependency with task_update {removeBlockedBy: ["${blocker.sdkTaskId}"]} to release the assignment, or cancel it (assignment id ${row.id}).`);
  }

  /**
   * Journaled console decision to the assigner. Status "blocked" is literal —
   * the scheduled assignment cannot dispatch without the assigner's action —
   * and it is also what makes the notice wake a main assigner under the
   * attention policy (a pending/in_progress decision RECORD would not).
   */
  #notice(row: ScheduledAssignmentRow, dedupeKey: string, action: string, summary: string, nextAction: string): void {
    try {
      this.#deps.post({
        agentSessionId: row.agentSessionId,
        speaker: { kind: "system", name: CONSOLE_SENDER },
        to: row.sender,
        handoff: {
          core: {
            schemaVersion: 1, taskId: null, status: "blocked", risk: "medium", action,
            state: { summary, evidence: [] }, result: { summary: null, artifacts: [] },
            uncertainty: [], nextAction, requestExpandedContext: false,
          },
          extension: { kind: "generic", data: { consoleSynthesized: true } },
        },
        category: "decision",
        dedupeKey,
      });
    } catch { /* best effort — an archived session has nobody to tell */ }
  }

  #taskRef(row: ScheduledAssignmentRow): string {
    const task = this.#deps.tasks.getWire(row.taskId);
    return task ? `"${task.subject}" (${task.sdkTaskId})` : row.taskId;
  }

  #emit(type: "task.assignment.scheduled" | "task.assignment.dispatched" | "task.assignment.canceled", row: ScheduledAssignmentRow): void {
    this.#deps.bus.append({
      type,
      workspaceId: row.workspaceId,
      userSessionId: row.userSessionId,
      agentSessionId: row.agentSessionId,
      payload: { assignment: toWireScheduledAssignment(row) },
    });
  }

  #recordFailure(scope: { agentSessionId: string | null; userSessionId: string } | undefined, error: unknown): void {
    const detail = `assignment scheduler: ${error instanceof Error ? error.message : String(error)}`;
    if (!scope || scope.agentSessionId === null) return;
    this.#deps.bus.append({
      type: "agent_session.runtime.noted",
      userSessionId: scope.userSessionId,
      agentSessionId: scope.agentSessionId,
      payload: { agentSessionId: scope.agentSessionId, agent: CONSOLE_SENDER, detail },
    });
  }
}
