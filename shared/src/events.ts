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
  ScheduledAssignment,
  SessionMessage,
  Task,
  UserSession,
  Workspace,
  PauseReason,
  SystemPauseState,
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
/** "deadline" is a set_deadline fire — distinct from "wake" so a deadline fire and a report wake are never conflated. */
export type TurnTrigger = "operator" | "wake" | "answer" | "deadline";
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
export interface UserRuntimePayload {
  userSessionId: string;
  detail: string;
  /** Deadline-fire forensics: which cron, when it was set/due, how late it fired. */
  cronId?: string;
  createdAt?: string;
  dueAt?: string | null;
  latenessMs?: number;
}
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
  /** The decision issue this ask participates in, when it has one. */
  issueId?: string;
}
export interface QuestionAnsweredPayload {
  userSessionId: string;
  interactionId: string;
  answers?: Record<string, string[]>;
  freeText?: Record<string, string>;
  note?: string;
  dismissed?: boolean;
  /** The sweep resolved this to the asker's recommendation (provisional). */
  autoProceeded?: boolean;
  recommendation?: string;
  /** Resolved together with its shared decision issue, not by its own card. */
  issueId?: string;
  /** The sibling card whose answer resolved the shared issue. */
  viaInteractionId?: string;
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
  /** "superseded" = the project's meaning moved while the proposal was pending; the Console withdrew it and will re-propose against fresh coverage. */
  reason: "changes_requested" | "operator_message" | "superseded";
}

/**
 * Provider capacity (or budget ceiling) paused the run. The run is NOT
 * failed: queued work stays queued and resumes when capacity returns.
 */
export interface RunCapacityPausedPayload {
  userSessionId: string;
  reason: PauseReason;
  /** Auto-resume time (ISO); null for budget pauses (operator resumes). */
  until: string | null;
  detail?: string;
}
export interface RunCapacityResumedPayload {
  userSessionId: string;
  manual?: boolean;
}
/**
 * The process-wide pause flipped. Scopeless (no session id) like
 * `workspace.created`: the top bar reads one signal for the whole install,
 * even when no session is open. Payload = the full state, so a late joiner
 * needs no other read.
 */
export type SystemPauseChangedPayload = SystemPauseState;

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
  /** Present when this card proposes a legacy SPEC revision rather than a plan. */
  spec?: { revision: number; changeNote?: string };
  /** Present when this card proposes a REQUIREMENT revision (the canonical spec). */
  requirements?: {
  revision: number;
  changeNote?: string;
  nodeCount: number;
  /** What the proposal patches: prose + structure, prose alone, or one subtree. */
  kind?: "full" | "intent" | "subtree";
  /** Subtree context for the card: the scope node and its ancestor chain. */
  scope?: { scopeId: string; statement: string; ancestors: { id: string; statement: string }[] };
  /** Server-computed change summary the operator approves against. */
  summary?: { added: string[]; changed: { id: string; statement: string }[]; retired: { id: string; statement: string }[] };
};
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
 * The Console recognised a report the sender labelled as something lesser: the
 * reporting agent addressed main with a terminal status. Every occurrence is a
 * near-miss worth reading — before the promotion existed, one of these ended a
 * run in silence.
 */
export interface HandoffCategoryPromotedPayload {
  agentSessionId: string; sender: string; from: string; to: string; status: string;
}

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
  /** Which remedy applies: content conflict vs dirty canonical checkout vs other. */
  kind: "conflict" | "dirty_tree" | "other";
  conflicts: string[];
  detail: string;
  artifactId: string | null;
}

export interface AgentWorktreeDiscardedPayload {
  agentSessionId: string;
  agent: string;
  reason: string;
  artifactId: string | null;
  /** Set when the branch was archived (infra failure) instead of deleted. */
  archivedBranch?: string | null;
}

/** A spec revision was approved (possibly operator-edited); it now governs the run. */
export interface SpecUpdatedPayload {
  userSessionId: string;
  revision: number;
  changeNote?: string;
  edited: boolean;
}

/**
 * A requirement revision was approved (possibly operator-edited); its graph
 * now governs the run as the committed specification.
 */
export interface RequirementsUpdatedPayload {
  userSessionId: string;
  revision: number;
  changeNote?: string;
  edited: boolean;
  nodeCount: number;
  /** Requirement ids minted by this revision. */
  added: string[];
  /** Requirement ids retired by this revision. */
  retired: string[];
  /** What the revision patched: prose + structure, prose alone, or one subtree. */
  kind: "full" | "intent" | "subtree";
  /** The subtree root a `subtree` revision amended. */
  scopeId?: string;
}

/**
 * A requirement's recorded status changed. Terminal statuses carry evidence;
 * `verifiedBy: "console"` marks mechanical resets (statement amended, node
 * retired), never a model's claim.
 */
export interface RequirementStatusChangedPayload {
  userSessionId: string;
  requirementId: string;
  from: string;
  to: string;
  verifiedBy: "self" | "independent" | "operator" | "console";
  /** "main", an agent name, "operator", or "console". */
  actor: string;
  agentSessionId?: string;
  evidenceCount: number;
  note?: string;
}

/** Refinement nodes were added below a committed (or delegated) requirement. */
export interface RequirementDecomposedPayload {
  userSessionId: string;
  parentId: string;
  addedIds: string[];
  actor: string;
  agentSessionId?: string;
}

/** Requirement ids were delegated to an agent session (its sub-scope). */
export interface RequirementDelegatedPayload {
  userSessionId: string;
  agentSessionId: string;
  requirementIds: string[];
  source: "commission" | "assignment" | "child";
}

/** A premise was recorded — the alternative to a silently invented default. */
export interface AssumptionRecordedPayload {
  userSessionId: string;
  id: string;
  text: string;
  source: "operator" | "main" | "agent";
  actor: string;
  agentSessionId?: string;
  /** Requirements linked rests_on at recording time. */
  requirementIds: string[];
}

/** A premise resolved. `affected` = linked requirements with their statuses at resolution. */
export interface AssumptionResolvedPayload {
  userSessionId: string;
  id: string;
  outcome: "confirmed" | "falsified" | "retired";
  actor: string;
  agentSessionId?: string;
  note?: string;
  evidenceCount: number;
  affected: { requirementId: string; status: string }[];
}

/** A requirement relationship was recorded or retired. */
export interface RequirementLinkChangedPayload {
  userSessionId: string;
  action: "recorded" | "retired";
  linkKind: "depends_on" | "conflicts_with" | "rests_on";
  fromId: string;
  toKind: "requirement" | "assumption";
  toId: string;
  actor: string;
  agentSessionId?: string;
}

/**
 * A meaning-changing event (approved amendment, falsified assumption,
 * withdrawn terminal claim) touched prior evidence or active work: its
 * console-computed transitive blast radius was persisted as a change impact.
 * Judgment stays with main/operator — nothing was reopened or rewritten.
 */
export interface ChangeImpactRecordedPayload {
  userSessionId: string;
  impactId: string;
  sourceKind: "amendment" | "assumption_falsified" | "claim_withdrawn";
  sourceRef: string;
  atRevision: number;
  /** The ids whose meaning/validity changed — the closure's seeds. */
  seedIds: string[];
  /** Terminal claims recorded before the change that may now be stale. */
  suspectClaims: { requirementId: string; status: string }[];
  /** Open agent sessions whose delegated or task-linked work is affected. */
  sessionIds: string[];
  /** Incomplete requirement-linked tasks inside the affected set. */
  taskIds: string[];
}

/** Main/operator judgment landed on change-impact items; `status` is the impact's derived state after this call. */
export interface ChangeImpactReconciledPayload {
  userSessionId: string;
  impactId: string;
  actor: string;
  items: { kind: "claim" | "session"; id: string; disposition: string; note: string }[];
  status: "open" | "reconciled";
}

/** A project-level decision issue was created for an operator ask. */
export interface DecisionIssueCreatedPayload {
  userSessionId: string;
  issueId: string;
  issueKey: string | null;
  subject: string;
  createdBy: string;
  interactionId: string;
  requirementIds: string[];
}

/** A later ask attached to an existing open issue — one card now answers for several askers. */
export interface DecisionIssueAskAttachedPayload {
  userSessionId: string;
  issueId: string;
  interactionId: string;
  asker: string;
  agentSessionId: string | null;
  /** Participating asks after the attach. */
  askCount: number;
}

/**
 * An issue got an answer. `supersedes` marks a reversal: the earlier
 * resolution stays in the history and the new entry becomes current.
 */
export interface DecisionIssueResolvedPayload {
  userSessionId: string;
  issueId: string;
  subject: string;
  answer: string;
  via: "card" | "chat" | "main";
  /** Asks resolved together with the issue (empty on a supersede — they were already resolved). */
  resolvedAskIds: string[];
  supersedes: boolean;
}

/** Main merged a duplicate issue into another; the source's asks now participate in the target. */
export interface DecisionIssueMergedPayload {
  userSessionId: string;
  fromIssueId: string;
  intoIssueId: string;
  movedAskIds: string[];
  why: string;
}

/** A workstream dependency link was declared: `consumer` depends on `producer` for `subject`. */
export interface WorkstreamLinkCreatedPayload {
  userSessionId: string;
  linkId: string;
  consumerAgentSessionId: string;
  producerAgentSessionId: string;
  subject: string;
  createdBy: string;
  note?: string;
  /** The link's derived status at creation ("satisfied" when the producer already reported). */
  status: "pending" | "satisfied";
}

/** Main released a workstream link with a judgment note (superseded, re-pointed, no longer holds). */
export interface WorkstreamLinkReleasedPayload {
  userSessionId: string;
  linkId: string;
  by: string;
  note: string;
}

/** A producer was archived without ever reporting; each live link on it is now visibly broken. */
export interface WorkstreamLinkBrokenPayload {
  userSessionId: string;
  linkId: string;
  producerAgentSessionId: string;
  consumerAgentSessionId: string;
  subject: string;
}

/**
 * A project continuation checkpoint was recorded at a run boundary — the
 * operational handoff the next UserSession on this project inherits. Emitted
 * once per source session (recording is idempotent).
 */
export interface ContinuationCheckpointRecordedPayload {
  /** The SOURCE session the checkpoint snapshots (also the envelope's session). */
  userSessionId: string;
  projectId: string;
  checkpointId: string;
  /** The governing requirement revision at record time (0 = none governed). */
  atRevision: number;
  /** The source session's runState at the boundary. */
  runState: "active" | "awaiting_signoff" | "completed";
  /** Whether model-authored synthesis (strategy et al.) was available to snapshot. */
  hasSynthesis: boolean;
  counts: { unfinishedWorkstreams: number; openChangeImpacts: number; openDecisionIssues: number; waivers: number };
}

/** Main revised its working state (strategy/uncertainties/assumptions/risks/completion). */
export interface StateUpdatedPayload {
  userSessionId: string;
  revision: number;
  trigger: "commission" | "discovery" | "alarm" | "direction_change" | "completion" | "operator";
  sections: string[];
  strategy?: string;
  counts: { uncertainties: number; assumptions: number; risks: number };
  /**
   * Refs to the evidence this update incorporates (handoff / agent-session /
   * artifact ids). Journal-only attribution: never required, never a DB
   * column — evaluation uses it to tie a state change to the returned result
   * that occasioned it.
   */
  incorporating?: string[];
}

/** A seat joined an open session mid-run (main's add_agent). */
export interface AgentAddedPayload {
  agentSessionId: string;
  agent: string;
  role: string;
  profileId: string;
  /** Main's capture-at-act rationale — the emergent need this seat answers. */
  why?: string;
}

/** A live turn is wedged: an in-flight tool call or the stream itself went quiet. */
export interface AgentLivenessTrippedPayload {
  agentSessionId: string;
  agent: string;
  turnId: string;
  kind: "tool_hang" | "quiet_turn";
  elapsedMs: number;
  toolName?: string;
  inputPreview?: string;
}

/** The orchestrator minted a narrow-only profile variant from a trusted base. */
export interface AgentProfileMintedPayload {
  userSessionId: string;
  profileId: string;
  baseProfileId: string;
  baseRevision: string;
  tools: string[];
  permissionMode: string;
  why?: string;
}

/** An alarmed tool call returned on its own — the alarm was a false positive. */
export interface AgentLivenessResolvedPayload {
  agentSessionId: string;
  agent: string;
  turnId: string;
  callId: string;
  elapsedMs?: number;
}

export interface TaskCreatedPayload {
  task: Task;
}
export interface TaskUpdatedPayload {
  task: Task;
  changed: string[];
}
/** One shape for all three `task.assignment.*` lifecycle events. */
export interface TaskAssignmentPayload {
  assignment: ScheduledAssignment;
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
  | "idle"
  /**
   * The seat's provider process is closed (idle reap or capacity eviction);
   * the resume handle is retained and the next delivery wakes it. Distinct
   * from `idle`: a parked seat still EXISTS as a durable participant but is
   * not resident — the difference between "team member between tasks" and
   * "process slot released", which is what resident-lane capacity counts.
   */
  | "parked";

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
    /** @deprecated historical — console-side rotation was removed; rows persist in old journals. */
    | { type: "user_session.context.rotated"; payload: UserContextRotatedPayload }
    | { type: "user_session.runtime.noted"; payload: UserRuntimePayload }
    | { type: "user_session.retry.recorded"; payload: RetryRecordedPayload }
    | { type: "user_session.tool.called"; payload: ToolCallPayload }
    | { type: "user_session.tool.completed"; payload: ToolResultPayload }
    | { type: "user_session.question.asked"; payload: QuestionAskedPayload }
    | { type: "user_session.question.answered"; payload: QuestionAnsweredPayload }
    | { type: "user_session.plan.proposed"; payload: PlanProposedPayload }
    | { type: "user_session.plan.resolved"; payload: PlanResolvedPayload }
    /** @deprecated historical — the legacy spec spine was removed; rows persist in old journals. */
    | { type: "user_session.spec.updated"; payload: SpecUpdatedPayload }
    | { type: "user_session.requirements.updated"; payload: RequirementsUpdatedPayload }
    | { type: "requirement.status.changed"; payload: RequirementStatusChangedPayload }
    | { type: "requirement.decomposed"; payload: RequirementDecomposedPayload }
    | { type: "requirement.delegated"; payload: RequirementDelegatedPayload }
    | { type: "assumption.recorded"; payload: AssumptionRecordedPayload }
    | { type: "assumption.resolved"; payload: AssumptionResolvedPayload }
    | { type: "requirement.link.changed"; payload: RequirementLinkChangedPayload }
    | { type: "change_impact.recorded"; payload: ChangeImpactRecordedPayload }
    | { type: "change_impact.reconciled"; payload: ChangeImpactReconciledPayload }
    | { type: "decision_issue.created"; payload: DecisionIssueCreatedPayload }
    | { type: "decision_issue.ask_attached"; payload: DecisionIssueAskAttachedPayload }
    | { type: "decision_issue.resolved"; payload: DecisionIssueResolvedPayload }
    | { type: "decision_issue.merged"; payload: DecisionIssueMergedPayload }
    | { type: "workstream.link.created"; payload: WorkstreamLinkCreatedPayload }
    | { type: "workstream.link.released"; payload: WorkstreamLinkReleasedPayload }
    | { type: "workstream.link.broken"; payload: WorkstreamLinkBrokenPayload }
    | { type: "user_session.state.updated"; payload: StateUpdatedPayload }
    | { type: "project.continuation.recorded"; payload: ContinuationCheckpointRecordedPayload }
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
    /** @deprecated historical — console-side rotation was removed; rows persist in old journals. */
    | { type: "agent_session.context.rotated"; payload: AgentContextRotatedPayload }
    | { type: "task.created"; payload: TaskCreatedPayload }
    | { type: "task.updated"; payload: TaskUpdatedPayload }
    | { type: "task.dependency.created"; payload: TaskDependencyPayload }
    | { type: "task.dependency.deleted"; payload: TaskDependencyPayload }
    | { type: "task.assignment.scheduled"; payload: TaskAssignmentPayload }
    | { type: "task.assignment.dispatched"; payload: TaskAssignmentPayload }
    | { type: "task.assignment.canceled"; payload: TaskAssignmentPayload }
    | { type: "agent_profile.changed"; payload: AgentProfileChangedPayload }
    | { type: "agent_profile.minted"; payload: AgentProfileMintedPayload }
    | { type: "usage.recorded"; payload: UsageRecordedPayload }
    | { type: "handoff.created"; payload: HandoffCreatedPayload }
    | { type: "handoff.consumed"; payload: HandoffConsumedPayload }
    | { type: "handoff.discrepancy.reported"; payload: HandoffDiscrepancyPayload }
    /** @deprecated historical — the model-queried rotation checkpoint was removed with rotation. */
    | { type: "handoff.checkpoint.failed"; payload: HandoffCheckpointFailedPayload }
    | { type: "handoff.final.caveats"; payload: HandoffFinalCaveatsPayload }
    | { type: "handoff.final.blocked"; payload: FinalBlockedPayload }
    | { type: "handoff.category.promoted"; payload: HandoffCategoryPromotedPayload }
    | { type: "operator.decision.recorded"; payload: OperatorDecisionRecordedPayload }
    | { type: "run.completion.proposed"; payload: RunCompletionProposedPayload }
    | { type: "run.signoff.resolved"; payload: RunSignoffResolvedPayload }
    | { type: "run.reopened"; payload: RunReopenedPayload }
    | { type: "run.capacity.paused"; payload: RunCapacityPausedPayload }
    | { type: "run.capacity.resumed"; payload: RunCapacityResumedPayload }
    | { type: "system.pause.changed"; payload: SystemPauseChangedPayload }
    | { type: "agent_session.closeout.forced"; payload: AgentSessionCloseoutForcedPayload }
    | { type: "agent_session.watchdog.tripped"; payload: AgentWatchdogTrippedPayload }
    | { type: "agent_session.liveness.tripped"; payload: AgentLivenessTrippedPayload }
    | { type: "agent_session.liveness.resolved"; payload: AgentLivenessResolvedPayload }
    | { type: "agent_session.agent.added"; payload: AgentAddedPayload }
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
