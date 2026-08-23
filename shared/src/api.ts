// REST request/response shapes. Paths are listed next to each shape so the
// server routes and the web client stay honest against one file.

import type {
  AgentSession,
  AgentSessionStatus,
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
  TimelineLane,
  TimelineItem,
  SystemPauseState,
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

// GET /api/system/pause · POST /api/system/pause · POST /api/system/resume
export interface PauseSystemBody {
  /** hard (default): interrupt in-flight turns too; soft: only mint no new ones. */
  mode?: "hard" | "soft";
  detail?: string;
}
export type PauseSystemResponse = SystemPauseState & {
  /** Turns the hard pause interrupted; 0/0 for soft. */
  interrupted: { main: number; seats: number };
};

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
  /**
   * Continue an existing project: the new session reads and extends its
   * requirement graph, ids, and decision ledger. Continuation is SEQUENTIAL —
   * rejected while the project has another open session. Omitted mints a
   * fresh project.
   */
  projectId?: string;
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
  /** Spend ceiling (USD); crossing it pauses the run. null clears it. */
  budgetUsd?: number | null;
  /** "away" = proceed on recommendations; queue only irreversible decisions. */
  autonomy?: "standard" | "away";
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

/**
 * The end-of-run report the operator reads on the sign-off card: console-owned
 * facts plus main's own criteria→evidence justification (null = a VISIBLE
 * omission, deliberately never a blocker). Lives here because the card
 * renders it; the completion service re-exports it for server code.
 */
export interface RunSummaryDocument {
  seqFrom: number;
  seqTo: number;
  verdict: "completed" | "completed_with_caveats" | "failed" | "infeasible";
  headline: string;
  durationMs: number;
  /** Wall clock minus the UNION of every turn interval across both lanes. */
  deadAirMs: number;
  build: { filesChanged: number; files: string[]; source: "git" | "handoff" | "none" };
  tasks: { completed: number; total: number; open: string[]; ledgerUpdatedAt: string | null };
  cost: {
    usd: number | null;
    /** recordedTurns / observedTurns. Below 0.9 the figure is labelled partial. */
    coverage: number;
    recordedTurns: number;
    observedTurns: number;
    inputTokens: number;
    outputTokens: number;
    byParticipant: { participant: string; usd: number | null; turns: number }[];
  };
  decisions: { question: string; answer: string; askedBy: string }[];
  /** Console-owned facts about what the run did not do as asked. */
  deviations: string[];
  uncertainty: string[];
  /** Seats whose provider process the Console released when the run settled. */
  resources: { reapedSeats: number; detail: string[] };
  justification: {
    revision: number;
    criteria: {
      /** Requirement id + statement (requirement-keyed records). */
      requirement?: string;
      statement?: string;
      /** Pre-graph records: the freeform criterion string. */
      criterion?: string;
      met: boolean;
      evidence: { kind: string; ref: string }[];
    }[];
    knownGaps: string[];
    nonGoals: string[];
  } | null;
  /**
   * Snapshot of the requirement graph at proposal time: status counts and the
   * rendered status outline. Persisted with the summary so a later amendment
   * never rewrites an old report. Null for pre-graph runs.
   */
  requirements: {
    revision: number;
    counts: Record<import("./requirements.ts").RequirementStatus, number>;
    outline: string;
  } | null;
  friction: { apiRetries: number; rateLimited: number; failedTurns: number; watchdogTrips: number; capacityPauses: number };
}

// GET /api/user-sessions/:id/run-summaries/:summaryId — the full document
// behind the sign-off card's scalars.
export interface GetRunSummaryResponse {
  id: string;
  status: "proposed" | "accepted" | "changes_requested";
  verdict: RunSummaryDocument["verdict"];
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  document: RunSummaryDocument;
}

// GET /api/user-sessions/:id/spec — the living specification.
export interface SpecRevisionWire {
  id: string;
  revision: number;
  document: string;
  changeNote: string | null;
  status: "draft" | "approved" | "superseded" | "rejected";
  origin: "main" | "operator_edited";
  /** The interaction card that approved this revision. */
  interactionId: string | null;
  createdAt: string;
  approvedAt: string | null;
}
export interface GetSpecResponse {
  revisions: SpecRevisionWire[];
  approved: SpecRevisionWire | null;
}

// GET /api/user-sessions/:id/requirements — the committed requirement graph
// (canonical specification) plus its live state.
export interface RequirementRevisionWire {
  id: string;
  revision: number;
  /** Canonical committed outline (renderCommitted output). */
  document: string;
  changeNote: string | null;
  status: "draft" | "approved" | "superseded" | "rejected";
  origin: "main" | "operator_edited";
  interactionId: string | null;
  nodeCount: number;
  createdAt: string;
  approvedAt: string | null;
}
export interface GetRequirementsResponse {
  revisions: RequirementRevisionWire[];
  approved: RequirementRevisionWire | null;
  /** Live nodes (committed + refinement) with recorded and derived statuses. */
  nodes: import("./domain.ts").RequirementNodeWire[];
  /** Open requirements whose resolution still affects the root, annotated. */
  frontier: import("./domain.ts").RequirementFrontierEntry[];
}

// POST /api/user-sessions/:id/requirements/:requirementId/status — the
// operator's own verdict on one requirement. Evidence is optional for the
// operator alone: their word IS the gate, and it is recorded as such.
export interface OperatorRequirementStatusBody {
  status: "open" | "satisfied" | "violated" | "infeasible";
  evidence?: { kind: string; ref: string; label?: string }[];
  note?: string;
}

// GET /api/user-sessions/:id/orchestration — the review surface: working
// state plus every commission joined to its rationale and outcome by STABLE
// ids (the creation briefing's handoff, never whatever main sent last).
export interface OrchestrationStateWire {
  revision: number;
  trigger: string;
  strategy: string;
  strategyWhy: string;
  uncertainties: string[];
  assumptions: string[];
  risks: string[];
  note: string | null;
  completion: Record<string, unknown> | null;
  createdAt: string;
}
export interface CommissionSummary {
  agentSessionId: string;
  title: string;
  pattern: string;
  lifecycle: string;
  parentAgentSessionId: string | null;
  /** The derived live status (working/idle/reported/archived), not just the lifecycle bit. */
  status: AgentSessionStatus;
  /** The creation briefing — later steering never overwrites it. Null for child sessions (their controller commissions them). */
  commission: { handoffId: string; action: string; why: string | null; expecting: string | null; briefedAt: string } | null;
  /** Steering after the briefing is counted, not listed — the handoffs are first-class on the timeline. */
  steering: { count: number };
  /** The delegated sub-scope: requirement ids this session answers for. */
  requirements: { id: string; statement: string }[];
  /** The last terminal report (final/failure) to main, by stable id. */
  outcome: { handoffId: string; trigger: string; status: string; action: string } | null;
}
export interface GetOrchestrationResponse {
  current: OrchestrationStateWire | null;
  revisions: OrchestrationStateWire[];
  commissions: CommissionSummary[];
}
