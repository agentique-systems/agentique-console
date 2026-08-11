/** Row → wire mappers, shared by the API/SSE payload producers. */
import type {
  AgentSession,
  HandoffSummary,
  SessionMessage,
  UserSession,
} from "@agentique-console/shared";
import type { MessageRow } from "../db/stores/message-store.ts";
import type { AgentSessionRow, UserSessionRow } from "../db/stores/session-store.ts";

export function toWireAgentSession(
  row: AgentSessionRow,
  specialists: string[],
  working: boolean,
): AgentSession {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    title: row.title,
    lifecycle: row.lifecycle,
    activity: working ? "working" : "idle",
    pattern: row.pattern,
    parentAgentSessionId: row.parentAgentSessionId,
    agents: specialists,
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
    lifecycle: row.lifecycle,
    runState: row.runState,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
