/**
 * interactions rows. Statements only — parking, routing, and resolution
 * policy stay in InteractionService; the DecisionLedger reads its decision
 * rows here (a decision IS a resolved interaction).
 */
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { interactions, userSessions } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type InteractionRow = typeof interactions.$inferSelect;
export type InteractionInsert = typeof interactions.$inferInsert;

export class InteractionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(values: InteractionInsert): void {
    this.#db.insert(interactions).values(values).run();
  }

  get(id: string): InteractionRow | undefined {
    return this.#db
      .select()
      .from(interactions)
      .where(eq(interactions.id, id))
      .get();
  }

  listByStatus(
    userSessionId: string,
    status: InteractionRow["status"],
  ): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.userSessionId, userSessionId),
          eq(interactions.status, status),
        ),
      )
      .all();
  }

  /** Every pending question across sessions — the auto-proceed sweep's scan. */
  listPendingQuestions(): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(and(eq(interactions.status, "pending"), eq(interactions.kind, "question")))
      .all();
  }

  findUnresolvedByDedupe(agentSessionId: string, dedupeKey: string): InteractionRow | undefined {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          eq(interactions.dedupeKey, dedupeKey),
          eq(interactions.status, "pending"),
        ),
      )
      .get();
  }

  listUnresolvedForAgentSession(agentSessionId: string): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          eq(interactions.status, "pending"),
        ),
      )
      .all();
  }

  listAnsweredUnflushed(agentSessionId: string, agent?: string): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          isNull(interactions.flushedAt),
          isNotNull(interactions.resolvedAt),
          ...(agent === undefined ? [] : [eq(interactions.participant, agent)]),
        ),
      )
      .all();
  }

  markFlushed(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = nowIso();
    for (const id of ids) {
      this.#db.update(interactions).set({ flushedAt: now }).where(eq(interactions.id, id)).run();
    }
  }

  markResolved(
    id: string,
    status: "answered" | "rejected" | "dismissed",
    response: Record<string, unknown>,
  ): void {
    this.#db
      .update(interactions)
      .set({ status, response, resolvedAt: nowIso() })
      .where(eq(interactions.id, id))
      .run();
  }

  setDetached(id: string): void {
    this.#db.update(interactions).set({ detached: true }).where(eq(interactions.id, id)).run();
  }

  /** Every ask participating in one decision issue, oldest first. */
  listByIssue(issueId: string): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(eq(interactions.issueId, issueId))
      .orderBy(interactions.createdAt)
      .all();
  }

  /** Merge relink: the source issue's asks now participate in the target. */
  reassignIssue(fromIssueId: string, toIssueId: string): string[] {
    const moved = this.listByIssue(fromIssueId).map((row) => row.id);
    this.#db
      .update(interactions)
      .set({ issueId: toIssueId })
      .where(eq(interactions.issueId, fromIssueId))
      .run();
    return moved;
  }

  markPendingMainStale(): void {
    this.#db
      .update(interactions)
      .set({ status: "stale" })
      .where(and(eq(interactions.status, "pending"), isNull(interactions.participant)))
      .run();
  }

  markPendingSeatsDetached(): void {
    this.#db
      .update(interactions)
      .set({ detached: true })
      .where(and(eq(interactions.status, "pending"), isNotNull(interactions.participant)))
      .run();
  }

  listPendingBlocking(agentSessionId: string): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          eq(interactions.status, "pending"),
          eq(interactions.urgency, "blocking"),
        ),
      )
      .all();
  }

  /** userSessionId -> open card count, for the sidebar's attention dots. */
  countPendingByUserSession(workspaceId: string): Map<string, number> {
    const rows = this.#db.select({ id: interactions.userSessionId })
      .from(interactions)
      .innerJoin(userSessions, eq(interactions.userSessionId, userSessions.id))
      .where(and(eq(userSessions.workspaceId, workspaceId), inArray(interactions.status, ["pending", "stale"])))
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return counts;
  }

  /**
   * The rows a decision can be read from: answered, a resolved plan approval,
   * or a question dismissed by a chat reply (its stored chatText IS the
   * answer — decisionOf filters the wordless dismissals).
   */
  listDecisionSourceRows(userSessionId: string): InteractionRow[] {
    return this.#db
      .select()
      .from(interactions)
      .where(and(
        eq(interactions.userSessionId, userSessionId),
        or(
          eq(interactions.status, "answered"),
          and(eq(interactions.kind, "plan_approval"), inArray(interactions.status, ["answered", "rejected"])),
          and(eq(interactions.kind, "question"), eq(interactions.status, "dismissed")),
        ),
      ))
      .all();
  }

  /**
   * Decision rows across EVERY session of a project — the Decision Ledger's
   * read under project continuity: a prior session's operator decisions still
   * govern a continued run.
   */
  listDecisionSourceRowsForProject(projectId: string): InteractionRow[] {
    return this.#db
      .select({ interaction: interactions })
      .from(interactions)
      .innerJoin(userSessions, eq(interactions.userSessionId, userSessions.id))
      .where(and(
        eq(userSessions.projectId, projectId),
        or(
          eq(interactions.status, "answered"),
          and(eq(interactions.kind, "plan_approval"), inArray(interactions.status, ["answered", "rejected"])),
          and(eq(interactions.kind, "question"), eq(interactions.status, "dismissed")),
        ),
      ))
      .all()
      .map((row) => row.interaction);
  }
}
