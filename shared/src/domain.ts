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
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
