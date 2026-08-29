/** orchestration_state_revisions — main's working-state history, append-only. */
import { desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { orchestrationStateRevisions } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type OrchestrationStateRow = typeof orchestrationStateRevisions.$inferSelect;

export class OrchestrationStateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  current(userSessionId: string): OrchestrationStateRow | undefined {
    return this.#db.select().from(orchestrationStateRevisions)
      .where(eq(orchestrationStateRevisions.userSessionId, userSessionId))
      .orderBy(desc(orchestrationStateRevisions.revision)).get();
  }

  listForUserSession(userSessionId: string): OrchestrationStateRow[] {
    return this.#db.select().from(orchestrationStateRevisions)
      .where(eq(orchestrationStateRevisions.userSessionId, userSessionId))
      .orderBy(orchestrationStateRevisions.revision).all();
  }

  /** Section-replace over the previous revision; each row is the FULL state. */
  append(input: {
    userSessionId: string;
    trigger: OrchestrationStateRow["trigger"];
    strategy?: string;
    strategyWhy?: string;
    uncertainties?: string[];
    assumptions?: string[];
    risks?: string[];
    note?: string | null;
    completion?: Record<string, unknown> | null;
    objectiveAssessment?: OrchestrationStateRow["objectiveAssessment"];
  }): OrchestrationStateRow {
    const previous = this.current(input.userSessionId);
    const row: OrchestrationStateRow = {
      id: newId("ost"),
      userSessionId: input.userSessionId,
      revision: (previous?.revision ?? 0) + 1,
      trigger: input.trigger,
      strategy: input.strategy ?? previous?.strategy ?? "",
      strategyWhy: input.strategyWhy ?? previous?.strategyWhy ?? "",
      uncertainties: input.uncertainties ?? previous?.uncertainties ?? [],
      assumptions: input.assumptions ?? previous?.assumptions ?? [],
      risks: input.risks ?? previous?.risks ?? [],
      note: input.note ?? null,
      completion: input.completion ?? null,
      objectiveAssessment: input.objectiveAssessment ?? null,
      createdAt: nowIso(),
    };
    this.#db.insert(orchestrationStateRevisions).values(row).run();
    return row;
  }
}
