/**
 * assumptions rows — recorded premises the work proceeds on. Statements only;
 * lifecycle policy (provenance rules, wake notes, rests_on links) lives in
 * AssumptionService. Ids ("a1", …) are project-lifetime and never reused —
 * the requirement-id discipline, same scan.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { assumptions } from "../schema.ts";
import { nowIso } from "../../ids.ts";

export type AssumptionRow = typeof assumptions.$inferSelect;

export class AssumptionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(projectId: string, id: string): AssumptionRow | undefined {
    return this.#db.select().from(assumptions)
      .where(and(eq(assumptions.projectId, projectId), eq(assumptions.id, id))).get();
  }

  list(projectId: string): AssumptionRow[] {
    return this.#db.select().from(assumptions)
      .where(eq(assumptions.projectId, projectId))
      .orderBy(assumptions.createdAt).all();
  }

  listByStatus(projectId: string, statuses: AssumptionRow["status"][]): AssumptionRow[] {
    return this.#db.select().from(assumptions)
      .where(and(eq(assumptions.projectId, projectId), inArray(assumptions.status, statuses)))
      .orderBy(assumptions.createdAt).all();
  }

  /** Highest minted numeric id ("a7" → 7); retired/resolved included — never reused. */
  maxAssumptionNumber(projectId: string): number {
    let max = 0;
    for (const row of this.list(projectId)) {
      const match = /^a(\d+)$/.exec(row.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  /** The highest resolution ordinal — half of the shared invalidation clock. */
  maxResolvedOrd(projectId: string): number {
    const row = this.#db.select().from(assumptions)
      .where(eq(assumptions.projectId, projectId))
      .orderBy(desc(assumptions.resolvedOrd)).get();
    return row?.resolvedOrd ?? 0;
  }

  insert(input: {
    projectId: string;
    id: string;
    text: string;
    source: "operator" | "main" | "agent";
    actor: string;
    agentSessionId?: string | null;
    interactionId?: string | null;
  }): AssumptionRow {
    const row: AssumptionRow = {
      id: input.id,
      projectId: input.projectId,
      text: input.text,
      status: "open",
      source: input.source,
      agentSessionId: input.agentSessionId ?? null,
      interactionId: input.interactionId ?? null,
      actor: input.actor,
      resolutionNote: null,
      resolutionEvidence: null,
      resolvedOrd: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.#db.insert(assumptions).values(row).run();
    return row;
  }

  resolve(input: {
    projectId: string;
    id: string;
    status: "confirmed" | "falsified" | "retired";
    actor: string;
    note?: string | null;
    evidence?: { kind: string; ref: string; label?: string }[] | null;
    interactionId?: string | null;
    resolvedOrd: number;
  }): AssumptionRow {
    this.#db.update(assumptions).set({
      status: input.status,
      actor: input.actor,
      resolutionNote: input.note ?? null,
      resolutionEvidence: input.evidence ?? null,
      ...(input.interactionId === undefined || input.interactionId === null ? {} : { interactionId: input.interactionId }),
      resolvedOrd: input.resolvedOrd,
      resolvedAt: nowIso(),
    }).where(and(eq(assumptions.projectId, input.projectId), eq(assumptions.id, input.id))).run();
    return this.get(input.projectId, input.id)!;
  }
}
