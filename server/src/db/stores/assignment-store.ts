/**
 * scheduled_assignments rows. Statements only — scheduling policy (intercept,
 * dispatch, readiness) lives in tasks/scheduler.ts. Terminal rows are never
 * deleted: they are the audit trail and the dedupe substrate.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { agentSessions, scheduledAssignments } from "../schema.ts";

export type ScheduledAssignmentRow = typeof scheduledAssignments.$inferSelect;

export class AssignmentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(row: ScheduledAssignmentRow): void {
    this.#db.insert(scheduledAssignments).values(row).run();
  }

  getById(id: string): ScheduledAssignmentRow | undefined {
    return this.#db.select().from(scheduledAssignments).where(eq(scheduledAssignments.id, id)).get();
  }

  /** The at-most-one live row for a task (enforced by the partial unique index). */
  findScheduledByTask(taskId: string): ScheduledAssignmentRow | undefined {
    return this.#db
      .select()
      .from(scheduledAssignments)
      .where(and(eq(scheduledAssignments.taskId, taskId), eq(scheduledAssignments.status, "scheduled")))
      .get();
  }

  /** FIFO by creation — the dispatch order for released dependents. */
  listScheduled(): ScheduledAssignmentRow[] {
    return this.#db
      .select()
      .from(scheduledAssignments)
      .where(eq(scheduledAssignments.status, "scheduled"))
      .orderBy(scheduledAssignments.createdAt, scheduledAssignments.id)
      .all();
  }

  listScheduledByTasks(taskIds: readonly string[]): ScheduledAssignmentRow[] {
    if (taskIds.length === 0) return [];
    return this.#db
      .select()
      .from(scheduledAssignments)
      .where(and(eq(scheduledAssignments.status, "scheduled"), inArray(scheduledAssignments.taskId, [...taskIds])))
      .orderBy(scheduledAssignments.createdAt, scheduledAssignments.id)
      .all();
  }

  listScheduledByWorkspace(workspaceId: string): ScheduledAssignmentRow[] {
    return this.#db
      .select()
      .from(scheduledAssignments)
      .where(and(eq(scheduledAssignments.status, "scheduled"), eq(scheduledAssignments.workspaceId, workspaceId)))
      .orderBy(scheduledAssignments.createdAt, scheduledAssignments.id)
      .all();
  }

  /** Guarded transition — false means another actor already settled the row. */
  markDispatched(id: string, dispatchedMessageId: string, updatedAt: string): boolean {
    return (
      this.#db
        .update(scheduledAssignments)
        .set({ status: "dispatched", dispatchedMessageId, updatedAt })
        .where(and(eq(scheduledAssignments.id, id), eq(scheduledAssignments.status, "scheduled")))
        .run().changes === 1
    );
  }

  /** Guarded transition — false means another actor already settled the row. */
  markCanceled(id: string, statusReason: ScheduledAssignmentRow["statusReason"], updatedAt: string): boolean {
    return (
      this.#db
        .update(scheduledAssignments)
        .set({ status: "canceled", statusReason, updatedAt })
        .where(and(eq(scheduledAssignments.id, id), eq(scheduledAssignments.status, "scheduled")))
        .run().changes === 1
    );
  }

  /** Read-model JOIN: live rows whose agent session is still open. */
  countScheduledForOpenSessions(userSessionId: string): number {
    const row = this.#db
      .select({ count: sql<number>`count(*)` })
      .from(scheduledAssignments)
      .innerJoin(agentSessions, eq(scheduledAssignments.agentSessionId, agentSessions.id))
      .where(and(
        eq(scheduledAssignments.userSessionId, userSessionId),
        eq(scheduledAssignments.status, "scheduled"),
        eq(agentSessions.lifecycle, "open"),
      ))
      .get();
    return row?.count ?? 0;
  }

  countScheduledByAgentSession(agentSessionId: string): number {
    const row = this.#db
      .select({ count: sql<number>`count(*)` })
      .from(scheduledAssignments)
      .where(and(eq(scheduledAssignments.agentSessionId, agentSessionId), eq(scheduledAssignments.status, "scheduled")))
      .get();
    return row?.count ?? 0;
  }
}
