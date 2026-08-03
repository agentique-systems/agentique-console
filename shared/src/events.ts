// The event spine wire contract. Frozen at milestone 1 — both server emission
// and web folds compile against these exact shapes. Persisted events carry a
// global `seq` (the SSE id); transient frames have no seq and are never replayed.

import type {
  AgentSession,
  AgentSessionStatus,
  InteractionQuestion,
  SessionMessage,
  SessionMode,
  SessionPhase,
  Task,
  UserSession,
  Workspace,
} from "./domain.ts";

export type SessionKind = "user" | "agent";

export interface EventScope {
  kind: SessionKind;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Persisted payloads

export interface WorkspaceCreatedPayload {
  workspace: Workspace;
}
export interface WorkspaceUpdatedPayload {
  workspaceId: string;
  patch: Partial<Pick<Workspace, "name" | "metadata">>;
}

export interface UserSessionCreatedPayload {
  session: UserSession;
}
export interface UserSessionUpdatedPayload {
  sessionId: string;
  patch: Partial<
    Pick<UserSession, "title" | "mode" | "phase" | "status">
  >;
}
export interface UserSessionMessagePayload {
  sessionId: string;
  message: SessionMessage;
}
export type TurnTrigger = "operator" | "wake" | "answer";
export interface UserTurnStartedPayload {
  sessionId: string;
  turnId: string;
  trigger: TurnTrigger;
}
export interface UserTurnSettledPayload {
  sessionId: string;
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorMessage?: string;
  /** Jobs still queued for this session — UI keeps the busy state up while > 0. */
  queuedJobs: number;
}
export interface ToolCallPayload {
  sessionId: string;
  turnId: string;
  callId: string;
  name: string;
  /** Size-capped JSON value (~16KB serialized). */
  input: unknown;
}
export interface ToolResultPayload {
  sessionId: string;
  callId: string;
  /** Size-capped JSON value (~16KB serialized). */
  output: unknown;
  isError?: boolean;
}
export interface QuestionAskedPayload {
  sessionId: string;
  interactionId: string;
  questions: InteractionQuestion[];
}
export interface QuestionAnsweredPayload {
  sessionId: string;
  interactionId: string;
  answers?: Record<string, string[]>;
  dismissed?: boolean;
}
export interface PlanProposedPayload {
  sessionId: string;
  interactionId: string;
  plan: string;
}
export interface PlanResolvedPayload {
  sessionId: string;
  interactionId: string;
  approved: boolean;
  note?: string;
}

export interface AgentSessionCreatedPayload {
  session: AgentSession;
  participants: string[];
}
export interface AgentSessionMessagePayload {
  agentSessionId: string;
  message: SessionMessage;
}
export interface AgentSessionRoutedPayload {
  agentSessionId: string;
  messageSeq: number;
  decisions: { recipient: string; reason: string }[];
  hopCount: number;
}
export interface AgentTurnStartedPayload {
  agentSessionId: string;
  participant: string;
  turnId: string;
}
export interface AgentTurnSettledPayload {
  agentSessionId: string;
  participant: string;
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorMessage?: string;
}
export interface AgentToolCallPayload extends ToolCallPayload {
  participant: string;
}
export interface AgentToolResultPayload extends ToolResultPayload {
  participant: string;
}
export interface AgentSessionStatusPayload {
  agentSessionId: string;
  status: AgentSessionStatus;
  owedToOrchestrator: boolean;
}
export interface AgentSessionPhasePayload {
  agentSessionId: string;
  phase: SessionPhase;
}
export interface AgentPlanCapturedPayload {
  agentSessionId: string;
  participant: string;
  plan: string;
}

export interface TaskCreatedPayload {
  task: Task;
}
export interface TaskUpdatedPayload {
  task: Task;
  changed: string[];
}

export interface FlowDelegationPayload {
  userSessionId: string;
  agentSessionId: string;
  kind: "created" | "sent";
  preview: string;
}
export interface FlowResultPayload {
  userSessionId: string;
  agentSessionId: string;
  digestPreview: string;
}

// ---------------------------------------------------------------------------
// Transient payloads (never persisted, never replayed)

export interface StreamDeltaPayload {
  scope: EventScope;
  speaker: string;
  turnId: string;
  text: string;
}
export type StreamReasoningPayload = StreamDeltaPayload;

export type AgentRuntimeState =
  | "thinking"
  | "responding"
  | "tool"
  | "waiting"
  | "idle";

export interface AgentStatePayload {
  scope: EventScope;
  participant: string;
  state: AgentRuntimeState;
  toolName?: string;
}

// ---------------------------------------------------------------------------
// The envelope

interface Base {
  /** Global spine sequence — present iff persisted. */
  seq?: number;
  ts: string;
  workspaceId?: string;
  userSessionId?: string;
  agentSessionId?: string;
  transient?: true;
}

export type ConsoleEvent = Base &
  (
    | { type: "workspace.created"; payload: WorkspaceCreatedPayload }
    | { type: "workspace.updated"; payload: WorkspaceUpdatedPayload }
    | { type: "user_session.created"; payload: UserSessionCreatedPayload }
    | { type: "user_session.updated"; payload: UserSessionUpdatedPayload }
    | { type: "user_session.message"; payload: UserSessionMessagePayload }
    | { type: "user_session.turn.started"; payload: UserTurnStartedPayload }
    | { type: "user_session.turn.settled"; payload: UserTurnSettledPayload }
    | { type: "user_session.tool.call"; payload: ToolCallPayload }
    | { type: "user_session.tool.result"; payload: ToolResultPayload }
    | { type: "user_session.question.asked"; payload: QuestionAskedPayload }
    | { type: "user_session.question.answered"; payload: QuestionAnsweredPayload }
    | { type: "user_session.plan.proposed"; payload: PlanProposedPayload }
    | { type: "user_session.plan.resolved"; payload: PlanResolvedPayload }
    | { type: "agent_session.created"; payload: AgentSessionCreatedPayload }
    | { type: "agent_session.message"; payload: AgentSessionMessagePayload }
    | { type: "agent_session.routed"; payload: AgentSessionRoutedPayload }
    | { type: "agent_session.turn.started"; payload: AgentTurnStartedPayload }
    | { type: "agent_session.turn.settled"; payload: AgentTurnSettledPayload }
    | { type: "agent_session.tool.call"; payload: AgentToolCallPayload }
    | { type: "agent_session.tool.result"; payload: AgentToolResultPayload }
    | { type: "agent_session.status"; payload: AgentSessionStatusPayload }
    | { type: "agent_session.phase"; payload: AgentSessionPhasePayload }
    | { type: "agent_session.plan.captured"; payload: AgentPlanCapturedPayload }
    | { type: "task.created"; payload: TaskCreatedPayload }
    | { type: "task.updated"; payload: TaskUpdatedPayload }
    | { type: "flow.delegation"; payload: FlowDelegationPayload }
    | { type: "flow.result"; payload: FlowResultPayload }
    | { type: "stream.delta"; payload: StreamDeltaPayload }
    | { type: "stream.reasoning"; payload: StreamReasoningPayload }
    | { type: "agent.state"; payload: AgentStatePayload }
  );

export type ConsoleEventType = ConsoleEvent["type"];

export const TRANSIENT_TYPES: ReadonlySet<ConsoleEventType> = new Set([
  "stream.delta",
  "stream.reasoning",
  "agent.state",
]);

/** Stable per-event identity used for client-side dedupe: seq for persisted events. */
export function eventId(event: ConsoleEvent): string | null {
  return event.seq != null ? `evt_${event.seq}` : null;
}
