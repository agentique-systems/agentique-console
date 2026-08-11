/**
 * tasks + task_dependencies rows. Statements only — projection sync, the
 * cycle guard, and wire building stay in TaskService.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { taskDependencies, tasks } from "../schema.ts";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;

export class TaskStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  getByKey(sdkSessionId: string, sdkTaskId: string): TaskRow | undefined {
    return this.#db
      .select()
      .from(tasks)
      .where(this.#key(sdkSessionId, sdkTaskId))
      .get();
  }

  getById(id: string): TaskRow | undefined { return this.#db.select().from(tasks).where(eq(tasks.id, id)).get(); }

  insert(row: TaskRow): void {
    this.#db.insert(tasks).values(row).run();
  }

  patchByKey(sdkSessionId: string, sdkTaskId: string, patch: Partial<TaskRow>): void {
    this.#db
      .update(tasks)
      .set(patch)
      .where(this.#key(sdkSessionId, sdkTaskId))
      .run();
  }

  listByUserSession(userSessionId: string): TaskRow[] {
    return this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.userSessionId, userSessionId))
      .all();
  }

  listByWorkspace(workspaceId: string): TaskRow[] {
    return this.#db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId)).all();
  }

  listByAgentSession(agentSessionId: string): TaskRow[] {
    return this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.agentSessionId, agentSessionId))
      .all();
  }

  listBySdkSession(sdkSessionId: string): TaskRow[] {
    return this.#db.select().from(tasks).where(eq(tasks.sdkSessionId, sdkSessionId)).all();
  }

  listIdsByWorkspace(workspaceId: string): { id: string }[] {
    return this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, workspaceId)).all();
  }

  listAll(): TaskRow[] { return this.#db.select().from(tasks).all(); }

  listAllDependencies(): TaskDependencyRow[] { return this.#db.select().from(taskDependencies).all(); }

  insertDependency(row: TaskDependencyRow): void {
    this.#db.insert(taskDependencies).values(row).onConflictDoNothing().run();
  }

  findDependency(blockerTaskId: string, blockedTaskId: string): TaskDependencyRow | undefined {
    return this.#db.select().from(taskDependencies).where(and(eq(taskDependencies.blockerTaskId, blockerTaskId), eq(taskDependencies.blockedTaskId, blockedTaskId))).get();
  }

  /** A durable-reference probe: some task row carries this provider task id. */
  hasSdkTaskId(ref: string): boolean {
    return this.#db.select({ id: tasks.sdkTaskId }).from(tasks).where(eq(tasks.sdkTaskId, ref)).get() !== undefined;
  }

  #key(sdkSessionId: string, sdkTaskId: string) {
    return and(eq(tasks.sdkSessionId, sdkSessionId), eq(tasks.sdkTaskId, sdkTaskId));
  }
}
