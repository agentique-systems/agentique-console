/**
 * The orchestrator's working state: the model-authored layer of the loop
 * state → calculus → move → evidence → state. Everything else the console
 * captures is what IT can know (spec, decisions, ledger, handoffs); this is
 * what only the model knows — strategy and why, open uncertainties, standing
 * assumptions, live risks — kept durable across rotations and injected into
 * main's own next generation, so junk here poisons the writer first.
 *
 * Section-replace semantics, no id-addressed patch grammar (models neglect id
 * collections — a live run's task ledger proved it). Updated on MATERIAL
 * events only; the cadence doctrine lives in the brief, and no hook enforces
 * it — a nag would produce exactly the ceremony this design avoids.
 */
import type { EventBus } from "../events/bus.ts";
import type { OrchestrationStateRow, OrchestrationStateStore } from "../db/stores/state-store.ts";

const DIGEST_MAX_BYTES = 2 * 1024;

export interface CompletionRecord {
  criteria: { criterion: string; met: boolean; evidence: { kind: string; ref: string }[] }[];
  knownGaps: string[];
  nonGoals: string[];
  /**
   * The approved spec revision these criteria were verified against. The
   * completion predicate requires it to match the CURRENT approved revision —
   * a record against a superseded spec is a stale claim, and a run with no
   * record at all must not propose done (a live run proposed completion of a
   * game with no window because the heuristic was "current ledger clean").
   */
  specRevision?: number;
}

export class OrchestrationStateService {
  readonly #store: OrchestrationStateStore;
  readonly #bus: EventBus;

  constructor(store: OrchestrationStateStore, bus: EventBus) {
    this.#store = store;
    this.#bus = bus;
  }

  current(userSessionId: string): OrchestrationStateRow | undefined {
    return this.#store.current(userSessionId);
  }

  history(userSessionId: string): OrchestrationStateRow[] {
    return this.#store.listForUserSession(userSessionId);
  }

  update(userSessionId: string, patch: {
    trigger: OrchestrationStateRow["trigger"];
    strategy?: string;
    strategyWhy?: string;
    uncertainties?: string[];
    assumptions?: string[];
    risks?: string[];
    note?: string;
    /** Evidence refs this update incorporates — journaled, never stored. */
    incorporating?: string[];
  }): OrchestrationStateRow {
    const { incorporating, ...sections } = patch;
    const row = this.#store.append({ userSessionId, ...sections });
    this.#emit(row, patch, incorporating);
    return row;
  }

  /** The criteria→evidence record main writes when it believes the run is done. */
  recordCompletion(userSessionId: string, completion: CompletionRecord, note?: string): OrchestrationStateRow {
    const row = this.#store.append({ userSessionId, trigger: "completion",
      completion: completion as unknown as Record<string, unknown>, note: note ?? null });
    this.#emit(row, { trigger: "completion" });
    return row;
  }

  latestCompletion(userSessionId: string): { revision: number; completion: CompletionRecord; createdAt: string } | null {
    const rows = this.#store.listForUserSession(userSessionId);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (row.trigger === "completion" && row.completion) {
        return { revision: row.revision, completion: row.completion as unknown as CompletionRecord, createdAt: row.createdAt };
      }
    }
    return null;
  }

  /** Injected into MAIN's prompt each generation. Empty when never written (cache rule). */
  digest(userSessionId: string): string {
    const current = this.#store.current(userSessionId);
    if (!current) return "";
    const list = (title: string, items: string[]): string =>
      items.length === 0 ? "" : `\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
    const body =
      `Strategy: ${current.strategy || "(none recorded)"}${current.strategyWhy ? ` — ${current.strategyWhy}` : ""}` +
      list("Open uncertainties", current.uncertainties) +
      list("Assumptions", current.assumptions) +
      list("Risks", current.risks) +
      `\n(rev ${current.revision}, ${current.trigger}${current.note ? `: ${current.note}` : ""})`;
    const capped = Buffer.byteLength(body, "utf8") > DIGEST_MAX_BYTES
      ? `${body.slice(0, DIGEST_MAX_BYTES)}\n…(truncated)` : body;
    return `## Your working state (as you last recorded it — amend on material change, never as ceremony)\n${capped}`;
  }

  /** Checkpoint lines: the state a successor generation must inherit. */
  lines(userSessionId: string): string[] {
    const current = this.#store.current(userSessionId);
    if (!current) return [];
    return [
      ...(current.strategy ? [`Strategy: ${current.strategy}${current.strategyWhy ? ` — ${current.strategyWhy}` : ""}`] : []),
      ...current.uncertainties.map((item) => `Uncertain: ${item}`),
      ...current.assumptions.map((item) => `Assumes: ${item}`),
      ...current.risks.map((item) => `Risk: ${item}`),
    ];
  }

  #emit(row: OrchestrationStateRow, patch: { trigger: OrchestrationStateRow["trigger"]; strategy?: string;
    uncertainties?: string[]; assumptions?: string[]; risks?: string[] }, incorporating?: string[]): void {
    const sections = (["strategy", "uncertainties", "assumptions", "risks"] as const)
      .filter((section) => patch[section] !== undefined);
    this.#bus.append({
      type: "user_session.state.updated",
      userSessionId: row.userSessionId,
      payload: { userSessionId: row.userSessionId, revision: row.revision, trigger: row.trigger,
        sections: row.trigger === "completion" ? ["completion"] : sections,
        ...(row.strategy === "" ? {} : { strategy: row.strategy.slice(0, 200) }),
        counts: { uncertainties: row.uncertainties.length, assumptions: row.assumptions.length, risks: row.risks.length },
        ...(incorporating === undefined || incorporating.length === 0 ? {} : { incorporating }) },
    });
  }
}
