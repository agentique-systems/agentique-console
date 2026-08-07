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
  status: "open" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type ConversationPurpose = "work" | "profile_manager";

export type AgentSessionStatus = "working" | "idle" | "archived";

export interface AgentSession {
  id: string;
  userSessionId: string;
  title: string;
  mode: SessionMode;
  phase: SessionPhase;
  status: AgentSessionStatus;
  /** Specialist seat names in seating order (excludes the orchestrator's virtual seat). */
  participants: string[];
  createdAt: string;
  updatedAt: string;
}
export interface AgentRunSummary {
  participant: string;
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
  /** "operator" | "orchestrator" | seat name | "system" */
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
  /** Seat name whose SDK session owns the list; null for the orchestrator. */
  participant: string | null;
  subject: string;
  description: string;
  activeForm: string | null;
  status: TaskStatus;
  owner: string | null;
  blocks: string[];
  blockedBy: string[];
  dependencyIds: string[];
  dependentIds: string[];
  unresolvedDependencies: string[];
  metadata: Record<string, unknown>;
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
  status: "open" | "archived";
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

/** One AskUserQuestion question block, as the SDK tool shapes it. */
export interface InteractionQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface Interaction {
  id: string;
  userSessionId: string;
  kind: InteractionKind;
  status: InteractionStatus;
  payload:
    | { questions: InteractionQuestion[] }
    | { plan: string };
  response: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}
