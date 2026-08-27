/**
 * Messages, their mailbox deliveries, and the multi-table transactional
 * appends anchored on a message row. Per-session message seq is assigned
 * MAX(seq)+1 inside a synchronous transaction — safe because this is a single
 * process and better-sqlite3 serializes writes.
 */
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { HandoffSummary, MessageKind, Speaker } from "@agentique-console/shared";
import type { Db } from "../client.ts";
import { agents, handoffRecords, mailboxDeliveries, messages, userSessions } from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";
import type { HandoffRecordRow } from "./handoff-store.ts";

export type MessageRow = typeof messages.$inferSelect;
export type MailboxDeliveryRow = typeof mailboxDeliveries.$inferSelect;

export interface AppendMessageInput {
  sessionKind: "user" | "agent";
  sessionId: string;
  speaker: Speaker;
  to?: string;
  kind: MessageKind;
  text: string;
  payload?: Record<string, unknown>;
  turnId?: string;
}

export class MessageStore {
  readonly #db: Db;
  readonly #sqlite: { transaction<T>(fn: () => T): () => T };

  constructor(db: Db, sqlite: { transaction<T>(fn: () => T): () => T }) {
    this.#db = db;
    this.#sqlite = sqlite;
  }

  /** Appends a message with the next per-session seq; returns the stored row. */
  appendMessage(input: AppendMessageInput): MessageRow {
    const run = this.#sqlite.transaction((): MessageRow => {
      const head = this.#db
        .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)` })
        .from(messages)
        .where(
          and(
            eq(messages.sessionKind, input.sessionKind),
            eq(messages.sessionId, input.sessionId),
          ),
        )
        .get();
      const row: MessageRow = {
        id: newId("msg"),
        sessionKind: input.sessionKind,
        sessionId: input.sessionId,
        seq: (head?.seq ?? 0) + 1,
        speakerKind: input.speaker.kind,
        speakerName: input.speaker.name,
        toName: input.to ?? null,
        kind: input.kind,
        text: input.text,
        payload: input.payload ?? null,
        turnId: input.turnId ?? null,
        createdAt: nowIso(),
      };
      this.#db.insert(messages).values(row).run();
      return row;
    });
    return run();
  }

  /** Atomically persists speech and its addressed mailbox delivery. */
  appendMailboxMessage(input: AppendMessageInput & {
    userSessionId: string;
    agentSessionId: string;
    recipient: string;
    category: MailboxDeliveryRow["category"];
    attention?: MailboxDeliveryRow["attention"];
    dedupeKey?: string;
  }): { message: MessageRow; delivery: MailboxDeliveryRow } {
    const run = this.#sqlite.transaction(() => {
      const message = this.appendMessage(input);
      const delivery: MailboxDeliveryRow = {
        id: newId("delivery"),
        messageId: message.id,
        userSessionId: input.userSessionId,
        agentSessionId: input.agentSessionId,
        sender: input.speaker.name,
        recipient: input.recipient,
        category: input.category,
        status: "queued",
        attention: input.attention ?? "wake",
        dedupeKey: input.dedupeKey ?? null,
        deliveredAt: null,
        acknowledgedAt: null,
        createdAt: nowIso(),
      };
      this.#db.insert(mailboxDeliveries).values(delivery).run();
      return { message, delivery };
    });
    return run();
  }

  /**
   * Atomically stores the lossless handoff, compact message projection, and
   * delivery. The latest-handoff pointer bump is NOT here: the caller knows
   * who the recipient is and calls `setMainLatestHandoff`/
   * `setAgentLatestHandoff` explicitly — the store does not branch on a
   * domain sentinel.
   */
  appendHandoffMailbox(input: AppendMessageInput & {
    userSessionId: string;
    agentSessionId: string;
    recipient: string;
    category: MailboxDeliveryRow["category"];
    attention?: MailboxDeliveryRow["attention"];
    handoff: HandoffRecordRow;
    summary: HandoffSummary;
    dedupeKey?: string;
  }): { message: MessageRow; delivery: MailboxDeliveryRow; handoff: HandoffRecordRow } {
    return this.#sqlite.transaction(() => {
      const { message, delivery } = this.appendMailboxMessage({
        ...input,
        payload: { ...(input.payload ?? {}), handoff: input.summary },
      });
      const handoff = { ...input.handoff, messageId: message.id };
      this.#db.insert(handoffRecords).values(handoff).run();
      return { message, delivery, handoff };
    })();
  }

  /** The main lane's latest-handoff pointer lives on its user-session row. */
  setMainLatestHandoff(userSessionId: string, handoffId: string): void {
    this.#db.update(userSessions).set({ latestHandoffId: handoffId, updatedAt: nowIso() }).where(eq(userSessions.id, userSessionId)).run();
  }

  /** An agent's latest-handoff pointer lives on its agents row. */
  setAgentLatestHandoff(agentSessionId: string, agent: string, handoffId: string): void {
    this.#db.update(agents).set({ latestHandoffId: handoffId }).where(and(
      eq(agents.agentSessionId, agentSessionId), eq(agents.name, agent),
    )).run();
  }

  listQueuedDeliveries(agentSessionId?: string): MailboxDeliveryRow[] {
    return this.#db.select().from(mailboxDeliveries)
      .where(agentSessionId === undefined
        ? eq(mailboxDeliveries.status, "queued")
        : and(eq(mailboxDeliveries.agentSessionId, agentSessionId), eq(mailboxDeliveries.status, "queued")))
      .orderBy(asc(mailboxDeliveries.createdAt)).all();
  }

  listActiveDeliveries(agentSessionId: string): MailboxDeliveryRow[] {
    return this.#db.select().from(mailboxDeliveries).where(and(eq(mailboxDeliveries.agentSessionId, agentSessionId), inArray(mailboxDeliveries.status, ["queued", "delivered"]))).orderBy(asc(mailboxDeliveries.createdAt)).all();
  }

  findDeliveryByDedupe(agentSessionId: string, sender: string, recipient: string, dedupeKey: string): MailboxDeliveryRow | undefined {
    return this.#db.select().from(mailboxDeliveries).where(and(eq(mailboxDeliveries.agentSessionId, agentSessionId), eq(mailboxDeliveries.sender, sender), eq(mailboxDeliveries.recipient, recipient), eq(mailboxDeliveries.dedupeKey, dedupeKey))).orderBy(desc(mailboxDeliveries.createdAt)).get();
  }

  getMessageById(id: string): MessageRow | undefined {
    return this.#db.select().from(messages).where(eq(messages.id, id)).get();
  }

  /**
   * `deliveredAt` is write-once per delivery attempt, enforced HERE rather
   * than by callers, so no caller holding a stale row snapshot can overwrite
   * the real timestamp. The one legitimate reset — rotation requeueing a
   * delivery — passes `deliveredAt: null` explicitly and is honoured.
   */
  patchDelivery(id: string, patch: Partial<Pick<MailboxDeliveryRow, "status" | "attention" | "deliveredAt" | "acknowledgedAt">>): void {
    const preserveDelivered = patch.deliveredAt !== undefined && patch.deliveredAt !== null;
    this.#db.update(mailboxDeliveries)
      .set(preserveDelivered
        ? { ...patch, deliveredAt: sql`coalesce(${mailboxDeliveries.deliveredAt}, ${patch.deliveredAt})` }
        : patch)
      .where(eq(mailboxDeliveries.id, id)).run();
  }

  getDeliveryById(id: string): MailboxDeliveryRow | undefined {
    return this.#db.select().from(mailboxDeliveries).where(eq(mailboxDeliveries.id, id)).get();
  }

  /** The agent's most recent inbound assignment, if it was ever assigned anything. */
  latestAssignmentDelivery(agentSessionId: string, recipient: string): MailboxDeliveryRow | undefined {
    return this.#db.select().from(mailboxDeliveries)
      .where(and(
        eq(mailboxDeliveries.agentSessionId, agentSessionId),
        eq(mailboxDeliveries.recipient, recipient),
        eq(mailboxDeliveries.category, "assignment"),
      ))
      .orderBy(desc(mailboxDeliveries.createdAt))
      .limit(1)
      .get();
  }

  /** Journal rows a (re)spawning recipient must be handed again: not yet consumed. */
  listUnackedDeliveries(agentSessionId: string, recipient: string): MailboxDeliveryRow[] {
    return this.#db.select().from(mailboxDeliveries)
      .where(and(
        eq(mailboxDeliveries.agentSessionId, agentSessionId),
        eq(mailboxDeliveries.recipient, recipient),
        inArray(mailboxDeliveries.status, ["queued", "delivered"]),
      ))
      .orderBy(asc(mailboxDeliveries.createdAt)).all();
  }

  requeueUnacknowledgedDeliveries(): number {
    // A delivered "hold" row means its join already flushed; requeueing it as
    // "wake" hands it to ordinary boundary delivery — the engine's one flush
    // is spent and must not be waited on again.
    return this.#db.update(mailboxDeliveries).set({ status: "queued", deliveredAt: null,
      attention: sql`CASE WHEN ${mailboxDeliveries.attention} = 'hold' THEN 'wake' ELSE ${mailboxDeliveries.attention} END` })
      .where(eq(mailboxDeliveries.status, "delivered")).run().changes;
  }

  /**
   * How many main-bound rows were recorded WITHOUT waking main since its last
   * woken delivery in this session — the counted breadcrumb the next wake
   * carries so deferred records stay discoverable (read_agent_session shows
   * them in full). `excludeId` is the wake being composed right now.
   */
  countMainDeferredSinceLastWake(agentSessionId: string, recipient: string, excludeId: string): number {
    const lastWake = this.#db.select({ createdAt: sql<string | null>`max(${mailboxDeliveries.createdAt})` })
      .from(mailboxDeliveries)
      .where(and(
        eq(mailboxDeliveries.agentSessionId, agentSessionId),
        eq(mailboxDeliveries.recipient, recipient),
        inArray(mailboxDeliveries.attention, ["wake", "interrupt"]),
        sql`${mailboxDeliveries.id} != ${excludeId}`,
      )).get()?.createdAt ?? "";
    const row = this.#db.select({ count: sql<number>`count(*)` })
      .from(mailboxDeliveries)
      .where(and(
        eq(mailboxDeliveries.agentSessionId, agentSessionId),
        eq(mailboxDeliveries.recipient, recipient),
        eq(mailboxDeliveries.attention, "defer"),
        sql`${mailboxDeliveries.createdAt} > ${lastWake}`,
      )).get();
    return row?.count ?? 0;
  }

  /**
   * Did `speaker` file a terminal-status handoff after `afterSeq`? One indexed
   * SQL probe — the assignment-boundary check runs at EVERY turn settle, and
   * loading the full message table for it allocated the whole transcript per
   * settle on long runs (straf3: 1,601 messages x 168 settles).
   */
  hasTerminalReportSince(sessionId: string, speaker: string, afterSeq: number): boolean {
    return this.#db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.sessionKind, "agent"),
        eq(messages.sessionId, sessionId),
        eq(messages.speakerName, speaker),
        gt(messages.seq, afterSeq),
        sql`json_extract(${messages.payload}, '$.handoff.status') IN ('completed','failed')`,
      ))
      .limit(1)
      .get() !== undefined;
  }

  listMessages(
    sessionKind: "user" | "agent",
    sessionId: string,
    afterSeq = 0,
  ): MessageRow[] {
    return this.#db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionKind, sessionKind),
          eq(messages.sessionId, sessionId),
          sql`${messages.seq} > ${afterSeq}`,
        ),
      )
      .orderBy(asc(messages.seq))
      .all();
  }

  listAllMessages(): MessageRow[] { return this.#db.select().from(messages).orderBy(asc(messages.createdAt)).all(); }
  listAllDeliveries(): MailboxDeliveryRow[] { return this.#db.select().from(mailboxDeliveries).orderBy(asc(mailboxDeliveries.createdAt)).all(); }

  messagesHeadSeq(sessionKind: "user" | "agent", sessionId: string): number {
    const row = this.#db
      .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)` })
      .from(messages)
      .where(
        and(
          eq(messages.sessionKind, sessionKind),
          eq(messages.sessionId, sessionId),
        ),
      )
      .get();
    return row?.seq ?? 0;
  }
}
