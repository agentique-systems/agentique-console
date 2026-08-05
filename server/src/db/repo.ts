/**
 * Thin typed queries shared by services. Per-session message seq is assigned
 * MAX(seq)+1 inside a synchronous transaction — safe because this is a single
 * process and better-sqlite3 serializes writes.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type {
  AgentSession,
  HandoffSummary,
  MessageKind,
  SessionMessage,
  Speaker,
  UserSession,
} from "@agentique-console/shared";
import type { Db } from "./client.ts";
import {
  agentSessions,
  eventArtifacts,
  handoffRecords,
  mailboxDeliveries,
  messages,
  participants,
  providerEntries,
  tasks,
  userSessions,
  usageSamples,
} from "./schema.ts";
import { newId, nowIso } from "../ids.ts";

export type UnsettledTurn =
  | { kind: "user"; turnId: string; userSessionId: string }
  | {
      kind: "agent";
      turnId: string;
      userSessionId: string;
      agentSessionId: string;
      participant: string;
    };

export type MessageRow = typeof messages.$inferSelect;
export type UserSessionRow = typeof userSessions.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MailboxDeliveryRow = typeof mailboxDeliveries.$inferSelect;
export type UsageSampleRow = typeof usageSamples.$inferSelect;
export type HandoffRecordRow = typeof handoffRecords.$inferSelect;

export function toWireAgentSession(
  row: AgentSessionRow,
  specialists: string[],
  working: boolean,
): AgentSession {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    title: row.title,
    mode: row.mode,
    phase: row.phase,
    status: row.status === "archived" ? "archived" : working ? "working" : "idle",
    participants: specialists,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toWireMessage(row: MessageRow): SessionMessage {
  const handoff = row.payload?.handoff as HandoffSummary | undefined;
  return {
    seq: row.seq,
    speaker: { kind: row.speakerKind, name: row.speakerName },
    ...(row.toName === null ? {} : { to: row.toName }),
    kind: row.kind,
    text: row.text,
    ...(handoff === undefined ? {} : { handoff }),
    createdAt: row.createdAt,
  };
}

export function toWireUserSession(row: UserSessionRow): UserSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    mode: row.mode,
    phase: row.phase,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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

export class Repo {
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

  /** Atomically stores the lossless handoff, compact message projection, and delivery. */
  appendHandoffMailbox(input: AppendMessageInput & {
    userSessionId: string;
    agentSessionId: string;
    recipient: string;
    category: MailboxDeliveryRow["category"];
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
      for (const participant of new Set([input.recipient, input.speaker.name])) {
        if (participant === "main") {
          this.#db.update(userSessions).set({ latestHandoffId: handoff.id, updatedAt: nowIso() }).where(eq(userSessions.id, input.userSessionId)).run();
        } else {
          this.#db.update(participants).set({ latestHandoffId: handoff.id }).where(and(
            eq(participants.agentSessionId, input.agentSessionId), eq(participants.name, participant),
          )).run();
        }
      }
      return { message, delivery, handoff };
    })();
  }

  insertCheckpointHandoff(row: HandoffRecordRow): void {
    this.#sqlite.transaction(() => {
      this.#db.insert(handoffRecords).values(row).run();
      if (row.agentSessionId === null) {
        this.#db.update(userSessions).set({ latestHandoffId: row.id, updatedAt: nowIso() }).where(eq(userSessions.id, row.userSessionId)).run();
      } else {
        this.#db.update(participants).set({ latestHandoffId: row.id }).where(and(
          eq(participants.agentSessionId, row.agentSessionId),
          eq(participants.name, row.recipient),
        )).run();
      }
    })();
  }

  getHandoff(id: string): HandoffRecordRow | undefined {
    return this.#db.select().from(handoffRecords).where(eq(handoffRecords.id, id)).get();
  }

  latestHandoff(input: { userSessionId: string; agentSessionId?: string | null; participant?: string }): HandoffRecordRow | undefined {
    const filters = [eq(handoffRecords.userSessionId, input.userSessionId)];
    if (input.agentSessionId === null) filters.push(sql`${handoffRecords.agentSessionId} is null`);
    else if (input.agentSessionId !== undefined) filters.push(eq(handoffRecords.agentSessionId, input.agentSessionId));
    if (input.participant !== undefined) filters.push(eq(handoffRecords.recipient, input.participant));
    return this.#db.select().from(handoffRecords).where(and(...filters)).orderBy(desc(handoffRecords.createdAt)).get();
  }

  hasDurableReference(kind: "journal" | "artifact" | "task", ref: string): boolean {
    if (kind === "artifact") return this.#db.select({ id: eventArtifacts.id }).from(eventArtifacts).where(eq(eventArtifacts.id, ref)).get() !== undefined;
    if (kind === "task") return this.#db.select({ id: tasks.sdkTaskId }).from(tasks).where(eq(tasks.sdkTaskId, ref)).get() !== undefined;
    return this.#db.select({ id: providerEntries.ord }).from(providerEntries)
      .where(or(eq(providerEntries.uuid, ref), eq(providerEntries.sessionId, ref))).get() !== undefined;
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

  patchDelivery(id: string, patch: Partial<Pick<MailboxDeliveryRow, "status" | "deliveredAt" | "acknowledgedAt">>): void {
    this.#db.update(mailboxDeliveries).set(patch).where(eq(mailboxDeliveries.id, id)).run();
  }

  requeueUnacknowledgedDeliveries(): number {
    return this.#db.update(mailboxDeliveries).set({ status: "queued", deliveredAt: null })
      .where(eq(mailboxDeliveries.status, "delivered")).run().changes;
  }

  insertUsage(row: UsageSampleRow): void { this.#db.insert(usageSamples).values(row).run(); }
  listUsage(userSessionId: string): UsageSampleRow[] { return this.#db.select().from(usageSamples).where(eq(usageSamples.userSessionId, userSessionId)).orderBy(asc(usageSamples.createdAt)).all(); }

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

  getUserSession(id: string): UserSessionRow | undefined {
    return this.#db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, id))
      .get();
  }

  listUserSessions(workspaceId: string): UserSessionRow[] {
    return this.#db
      .select()
      .from(userSessions)
      .where(eq(userSessions.workspaceId, workspaceId))
      .orderBy(desc(userSessions.updatedAt))
      .all();
  }

  insertUserSession(row: UserSessionRow): void {
    this.#db.insert(userSessions).values(row).run();
  }

  patchUserSession(
    id: string,
    patch: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "status" | "sdkSessionId" | "sdkGeneration" | "sdkTurnCount" | "contextTokens" | "memory" | "latestHandoffId">
    >,
  ): void {
    this.#db
      .update(userSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(userSessions.id, id))
      .run();
  }

  touchUserSession(id: string): void {
    this.#db
      .update(userSessions)
      .set({ updatedAt: nowIso() })
      .where(eq(userSessions.id, id))
      .run();
  }

  // --- Agent sessions -------------------------------------------------------

  getAgentSession(id: string): AgentSessionRow | undefined {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get();
  }

  listAgentSessions(userSessionId: string): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userSessionId, userSessionId))
      .orderBy(desc(agentSessions.createdAt))
      .all();
  }

  insertAgentSession(row: AgentSessionRow): void {
    this.#db.insert(agentSessions).values(row).run();
  }

  /**
   * Turns that started but never settled — every one is a turn that died with
   * a previous process. Derived from the spine rather than a status column, so
   * it stays true no matter how the process ended, and recovery writing the
   * missing settle is what stops a turn being recovered twice.
   */
  findUnsettledTurns(): UnsettledTurn[] {
    return this.#db
      .all<{
        type: string;
        turnId: string | null;
        userSessionId: string | null;
        agentSessionId: string | null;
        participant: string | null;
      }>(sql`
        select
          type,
          json_extract(payload, '$.turnId') as turnId,
          user_session_id as userSessionId,
          agent_session_id as agentSessionId,
          json_extract(payload, '$.participant') as participant
        from events
        where type in ('user_session.turn.started', 'agent_session.turn.started')
          and json_extract(payload, '$.turnId') not in (
            select json_extract(payload, '$.turnId') from events
            where type in ('user_session.turn.settled', 'agent_session.turn.settled')
          )
        order by seq
      `)
      .flatMap((row): UnsettledTurn[] => {
        if (row.turnId === null) return [];
        if (row.type === "agent_session.turn.started") {
          if (row.agentSessionId === null || row.participant === null) return [];
          return [
            {
              kind: "agent" as const,
              turnId: row.turnId,
              userSessionId: row.userSessionId ?? "",
              agentSessionId: row.agentSessionId,
              participant: row.participant,
            },
          ];
        }
        if (row.userSessionId === null) return [];
        return [
          {
            kind: "user" as const,
            turnId: row.turnId,
            userSessionId: row.userSessionId,
          },
        ];
      });
  }

  patchAgentSession(
    id: string,
    patch: Partial<
      Pick<AgentSessionRow, "phase" | "status">
    >,
  ): void {
    this.#db
      .update(agentSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(agentSessions.id, id))
      .run();
  }

  /** Participants in seating order (the orchestrator's virtual seat is ord 0). */
  listParticipants(agentSessionId: string): ParticipantRow[] {
    return this.#db
      .select()
      .from(participants)
      .where(eq(participants.agentSessionId, agentSessionId))
      .orderBy(asc(participants.ord))
      .all();
  }

  getParticipant(
    agentSessionId: string,
    name: string,
  ): ParticipantRow | undefined {
    return this.#db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.agentSessionId, agentSessionId),
          eq(participants.name, name),
        ),
      )
      .get();
  }

  insertParticipant(row: ParticipantRow): void {
    this.#db.insert(participants).values(row).run();
  }

  patchParticipant(
    agentSessionId: string,
    name: string,
    patch: Partial<Pick<ParticipantRow,
      "lastSeenSeq" | "pendingTurnSeq" | "sdkSessionId" | "generation" |
      "turnCount" | "contextTokens" | "profileSnapshot" | "profileId"
      | "memory" | "latestHandoffId" | "checkpointReady"
    >>,
  ): void {
    this.#db
      .update(participants)
      .set(patch)
      .where(
        and(
          eq(participants.agentSessionId, agentSessionId),
          eq(participants.name, name),
        ),
      )
      .run();
  }
}
