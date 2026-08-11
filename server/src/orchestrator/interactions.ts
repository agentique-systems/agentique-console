/**
 * Human-in-the-loop interactions: every question anyone puts to the operator.
 *
 * Two askers, one table. The main lane's `AskUserQuestion`/`ExitPlanMode` park
 * inside `canUseTool`; a seat's `ask_operator` parks inside its MCP handler.
 * Rows are durable, the promise is not — so `detached` marks a row whose asker
 * has gone (park, rotation, watchdog, restart) but whose answer is still wanted
 * and is delivered by mailbox instead of by return.
 *
 * What db-live-1 and db-live-2 taught this file:
 *  - a seat could not reach the operator at all, so a specialist that KNEW the
 *    deliverable was broken had to hope its coordinator would relay it. It
 *    didn't.
 *  - chat dismissed every pending card, including ones raised inside an
 *    AgentSession, telling a seat that cannot read operator chat to "read their
 *    next message".
 *  - a non-blocking decision lived in an in-memory map and was dropped whenever
 *    no further material report happened to arrive.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type {
  Interaction,
  InteractionQuestion,
  InteractionSource,
  InteractionUrgency,
  ResolveInteractionBody,
} from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { interactions } from "../db/schema.ts";
import { renderAnswer } from "./decisions.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { ConflictError, NotFoundError, InvalidInputError } from "../errors.ts";

export type InteractionResolution =
  | {
      kind: "answers";
      answers: Record<string, string[]>;
      freeText?: Record<string, string>;
      note?: string;
    }
  | { kind: "decision"; approved: boolean; note?: string }
  | { kind: "dismissed"; reason: string };

type InteractionRow = typeof interactions.$inferSelect;

function toWire(row: InteractionRow): Interaction {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    agentSessionId: row.agentSessionId,
    participant: row.participant,
    kind: row.kind,
    status: row.status,
    urgency: row.urgency,
    source: row.source,
    recommendation: row.recommendation,
    allowFreeText: row.allowFreeText,
    detached: row.detached,
    payload: row.payload as Interaction["payload"],
    response: row.response ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** Collapses whitespace and case so a re-asked question is recognisably the same one. */
export function dedupeKeyFor(asker: string, question: string): string {
  return `${asker}\n${question.trim().toLowerCase().replace(/\s+/g, " ")}`.slice(0, 400);
}

/**
 * The prompt for an answer-revival turn: the interaction's promise died with a
 * previous process, so the answer arrives as a fresh resumed turn instead.
 * Main lane only — a seat is revived by mailbox delivery, not by lane revival.
 */
export function revivalPrompt(
  interaction: Interaction,
  body: ResolveInteractionBody,
): string {
  const asked =
    interaction.kind === "question"
      ? `you asked the operator: ${JSON.stringify(
          (interaction.payload as { questions: InteractionQuestion[] }).questions.map(
            (q) => q.question,
          ),
        )}`
      : "you proposed a plan for approval";
  const answered =
    "answers" in body
      ? `They have now answered: ${JSON.stringify(body.answers)}.${
          body.freeText === undefined ? "" : ` In their own words: ${JSON.stringify(body.freeText)}.`
        }`
      : body.decision === "approve"
        ? `They have now approved it.${body.note === undefined ? "" : ` Note: ${body.note}`}`
        : `They asked for changes: ${body.note ?? "(no note)"}.`;
  return `[console] Earlier (before a server restart) ${asked}. ${answered} Continue from there.`;
}

export interface CreateOperatorQuestionInput {
  userSessionId: string;
  /** Null/absent = the main lane. */
  agentSessionId?: string | null;
  participant?: string | null;
  questions: InteractionQuestion[];
  urgency?: InteractionUrgency;
  source?: InteractionSource;
  recommendation?: string;
  allowFreeText?: boolean;
  dedupeKey?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}

export class InteractionService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #pending = new Map<string, (res: InteractionResolution) => void>();
  /** Fired when a session's last unresolved BLOCKING row resolves — see the final gate. */
  #onBlockingCleared: ((userSessionId: string, agentSessionId: string) => void) | undefined;
  /** Notified whenever any card resolves; the completion predicate re-evaluates. */
  #onResolved: ((userSessionId: string) => void) | undefined;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  /**
   * The host registers this so a withheld `final` is not answered by silence:
   * when the last blocking question clears, the coordinator is told it may now
   * report.
   */
  onBlockingCleared(handler: (userSessionId: string, agentSessionId: string) => void): void {
    if (this.#onBlockingCleared) throw new Error("onBlockingCleared is already registered — wire callbacks once, in createApp");
    this.#onBlockingCleared = handler;
  }

  onResolved(handler: (userSessionId: string) => void): void {
    if (this.#onResolved) throw new Error("onResolved is already registered — wire callbacks once, in createApp");
    this.#onResolved = handler;
  }

  /** Creates a pending question card and parks its resolution promise. */
  createQuestion(
    userSessionId: string,
    questions: InteractionQuestion[],
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    return this.createOperatorQuestion({
      userSessionId,
      questions,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  createOperatorQuestion(
    input: CreateOperatorQuestionInput,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const urgency = input.urgency ?? "blocking";
    const source = input.source ?? "agent";
    return this.#create(
      input.userSessionId,
      "question",
      { questions: input.questions },
      input.toolUseId,
      input.signal,
      {
        agentSessionId: input.agentSessionId ?? null,
        participant: input.participant ?? null,
        urgency,
        source,
        recommendation: input.recommendation ?? null,
        dedupeKey: input.dedupeKey ?? null,
        allowFreeText: input.allowFreeText ?? false,
      },
      (id) => {
        this.#bus.append({
          type: "user_session.question.asked",
          userSessionId: input.userSessionId,
          ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
          payload: {
            sessionId: input.userSessionId,
            interactionId: id,
            questions: input.questions,
            ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
            ...(input.participant ? { participant: input.participant } : {}),
            urgency,
            source,
            ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
            allowFreeText: input.allowFreeText ?? false,
          },
        });
      },
    );
  }

  /** Creates a pending plan-approval card and parks its resolution promise. */
  createPlanApproval(
    userSessionId: string,
    plan: string,
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    return this.#create(
      userSessionId,
      "plan_approval",
      { plan },
      toolUseId,
      signal,
      {},
      (id) => {
        this.#bus.append({
          type: "user_session.plan.proposed",
          userSessionId,
          payload: { sessionId: userSessionId, interactionId: id, plan },
        });
      },
    );
  }

  #create(
    userSessionId: string,
    kind: "question" | "plan_approval",
    payload: Record<string, unknown>,
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
    extra: Partial<InteractionRow>,
    emit: (id: string) => void,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const id = newId("int");
    const participant = extra.participant ?? null;
    this.#db
      .insert(interactions)
      .values({
        id,
        userSessionId,
        kind,
        status: "pending",
        payload,
        response: null,
        toolUseId: toolUseId ?? null,
        createdAt: nowIso(),
        resolvedAt: null,
        ...extra,
      })
      .run();
    emit(id);
    const resolution = new Promise<InteractionResolution>((resolve) => {
      this.#pending.set(id, resolve);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.delete(id)) return;
          if (participant === null) {
            // Main lane: the turn is gone and the operator's answer will come
            // back as a resumed turn, so the card is done.
            this.#markResolved(id, "dismissed", { reason: "turn aborted" });
            resolve({ kind: "dismissed", reason: "the turn was interrupted" });
            return;
          }
          // A SEAT's question outlives its turn. Park, rotation and the
          // watchdog all tear the lane down; the operator has still been asked
          // and the answer still matters. Keep the row pending and mark it
          // detached so answering delivers by mailbox.
          this.#detachRow(id, "the asking turn ended before you answered");
          resolve({ kind: "dismissed", reason: "your turn ended before the operator answered; the question stays open and their answer will reach you as a delivery" });
        },
        { once: true },
      );
    });
    return { id, resolution };
  }

  /** REST answer endpoint. 409s when the interaction is already resolved. */
  resolveFromApi(
    userSessionId: string,
    interactionId: string,
    body: ResolveInteractionBody,
  ): Interaction {
    const row = this.#db
      .select()
      .from(interactions)
      .where(eq(interactions.id, interactionId))
      .get();
    if (!row || row.userSessionId !== userSessionId) {
      throw new NotFoundError(`no interaction ${interactionId}`);
    }
    if (row.status !== "pending" && row.status !== "stale") {
      throw new ConflictError(`interaction ${interactionId} is already ${row.status}`);
    }

    if ("answers" in body) {
      if (row.kind !== "question") {
        throw new InvalidInputError("answers apply to question interactions");
      }
      if (body.freeText !== undefined && !row.allowFreeText) {
        throw new InvalidInputError("this question does not accept a free-text answer");
      }
      this.#markResolved(interactionId, "answered", {
        answers: body.answers,
        ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#bus.append({
        type: "user_session.question.answered",
        userSessionId,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        payload: {
          sessionId: userSessionId,
          interactionId,
          answers: body.answers,
          ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      });
      this.#recordDecision(row, {
        answer: renderAnswer(body.answers, body.freeText),
        ...(body.note === undefined ? {} : { note: body.note }),
        source: "interaction",
      });
      this.#pending.get(interactionId)?.({
        kind: "answers",
        answers: body.answers,
        ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#pending.delete(interactionId);
      this.#notifyIfBlockingCleared(row);
    } else {
      if (row.kind !== "plan_approval") {
        throw new InvalidInputError("decisions apply to plan_approval interactions");
      }
      const approved = body.decision === "approve";
      this.#markResolved(interactionId, approved ? "answered" : "rejected", {
        decision: body.decision,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#bus.append({
        type: "user_session.plan.resolved",
        userSessionId,
        payload: {
          sessionId: userSessionId,
          interactionId,
          approved,
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      });
      // A plan approval IS an operator decision — the largest one they make.
      this.#recordDecision(row, {
        answer: `${approved ? "Approved the plan" : "Requested changes to the plan"}${body.note === undefined ? "" : `: ${body.note}`}`,
        source: "plan_approval",
      });
      this.#pending.get(interactionId)?.({
        kind: "decision",
        approved,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#pending.delete(interactionId);
    }
    return this.get(interactionId);
  }

  /**
   * Operator chatted while cards were pending.
   *
   * MAIN-LANE cards are dismissed: the model is about to read the operator's
   * actual message, which is a better answer than the card would have been.
   *
   * SEAT cards are NOT. A seat has no access to the operator's chat lane — only
   * main does — so resolving one with "read their next message" hands a seat an
   * instruction it cannot follow, and silently drops a question a specialist
   * thought was important enough to stop for.
   */
  dismissPendingForChat(userSessionId: string, chatText: string): void {
    const rows = this.#listByStatus(userSessionId, "pending");
    let held = 0;
    for (const row of rows) {
      if (row.participant !== null) {
        held += 1;
        continue;
      }
      if (row.kind === "plan_approval") {
        this.#markResolved(row.id, "rejected", {
          decision: "reject",
          note: chatText,
        });
        this.#bus.append({
          type: "user_session.plan.resolved",
          userSessionId,
          payload: {
            sessionId: userSessionId,
            interactionId: row.id,
            approved: false,
            note: chatText,
          },
        });
        this.#pending.get(row.id)?.({
          kind: "decision",
          approved: false,
          note: chatText,
        });
      } else {
        this.#markResolved(row.id, "dismissed", { reason: "chat" });
        this.#bus.append({
          type: "user_session.question.answered",
          userSessionId,
          payload: {
            sessionId: userSessionId,
            interactionId: row.id,
            dismissed: true,
          },
        });
        this.#pending.get(row.id)?.({
          kind: "dismissed",
          reason:
            "The operator replied in chat instead — read their next message.",
        });
      }
      this.#pending.delete(row.id);
    }
    if (held > 0) {
      this.#bus.append({
        type: "user_session.runtime",
        userSessionId,
        payload: {
          sessionId: userSessionId,
          detail: `${held} question(s) raised by agent seats stay open — chatting does not answer them; use their cards.`,
        },
      });
    }
  }

  listPending(userSessionId: string): Interaction[] {
    return [
      ...this.#listByStatus(userSessionId, "pending"),
      ...this.#listByStatus(userSessionId, "stale"),
    ].map(toWire);
  }

  /** An unresolved row with the same normalized question from the same asker. */
  findUnresolvedByDedupe(agentSessionId: string, dedupeKey: string): Interaction | undefined {
    const row = this.#db
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
    return row ? toWire(row) : undefined;
  }

  /** Every still-open question raised inside one AgentSession. Feeds the final gate. */
  listUnresolvedForAgentSession(agentSessionId: string): Interaction[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          eq(interactions.status, "pending"),
        ),
      )
      .all()
      .map(toWire);
  }

  /**
   * Answered questions the ASKING SEAT has not been told about yet. Replaces
   * the in-memory deferred map — these survive a restart and are guaranteed to
   * reach the asker at its next delivery.
   */
  listAnsweredUnflushed(agentSessionId: string, participant?: string): Interaction[] {
    return this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, agentSessionId),
          isNull(interactions.flushedAt),
          isNotNull(interactions.resolvedAt),
          ...(participant === undefined ? [] : [eq(interactions.participant, participant)]),
        ),
      )
      .all()
      .filter((row) => row.status === "answered" || row.status === "rejected")
      .map(toWire);
  }

  markFlushed(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = nowIso();
    for (const id of ids) {
      this.#db.update(interactions).set({ flushedAt: now }).where(eq(interactions.id, id)).run();
    }
  }

  /**
   * The asker is gone but the question is not. Keeps the row `pending` and
   * answerable; the answer will be delivered rather than returned.
   */
  detach(id: string, reason: string): void {
    // Unpark the asker first so its tool call returns, then mark the row. The
    // order matters: the resolver must see a still-`pending` row.
    const resolve = this.#pending.get(id);
    this.#pending.delete(id);
    this.#detachRow(id, reason);
    resolve?.({ kind: "dismissed", reason });
  }


  get(id: string): Interaction {
    const row = this.#db
      .select()
      .from(interactions)
      .where(eq(interactions.id, id))
      .get();
    if (!row) throw new NotFoundError(`no interaction ${id}`);
    return toWire(row);
  }

  /**
   * Boot pass, split by asker.
   *
   * Main-lane rows go `stale`: their promise died with the process, and the
   * revival path replays the answer as a resumed turn.
   *
   * Seat rows stay `pending` and become `detached`: a seat is not revived by a
   * lane, it is woken by a delivery — so its question is still genuinely open
   * and answering it still reaches somebody.
   */
  expirePendingOnBoot(): void {
    this.#db
      .update(interactions)
      .set({ status: "stale" })
      .where(and(eq(interactions.status, "pending"), isNull(interactions.participant)))
      .run();
    this.#db
      .update(interactions)
      .set({ detached: true })
      .where(and(eq(interactions.status, "pending"), isNotNull(interactions.participant)))
      .run();
  }

  /** The single write point into the decision ledger. */
  /**
   * A resolved interaction IS the decision record — the `DecisionLedger` is a
   * read-model over these rows, so there is nothing to write and keep in sync.
   * What remains here is the timeline event (the Run Summary reads decisions
   * from the event window; a live UI can, too).
   */
  #recordDecision(
    row: InteractionRow,
    input: { answer: string; note?: string; source: "interaction" | "plan_approval" },
  ): void {
    const question = row.kind === "plan_approval"
      ? "Plan approval"
      : ((row.payload as { questions?: InteractionQuestion[] }).questions ?? []).map((q) => q.question).join(" | ");
    if (question === "" && input.answer === "") return;
    this.#bus.append({
      type: "operator.decision.recorded",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: {
        sessionId: row.userSessionId,
        decisionId: row.id,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        interactionId: row.id,
        // Attribution matters: "renderer asked this" reads very differently
        // from "the console asked this" when the operator reviews the run.
        askedBy: row.participant ?? "main",
        source: input.source,
        question,
        answer: input.answer,
      },
    });
  }

  #detachRow(id: string, reason: string): void {
    const row = this.#db.select().from(interactions).where(eq(interactions.id, id)).get();
    if (!row || row.status !== "pending") return;
    this.#db.update(interactions).set({ detached: true }).where(eq(interactions.id, id)).run();
    if (row.agentSessionId === null || row.participant === null) return;
    this.#bus.append({
      type: "agent_session.runtime",
      userSessionId: row.userSessionId,
      agentSessionId: row.agentSessionId,
      payload: {
        agentSessionId: row.agentSessionId,
        participant: row.participant,
        detail: `question ${row.id} detached (${reason}); it stays open and the answer will arrive as a delivery`,
      },
    });
  }

  /** Fires the host's hook when a session's LAST blocking question clears. */
  #notifyIfBlockingCleared(row: InteractionRow): void {
    if (row.agentSessionId === null || row.urgency !== "blocking") return;
    const stillBlocking = this.#db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.agentSessionId, row.agentSessionId),
          eq(interactions.status, "pending"),
          eq(interactions.urgency, "blocking"),
        ),
      )
      .all();
    if (stillBlocking.length === 0) {
      this.#onBlockingCleared?.(row.userSessionId, row.agentSessionId);
    }
  }

  #listByStatus(
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

  #markResolved(
    id: string,
    status: "answered" | "rejected" | "dismissed",
    response: Record<string, unknown>,
  ): void {
    this.#db
      .update(interactions)
      .set({ status, response, resolvedAt: nowIso() })
      .where(eq(interactions.id, id))
      .run();
    const row = this.#db.select().from(interactions).where(eq(interactions.id, id)).get();
    // A pending question is a completion blocker, so resolving one may be the
    // last thing standing between this run and its sign-off card.
    if (row) this.#onResolved?.(row.userSessionId);
  }
}
