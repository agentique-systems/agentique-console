/**
 * Human-in-the-loop interactions: AskUserQuestion and ExitPlanMode calls park
 * here as durable rows + in-memory promises. The REST answer endpoint resolves
 * them; operator chat while one is pending auto-dismisses it (the model is
 * told to read the next message instead). In-flight promises die with the
 * process; boot marks orphaned rows stale (M8 revival path).
 */
import { and, eq } from "drizzle-orm";
import type {
  Interaction,
  InteractionQuestion,
  ResolveInteractionBody,
} from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { interactions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { conflict, notFound, badRequest } from "../api/errors.ts";

export type InteractionResolution =
  | { kind: "answers"; answers: Record<string, string[]> }
  | { kind: "decision"; approved: boolean; note?: string }
  | { kind: "dismissed"; reason: string };

type InteractionRow = typeof interactions.$inferSelect;

function toWire(row: InteractionRow): Interaction {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    kind: row.kind,
    status: row.status,
    payload: row.payload as Interaction["payload"],
    response: row.response ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export class InteractionService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #pending = new Map<string, (res: InteractionResolution) => void>();

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  /** Creates a pending question card and parks its resolution promise. */
  createQuestion(
    userSessionId: string,
    questions: InteractionQuestion[],
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    return this.#create(
      userSessionId,
      "question",
      { questions },
      toolUseId,
      signal,
      (id) => {
        this.#bus.append({
          type: "user_session.question.asked",
          userSessionId,
          payload: { sessionId: userSessionId, interactionId: id, questions },
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
    emit: (id: string) => void,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const id = newId("int");
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
      })
      .run();
    emit(id);
    const resolution = new Promise<InteractionResolution>((resolve) => {
      this.#pending.set(id, resolve);
      // A turn abort tears the query down; unpark so the closure can return.
      signal?.addEventListener(
        "abort",
        () => {
          if (this.#pending.delete(id)) {
            this.#markResolved(id, "dismissed", { reason: "turn aborted" });
            resolve({ kind: "dismissed", reason: "the turn was interrupted" });
          }
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
      throw notFound(`no interaction ${interactionId}`);
    }
    if (row.status !== "pending" && row.status !== "stale") {
      throw conflict(`interaction ${interactionId} is already ${row.status}`);
    }

    if ("answers" in body) {
      if (row.kind !== "question") {
        throw badRequest("answers apply to question interactions");
      }
      this.#markResolved(interactionId, "answered", { answers: body.answers });
      this.#bus.append({
        type: "user_session.question.answered",
        userSessionId,
        payload: {
          sessionId: userSessionId,
          interactionId,
          answers: body.answers,
        },
      });
      this.#pending.get(interactionId)?.({
        kind: "answers",
        answers: body.answers,
      });
      this.#pending.delete(interactionId);
    } else {
      if (row.kind !== "plan_approval") {
        throw badRequest("decisions apply to plan_approval interactions");
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
   * Operator chatted while interactions were pending: dismiss them all. The
   * parked closures return deny("read the next message"); pending plan
   * approvals resolve as rejected with the chat text as the note.
   */
  dismissPendingForChat(userSessionId: string, chatText: string): void {
    const rows = this.#listByStatus(userSessionId, "pending");
    for (const row of rows) {
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
  }

  listPending(userSessionId: string): Interaction[] {
    return [
      ...this.#listByStatus(userSessionId, "pending"),
      ...this.#listByStatus(userSessionId, "stale"),
    ].map(toWire);
  }

  get(id: string): Interaction {
    const row = this.#db
      .select()
      .from(interactions)
      .where(eq(interactions.id, id))
      .get();
    if (!row) throw notFound(`no interaction ${id}`);
    return toWire(row);
  }

  /** Boot pass: promises died with the process; mark orphaned rows stale. */
  expirePendingOnBoot(): void {
    this.#db
      .update(interactions)
      .set({ status: "stale" })
      .where(eq(interactions.status, "pending"))
      .run();
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
  }
}
