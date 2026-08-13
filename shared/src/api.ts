// REST request/response shapes. Paths are listed next to each shape so the
// server routes and the web client stay honest against one file.

import type {
  AgentSession,
  AgentRunSummary,
  Interaction,
  ScheduledAssignment,
  SessionMessage,
  SessionMode,
  Task,
  TaskDependency,
  UserSession,
  Workspace,
  SessionTreeBranch,
  AgentProfileSummary,
  AgentProfileDetail,
  ManagerSession,
  ProfileProposal,
  TimelineLane,
  TimelineItem,
} from "./domain.ts";
import type { HandoffPage } from "./handoffs.ts";
import type { ConsoleEvent } from "./events.ts";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// GET /api/health
export interface HealthResponse {
  ok: true;
}

// GET /api/stats
export interface StatsResponse {
  lastEventSeq: number;
}

// GET /api/config
/**
 * Server-resolved defaults the client cannot derive. Only the server knows
 * whether `CONSOLE_MODEL` moved the orchestrator default, and the draft view
 * has to preselect the right chip before a session exists.
 */
export interface ConfigResponse {
  defaultModel: string;
}

// GET /api/fs/roots
export interface FsRootsResponse {
  roots: { path: string; label: string }[];
}

// GET /api/fs/dirs?path=&showHidden=
export interface FsDirsResponse {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; hidden: boolean }[];
}

// GET /api/workspaces
export type ListWorkspacesResponse = Workspace[];

// POST /api/workspaces
export interface CreateWorkspaceBody {
  name: string;
  rootPath: string;
  /** mkdir -p the rootPath when it does not exist. */
  create?: boolean;
}

// GET /api/user-sessions?workspaceId=
/**
 * `pendingInteractions` is server-authoritative attention. The client's
 * `ui.awaitingInput` is a live overlay only — it is rebuilt from events and is
 * therefore lossy on a cold boot, which is exactly when the operator most needs
 * to know a run is waiting on them.
 */
export interface UserSessionListItem extends UserSession {
  pendingInteractions: number;
}
export type ListUserSessionsResponse = UserSessionListItem[];

// POST /api/user-sessions — create-on-first-message
export interface CreateUserSessionBody {
  workspaceId: string;
  mode: SessionMode;
  message: string;
  /** Orchestrator model; omitted means the server's configured default. */
  model?: string;
}
export interface CreateUserSessionResponse {
  session: UserSession;
}

// GET /api/user-sessions/:id
export interface GetUserSessionResponse {
  session: UserSession;
  pendingInteractions: Interaction[];
}

// PATCH /api/user-sessions/:id
export interface PatchUserSessionBody {
  mode?: SessionMode;
  title?: string;
  lifecycle?: "open" | "archived";
  /** Takes effect on the next turn: the change recycles the lane. */
  model?: string;
}

// POST /api/user-sessions/:id/messages → 202
export interface PostMessageBody {
  text: string;
}
export interface PostMessageResponse {
  messageId: string;
  seq: number;
}

// POST /api/user-sessions/:id/interactions/:interactionId
export type ResolveInteractionBody =
  | {
      /** Chosen option labels per question. May be `{}` when freeText covers every question. */
      answers: Record<string, string[]>;
      /**
       * Free-text answer per question, keyed by question text. Only accepted
       * when the card was raised with `allowFreeText`. Without this the only
       * way to say something the asker did not anticipate was to type in chat,
       * which DISMISSES the card rather than answering it.
       */
      freeText?: Record<string, string>;
      /** Card-level note attached to any answer. */
      note?: string;
    }
  | {
      decision: "approve" | "reject";
      note?: string;
      /**
       * The operator's edited version of the proposed plan/spec text. On
       * approval this becomes the governing text — their words outrank the
       * proposal.
       */
      editedDocument?: string;
    };

// POST /api/user-sessions/:id/signoff
export interface RunSignoffBody {
  decision: "accept" | "changes";
  note?: string;
}
// GET /api/user-sessions/:id/transcript
// GET /api/agent-sessions/:id/transcript
export type TranscriptResponse = ConsoleEvent[];

// GET /api/user-sessions/:id/agent-sessions
export type ListAgentSessionsResponse = AgentSession[];

// GET /api/agent-sessions/:id
export interface GetAgentSessionResponse {
  session: AgentSession;
  runs: AgentRunSummary[];
  messages: SessionMessage[];
}

// GET /api/user-sessions/:id/tasks
export type ListTasksResponse = Task[];

// GET /api/workspaces/:id/session-tree
export type SessionTreeResponse = SessionTreeBranch[];

// GET /api/workspaces/:id/tasks
export interface WorkspaceTasksResponse {
  tasks: Task[];
  dependencies: TaskDependency[];
  /** Live (`scheduled`) assignments only; tombstones stay server-side. */
  scheduledAssignments: ScheduledAssignment[];
}

// GET /api/workspaces/:id/agent-profiles
export type ListAgentProfilesResponse = AgentProfileSummary[];
// GET /api/workspaces/:id/agent-profiles/:profileId
export type GetAgentProfileResponse = AgentProfileDetail;

// POST /api/workspaces/:id/profile-manager-sessions
export interface CreateManagerSessionBody {
  profileId?: string;
  sourceProfileId?: string;
}
export interface ManagerSessionResponse {
  session: ManagerSession;
  proposal: ProfileProposal | null;
}

// GET /api/user-sessions/:id/timeline
export interface TimelinePageResponse {
  lanes: TimelineLane[];
  items: TimelineItem[];
  nextBeforeSeq: number | null;
}

// GET /api/handoffs/:id?section=&cursor=&maxBytes=
export type ReadHandoffResponse = HandoffPage;

// POST /api/compose/improve — a one-shot rewrite of a draft message. Nothing
// is persisted; the caller decides whether to keep the result.
export interface ImproveMessageBody {
  text: string;
}
export interface ImproveMessageResponse {
  text: string;
}
