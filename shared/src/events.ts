// The event spine wire contract. Frozen at milestone 1 — both server emission
// and web folds compile against these exact shapes. Persisted events carry a
// global `seq` (the SSE id); transient frames have no seq and are never replayed.

import type {
  AgentSession,
  AgentSessionStatus,
  InteractionQuestion,
  InteractionSource,
  InteractionUrgency,
  RunSummaryStats,
  SessionMessage,
  Task,
  UserSession,
  Workspace,
} from "./domain.ts";
import type { HandoffSummary } from "./handoffs.ts";

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
    Pick<UserSession, "title" | "mode" | "phase" | "status" | "runState">
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
  durationMs?: number;
}
export interface UserContextRotatedPayload {
  sessionId: string; generation: number; reason: "token_limit" | "turn_limit";
  handoffId?: string; checkpointBytes?: number; degraded?: boolean;
}
export interface UserRuntimePayload { sessionId: string; detail: string; }
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
  turnId?: string;
  /** Size-capped JSON value (~16KB serialized). */
  output: unknown;
  isError?: boolean;
  durationMs?: number;
  bytes?: number;
}
export interface QuestionAskedPayload {
  sessionId: string;
  interactionId: string;
  questions: InteractionQuestion[];
  /** The asking seat, so the card can name it. Absent = the main lane. */
  agentSessionId?: string;
  participant?: string;
  urgency: InteractionUrgency;
  source: InteractionSource;
  recommendation?: string;
  allowFreeText: boolean;
}
export interface QuestionAnsweredPayload {
  sessionId: string;
  interactionId: string;
  answers?: Record<string, string[]>;
  freeText?: Record<string, string>;
  note?: string;
  dismissed?: boolean;
}
/**
 * A `final` report was withheld because questions this session put to the
 * operator are still unanswered. The coordinator cannot answer them and
 * neither can main.
 */
export interface FinalBlockedPayload {
  agentSessionId: string;
  sender: string;
  interactionIds: string[];
}
/**
 * The Console believes the run is finished and is asking the operator to
 * agree. Carries a render-ready projection so the card needs no second fetch
 * to be useful; the expanded view fetches the full document.
 */
export interface RunCompletionProposedPayload extends RunSummaryStats {
  sessionId: string;
  runId: string;
  summaryId: string;
}
/**
 * The operator's verdict. Deliberately no separate `run.completed` event —
 * `decision:"accept"` IS completion, and a second event could disagree with it.
 */
export interface RunSignoffResolvedPayload {
  sessionId: string;
  runId: string;
  decision: "accept" | "changes";
  note?: string;
}
export interface RunReopenedPayload {
  sessionId: string;
  runId: string;
  reason: "changes_requested" | "operator_message";
}

/**
 * The operator decided something. Durable and session-scoped: every seat and
 * every later generation reads these back, so an answer given once never has
 * to be relayed or re-derived.
 */
export interface OperatorDecisionRecordedPayload {
  sessionId: string;
  decisionId: string;
  agentSessionId?: string;
  interactionId?: string;
  /** Seat name, "orchestrator", "main", or "console". */
  askedBy: string;
  source: "interaction" | "plan_approval";
  question: string;
  answer: string;
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
  durationMs?: number;
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
}
/** A session-level TerminationPolicy bound was hit; the console asks for close-out. */
export interface AgentSessionTerminationTrippedPayload {
  agentSessionId: string;
  pattern: string;
  rule: string;
  detail: string;
}
/** A fan-in met its mode; the held reports flushed to the collector in one turn. */
export interface AgentSessionJoinCompletedPayload {
  agentSessionId: string;
  joinId: string;
  arrived: string[];
  of: number;
  failed: number;
}
/**
 * Boundary-edge events. These are ALSO the nesting flow pulses: the web maps
 * child.spawned/child.reported onto the parent card's delegation/result
 * animations, while the legacy `flow.delegation`/`flow.result` pair keeps
 * carrying the root main↔session edges. No third flow vocabulary.
 */
/** A controller seat spawned a child session; agentSessionId is the PARENT. */
export interface AgentSessionChildSpawnedPayload {
  agentSessionId: string;
  childAgentSessionId: string;
  pattern: string;
  byParticipant: string;
  title: string;
}
/** A child's final/failure crossed the boundary into its parent. */
export interface AgentSessionChildReportedPayload {
  agentSessionId: string;
  childAgentSessionId: string;
  status: "completed" | "failed";
  handoffId: string;
}
export interface AgentMailboxPayload {
  agentSessionId: string;
  deliveryId: string;
  messageSeq: number;
  sender: string;
  recipient: string;
  category: "assignment" | "update" | "milestone" | "failure" | "final" | "decision";
  status: "queued" | "delivered" | "acknowledged" | "cancelled";
}
export interface AgentRuntimePayload {
  agentSessionId: string;
  participant: string;
  turnId?: string;
  detail: string;
}
export interface AgentContextRotatedPayload {
  agentSessionId: string;
  participant: string;
  generation: number;
  reason: "token_limit" | "turn_limit";
  handoffId?: string; checkpointBytes?: number; degraded?: boolean;
}
export interface AgentProcessStartedPayload {
  agentSessionId: string; participant: string; processId: string;
  command: string; args: string[]; cwd: string; pid?: number;
}
export interface AgentProcessOutputPayload {
  agentSessionId: string; participant: string; processId: string;
  seq: number; stream: "stdout" | "stderr"; text: string;
}
export interface AgentProcessExitedPayload {
  agentSessionId: string; participant: string; processId: string;
  code: number | null; signal: string | null;
}
export interface UsageRecordedPayload {
  sessionId: string; participant: string; profileId?: string; generation: number;
  turnId: string; inputTokens: number; outputTokens: number; costUsd?: number;
  uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number;
  model?: string; effort?: string; trigger?: string; durationMs?: number;
  apiDurationMs?: number; sdkDurationMs?: number;
  status?: "completed" | "error" | "aborted"; stopReason?: string;
}

export interface AgentProfileChangedPayload {
  workspaceId: string; profileId: string; revision: string; trusted: boolean;
}
export interface TaskDependencyPayload {
  dependency: import("./domain.ts").TaskDependency;
}

export interface HandoffCreatedPayload {
  handoff: HandoffSummary; sender: string; recipient: string; checkpoint: boolean;
  bytes: number;
}
export interface HandoffConsumedPayload { handoffId: string; participant: string; mode: "compact" | "expanded"; }
export interface HandoffDiscrepancyPayload { handoffId: string; reporter: string; claim: string; evidence: string; }
export interface HandoffCheckpointFailedPayload { participant: string; reason: string; degraded: boolean; }
/**
 * A `final` reached the operator with work still outstanding. The conditions
 * ride along with the report rather than suppressing it — the operator can
 * judge an incomplete result, but cannot judge silence.
 */
export interface HandoffFinalCaveatsPayload { agentSessionId: string; sender: string; caveats: string[]; }

/**
 * The Console closed an operator obligation the coordinator left open. Any
 * occurrence is a coordination defect worth reading — the run produced results
 * that would otherwise have reached nobody.
 */
export interface AgentSessionUnreportedPayload { agentSessionId: string; seatReports: number; hadCoordinatorReport: boolean; }

/** The host interrupted a seat turn that was repeating itself without progress. */
export interface AgentWatchdogPayload {
  agentSessionId: string;
  participant: string;
  turnId: string;
  kind: "repeat_tool_calls" | "tool_error_streak";
  toolName?: string;
  count: number;
  detail: string;
}

/** Governance: the orchestrator lane's canUseTool denied a tool call. */
export interface ToolDeniedPayload {
  sessionId: string;
  /** Present for a seat-level denial; absent for the main lane's. */
  agentSessionId?: string;
  participant?: string;
  toolName: string;
  kind: "coordination_only" | "empty_question" | "question_declined" | "plan_missing" | "plan_rejected";
  reason: string;
}

/** Seat worktree isolation: write seats land completed work atomically. */
export interface SeatWorktreeCreatedPayload {
  agentSessionId: string;
  seat: string;
  branch: string;
  baseCommit: string;
}

export interface SeatWorktreeMergedPayload {
  agentSessionId: string;
  seat: string;
  mergeCommit: string;
  filesChanged: number;
  artifactId: string | null;
}

export interface SeatWorktreeMergeFailedPayload {
  agentSessionId: string;
  seat: string;
  conflicts: string[];
  detail: string;
  artifactId: string | null;
}

export interface SeatWorktreeDiscardedPayload {
  agentSessionId: string;
  seat: string;
  reason: string;
  artifactId: string | null;
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
// Streaming payloads are transient. Agent state is durable so crashes and
// unexpected termination remain visible when a transcript is replayed.

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
  /**
   * What the provider is doing right now when nothing else is visible —
   * "requesting…", "rate limited · retry 2/5 · in 30s", "Grep running · 12s".
   * Advisory liveness only; it never becomes a transcript row.
   */
  detail?: string;
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
    | { type: "user_session.context.rotated"; payload: UserContextRotatedPayload }
    | { type: "user_session.runtime"; payload: UserRuntimePayload }
    | { type: "user_session.tool.call"; payload: ToolCallPayload }
    | { type: "user_session.tool.result"; payload: ToolResultPayload }
    | { type: "user_session.question.asked"; payload: QuestionAskedPayload }
    | { type: "user_session.question.answered"; payload: QuestionAnsweredPayload }
    | { type: "user_session.plan.proposed"; payload: PlanProposedPayload }
    | { type: "user_session.plan.resolved"; payload: PlanResolvedPayload }
    | { type: "agent_session.created"; payload: AgentSessionCreatedPayload }
    | { type: "agent_session.termination.tripped"; payload: AgentSessionTerminationTrippedPayload }
    | { type: "agent_session.join.completed"; payload: AgentSessionJoinCompletedPayload }
    | { type: "agent_session.child.spawned"; payload: AgentSessionChildSpawnedPayload }
    | { type: "agent_session.child.reported"; payload: AgentSessionChildReportedPayload }
    | { type: "agent_session.message"; payload: AgentSessionMessagePayload }
    | { type: "agent_session.turn.started"; payload: AgentTurnStartedPayload }
    | { type: "agent_session.turn.settled"; payload: AgentTurnSettledPayload }
    | { type: "agent_session.tool.call"; payload: AgentToolCallPayload }
    | { type: "agent_session.tool.result"; payload: AgentToolResultPayload }
    | { type: "agent_session.status"; payload: AgentSessionStatusPayload }
    | { type: "agent_session.mailbox"; payload: AgentMailboxPayload }
    | { type: "agent_session.runtime"; payload: AgentRuntimePayload }
    | { type: "agent_session.context.rotated"; payload: AgentContextRotatedPayload }
    | { type: "agent_session.process.started"; payload: AgentProcessStartedPayload }
    | { type: "agent_session.process.output"; payload: AgentProcessOutputPayload }
    | { type: "agent_session.process.exited"; payload: AgentProcessExitedPayload }
    | { type: "task.created"; payload: TaskCreatedPayload }
    | { type: "task.updated"; payload: TaskUpdatedPayload }
    | { type: "task_dependency.created"; payload: TaskDependencyPayload }
    | { type: "task_dependency.deleted"; payload: TaskDependencyPayload }
    | { type: "agent_profile.changed"; payload: AgentProfileChangedPayload }
    | { type: "usage.recorded"; payload: UsageRecordedPayload }
    | { type: "handoff.created"; payload: HandoffCreatedPayload }
    | { type: "handoff.consumed"; payload: HandoffConsumedPayload }
    | { type: "handoff.discrepancy"; payload: HandoffDiscrepancyPayload }
    | { type: "handoff.checkpoint.failed"; payload: HandoffCheckpointFailedPayload }
    | { type: "handoff.final.caveats"; payload: HandoffFinalCaveatsPayload }
    | { type: "handoff.final.blocked"; payload: FinalBlockedPayload }
    | { type: "operator.decision.recorded"; payload: OperatorDecisionRecordedPayload }
    | { type: "run.completion.proposed"; payload: RunCompletionProposedPayload }
    | { type: "run.signoff.resolved"; payload: RunSignoffResolvedPayload }
    | { type: "run.reopened"; payload: RunReopenedPayload }
    | { type: "agent_session.unreported"; payload: AgentSessionUnreportedPayload }
    | { type: "agent_session.watchdog"; payload: AgentWatchdogPayload }
    | { type: "governance.tool.denied"; payload: ToolDeniedPayload }
    | { type: "agent_session.worktree.created"; payload: SeatWorktreeCreatedPayload }
    | { type: "agent_session.worktree.merged"; payload: SeatWorktreeMergedPayload }
    | { type: "agent_session.worktree.merge_failed"; payload: SeatWorktreeMergeFailedPayload }
    | { type: "agent_session.worktree.discarded"; payload: SeatWorktreeDiscardedPayload }
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
]);

/** Stable per-event identity used for client-side dedupe: seq for persisted events. */
export function eventId(event: ConsoleEvent): string | null {
  return event.seq != null ? `evt_${event.seq}` : null;
}
