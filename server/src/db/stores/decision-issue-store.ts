/**
 * decision_issues rows. Statements only — attachment policy, resolution
 * semantics, and the derived wire model stay in DecisionIssueService; the
 * partial unique index on (project, issue_key) among OPEN issues is the
 * attach-by-key idempotency substrate.
 */
import { and, eq } from "drizzle-orm";
import type { DecisionIssueResolution } from "@agentique-console/shared";
import type { Db } from "../client.ts";
import { decisionIssues } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type DecisionIssueRow = typeof decisionIssues.$inferSelect;

export class DecisionIssueStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: {
    projectId: string;
    userSessionId: string;
    issueKey: string | null;
    subject: string;
    requirementIds: string[];
    createdBy: string;
  }): DecisionIssueRow {
    const row: DecisionIssueRow = {
      id: newId("di"),
      projectId: input.projectId,
      userSessionId: input.userSessionId,
      issueKey: input.issueKey,
      subject: input.subject,
      status: "open",
      requirementIds: input.requirementIds,
      resolutions: [],
      supersededById: null,
      createdBy: input.createdBy,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.#db.insert(decisionIssues).values(row).run();
    return row;
  }

  get(id: string): DecisionIssueRow | undefined {
    return this.#db.select().from(decisionIssues).where(eq(decisionIssues.id, id)).get();
  }

  /** The open issue an explicit key attaches to, if one exists in this project. */
  findOpenByKey(projectId: string, issueKey: string): DecisionIssueRow | undefined {
    return this.#db
      .select()
      .from(decisionIssues)
      .where(
        and(
          eq(decisionIssues.projectId, projectId),
          eq(decisionIssues.issueKey, issueKey),
          eq(decisionIssues.status, "open"),
        ),
      )
      .get();
  }

  listByProject(projectId: string): DecisionIssueRow[] {
    return this.#db
      .select()
      .from(decisionIssues)
      .where(eq(decisionIssues.projectId, projectId))
      .orderBy(decisionIssues.createdAt)
      .all();
  }

  setRequirementIds(id: string, requirementIds: string[]): void {
    this.#db.update(decisionIssues).set({ requirementIds }).where(eq(decisionIssues.id, id)).run();
  }

  /** Append-only by convention: callers pass the prior history plus one entry. */
  setResolutions(id: string, resolutions: DecisionIssueResolution[], status: "open" | "resolved"): void {
    this.#db
      .update(decisionIssues)
      .set({ resolutions, status, resolvedAt: status === "resolved" ? nowIso() : null })
      .where(eq(decisionIssues.id, id))
      .run();
  }

  /** Merge: the source stops being an open identity and points at its target. */
  markSuperseded(id: string, intoId: string): void {
    this.#db
      .update(decisionIssues)
      .set({ status: "superseded", supersededById: intoId })
      .where(eq(decisionIssues.id, id))
      .run();
  }
}
