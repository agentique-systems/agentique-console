// REST request/response shapes. Paths are listed next to each shape so the
// server routes and the web client stay honest against one file.

import type {
  AgentSession,
  AgentSessionStatus,
  AgentRunSummary,
  DecisionIssueWire,
  Interaction,
  PauseReason,
  RunState,
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

// POST /api/user-sessions/:id/continue — the explicit run-boundary handoff.
/**
 * Continue the source session's PROJECT in a fresh UserSession. If the source
 * is still open (quota-paused, idle, awaiting sign-off) it is archived first —
 * the same transition as the archive button, which records its continuation
 * checkpoint and stops its agents — then exactly one successor is created on
 * the same project. Never a resume: the old provider conversation stays
 * closed, no AgentSession or task reactivates, and `runState` is untouched
 * (an interrupted run stays honestly incomplete). Rejected while the project
 * has a DIFFERENT open session — continuation is sequential.
 */
export interface ContinueUserSessionBody {
  message: string;
  /** Omitted inherits the source session's mode. */
  mode?: SessionMode;
  /** Omitted inherits the source session's model choice. */
  model?: string;
}

// GET /api/workspaces/:id/projects — continuation discovery
/**
 * One row per project that has carried work sessions: the facts an operator
 * needs to pick a continuation target. Status words are DERIVED client-side
 * from the session facts here — the server ships no second status vocabulary.
 */
export interface ProjectContinuationItem {
  id: string;
  /** The workspace-visible name: the latest session's title (projects are unnamed). */
  name: string | null;
  /** First line(s) of the operator-approved intent document, clipped. */
  intentPreview: string | null;
  /** The project's open session, when one exists — continuing then requires handing it off. */
  openSession: { id: string; title: string | null; pauseReason: PauseReason | null } | null;
  /** The most recent session, open or archived — the "where it left off" row. */
  lastSession: {
    id: string;
    title: string | null;
    lifecycle: "open" | "archived";
    runState: RunState;
    /** Frozen at archival for archived rows — why the run stopped, when it was paused. */
    pauseReason: PauseReason | null;
    updatedAt: string;
  } | null;
  sessionCount: number;
  /** A continuation checkpoint exists for the next session to inherit. */
  hasCheckpoint: boolean;
  /** Open requirement frontier size — unresolved work, cheaply derived. */
  openRequirements: number;
  createdAt: string;
}
export type ListWorkspaceProjectsResponse = ProjectContinuationItem[];

// GET /api/user-sessions/:id
export interface GetUserSessionResponse {
  session: UserSession;
  pendingInteractions: Interaction[];
  /**
   * Open project-level decision issues (a continued project inherits its
   * predecessors' unresolved questions). The full list, resolved history
   * included, lives at GET /:id/decision-issues.
   */
  openDecisionIssues: DecisionIssueWire[];
}

// GET /api/user-sessions/:id/decision-issues — the project decision-issue
// registry, deterministically ordered by structural consequence: open before
// resolved; open issues by (active blocking asks, requirement breadth, age).
export interface ListDecisionIssuesResponse {
  issues: DecisionIssueWire[];
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
  /**
   * Typed acceptances of the proposal's outstanding coverage exceptions —
   * required (one per exception, matched by kind+ref) to accept a run whose
   * coverage report carries exceptions under the `waiver_required` policy.
   * The server validates against FRESHLY recomputed coverage, so a stale card
   * cannot waive conditions the operator never saw; submitted waivers that no
   * longer match an outstanding exception are dropped, not recorded.
   */
  waivers?: { kind: import("./domain.ts").CoverageExceptionKind; ref: string; note?: string }[];
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
    /** Absent on summaries persisted before verification gaps existed. */
    verificationGaps?: import("./domain.ts").RequirementVerificationGap[];
    /** Terminal claims the run later withdrew; absent on older summaries. */
    reversals?: import("./domain.ts").RequirementReversal[];
  } | null;
  /**
   * The machine-checkable completion accounting at proposal time: every live
   * root-affecting requirement leaf exactly once, typed exceptions, and the
   * policy snapshot. Persisted complete — never truncated to stay card-sized.
   * Null for graph-less runs and summaries persisted before coverage existed.
   */
  coverage: import("./domain.ts").CompletionCoverageReport | null;
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
  /** Typed waivers granted at acceptance — empty until accepted, and for runs accepted before waivers existed. */
  waivers: import("./domain.ts").CompletionWaiver[];
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
  /** Recorded premises, rests_on-linked to the requirements built on them. */
  assumptions: import("./domain.ts").AssumptionWire[];
  /** The operator's approved intent prose (title + preamble); null when none. */
  intent: string | null;
  /** Satisfied leaves still below their declared verification expectation. */
  verificationGaps: import("./domain.ts").RequirementVerificationGap[];
  /** Terminal claims the run later withdrew (journal-derived, oldest first). */
  reversals: import("./domain.ts").RequirementReversal[];
  /** The change-impact ledger: durable blast radii of amendments, falsifications, and withdrawn claims, with derived reconciliation state. */
  changeImpacts: import("./domain.ts").ChangeImpactWire[];
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
  /** Nesting level: 0 = top-level, each child one deeper, bounded by the configured depth cap. */
  depth: number;
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
