import { ConflictError, type ConversationId, type InvocationId, type MessagePostResponse, type RunId } from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";

/** Durable transport receipts and typed dispatch receipts; domain changes share their root transaction. */
export class ConversationOperationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  replay(conversationId: ConversationId, requestId: string, digest: string): MessagePostResponse | null {
    const row = this.ctx.sqlite.prepare("SELECT digest, response FROM conversation_receipts WHERE conversation_id = ? AND request_id = ?").get(conversationId, requestId) as { digest: string; response: string } | undefined;
    if (!row) return null;
    if (row.digest !== digest) throw new ConflictError("This message request id was already used for different content");
    return JSON.parse(row.response) as MessagePostResponse;
  }

  record(conversationId: ConversationId, requestId: string, digest: string, response: MessagePostResponse): void {
    this.ctx.sqlite.prepare("INSERT INTO conversation_receipts VALUES (?, ?, ?, ?)").run(conversationId, requestId, digest, JSON.stringify(response));
  }

  dispatched(invocationId: InvocationId): boolean {
    return this.ctx.sqlite.prepare("SELECT 1 FROM conversation_dispatches WHERE invocation_id = ?").get(invocationId) !== undefined;
  }

  dispatch(invocationId: InvocationId, workRunId: RunId | null, error: string | null): void {
    this.ctx.sqlite.prepare("INSERT INTO conversation_dispatches VALUES (?, ?, ?)").run(invocationId, workRunId, error);
  }

  /** A restart also projects terminal work, whose host pass no longer needs execution. */
  pendingRunIds(): RunId[] {
    return (this.ctx.sqlite.prepare(`SELECT DISTINCT i.run_id AS id FROM invocations i
      WHERE i.role = 'orchestrator' AND i.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = i.run_id AND r.mode = 'conversation' AND r.operator_pause IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.invocation_id = i.id)
      ORDER BY i.run_id LIMIT 200`).all() as { id: RunId }[]).map((r) => r.id);
  }
}
