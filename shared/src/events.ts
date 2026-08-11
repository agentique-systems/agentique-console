// The event spine wire contract. Both server emission and web folds compile
// against these exact shapes. Persisted events carry a global `seq` (the SSE
// id); transient frames have no seq and are never replayed.
//
// Naming convention (durable events): `scope.subject.verb-past`, two parts
// allowed when the subject IS the scope entity. Transient stream frames
// (`stream.*`) are exempt. Payloads never carry a bare `sessionId` — always
// `userSessionId` / `agentSessionId`.

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

/** Which transcript a transient frame belongs to; never a bare `sessionId`. */
export type EventScope =
  | { kind: "user"; userSessionId: string }
  | { kind: "agent"; agentSessionId: string };

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
  userSessionId: string;
  patch: Partial<
    Pick<UserSession, "title" | "mode" | "phase" | "lifecycle" | "runState">
  >;
}
export interface UserSessionMessagePayload {
  userSessionId: string;
  message: SessionMessage;
}
export type TurnTrigger = "operator" | "wake" | "answer";
export interface UserTurnStartedPayload {
  userSessionId: string;
  turnId: string;
  trigger: TurnTrigger;
}
export interface UserTurnSettledPayload {
  userSessionId: string;
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorMessage?: string;
  /** Jobs still queued for this session — UI keeps the busy state up while > 0. */
  queuedJobs: number;
  durationMs?: number;
}
export interface UserContextRotatedPayload {
  userSessionId: string; generation: number; reason: "token_limit" | "turn_limit";
  handoffId?: string; checkpointBytes?: number; degraded?: boolean;
}
export interface UserRuntimePayload { userSessionId: string; detail: string; }
interface ToolCallCore {
  turnId: string;
  callId: string;
  name: string;
  /** Size-capped JSON value (~16KB serialized). */
  input: unknown;
}
interface ToolResultCore {
  callId: string;
  turnId?: string;
  /** Size-capped JSON value (~16KB serialized). */
  output: unknown;
  isError?: boolean;
  durationMs?: number;
  bytes?: number;
}
export interface ToolCallPayload extends ToolCallCore {
  userSessionId: string;
}
export interface ToolResultPayload extends ToolResultCore {
  userSessionId: string;
}
export interface QuestionAskedPayload {
  userSessionId: string;
  interactionId: string;
  questions: InteractionQuestion[];
  /** The asking agent, so the card can name it. Absent = the main lane. */
  agentSessionId?: string;
  agent?: string;
  urgency: InteractionUrgency;
  source: InteractionSource;
  recommendation?: string;
  allowFreeText: boolean;
}
export interface QuestionAnsweredPayload {
  userSessionId: string;
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
  userSessionId: string;
  runId: string;
  summaryId: string;
}
/**
 * The operator's verdict. Deliberately no separate `run.completed` event —
 * `decision:"accept"` IS completion, and a second event could disagree with it.
 */
export interface RunSignoffResolvedPayload {
  userSessionId: string;
  runId: string;
  decision: "accept" | "changes";
  note?: string;
}
export interface RunReopenedPayload {
  userSessionId: string;
  runId: string;
  reason: "changes_requested" | "operator_message";
}

/**
 * The operator decided something. Durable and session-scoped: every agent and
 * every later generation reads these back, so an answer given once never has
 * to be relayed or re-derived.
 */
export interface OperatorDecisionRecordedPayload {
  userSessionId: string;
  decisionId: string;
  agentSessionId?: string;
  interactionId?: string;
  /** Agent name, "coordinator", "main", or "console". */
  askedBy: string;
  source: "interaction" | "plan_approval";
  question: string;
  answer: string;
}
export interface PlanProposedPayload {
  userSessionId: string;
  interactionId: string;
  plan: string;
}
export interface PlanResolvedPayload {
  userSessionId: string;
  interactionId: string;
  approved: boolean;
  note?: string;
}

export interface AgentSessionCreatedPayload {
  session: AgentSession;
  agents: string[];
}
export interface AgentSessionMessagePayload {
  agentSessionId: string;
  message: SessionMessage;
}
export interface AgentTurnStartedPayload {
  agentSessionId: string;
  agent: string;
  turnId: string;
}
export interface AgentTurnSettledPayload {
  agentSessionId: string;
  agent: string;
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorMessage?: string;
  durationMs?: number;
}
export interface AgentToolCallPayload extends ToolCallCore {
  agentSessionId: string;
  agent: string;
}
export interface AgentToolResultPayload extends ToolResultCore {
  agentSessionId: string;
  agent: string;
}
export interface AgentSessionStatusChangedPayload {
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
 * animations, while `agent_session.delegation.sent`/`agent_session.result.returned`
 * keep carrying the root main↔session edges. No third flow vocabulary.
 */
/** A controller agent spawned a child session; agentSessionId is the PARENT. */
export interface AgentSessionChildSpawnedPayload {
  agentSessionId: string;
  childAgentSessionId: string;
  pattern: string;
  byAgent: string;
  title: string;
}
/** A child's final/failure crossed the boundary into its parent. */
export interface AgentSessionChildReportedPayload {
  agentSessionId: string;
  childAgentSessionId: string;
  status: "completed" | "failed";
  handoffId: string;
}
export interface AgentDeliveryUpdatedPayload {
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
  agent: string;
  turnId?: string;
  detail: string;
}
export interface AgentContextRotatedPayload {
  agentSessionId: string;
  agent: string;
  generation: number;
  reason: "token_limit" | "turn_limit";
  handoffId?: string; checkpointBytes?: number; degraded?: boolean;
}
export interface AgentProcessStartedPayload {
  agentSessionId: string; agent: string; processId: string;
  command: string; args: string[]; cwd: string; pid?: number;
}
export interface AgentProcessOutputPayload {
  agentSessionId: string; agent: string; processId: string;
  seq: number; stream: "stdout" | "stderr"; text: string;
}
export interface AgentProcessExitedPayload {
  agentSessionId: string; agent: string; processId: string;
  code: number | null; signal: string | null;
}
export interface UsageRecordedPayload {
  userSessionId: string;
  /** Present when the sample belongs to an agent rather than the main lane. */
  agentSessionId?: string;
  agent: string; profileId?: string; generation: number;
  turnId: string; inputTokens: number; outputTokens: number; costUsd?: number;
  uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number;
  model?: string; effort?: string; trigger?: string; durationMs?: number;
  apiDurationMs?: number; sdkDurationMs?: number;
  status?: "completed" | "error" | "aborted"; stopReason?: string;
}

/**
 * A provider retry, recorded with its numbers instead of as prose. The
 * transcript keeps the human-readable runtime notice; THIS is what counters
 * and budgets read.
 */
export interface RetryRecordedPayload {
  userSessionId: string;
  /** Present when the retrying lane is an agent rather than the main lane. */
  agentSessionId?: string;
  agent?: string;
  kind: "api_error" | "rate_limited";
  attempt?: number;
  retryInMs?: number;
  detail: string;
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
export interface HandoffConsumedPayload { handoffId: string; agent: string; mode: "compact" | "expanded"; }
export interface HandoffDiscrepancyPayload { handoffId: string; reporter: string; claim: string; evidence: string; }
export interface HandoffCheckpointFailedPayload { agent: string; reason: string; degraded: boolean; }
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
export interface AgentSessionCloseoutForcedPayload { agentSessionId: string; agentReports: number; hadCoordinatorReport: boolean; }

/** The console interrupted an agent turn that was repeating itself without progress. */
export interface AgentWatchdogTrippedPayload {
  agentSessionId: string;
  agent: string;
  turnId: string;
  kind: "repeat_tool_calls" | "tool_error_streak";
  toolName?: string;
  count: number;
  detail: string;
}

/** A `canUseTool` gate denied a tool call. */
export interface ToolDeniedPayload {
  userSessionId: string;
  /** Present for an agent-level denial; absent for the main lane's. */
  agentSessionId?: string;
  agent?: string;
  toolName: string;
  kind: "coordination_only" | "empty_question" | "question_declined" | "plan_missing" | "plan_rejected";
  reason: string;
}

/** Agent worktree isolation: write agents land completed work atomically. */
export interface AgentWorktreeCreatedPayload {
  agentSessionId: string;
  agent: string;
  branch: string;
  baseCommit: string;
}

export interface AgentWorktreeMergedPayload {
  agentSessionId: string;
  agent: string;
  mergeCommit: string;
  filesChanged: number;
  artifactId: string | null;
}

export interface AgentWorktreeMergeFailedPayload {
  agentSessionId: string;
  agent: string;
  conflicts: string[];
  detail: string;
  artifactId: string | null;
}

export interface AgentWorktreeDiscardedPayload {
  agentSessionId: string;
  agent: string;
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

export interface DelegationSentPayload {
  userSessionId: string;
  agentSessionId: string;
  kind: "created" | "sent";
  preview: string;
}
export interface ResultReturnedPayload {
  userSessionId: string;
  agentSessionId: string;
  digestPreview: string;
}

// ---------------------------------------------------------------------------
// Streaming payloads are transient. Agent activity is durable so crashes and
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

export interface AgentActivityChangedPayload {
  scope: EventScope;
  agent: string;
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
    | { type: "user_session.message.appended"; payload: UserSessionMessagePayload }
    | { type: "user_session.turn.started"; payload: UserTurnStartedPayload }
    | { type: "user_session.turn.settled"; payload: UserTurnSettledPayload }
    | { type: "user_session.context.rotated"; payload: UserContextRotatedPayload }
    | { type: "user_session.runtime.noted"; payload: UserRuntimePayload }
    | { type: "user_session.retry.recorded"; payload: RetryRecordedPayload }
    | { type: "user_session.tool.called"; payload: ToolCallPayload }
    | { type: "user_session.tool.completed"; payload: ToolResultPayload }
    | { type: "user_session.question.asked"; payload: QuestionAskedPayload }
    | { type: "user_session.question.answered"; payload: QuestionAnsweredPayload }
    | { type: "user_session.plan.proposed"; payload: PlanProposedPayload }
    | { type: "user_session.plan.resolved"; payload: PlanResolvedPayload }
    | { type: "agent_session.created"; payload: AgentSessionCreatedPayload }
    | { type: "agent_session.termination.tripped"; payload: AgentSessionTerminationTrippedPayload }
    | { type: "agent_session.join.completed"; payload: AgentSessionJoinCompletedPayload }
    | { type: "agent_session.child.spawned"; payload: AgentSessionChildSpawnedPayload }
    | { type: "agent_session.child.reported"; payload: AgentSessionChildReportedPayload }
    | { type: "agent_session.message.appended"; payload: AgentSessionMessagePayload }
    | { type: "agent_session.turn.started"; payload: AgentTurnStartedPayload }
    | { type: "agent_session.turn.settled"; payload: AgentTurnSettledPayload }
    | { type: "agent_session.tool.called"; payload: AgentToolCallPayload }
    | { type: "agent_session.tool.completed"; payload: AgentToolResultPayload }
    | { type: "agent_session.status.changed"; payload: AgentSessionStatusChangedPayload }
    | { type: "agent_session.delivery.updated"; payload: AgentDeliveryUpdatedPayload }
    | { type: "agent_session.runtime.noted"; payload: AgentRuntimePayload }
    | { type: "agent_session.retry.recorded"; payload: RetryRecordedPayload }
    | { type: "agent_session.context.rotated"; payload: AgentContextRotatedPayload }
    | { type: "agent_session.process.started"; payload: AgentProcessStartedPayload }
    | { type: "agent_session.process.output"; payload: AgentProcessOutputPayload }
    | { type: "agent_session.process.exited"; payload: AgentProcessExitedPayload }
    | { type: "task.created"; payload: TaskCreatedPayload }
    | { type: "task.updated"; payload: TaskUpdatedPayload }
    | { type: "task.dependency.created"; payload: TaskDependencyPayload }
    | { type: "task.dependency.deleted"; payload: TaskDependencyPayload }
    | { type: "agent_profile.changed"; payload: AgentProfileChangedPayload }
    | { type: "usage.recorded"; payload: UsageRecordedPayload }
    | { type: "handoff.created"; payload: HandoffCreatedPayload }
    | { type: "handoff.consumed"; payload: HandoffConsumedPayload }
    | { type: "handoff.discrepancy.reported"; payload: HandoffDiscrepancyPayload }
    | { type: "handoff.checkpoint.failed"; payload: HandoffCheckpointFailedPayload }
    | { type: "handoff.final.caveats"; payload: HandoffFinalCaveatsPayload }
    | { type: "handoff.final.blocked"; payload: FinalBlockedPayload }
    | { type: "operator.decision.recorded"; payload: OperatorDecisionRecordedPayload }
    | { type: "run.completion.proposed"; payload: RunCompletionProposedPayload }
    | { type: "run.signoff.resolved"; payload: RunSignoffResolvedPayload }
    | { type: "run.reopened"; payload: RunReopenedPayload }
    | { type: "agent_session.closeout.forced"; payload: AgentSessionCloseoutForcedPayload }
    | { type: "agent_session.watchdog.tripped"; payload: AgentWatchdogTrippedPayload }
    | { type: "tool.denied"; payload: ToolDeniedPayload }
    | { type: "agent_session.worktree.created"; payload: AgentWorktreeCreatedPayload }
    | { type: "agent_session.worktree.merged"; payload: AgentWorktreeMergedPayload }
    | { type: "agent_session.worktree.merge_failed"; payload: AgentWorktreeMergeFailedPayload }
    | { type: "agent_session.worktree.discarded"; payload: AgentWorktreeDiscardedPayload }
    | { type: "agent_session.delegation.sent"; payload: DelegationSentPayload }
    | { type: "agent_session.result.returned"; payload: ResultReturnedPayload }
    | { type: "stream.delta"; payload: StreamDeltaPayload }
    | { type: "stream.reasoning"; payload: StreamReasoningPayload }
    | { type: "agent_session.activity.changed"; payload: AgentActivityChangedPayload }
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
