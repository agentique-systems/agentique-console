import { z } from "zod";
import type { ConversationId, ConversationMessageId, InvocationId, RunId, WorkspaceId } from "./ids.ts";
import { idSchema, nonEmptyString, timestampSchema, type Timestamp } from "./validation.ts";

/**
 * The operator's ordered exchange with the Orchestrator inside one
 * Workspace. It persists across Runs and owns Requirements and Decisions.
 */
export interface Conversation {
  id: ConversationId;
  workspaceId: WorkspaceId;
  title: string | null;
  /** The Run currently executing in this Conversation, if any (at most one). */
  activeRunId: RunId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const conversationSchema: z.ZodType<Conversation> = z.strictObject({
  id: idSchema("conversation"),
  workspaceId: idSchema("workspace"),
  title: nonEmptyString.nullable(),
  activeRunId: idSchema("run").nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Who wrote a Conversation message: the operator or the Orchestrator. */
export const CONVERSATION_MESSAGE_AUTHORS = ["operator", "orchestrator"] as const;
export type ConversationMessageAuthor = (typeof CONVERSATION_MESSAGE_AUTHORS)[number];

export interface ConversationMessage {
  id: ConversationMessageId;
  conversationId: ConversationId;
  /** The Run during which the message was posted, when one was active. */
  runId: RunId | null;
  /** The Orchestrator Invocation that produced the message, for Orchestrator messages. */
  invocationId: InvocationId | null;
  author: ConversationMessageAuthor;
  content: string;
  createdAt: Timestamp;
}

export const conversationMessageSchema: z.ZodType<ConversationMessage> = z
  .strictObject({
    id: idSchema("conversationMessage"),
    conversationId: idSchema("conversation"),
    runId: idSchema("run").nullable(),
    invocationId: idSchema("invocation").nullable(),
    author: z.enum(CONVERSATION_MESSAGE_AUTHORS),
    content: z.string().min(1),
    createdAt: timestampSchema,
  })
  .refine((message) => message.author === "orchestrator" || message.invocationId === null, {
    message: "only an Orchestrator message carries an Invocation id",
    path: ["invocationId"],
  });
