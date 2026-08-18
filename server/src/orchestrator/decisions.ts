/**
 * The Decision Ledger: what the operator has actually decided, as durable
 * state every agent can read.
 *
 * This is a READ-MODEL, not a table. A decision IS a resolved interaction row
 * — the answers, the asker, the note and the auto-taken flag all already live
 * there durably. One source of truth, one mapper (`decisionOf`), one renderer
 * (`renderDecision`), read back into every agent's prompt.
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

/** The spec marker a living-spec card carries in its plan_approval payload. */
export function specMarkerOf(payload: unknown): { revision: number; changeNote?: string } | null {
  const spec = (payload as { spec?: { revision?: unknown; changeNote?: unknown } } | null | undefined)?.spec;
  if (!spec || typeof spec.revision !== "number") return null;
  return {
    revision: spec.revision,
    ...(typeof spec.changeNote === "string" && spec.changeNote !== "" ? { changeNote: spec.changeNote } : {}),
  };
}

/** One question string for a plan_approval row, spec-aware. */
export function planDecisionQuestion(payload: unknown): string {
  const marker = specMarkerOf(payload);
  return marker ? `Specification approval (rev ${marker.revision})` : "Plan approval";
}

/**
 * One renderer for every consumer of a plan_approval decision. Plain plans
 * keep the historical strings byte-for-byte; spec-marked rows say WHICH
 * revision changed and why — the per-delivery decision delta is how a
 * running seat learns the governing spec moved, and a generic
 * "Approved the plan" line told it nothing.
 */
export function planDecisionStrings(payload: unknown, approved: boolean, note?: string): { question: string; answer: string } {
  const marker = specMarkerOf(payload);
  const suffix = note === undefined ? "" : `: ${note}`;
  if (!marker) {
    return { question: "Plan approval", answer: `${approved ? "Approved the plan" : "Requested changes to the plan"}${suffix}` };
  }
  const change = marker.changeNote === undefined ? "" : ` — ${marker.changeNote}`;
  return {
    question: `Specification approval (rev ${marker.revision})`,
    answer: `${approved ? "Approved" : "Requested changes to"} specification revision ${marker.revision}${change}${suffix}`,
  };
}

/**
 * The decision a resolved interaction records, or null when it records none
 * (unresolved, contentless, or dismissed WITHOUT words). Rejected plans count
 * — "requested changes" is a decision the run must respect. So does a
 * question the operator answered in CHAT: the dismissal stores their words as
 * `chatText`, and "use three.js" typed into the input box is no less binding
 * than a clicked option.
 */
export function decisionOf(row: DecisionSourceRow): OperatorDecision | null {
  const isPlan = row.kind === "plan_approval";
  const response = (row.response ?? {}) as {
    answers?: Record<string, string[]>; freeText?: Record<string, string>;
    note?: string; decision?: string; chatText?: string;
  };
  const chatAnswered = !isPlan && row.status === "dismissed" &&
    typeof response.chatText === "string" && response.chatText.trim() !== "";
  if (row.status !== "answered" && !(isPlan && row.status === "rejected") && !chatAnswered) return null;
  const planStrings = isPlan ? planDecisionStrings(row.payload, response.decision === "approve", response.note) : null;
  const question = planStrings
    ? planStrings.question
    : ((row.payload as { questions?: InteractionQuestion[] }).questions ?? []).map((q) => q.question).join(" | ");
  const answer = planStrings
    ? planStrings.answer
    : chatAnswered
      ? `(in chat) ${response.chatText!.trim()}`
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
   * The bounded block injected into an agent's system prompt. Newest first so a
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
