import type { HandoffSummary } from "./handoffs.ts";

// Domain rows as they appear on the wire. The server owns persistence shapes;
// these are the JSON forms REST and the event spine agree on.

export type SessionMode = "execute" | "plan_execute";
export type SessionPhase = "planning" | "executing";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UserSession {
  id: string;
  workspaceId: string;
  title: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  /** Is this in the operator's active list. Orthogonal to `runState`. */
  lifecycle: "open" | "archived";
  /**
   * Is the work done. `awaiting_signoff` is the Console asserting it believes
   * the run is finished while the operator has not yet agreed.
   */
  runState: RunState;
  /**
   * The orchestrator model this session runs on. `null` means the server's
   * configured default — the client renders that default rather than the word
   * "null", so it reads `/api/config` for it.
   */
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunState = "active" | "awaiting_signoff" | "completed";

/**
 * The render-ready projection of a run summary — ONE shape shared by the
 * `run.completion.proposed` payload and the web fold's card, so copies cannot
 * drift.
 */
export interface RunSummaryStats {
  headline: string;
  verdict: "completed" | "completed_with_caveats" | "failed";
  filesChanged: number;
  tasks: { completed: number; total: number };
  durationMs: number;
  deadAirMs: number;
  costUsd: number | null;
  /** 1 = every observed turn has a usage row. Below 0.9 the cost reads "partial". */
  costCoverage: number;
  openUncertainty: number;
  reaped: { processes: number; browsers: number; leakedBefore: number };
}


/**
 * `reported` is derived, not stored: the coordinator has delivered a result to
 * main and nothing is in flight. Without it a finished session renders with the
 * same grey dot as one that died.
 */
export type AgentSessionStatus = "working" | "idle" | "reported" | "archived";

export type AgentSessionLifecycle = "open" | "archived";
/** Derived busy state — never stored. */
export type AgentSessionActivity = "working" | "idle" | "reported";

export interface AgentSession {
  id: string;
  userSessionId: string;
  title: string;
  lifecycle: AgentSessionLifecycle;
  activity: AgentSessionActivity;
  /** Orchestration-pattern catalog id (hub_and_spoke, pipeline, …). */
  pattern: string;
  /** NULL = top-level; set = this is a child session nested one level down. */
  parentAgentSessionId: string | null;
  /** Specialist agent names in seating order (excludes the coordinator). */
  agents: string[];
  createdAt: string;
  updatedAt: string;
}
export interface AgentRunSummary {
  agent: string;
  profileId: string;
  profile: Record<string, unknown>;
  ownership: string[];
  generation: number;
  turnCount: number;
  contextTokens: number;
  providerSessionId: string | null;
}

export type SpeakerKind = "operator" | "orchestrator" | "agent" | "system";

export interface Speaker {
  kind: SpeakerKind;
  /** "operator" | "orchestrator" (the main lane) | agent name | "system" */
  name: string;
}

export type MessageKind = "message" | "notice" | "plan";

export interface SessionMessage {
  seq: number;
  speaker: Speaker;
  to?: string;
  kind: MessageKind;
  text: string;
  /** Present only for structured v2 handoff rows; legacy rows remain plain text. */
  handoff?: HandoffSummary;
  createdAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  /** Stable Console-owned identity; provider ids remain reconciliation keys. */
  id: string;
  /** SDK session that owns the task list this task lives in. */
  sdkSessionId: string;
  /** The SDK's task id, unique within that session's list. */
  sdkTaskId: string;
  workspaceId: string;
  userSessionId: string;
  /** null = the orchestrator's own list. */
  agentSessionId: string | null;
  /** Agent name whose SDK session owns the list; null for the orchestrator. */
  agent: string | null;
  subject: string;
  description: string;
  activeForm: string | null;
  status: TaskStatus;
  owner: string | null;
  blocks: string[];
  blockedBy: string[];
  dependencyIds: string[];
  dependentIds: string[];
  /** `pending` with every dependency completed — the scheduler's dispatch predicate. */
  ready: boolean;
  /** The live scheduled assignment awaiting this task's dependencies, if any. */
  scheduledAssignment: {
    id: string;
    sender: string;
    recipient: string;
    createdAt: string;
  } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledAssignmentStatus = "scheduled" | "dispatched" | "canceled";

export type ScheduledAssignmentStatusReason =
  | "replaced"
  | "task_deleted"
  | "task_completed"
  | "session_archived"
  | "canceled";

/** A durable assignment awaiting its task's dependencies; no handoff body on the wire. */
export interface ScheduledAssignment {
  id: string;
  workspaceId: string;
  userSessionId: string;
  agentSessionId: string;
  taskId: string;
  sender: string;
  recipient: string;
  category: string;
  status: ScheduledAssignmentStatus;
  statusReason: ScheduledAssignmentStatusReason | null;
  dispatchedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  blockerTaskId: string;
  blockedTaskId: string;
  source: "console" | "provider" | "migration";
  createdAt: string;
}

export interface SessionTreeBranch {
  session: UserSession;
  agentSessions: AgentSession[];
}

export interface ProfileValidationIssue {
  level: "error" | "warning";
  path: string | null;
  message: string;
}

export interface AgentProfileSummary {
  id: string;
  title: string;
  purpose: string;
  source: "builtin" | "workspace";
  revision: string;
  trusted: boolean;
  valid: boolean;
  tools: string[];
  skills: string[];
  componentCounts: Record<string, number>;
}

export interface AgentProfileComponent {
  kind: "prompt" | "skill" | "hook" | "mcp" | "agent" | "command" | "monitor" | "settings" | "other";
  name: string;
  path: string;
  supported: boolean;
  summary: string;
}

export interface AgentProfileDetail extends AgentProfileSummary {
  instructions: string;
  permissionMode: "default" | "plan" | "bypassPermissions";
  model: string | null;
  effort: string | null;
  maxTurns: number;
  sandboxRequired: boolean;
  runtime: { shell: boolean; browser: boolean; screenshots: boolean };
  handoffExtension: string | null;
  pluginPath: string | null;
  components: AgentProfileComponent[];
  files: { path: string; content: string }[];
  issues: ProfileValidationIssue[];
}

export interface ManagerSession {
  id: string;
  workspaceId: string;
  profileKey: string;
  profileId: string | null;
  title: string;
  phase: SessionPhase;
  lifecycle: "open" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ProfileProposal {
  managerSessionId: string;
  baseRevision: string | null;
  profileId: string | null;
  files: { path: string; before: string | null; after: string | null }[];
  issues: ProfileValidationIssue[];
  valid: boolean;
}

export type TimelineLaneKind = "operator" | "orchestrator" | "agent_session" | "agent";
export interface TimelineLane {
  id: string;
  kind: TimelineLaneKind;
  label: string;
  parentId: string | null;
  order: number;
}

export interface TimelineItem {
  id: string;
  laneId: string;
  kind: "message" | "turn" | "tool" | "process" | "task" | "handoff" | "decision" | "rotation" | "runtime" | "usage";
  label: string;
  start: string;
  end: string | null;
  status: string | null;
  eventSeqs: number[];
  detail: Record<string, unknown>;
}

export type InteractionKind = "question" | "plan_approval";
export type InteractionStatus =
  | "pending"
  | "answered"
  | "rejected"
  | "dismissed"
  | "stale";

/**
 * Blocking parks the asker until the operator answers; deferred renders the
 * card immediately and hands the answer over at the asker's next delivery.
 * A column rather than a status, because `status`'s CHECK cannot be widened on
 * an existing database.
 */
export type InteractionUrgency = "blocking" | "deferred";
/** Who raised it: an agent directly, the uncertainty classifier, or the Console. */
export type InteractionSource = "agent" | "console";

/** One AskUserQuestion question block, as the SDK tool shapes it. */
export interface InteractionQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  /**
   * Which option the asker recommends, and why. `request_decision` accepted
   * this and then dropped it on the blocking path, so the operator never saw
   * the asker's own read of its own question.
   */
  recommendation?: string;
  /** Why they are asking and what they already tried. Never an option. */
  context?: string;
}

export interface Interaction {
  id: string;
  userSessionId: string;
  /** Null = the main lane. Otherwise the AgentSession the asker sits in. */
  agentSessionId: string | null;
  /** Null = the main lane. Otherwise the asking agent's name. */
  agent: string | null;
  kind: InteractionKind;
  status: InteractionStatus;
  urgency: InteractionUrgency;
  source: InteractionSource;
  /** Card-level recommendation for Console-generated cards. */
  recommendation: string | null;
  allowFreeText: boolean;
  /**
   * The asker's parked promise died (park, rotation, watchdog, restart). The
   * row is still answerable — the answer is delivered by mailbox instead of
   * returned from the tool call.
   */
  detached: boolean;
  payload:
    | { questions: InteractionQuestion[] }
    | { plan: string };
  response: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Orchestration-pattern catalog ids — the create-session wire vocabulary. */
export const PATTERN_IDS = [
  "hub_and_spoke",
  "pipeline",
  "evaluator_optimizer",
  "map_reduce",
  "peer_to_peer",
  "plan_execute",
  "debate",
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];
