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
  /** The requirement ids the question named — the decision is pinned to them. */
  requirementIds: string[];
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
export function specMarkerOf(payload: unknown): { revision: number; changeNote?: string; kind: "spec" | "requirements" } | null {
  const markers = payload as {
    spec?: { revision?: unknown; changeNote?: unknown };
    requirements?: { revision?: unknown; changeNote?: unknown };
  } | null | undefined;
  const marker = markers?.requirements ?? markers?.spec;
  if (!marker || typeof marker.revision !== "number") return null;
  return {
    revision: marker.revision,
    kind: markers?.requirements !== undefined ? "requirements" : "spec",
    ...(typeof marker.changeNote === "string" && marker.changeNote !== "" ? { changeNote: marker.changeNote } : {}),
  };
}

/** One question string for a plan_approval row, spec/requirements-aware. */
export function planDecisionQuestion(payload: unknown): string {
  const marker = specMarkerOf(payload);
  if (!marker) return "Plan approval";
  return marker.kind === "requirements"
    ? `Requirements approval (rev ${marker.revision})`
    : `Specification approval (rev ${marker.revision})`;
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
  const noun = marker.kind === "requirements" ? "requirements" : "specification";
  return {
    question: planDecisionQuestion(payload),
    answer: `${approved ? "Approved" : "Requested changes to"} ${noun} revision ${marker.revision}${change}${suffix}`,
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
  const payloadIds = (row.payload as { requirementIds?: unknown } | null | undefined)?.requirementIds;
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
    requirementIds: Array.isArray(payloadIds) ? payloadIds.filter((id): id is string => typeof id === "string") : [],
    createdAt: row.resolvedAt ?? row.createdAt,
  };
}

export class DecisionLedger {
  readonly #interactions: InteractionStore;
  readonly #resolveProject: (userSessionId: string) => string;

  constructor(interactions: InteractionStore, resolveProject: (userSessionId: string) => string) {
    this.#interactions = interactions;
    this.#resolveProject = resolveProject;
  }

  /**
   * Project-wide: a continued session inherits every decision recorded across
   * the project's prior sessions — an operator decision outlives the session
   * it was made in.
   */
  list(userSessionId: string): OperatorDecision[] {
    return this.#interactions.listDecisionSourceRowsForProject(this.#resolveProject(userSessionId))
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
   * The bounded block injected into an agent's system prompt. Newest first so
   * a truncation drops the oldest, and capped in BYTES as well as entries — a
   * long run must not silently push the checkpoint out of the prompt.
   *
   * `pinned` (see `decisionPin`) partitions by RELEVANCE, not only recency:
   * decisions whose named requirements are still live and unsatisfied in the
   * caller's scope render first (chronological) and survive the caps
   * preferentially — recency alone would age a foundational decision out of
   * a long project's prompt exactly when a seat needs it most.
   */
  digest(userSessionId: string, opts: { pinned?: (requirementIds: string[]) => boolean } = {}): string {
    const all = this.list(userSessionId);
    const pinnedRows = opts.pinned === undefined
      ? []
      : all.filter((row) => row.requirementIds.length > 0 && opts.pinned!(row.requirementIds));
    const pinnedIds = new Set(pinnedRows.map((row) => row.id));
    const recent = all.filter((row) => !pinnedIds.has(row.id)).reverse();
    const ordered = [...pinnedRows, ...recent];
    const lines: string[] = [];
    let bytes = 0;
    let dropped = 0;
    for (const row of ordered.slice(0, DIGEST_MAX_ENTRIES)) {
      const line = `- ${renderDecision(row)}`;
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > DIGEST_MAX_BYTES) { dropped += 1; continue; }
      lines.push(line);
      bytes += size;
    }
    const omitted = dropped + Math.max(0, ordered.length - DIGEST_MAX_ENTRIES);
    if (omitted > 0) lines.push(`- (${omitted} older decision(s) omitted; they still stand)`);
    return lines.join("\n");
  }

}

/** One canonical rendering, so every consumer says the same thing. */
export function renderDecision(row: OperatorDecision): string {
  const note = row.note === null || row.note === "" ? "" : ` (${row.note})`;
  const ids = row.requirementIds.length === 0 ? "" : ` [${row.requirementIds.join(", ")}]`;
  return `${row.question} → ${row.answer}${note}${ids}`;
}

/**
 * The pinning predicate for `DecisionLedger.digest`: a decision stays pinned
 * while any requirement it names is live and not yet satisfied — a settled or
 * retired obligation lets its decisions age out like any other. `scope`
 * narrows to a seat's world (its delegated subtrees plus their ancestors);
 * absent, the whole graph is the scope (main).
 */
export function decisionPin(
  nodes: readonly { id: string; derivedStatus: string }[],
  scope?: ReadonlySet<string>,
): (requirementIds: string[]) => boolean {
  const unsatisfied = new Set(
    nodes.filter((node) => node.derivedStatus !== "satisfied" && node.derivedStatus !== "retired")
      .map((node) => node.id),
  );
  return (requirementIds) =>
    requirementIds.some((id) => unsatisfied.has(id) && (scope === undefined || scope.has(id)));
}
