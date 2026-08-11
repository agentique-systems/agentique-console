/**
 * The Decision Ledger: what the operator has actually decided, as durable
 * state every agent can read.
 *
 * Before this existed, an operator answer was a side effect of one tool call.
 * `AskUserQuestion`'s answer lived in `updatedInput.answers` inside a single
 * provider transcript and died at that session's next rotation. A coordinator's
 * escalation returned the answer to exactly one seat, and its siblings never
 * learned it. The cost, from db-live-1: the operator was asked one reserved
 * question ("dodge obstacles or collect targets?"), answered it in 11.8
 * seconds, and the word "dodge" then appeared in ZERO of the three
 * specialists' sessions.
 *
 * This is a READ-MODEL, not a table. A decision IS a resolved interaction row
 * — the answers, the asker, the note and the auto-taken flag all already live
 * there durably — so a second `operator_decisions` table was a projection of
 * facts stored one join away, with a writer to keep in sync and its own copy
 * of every rendering. One source of truth, one mapper (`decisionOf`), one
 * renderer (`renderDecision`), read back into every seat's prompt.
 */
import type { InteractionStore } from "../db/stores/interaction-store.ts";
import type { InteractionQuestion } from "@agentique-console/shared";

export type DecisionSource = "interaction" | "plan_approval";

export interface OperatorDecision {
  id: string;
  userSessionId: string;
  agentSessionId: string | null;
  interactionId: string;
  askedBy: string;
  source: DecisionSource;
  question: string;
  answer: string;
  note: string | null;
  /** When the operator decided — the interaction's resolution time. */
  createdAt: string;
}

/** The structural slice of an interaction (row or wire) a decision reads. */
export interface DecisionSourceRow {
  id: string;
  userSessionId: string;
  agentSessionId: string | null;
  agent: string | null;
  kind: string;
  status: string;
  payload: unknown;
  response: unknown;
  resolvedAt?: string | null;
  createdAt: string;
}

/** Bounds on the digest injected into prompts. Newest first, oldest dropped. */
const DIGEST_MAX_ENTRIES = 40;
const DIGEST_MAX_BYTES = 4 * 1024;

/** Chosen labels plus anything the operator typed, as one readable answer. */
export function renderAnswer(answers: Record<string, string[]>, freeText?: Record<string, string>): string {
  const chosen = Object.values(answers).flat().filter((label) => label !== "");
  const typed = Object.values(freeText ?? {}).filter((text) => text.trim() !== "");
  return [...chosen, ...typed].join(" · ");
}

/**
 * The decision a resolved interaction records, or null when it records none
 * (unresolved, dismissed, or contentless). Rejected plans count — "requested
 * changes" is a decision the run must respect.
 */
export function decisionOf(row: DecisionSourceRow): OperatorDecision | null {
  const isPlan = row.kind === "plan_approval";
  if (row.status !== "answered" && !(isPlan && row.status === "rejected")) return null;
  const response = (row.response ?? {}) as {
    answers?: Record<string, string[]>; freeText?: Record<string, string>;
    note?: string; decision?: string;
  };
  const question = isPlan
    ? "Plan approval"
    : ((row.payload as { questions?: InteractionQuestion[] }).questions ?? []).map((q) => q.question).join(" | ");
  const answer = isPlan
    ? `${response.decision === "approve" ? "Approved the plan" : "Requested changes to the plan"}${response.note === undefined ? "" : `: ${response.note}`}`
    : renderAnswer(response.answers ?? {}, response.freeText);
  if (question === "" && answer === "") return null;
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    agentSessionId: row.agentSessionId,
    interactionId: row.id,
    // Attribution matters: "renderer asked this" reads very differently from
    // "the console asked this" when the operator reviews the run.
    askedBy: row.agent ?? "main",
    source: isPlan ? "plan_approval" : "interaction",
    question,
    answer,
    note: isPlan ? null : (response.note ?? null),
    createdAt: row.resolvedAt ?? row.createdAt,
  };
}

export class DecisionLedger {
  readonly #interactions: InteractionStore;

  constructor(interactions: InteractionStore) {
    this.#interactions = interactions;
  }

  list(userSessionId: string): OperatorDecision[] {
    return this.#interactions.listDecisionSourceRows(userSessionId)
      .map((row) => decisionOf({ ...row, agent: row.participant }))
      .filter((decision): decision is OperatorDecision => decision !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Decisions made strictly after an ISO watermark. Feeds the per-delivery delta. */
  since(userSessionId: string, watermark: string | null): OperatorDecision[] {
    const rows = this.list(userSessionId);
    return watermark === null ? rows : rows.filter((row) => row.createdAt > watermark);
  }

  /** One line per decision, newest-relevant last, for prompt injection. */
  lines(userSessionId: string, opts: { max?: number } = {}): string[] {
    const rows = this.list(userSessionId);
    const kept = opts.max === undefined ? rows : rows.slice(-opts.max);
    return kept.map((row) => renderDecision(row));
  }

  /**
   * The bounded block injected into a seat's system prompt. Newest first so a
   * truncation drops the oldest, and capped in BYTES as well as entries — a
   * long run must not silently push the checkpoint out of the prompt.
   */
  digest(userSessionId: string): string {
    const rows = this.list(userSessionId).reverse();
    const lines: string[] = [];
    let bytes = 0;
    let dropped = 0;
    for (const row of rows.slice(0, DIGEST_MAX_ENTRIES)) {
      const line = `- ${renderDecision(row)}`;
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > DIGEST_MAX_BYTES) { dropped += 1; continue; }
      lines.push(line);
      bytes += size;
    }
    const omitted = dropped + Math.max(0, rows.length - DIGEST_MAX_ENTRIES);
    if (omitted > 0) lines.push(`- (${omitted} older decision(s) omitted; they still stand)`);
    return lines.join("\n");
  }

}

/** One canonical rendering, so every consumer says the same thing. */
export function renderDecision(row: OperatorDecision): string {
  const note = row.note === null || row.note === "" ? "" : ` (${row.note})`;
  return `${row.question} → ${row.answer}${note}`;
}
