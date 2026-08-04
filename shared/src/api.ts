// REST request/response shapes. Paths are listed next to each shape so the
// server routes and the web client stay honest against one file.

import type {
  AgentSession,
  AgentRunSummary,
  Interaction,
  SessionMessage,
  SessionMode,
  Task,
  UserSession,
  Workspace,
} from "./domain.ts";
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
export type ListUserSessionsResponse = UserSession[];

// POST /api/user-sessions — create-on-first-message
export interface CreateUserSessionBody {
  workspaceId: string;
  mode: SessionMode;
  message: string;
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
  status?: "open" | "archived";
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
  | { answers: Record<string, string[]> }
  | { decision: "approve" | "reject"; note?: string };

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

// POST /api/compose/improve — a one-shot rewrite of a draft message. Nothing
// is persisted; the caller decides whether to keep the result.
export interface ImproveMessageBody {
  text: string;
}
export interface ImproveMessageResponse {
  text: string;
}
