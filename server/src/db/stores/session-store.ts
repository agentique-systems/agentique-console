/**
 * The session tree: user_sessions, agent_sessions, and agents rows.
 * (Distinct from sdk/session-store.ts's SqliteSessionStore, which journals
 * provider transcript entries.)
 */
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { agentSessions, agents, userSessions } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type UserSessionRow = typeof userSessions.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;

export class SessionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // --- User sessions --------------------------------------------------------

  getUserSession(id: string): UserSessionRow | undefined {
    return this.#db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, id))
      .get();
  }

  listOpenUserSessions(): UserSessionRow[] {
    return this.#db.select().from(userSessions).where(eq(userSessions.lifecycle, "open")).all();
  }

  /** Open, non-manager sessions — the ones a run can complete in. */
  listOpenWorkSessions(): UserSessionRow[] {
    return this.#db.select().from(userSessions)
      .where(and(eq(userSessions.lifecycle, "open"), eq(userSessions.purpose, "work"))).all();
  }

  listUserSessions(workspaceId: string): UserSessionRow[] {
    return this.#db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "work")))
      .orderBy(desc(userSessions.updatedAt))
      .all();
  }

  listManagerSessions(workspaceId: string): UserSessionRow[] {
    return this.#db.select().from(userSessions).where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "profile_manager"))).orderBy(desc(userSessions.updatedAt)).all();
  }

  findManagerSession(workspaceId: string, subjectKey: string): UserSessionRow | undefined {
    return this.#db.select().from(userSessions).where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "profile_manager"), eq(userSessions.subjectKey, subjectKey))).get();
  }

  insertUserSession(row: UserSessionRow): void {
    this.#db.insert(userSessions).values(row).run();
  }

  patchUserSession(
    id: string,
    patch: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "lifecycle" | "subjectKey" | "sdkSessionId" | "sdkGeneration" | "sdkTurnCount" | "contextTokens" | "memory" |  "latestHandoffId" | "cumulativeCostUsd" | "cumulativeApiDurationMs" | "runState" | "runBaseCommit" | "model" | "pausedUntil" | "pauseReason" | "budgetUsd" | "autonomy">
    >,
  ): void {
    this.#db
      .update(userSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(userSessions.id, id))
      .run();
  }

  touchUserSession(id: string): void {
    this.#db
      .update(userSessions)
      .set({ updatedAt: nowIso() })
      .where(eq(userSessions.id, id))
      .run();
  }

  // --- Agent sessions -------------------------------------------------------

  getAgentSession(id: string): AgentSessionRow | undefined {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get();
  }

  listAgentSessions(userSessionId: string): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userSessionId, userSessionId))
      .orderBy(desc(agentSessions.createdAt))
      .all();
  }

  insertAgentSession(row: AgentSessionRow): void {
    this.#db.insert(agentSessions).values(row).run();
  }

  listOpenAgentSessions(): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.lifecycle, "open"))
      .all();
  }

  listChildSessions(parentAgentSessionId: string): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.parentAgentSessionId, parentAgentSessionId))
      .orderBy(asc(agentSessions.createdAt))
      .all();
  }

  patchAgentSession(
    id: string,
    patch: Partial<
      Pick<AgentSessionRow, "lifecycle">
    >,
  ): void {
    this.#db
      .update(agentSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(agentSessions.id, id))
      .run();
  }

  // --- Agents ---------------------------------------------------------------

  /** Agents in seating order (the coordinator is ord 0). */
  listAgents(agentSessionId: string): AgentRow[] {
    return this.#db
      .select()
      .from(agents)
      .where(eq(agents.agentSessionId, agentSessionId))
      .orderBy(asc(agents.ord))
      .all();
  }

  getAgent(
    agentSessionId: string,
    name: string,
  ): AgentRow | undefined {
    return this.#db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.agentSessionId, agentSessionId),
          eq(agents.name, name),
        ),
      )
      .get();
  }

  insertAgent(row: AgentRow): void {
    this.#db.insert(agents).values(row).run();
  }

  patchAgent(
    agentSessionId: string,
    name: string,
    patch: Partial<Pick<AgentRow,
      "sdkSessionId" | "generation" |
      "turnCount" | "contextTokens" | "profileSnapshot" | "profileId"
      |  "latestHandoffId" | "pendingCheckpointHandoffId"
      | "worktreePath" | "worktreeBaseCommit" | "worktreeBranch"
      | "salvageBranch" | "salvageArtifactId"
      | "lastActiveAt" | "cumulativeCostUsd" | "cumulativeApiDurationMs" | "lastDecisionAt"
    >>,
  ): void {
    this.#db
      .update(agents)
      .set(patch)
      .where(
        and(
          eq(agents.agentSessionId, agentSessionId),
          eq(agents.name, name),
        ),
      )
      .run();
  }

  /** Every agent currently bound to a worktree (boot orphan-recovery input). */
  listWorktreeAgents(): { agentSessionId: string; name: string; worktreePath: string }[] {
    return this.#db.select({ agentSessionId: agents.agentSessionId, name: agents.name, worktreePath: agents.worktreePath })
      .from(agents).where(isNotNull(agents.worktreePath)).all()
      .map((row) => ({ ...row, worktreePath: row.worktreePath! }));
  }
}
