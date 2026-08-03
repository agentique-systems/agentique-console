/**
 * Thin typed queries shared by services. Per-session message seq is assigned
 * MAX(seq)+1 inside a synchronous transaction — safe because this is a single
 * process and better-sqlite3 serializes writes.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  MessageKind,
  SessionMessage,
  Speaker,
  UserSession,
} from "@agentique-console/shared";
import type { Db } from "./client.ts";
import { messages, userSessions } from "./schema.ts";
import { newId, nowIso } from "../ids.ts";

export type MessageRow = typeof messages.$inferSelect;
export type UserSessionRow = typeof userSessions.$inferSelect;

export function toWireMessage(row: MessageRow): SessionMessage {
  return {
    seq: row.seq,
    speaker: { kind: row.speakerKind, name: row.speakerName },
    ...(row.toName === null ? {} : { to: row.toName }),
    kind: row.kind,
    text: row.text,
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
      Pick<UserSessionRow, "title" | "mode" | "phase" | "status" | "sdkSessionId">
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
}
