import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  InvariantViolationError,
  NotFoundError,
  parseOrThrow,
  type ConversationId,
  type EventActor,
  type EventScope,
  type RunId,
  type RunStatus,
  type WorkspaceId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { conversations, runs } from "../schema.ts";

export function requireRow<T>(row: T | undefined, what: string, id: string): T {
  if (row === undefined) throw new NotFoundError(what, id);
  return row;
}

/** Validates a JSON column against its core schema when reading a row. */
export function column<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  return parseOrThrow(schema, value, what);
}

export interface RunRef {
  id: RunId;
  conversationId: ConversationId;
  workspaceId: WorkspaceId;
  status: RunStatus;
}

export function loadRunRef(ctx: PersistenceContext, runId: string): RunRef {
  const row = requireRow(
    ctx.db
      .select({ id: runs.id, conversationId: runs.conversationId, workspaceId: runs.workspaceId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .get(),
    "Run",
    runId,
  );
  return row as RunRef;
}

export interface ConversationRef {
  id: ConversationId;
  workspaceId: WorkspaceId;
}

export function loadConversationRef(ctx: PersistenceContext, conversationId: string): ConversationRef {
  const row = requireRow(
    ctx.db
      .select({ id: conversations.id, workspaceId: conversations.workspaceId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get(),
    "Conversation",
    conversationId,
  );
  return row as ConversationRef;
}

export function runScope(run: RunRef, extra: Partial<EventScope> = {}): EventScope {
  return {
    workspaceId: run.workspaceId,
    conversationId: run.conversationId,
    runId: run.id,
    planNodeId: null,
    invocationId: null,
    attemptId: null,
    ...extra,
  };
}

export function conversationScope(conversation: ConversationRef, extra: Partial<EventScope> = {}): EventScope {
  return {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    runId: null,
    planNodeId: null,
    invocationId: null,
    attemptId: null,
    ...extra,
  };
}

export function workspaceScope(workspaceId: WorkspaceId): EventScope {
  return { workspaceId, conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null };
}

export const RUNTIME_ACTOR: EventActor = { kind: "runtime" };
export const OPERATOR_ACTOR: EventActor = { kind: "operator" };

/** Fails when `actualRunId` differs from `expectedRunId`; ids never cross Runs. */
export function assertSameRun(what: string, id: string, actualRunId: string, expectedRunId: string): void {
  if (actualRunId !== expectedRunId) {
    throw new InvariantViolationError(`${what} ${id} belongs to Run ${actualRunId}, not ${expectedRunId}`, {
      what,
      id,
      actualRunId,
      expectedRunId,
    });
  }
}

export function assertSameConversation(
  what: string,
  id: string,
  actualConversationId: string,
  expectedConversationId: string,
): void {
  if (actualConversationId !== expectedConversationId) {
    throw new InvariantViolationError(
      `${what} ${id} belongs to Conversation ${actualConversationId}, not ${expectedConversationId}`,
      { what, id, actualConversationId, expectedConversationId },
    );
  }
}

export interface WriteOptions {
  actor?: EventActor;
  correlationId?: string | null;
  causationSeq?: number | null;
}

export function writeMeta(options: WriteOptions | undefined, fallbackActor: EventActor = RUNTIME_ACTOR) {
  return {
    actor: options?.actor ?? fallbackActor,
    correlationId: options?.correlationId ?? null,
    causationSeq: options?.causationSeq ?? null,
  };
}
