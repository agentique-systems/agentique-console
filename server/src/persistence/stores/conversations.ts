import { asc, eq } from "drizzle-orm";
import {
  ConflictError,
  conversationMessageSchema,
  conversationSchema,
  parseOrThrow,
  type Conversation,
  type ConversationId,
  type ConversationMessage,
  type ConversationMessageAuthor,
  type InvocationId,
  type RunId,
  type WorkspaceId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { conversationMessages, conversations, invocations, runs, workspaces } from "../schema.ts";
import {
  assertSameConversation,
  conversationScope,
  OPERATOR_ACTOR,
  requireRow,
  RUNTIME_ACTOR,
  writeMeta,
  type WriteOptions,
} from "./support.ts";

function toDomain(row: typeof conversations.$inferSelect): Conversation {
  return parseOrThrow(conversationSchema, row, "Conversation row");
}

function messageToDomain(row: typeof conversationMessages.$inferSelect): ConversationMessage {
  return parseOrThrow(conversationMessageSchema, row, "ConversationMessage row");
}

export interface ConversationMessageInput {
  conversationId: ConversationId;
  author: ConversationMessageAuthor;
  content: string;
  runId: RunId | null;
  invocationId: InvocationId | null;
}

export class ConversationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: { workspaceId: WorkspaceId; title: string | null }, options?: WriteOptions): Conversation {
    return this.ctx.tx.write(() => {
      requireRow(this.ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).get(), "Workspace", input.workspaceId);
      const now = this.ctx.clock();
      const conversation: Conversation = {
        id: this.ctx.ids("conversation"),
        workspaceId: input.workspaceId,
        title: input.title,
        activeRunId: null,
        createdAt: now,
        updatedAt: now,
      };
      parseOrThrow(conversationSchema, conversation, "Conversation");
      this.ctx.journal.append({
        type: "conversation.created",
        scope: conversationScope(conversation),
        subjectType: "conversation",
        subjectId: conversation.id,
        payload: conversation,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.insert(conversations).values(conversation).run();
      return conversation;
    });
  }

  get(id: ConversationId): Conversation {
    return toDomain(requireRow(this.ctx.db.select().from(conversations).where(eq(conversations.id, id)).get(), "Conversation", id));
  }

  listByWorkspace(workspaceId: WorkspaceId): Conversation[] {
    return this.ctx.db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId)).all().map(toDomain);
  }

  update(id: ConversationId, patch: { title?: string | null }, options?: WriteOptions): Conversation {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      const updated: Conversation = {
        ...current,
        title: patch.title === undefined ? current.title : patch.title,
        updatedAt: this.ctx.clock(),
      };
      parseOrThrow(conversationSchema, updated, "Conversation");
      this.ctx.journal.append({
        type: "conversation.updated",
        scope: conversationScope(updated),
        subjectType: "conversation",
        subjectId: id,
        payload: updated,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.update(conversations).set({ title: updated.title, updatedAt: updated.updatedAt }).where(eq(conversations.id, id)).run();
      return updated;
    });
  }

  /**
   * Sets or clears the active Run. A Conversation has at most one active Run;
   * setting a second one is a conflict. Called by the Run store inside its
   * own transaction.
   */
  setActiveRun(id: ConversationId, runId: RunId | null, options?: WriteOptions): Conversation {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (runId !== null && current.activeRunId !== null && current.activeRunId !== runId) {
        throw new ConflictError(`Conversation ${id} already has active Run ${current.activeRunId}`, {
          conversationId: id,
          activeRunId: current.activeRunId,
        });
      }
      const updated: Conversation = { ...current, activeRunId: runId, updatedAt: this.ctx.clock() };
      this.ctx.journal.append({
        type: "conversation.updated",
        scope: conversationScope(updated, { runId }),
        subjectType: "conversation",
        subjectId: id,
        payload: updated,
        ...writeMeta(options, RUNTIME_ACTOR),
      });
      this.ctx.db.update(conversations).set({ activeRunId: runId, updatedAt: updated.updatedAt }).where(eq(conversations.id, id)).run();
      return updated;
    });
  }

  postMessage(input: ConversationMessageInput, options?: WriteOptions): ConversationMessage {
    return this.ctx.tx.write(() => {
      const conversation = this.get(input.conversationId);
      if (input.runId !== null) {
        const run = requireRow(
          this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, input.runId)).get(),
          "Run",
          input.runId,
        );
        assertSameConversation("Run", input.runId, run.conversationId, input.conversationId);
      }
      if (input.invocationId !== null) {
        const invocation = requireRow(
          this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, input.invocationId)).get(),
          "Invocation",
          input.invocationId,
        );
        if (invocation.runId !== input.runId) {
          throw new ConflictError(`Invocation ${input.invocationId} does not belong to Run ${input.runId}`);
        }
      }
      const message: ConversationMessage = {
        id: this.ctx.ids("conversationMessage"),
        conversationId: input.conversationId,
        runId: input.runId,
        invocationId: input.invocationId,
        author: input.author,
        content: input.content,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(conversationMessageSchema, message, "ConversationMessage");
      this.ctx.journal.append({
        type: "conversation.message_posted",
        scope: conversationScope(conversation, { runId: input.runId, invocationId: input.invocationId }),
        subjectType: "conversation_message",
        subjectId: message.id,
        payload: message,
        ...writeMeta(options, input.author === "operator" ? OPERATOR_ACTOR : RUNTIME_ACTOR),
      });
      this.ctx.db.insert(conversationMessages).values(message).run();
      return message;
    });
  }

  listMessages(conversationId: ConversationId): ConversationMessage[] {
    return this.ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id))
      .all()
      .map(messageToDomain);
  }
}
