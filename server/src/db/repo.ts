/**
 * Thin typed queries shared by services. Per-session message seq is assigned
 * MAX(seq)+1 inside a synchronous transaction — safe because this is a single
 * process and better-sqlite3 serializes writes.
 */
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
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
  crons,
  eventArtifacts,
  handoffRecords,
  events,
  interactions,
  mailboxDeliveries,
  messages,
  participants,
  patternState,
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
export type CronRow = typeof crons.$inferSelect;
export type PatternStateRow = typeof patternState.$inferSelect;

export function toWireAgentSession(
  row: AgentSessionRow,
  specialists: string[],
  working: boolean,
): AgentSession {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    title: row.title,
    status: row.status === "archived" ? "archived" : working ? "working" : "idle",
    pattern: row.pattern,
    parentAgentSessionId: row.parentAgentSessionId,
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
    runState: row.runState,
    model: row.model,
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

  /**
   * `participant` matches the RECIPIENT — "the last handoff addressed to X".
   * `sender` matches the AUTHOR — "the last thing X itself reported". Rotation
   * recovery must use `sender`: a seat's inheritance is its own last report,
   * never the last message someone else sent it.
   */
  latestHandoff(input: { userSessionId: string; agentSessionId?: string | null; participant?: string; sender?: string; excludeCheckpoints?: boolean; excludeConsoleSynthesized?: boolean }): HandoffRecordRow | undefined {
    const filters = [eq(handoffRecords.userSessionId, input.userSessionId)];
    if (input.agentSessionId === null) filters.push(sql`${handoffRecords.agentSessionId} is null`);
    else if (input.agentSessionId !== undefined) filters.push(eq(handoffRecords.agentSessionId, input.agentSessionId));
    if (input.participant !== undefined) filters.push(eq(handoffRecords.recipient, input.participant));
    if (input.sender !== undefined) filters.push(eq(handoffRecords.sender, input.sender));
    if (input.excludeCheckpoints === true) filters.push(eq(handoffRecords.checkpoint, false));
    // Console-authored notices (see host `#simpleHandoff`) are not reports.
    if (input.excludeConsoleSynthesized === true) filters.push(sql`coalesce(json_extract(${handoffRecords.extension}, '$.data.consoleSynthesized'), 0) = 0`);
    // rowid breaks createdAt ties: handoffs written in the same millisecond are
    // ordinary (an ack and its follow-up), and "latest" must not be a coin flip
    // when a rotation checkpoint depends on it.
    return this.#db.select().from(handoffRecords).where(and(...filters))
      .orderBy(desc(handoffRecords.createdAt), desc(sql`rowid`)).get();
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
  /** Open, non-manager sessions — the ones a run can complete in. */
  listOpenWorkSessions(): UserSessionRow[] {
    return this.#db.select().from(userSessions)
      .where(and(eq(userSessions.status, "open"), eq(userSessions.purpose, "work"))).all();
  }

  /** userSessionId -> open card count, for the sidebar's attention dots. */
  countPendingInteractions(workspaceId: string): Map<string, number> {
    const rows = this.#db.select({ id: interactions.userSessionId })
      .from(interactions)
      .innerJoin(userSessions, eq(interactions.userSessionId, userSessions.id))
      .where(and(eq(userSessions.workspaceId, workspaceId), inArray(interactions.status, ["pending", "stale"])))
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return counts;
  }

  /**
   * Processes the journal shows as started with no matching exit, across every
   * session, oldest first — the boot-time leak scan. Carries the recorded argv
   * so the caller can guard against pid reuse before killing anything.
   */
  listOrphanedProcesses(): { processId: string; pid: number | null; command: string; args: string[]; userSessionId: string; agentSessionId: string; participant: string }[] {
    const rows = this.#db.select({ type: events.type, userSessionId: events.userSessionId, agentSessionId: events.agentSessionId, payload: events.payload })
      .from(events)
      .where(inArray(events.type, ["agent_session.process.started", "agent_session.process.exited"]))
      .orderBy(asc(events.seq)).all();
    const open = new Map<string, { processId: string; pid: number | null; command: string; args: string[]; userSessionId: string; agentSessionId: string; participant: string }>();
    for (const row of rows) {
      const payload = row.payload as { processId?: string; pid?: number; command?: string; args?: string[]; participant?: string };
      const processId = payload.processId;
      if (processId === undefined) continue;
      if (row.type === "agent_session.process.exited") { open.delete(processId); continue; }
      open.set(processId, {
        processId, pid: payload.pid ?? null,
        command: payload.command ?? "", args: payload.args ?? [],
        userSessionId: row.userSessionId ?? "", agentSessionId: row.agentSessionId ?? "",
        participant: payload.participant ?? "",
      });
    }
    return [...open.values()];
  }

  listProcessEvents(userSessionId: string): { type: string; processId: string }[] {
    return this.#db.select({ type: events.type, payload: events.payload }).from(events)
      .where(and(
        eq(events.userSessionId, userSessionId),
        inArray(events.type, ["agent_session.process.started", "agent_session.process.exited"]),
      ))
      .orderBy(asc(events.seq))
      .all()
      .map((row) => ({ type: row.type, processId: String((row.payload as { processId?: string }).processId ?? "") }))
      .filter((row) => row.processId !== "");
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
   * `deliveredAt` is write-once per delivery attempt, enforced HERE rather than
   * by callers. `#deliverConsole` reads rows while they are still `queued`,
   * patches them to `delivered`, and hands the SAME stale objects to
   * `#mintTurn`; at settle, `delivery.deliveredAt ?? now` then read the stale
   * NULL and overwrote the real timestamp with the settle time. Six of
   * db-live-2's twelve rows reported fabricated ~400s "delivery latencies" for
   * messages the seat had within a second — and `report-run.ts` prints those as
   * mesh health.
   *
   * Making it a property of the store means no future caller can reintroduce
   * it. The one legitimate reset — rotation requeueing a delivery — passes
   * `deliveredAt: null` explicitly and is honoured.
   */
  patchDelivery(id: string, patch: Partial<Pick<MailboxDeliveryRow, "status" | "deliveredAt" | "acknowledgedAt">>): void {
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

  insertCron(row: CronRow): void {
    this.#db.insert(crons).values(row).run();
  }
  /** Console-owned one-shot deadlines whose absolute time has arrived. */
  listDueDeadlines(userSessionId: string, nowIsoTime: string): CronRow[] {
    return this.#db.select().from(crons)
      .where(and(eq(crons.userSessionId, userSessionId), eq(crons.status, "active"), isNotNull(crons.dueAt)))
      .all()
      .filter((row) => row.dueAt !== null && row.dueAt <= nowIsoTime);
  }

  patchCron(id: string, patch: Partial<Pick<CronRow, "schedule" | "prompt" | "status">>): void {
    this.#db.update(crons).set({ ...patch, updatedAt: nowIso() }).where(eq(crons.id, id)).run();
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

  listOpenUserSessions(): UserSessionRow[] {
    return this.#db.select().from(userSessions).where(eq(userSessions.status, "open")).all();
  }

  listUserSessions(workspaceId: string): UserSessionRow[] {
    return this.#db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "work")))
      .orderBy(desc(userSessions.updatedAt))
      .all();
  }

  listManagerSessions(workspaceId: string): UserSessionRow[] {
    return this.#db.select().from(userSessions).where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "profile_manager"))).orderBy(desc(userSessions.updatedAt)).all();
  }

  findManagerSession(workspaceId: string, subjectKey: string): UserSessionRow | undefined {
    return this.#db.select().from(userSessions).where(and(eq(userSessions.workspaceId, workspaceId), eq(userSessions.purpose, "profile_manager"), eq(userSessions.subjectKey, subjectKey))).get();
  }

  insertUserSession(row: UserSessionRow): void {
    this.#db.insert(userSessions).values(row).run();
  }

  patchUserSession(
    id: string,
    patch: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "status" | "subjectKey" | "sdkSessionId" | "sdkGeneration" | "sdkTurnCount" | "contextTokens" | "memory" |  "latestHandoffId" | "cumulativeCostUsd" | "cumulativeApiDurationMs" | "runState" | "runBaseCommit" | "model">
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

  listOpenAgentSessions(): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.status, "open"))
      .all();
  }

  listChildSessions(parentAgentSessionId: string): AgentSessionRow[] {
    return this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.parentAgentSessionId, parentAgentSessionId))
      .orderBy(asc(agentSessions.createdAt))
      .all();
  }

  // --- Pattern state (progression-module-owned) -----------------------------

  getPatternState(agentSessionId: string): PatternStateRow | undefined {
    return this.#db.select().from(patternState).where(eq(patternState.agentSessionId, agentSessionId)).get();
  }

  /** Creates the row on first touch; merges the patch into the existing one after. */
  upsertPatternState(agentSessionId: string, patch: Partial<Omit<PatternStateRow, "agentSessionId" | "createdAt" | "updatedAt">>): PatternStateRow {
    const now = nowIso();
    const existing = this.getPatternState(agentSessionId);
    if (!existing) {
      const row: PatternStateRow = {
        agentSessionId, rounds: 0, handoffCount: 0, lastProgressAt: null,
        recentEdges: [], joins: {}, tripped: null, createdAt: now, updatedAt: now,
        ...patch,
      };
      this.#db.insert(patternState).values(row).run();
      return row;
    }
    this.#db.update(patternState).set({ ...patch, updatedAt: now }).where(eq(patternState.agentSessionId, agentSessionId)).run();
    return { ...existing, ...patch, updatedAt: now };
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
      Pick<AgentSessionRow, "status">
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
      "sdkSessionId" | "generation" |
      "turnCount" | "contextTokens" | "profileSnapshot" | "profileId"
      |  "latestHandoffId"
      | "worktreePath" | "worktreeBaseCommit" | "worktreeBranch"
      | "lastActiveAt" | "cumulativeCostUsd" | "cumulativeApiDurationMs" | "lastDecisionAt"
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

  /** Every seat currently bound to a worktree (boot orphan-recovery input). */
  listWorktreeSeats(): { agentSessionId: string; name: string; worktreePath: string }[] {
    return this.#db.select({ agentSessionId: participants.agentSessionId, name: participants.name, worktreePath: participants.worktreePath })
      .from(participants).where(isNotNull(participants.worktreePath)).all()
      .map((row) => ({ ...row, worktreePath: row.worktreePath! }));
  }

}
