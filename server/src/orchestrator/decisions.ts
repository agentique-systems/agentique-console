/**
 * The Decision Ledger: what the operator has actually decided, as durable
 * state every agent can read.
 *
 * Before this existed, an operator answer was a side effect of one tool call.
 * `AskUserQuestion`'s answer lived in `updatedInput.answers` inside a single
 * provider transcript and died at that session's next rotation. A coordinator's
 * escalation returned the answer to exactly one seat, and its siblings never
 * learned it. `CoordinationHandoffData.operatorDecisions` was declared in the
 * shared types and never written by anything.
 *
 * The cost, from db-live-1: the operator was asked one reserved question
 * ("dodge obstacles or collect targets?"), answered it in 11.8 seconds, and the
 * word "dodge" then appeared in ZERO of the three specialists' sessions. They
 * built the right game only because the operator's own prompt text independently
 * implied it. Had they answered "collect", that run builds the wrong thing and
 * nobody notices until the end.
 *
 * So: one row per decision, one writer, and read back into every seat's prompt.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { operatorDecisions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";

export type DecisionSource = "interaction" | "plan_approval" | "ttl_default";

export interface OperatorDecision {
  id: string;
  userSessionId: string;
  agentSessionId: string | null;
  interactionId: string | null;
  askedBy: string;
  source: DecisionSource;
  question: string;
  answer: string;
  note: string | null;
  autoTaken: boolean;
  supersededBy: string | null;
  createdAt: string;
}

export interface RecordDecisionInput {
  userSessionId: string;
  agentSessionId?: string | null;
  interactionId?: string | null;
  askedBy: string;
  source: DecisionSource;
  question: string;
  answer: string;
  note?: string | null;
  autoTaken?: boolean;
}

/** Bounds on the digest injected into prompts. Newest first, oldest dropped. */
const DIGEST_MAX_ENTRIES = 40;
const DIGEST_MAX_BYTES = 4 * 1024;

/**
 * `name@1.2.3` and three.js-style `r160` pins inside an answer. Deliberately
 * syntax-agnostic, matching `dependencyPinsInPatch`'s approach: the point is to
 * recognise that the operator NAMED a version, so a later substitution can be
 * detected, not to parse a package manifest.
 */
const PIN_RE = /(?:^|[\s"'`(/@])([a-z][a-z0-9._-]{1,40})[@ ]v?(\d+\.\d+(?:\.\d+)?|r\d{2,3})\b/gi;

export class DecisionLedger {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  record(input: RecordDecisionInput): OperatorDecision {
    const row: OperatorDecision = {
      id: newId("decision"),
      userSessionId: input.userSessionId,
      agentSessionId: input.agentSessionId ?? null,
      interactionId: input.interactionId ?? null,
      askedBy: input.askedBy,
      source: input.source,
      question: input.question,
      answer: input.answer,
      note: input.note ?? null,
      autoTaken: input.autoTaken ?? false,
      supersededBy: null,
      createdAt: nowIso(),
    };
    this.#db.insert(operatorDecisions).values(row).run();
    this.#bus.append({
      type: "operator.decision.recorded",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: {
        sessionId: row.userSessionId,
        decisionId: row.id,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        ...(row.interactionId ? { interactionId: row.interactionId } : {}),
        askedBy: row.askedBy,
        source: row.source,
        question: row.question,
        answer: row.answer,
        ...(row.autoTaken ? { autoTaken: true } : {}),
      },
    });
    return row;
  }

  list(userSessionId: string): OperatorDecision[] {
    return this.#db
      .select()
      .from(operatorDecisions)
      .where(eq(operatorDecisions.userSessionId, userSessionId))
      .orderBy(operatorDecisions.createdAt)
      .all();
  }

  /** Decisions recorded strictly after an ISO watermark. Feeds the per-delivery delta. */
  since(userSessionId: string, watermark: string | null): OperatorDecision[] {
    if (watermark === null) return this.list(userSessionId);
    return this.#db
      .select()
      .from(operatorDecisions)
      .where(and(eq(operatorDecisions.userSessionId, userSessionId), gt(operatorDecisions.createdAt, watermark)))
      .orderBy(operatorDecisions.createdAt)
      .all();
  }

  /** One line per decision, newest-relevant last, for prompt injection. */
  lines(userSessionId: string, opts: { max?: number } = {}): string[] {
    const rows = this.list(userSessionId).filter((row) => row.supersededBy === null);
    const kept = opts.max === undefined ? rows : rows.slice(-opts.max);
    return kept.map((row) => renderDecision(row));
  }

  /**
   * The bounded block injected into a seat's system prompt. Newest first so a
   * truncation drops the oldest, and capped in BYTES as well as entries — a
   * long run must not silently push the checkpoint out of the prompt.
   */
  digest(userSessionId: string): string {
    const rows = this.list(userSessionId).filter((row) => row.supersededBy === null).reverse();
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

  /**
   * Dependency → version the operator named, parsed from their answers.
   * Consumed by the uncertainty classifier so "shipped r169, they said r160"
   * is recognisable as a spec deviation rather than a note nobody reads.
   */
  pins(userSessionId: string): Map<string, string> {
    const pins = new Map<string, string>();
    for (const row of this.list(userSessionId)) {
      for (const text of [row.question, row.answer]) {
        for (const match of text.matchAll(PIN_RE)) {
          const name = (match[1] as string).toLowerCase();
          // The ANSWER wins over the question: the operator's chosen value
          // outranks whatever the options offered.
          if (text === row.answer || !pins.has(name)) pins.set(name, match[2] as string);
        }
      }
    }
    return pins;
  }

  /** Raw answer strings, for substring checks against a seat's uncertainty. */
  constraints(userSessionId: string): string[] {
    return this.list(userSessionId)
      .filter((row) => row.supersededBy === null)
      .map((row) => row.answer)
      .filter((answer) => answer.trim() !== "");
  }

  /** A later decision replaces an earlier one; the original stays for the record. */
  supersede(id: string, byId: string): void {
    this.#db.update(operatorDecisions).set({ supersededBy: byId }).where(eq(operatorDecisions.id, id)).run();
  }

  latestAt(userSessionId: string): string | null {
    const row = this.#db
      .select({ createdAt: operatorDecisions.createdAt })
      .from(operatorDecisions)
      .where(eq(operatorDecisions.userSessionId, userSessionId))
      .orderBy(desc(operatorDecisions.createdAt))
      .get();
    return row?.createdAt ?? null;
  }
}

/** One canonical rendering, so every consumer says the same thing. */
export function renderDecision(row: OperatorDecision): string {
  const note = row.note === null || row.note === "" ? "" : ` (${row.note})`;
  const auto = row.autoTaken ? " [auto-taken on timeout, NOT chosen by the operator]" : "";
  return `${row.question} → ${row.answer}${note}${auto}`;
}
