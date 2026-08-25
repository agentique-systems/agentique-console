import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull().unique(),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * A project: the durable identity for a body of intent. Requirement ids,
 * revisions, status history, and operator decisions belong to a project, not
 * a UserSession — a later session opened onto the same project continues the
 * same graph, the same ids, and the same decision ledger. Sessions attach at
 * creation; continuation is SEQUENTIAL (one open session per project), so
 * there is never concurrent multi-session mutation of one graph.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  title: text("title"),
  /**
   * Operator-approved intent prose (title + preamble sections of the
   * requirement document). Written at approval of a full or intent-kind
   * proposal; never by a subtree amendment — the vision outlives patches.
   */
  intentDocument: text("intent_document"),
  createdAt: text("created_at").notNull(),
});

export const userSessions = sqliteTable("user_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  /** The project this session works on; minted fresh unless continuing one. */
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title"),
  mode: text("mode", { enum: ["execute", "plan_execute"] }).notNull(),
  phase: text("phase", { enum: ["planning", "executing"] })
    .notNull()
    .default("planning"),
  lifecycle: text("lifecycle", { enum: ["open", "archived"] })
    .notNull()
    .default("open"),
  purpose: text("purpose", { enum: ["work", "profile_manager"] })
    .notNull()
    .default("work"),
  subjectKey: text("subject_key"),
  /** Orchestrator resume id, captured from the SDK's system:init message. */
  sdkSessionId: text("sdk_session_id"),
  sdkGeneration: integer("sdk_generation").notNull().default(0),
  sdkTurnCount: integer("sdk_turn_count").notNull().default(0),
  contextTokens: integer("context_tokens").notNull().default(0),
  memory: text("memory").notNull().default(""),
  latestHandoffId: text("latest_handoff_id"),
  /**
   * Baseline for the SDK's cumulative `total_cost_usd` / `duration_api_ms`.
   * Persisted rather than held in the lane, because a resumed provider session
   * carries its running total across the process that started it.
   */
  cumulativeCostUsd: real("cumulative_cost_usd").notNull().default(0),
  cumulativeApiDurationMs: integer("cumulative_api_duration_ms").notNull().default(0),
  /**
   * Orthogonal to `lifecycle`. `lifecycle` is "in my active list"; this is
   * "is the work done". `awaiting_signoff` is its own state because it is the
   * only one where the Console asserts done and the operator has not agreed.
   */
  runState: text("run_state", { enum: ["active", "awaiting_signoff", "completed"] })
    .notNull()
    .default("active"),
  /** HEAD when the first agent session was created; diff base for the summary. */
  runBaseCommit: text("run_base_commit"),
  /**
   * Provider-capacity / budget / operator pause. While `pauseReason` is set
   * the run mints no turns: queued work stays queued, nothing is cancelled,
   * nothing is salvaged-off-main. `pausedUntil` is the auto-resume time for
   * capacity pauses; null for budget and operator pauses (the operator
   * resumes). Columns, not a `runState` widening — a paused run is still
   * `active` work. The pause is process-wide; every open session carries the
   * same value so a restart can restore it.
   */
  pausedUntil: text("paused_until"),
  pauseReason: text("pause_reason", { enum: ["capacity", "budget", "operator"] }),
  /** Optional spend ceiling (USD); crossing it pauses with reason "budget". */
  budgetUsd: real("budget_usd"),
  /**
   * Operator-away autonomy. "away" shortens auto-proceed deadlines and lets
   * blocking asks WITH a recommendation proceed provisionally.
   */
  autonomy: text("autonomy", { enum: ["standard", "away"] }).notNull().default("standard"),
  /**
   * This session's orchestrator model. NULL falls back to `config.model`, which
   * is what internally-created sessions (the profile manager) carry. Agents are
   * unaffected — they resolve their own model from the profile.
   */
  model: text("model"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("user_sessions_mode", sql`${t.mode} IN ('execute','plan_execute')`),
  check("user_sessions_phase", sql`${t.phase} IN ('planning','executing')`),
  check("user_sessions_lifecycle", sql`${t.lifecycle} IN ('open','archived')`),
  check("user_sessions_purpose", sql`${t.purpose} IN ('work','profile_manager')`),
  check("user_sessions_run_state", sql`${t.runState} IN ('active','awaiting_signoff','completed')`),
]);

/** One proposed end-of-run report, awaiting or carrying the operator's verdict. */
export const runSummaries = sqliteTable(
  "run_summaries",
  {
    id: text("id").primaryKey(),
    userSessionId: text("user_session_id")
      .notNull()
      .references(() => userSessions.id),
    /** Events window covered; the next summary starts at seqTo + 1. */
    seqFrom: integer("seq_from").notNull(),
    seqTo: integer("seq_to").notNull(),
    verdict: text("verdict", { enum: ["completed", "completed_with_caveats", "failed", "infeasible"] }).notNull(),
    document: text("document", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["proposed", "accepted", "changes_requested"] })
      .notNull()
      .default("proposed"),
    /**
     * Typed operator acceptances of the proposal's coverage exceptions,
     * written at accept. Resolution-time facts, deliberately NOT inside
     * `document` (the proposal-time snapshot): what was proposed and what the
     * operator accepted are different records. [] until accepted, and for
     * runs accepted before waivers existed.
     */
    waivers: text("waivers", { mode: "json" })
      .$type<import("@agentique-console/shared").CompletionWaiver[]>()
      .notNull()
      .default([]),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("run_summaries_session").on(table.userSessionId, table.createdAt),
    check("run_summaries_status", sql`${table.status} IN ('proposed','accepted','changes_requested')`),
  ],
);

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id")
    .notNull()
    .references(() => userSessions.id),
  title: text("title").notNull(),
  lifecycle: text("lifecycle", { enum: ["open", "archived"] })
    .notNull()
    .default("open"),
  /** Orchestration-pattern catalog id — a forensic label; the service executes `topology`. */
  pattern: text("pattern").notNull().default("hub_and_spoke"),
  /** Compiled TopologyContract snapshot; '{}' = pre-contract row, read as the hub default. */
  topology: text("topology", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  /** NULL = top-level. Nesting depth is capped by `config.policy.maxSessionDepth`. */
  parentAgentSessionId: text("parent_agent_session_id"),
  /** Agent in the PARENT that receives this child's boundary traffic; snapshotted at spawn. */
  parentControllerAgent: text("parent_controller_agent"),
  depth: integer("depth").notNull().default(0),
  /**
   * Commission-time nesting opt-in: the orchestrator decides which sessions
   * may spawn children (the entry agent gets create_child_session while the
   * depth cap allows). Off by default so nesting stays a deliberate choice.
   */
  allowChildSessions: integer("allow_child_sessions", { mode: "boolean" }).notNull().default(false),
  /**
   * Optional commission spend ceiling in USD, covering this session and its
   * child sessions. Crossing it notifies the session and escalates to main —
   * it never pauses the run, never kills a lane, never blocks a final.
   */
  budgetUsd: real("budget_usd"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [check("agent_sessions_lifecycle", sql`${t.lifecycle} IN ('open','archived')`)]);

export const agents = sqliteTable(
  "agents",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentSessions.id),
    /** Agent name; "coordinator" is the reserved coordination agent. */
    name: text("name").notNull(),
    /** Contract role binding ("coordinator", "specialist", "mapper", …). */
    role: text("role").notNull(),
    /** Resolved brief (profile + ad-hoc extension), verbatim. */
    instructions: text("instructions").notNull(),
    model: text("model"),
    profileId: text("profile_id").notNull().default("explorer"),
    profileSnapshot: text("profile_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ownership: text("ownership", { mode: "json" }).$type<string[]>().notNull().default([]),
    /**
     * The subset of `ownership` this seat holds as DECLARED-SHARED write
     * responsibility, each with its why. The one ownership rule
     * (portfolio/ownership.ts) lets write claims on one scope coexist only
     * when EVERY claimant declared sharing — this column is what makes an
     * intentional overlap structurally visible instead of a prompt fact.
     * Absent scopes are exclusive; old rows ('[]') read as all-exclusive.
     */
    sharedOwnership: text("shared_ownership", { mode: "json" })
      .$type<{ scope: string; why: string }[]>()
      .notNull()
      .default([]),
    sdkSessionId: text("sdk_session_id"),
    /** Last turn activity; park/reap bookkeeping that survives restarts. */
    lastActiveAt: text("last_active_at"),
    generation: integer("generation").notNull().default(0),
    turnCount: integer("turn_count").notNull().default(0),
    contextTokens: integer("context_tokens").notNull().default(0),
    latestHandoffId: text("latest_handoff_id"),
    /** See userSessions: the cumulative baseline outlives the lane process. */
    cumulativeCostUsd: real("cumulative_cost_usd").notNull().default(0),
    cumulativeApiDurationMs: integer("cumulative_api_duration_ms").notNull().default(0),
    /** Watermark for the per-delivery operator-decision delta. */
    lastDecisionAt: text("last_decision_at"),
    /** Isolated git worktree this agent works in; NULL = the real workspace. */
    worktreePath: text("worktree_path"),
    /** The commit the agent's worktree branched from (diff base). */
    worktreeBaseCommit: text("worktree_base_commit"),
    /** The worktree's branch ref (merge target on completion). */
    worktreeBranch: text("worktree_branch"),
    /**
     * Where unlanded work survives after an infra-failure archive or merge
     * conflict: the renamed branch and the captured diff artifact. A discarded
     * seat vanishes from `worktreePath`-based scans, so without these pointers
     * salvaged work is invisible to checkpoints and the sign-off summary.
     */
    salvageBranch: text("salvage_branch"),
    salvageArtifactId: text("salvage_artifact_id"),
    /** Seating order for accents and prompt listings. */
    ord: integer("ord").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentSessionId, t.name] })],
);


/**
 * Per-session pattern progression: counters and join arrivals. Written
 * only by the pattern-progression module.
 */
export const patternState = sqliteTable("pattern_state", {
  agentSessionId: text("agent_session_id")
    .primaryKey()
    .references(() => agentSessions.id),
  rounds: integer("rounds").notNull().default(0),
  /** Non-checkpoint handoffs journaled, session-wide. */
  handoffCount: integer("handoff_count").notNull().default(0),
  lastProgressAt: text("last_progress_at"),
  /** Ring buffer of recent "sender>recipient" hops — oscillation detection. */
  recentEdges: text("recent_edges", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** joinId → { expected: seats[], reports: seat → "completed"|"failed" }. */
  joins: text("joins", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  /** Termination reason once tripped; NULL = live. */
  tripped: text("tripped"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionKind: text("session_kind", { enum: ["user", "agent"] }).notNull(),
    sessionId: text("session_id").notNull(),
    /** Per-session monotonic; assigned MAX(seq)+1 inside the write txn. */
    seq: integer("seq").notNull(),
    speakerKind: text("speaker_kind", {
      enum: ["operator", "orchestrator", "agent", "system"],
    }).notNull(),
    speakerName: text("speaker_name").notNull(),
    toName: text("to_name"),
    kind: text("kind", { enum: ["message", "notice", "plan"] }).notNull(),
    text: text("text").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    turnId: text("turn_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("messages_session_seq").on(t.sessionKind, t.sessionId, t.seq),
    index("messages_session").on(t.sessionKind, t.sessionId),
    check("messages_session_kind", sql`${t.sessionKind} IN ('user','agent')`),
    check("messages_speaker_kind", sql`${t.speakerKind} IN ('operator','orchestrator','agent','system')`),
    check("messages_kind", sql`${t.kind} IN ('message','notice','plan')`),
  ],
);

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id")
    .notNull()
    .references(() => userSessions.id),
  /** Where it was raised. null/null = the main lane; else the asking seat. */
  agentSessionId: text("agent_session_id"),
  participant: text("participant"),
  kind: text("kind", { enum: ["question", "plan_approval"] }).notNull(),
  status: text("status", {
    enum: ["pending", "answered", "rejected", "dismissed", "stale"],
  })
    .notNull()
    .default("pending"),
  /** blocking parks the asker; deferred hands the answer over at its next delivery. */
  urgency: text("urgency", { enum: ["blocking", "deferred"] })
    .notNull()
    .default("blocking"),
  source: text("source", { enum: ["agent", "console"] })
    .notNull()
    .default("agent"),
  recommendation: text("recommendation"),
  /** Normalized (asker, question) — an open duplicate returns the same card. */
  dedupeKey: text("dedupe_key"),
  allowFreeText: integer("allow_free_text", { mode: "boolean" }).notNull().default(false),
  /** The asker's promise died; the answer will arrive by mailbox, not by return. */
  detached: integer("detached", { mode: "boolean" }).notNull().default(false),
  /** When the ASKING SEAT was told — distinct from resolvedAt (when the operator answered). */
  flushedAt: text("flushed_at"),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  response: text("response", { mode: "json" }).$type<Record<string, unknown>>(),
  toolUseId: text("tool_use_id"),
  /** The decision issue this ask participates in; null for pre-issue rows, native cards, and plan approvals. */
  issueId: text("issue_id"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (t) => [
  index("interactions_session_status").on(t.userSessionId, t.status),
  index("interactions_agent_open").on(t.agentSessionId, t.status, t.urgency),
  index("interactions_issue").on(t.issueId),
  check("interactions_kind", sql`${t.kind} IN ('question','plan_approval')`),
  check("interactions_status", sql`${t.status} IN ('pending','answered','rejected','dismissed','stale')`),
  check("interactions_urgency", sql`${t.urgency} IN ('blocking','deferred')`),
  check("interactions_source", sql`${t.source} IN ('agent','console')`),
]);

// Operator decisions are NOT a table: a decision is a resolved `interactions`
// row, and `orchestrator/decisions.ts` is a read-model over them. (A legacy
// `operator_decisions` table may exist in older databases; it is simply
// unused.)

/**
 * Decision issues: the project-level unresolved human choice one or more asks
 * (interaction rows, linked by `interactions.issue_id`) refer to. The ask is a
 * session-scoped attempt to get the answer; the issue is the durable shared
 * question — it survives asker termination, restarts, and project
 * continuation. Identity is EXPLICIT: askers attach by `issue_key` (or main
 * merges duplicates); nothing here infers semantic equivalence from wording.
 * `resolutions` is append-only history — the last entry is the current answer,
 * earlier entries are retained reversals, never rewritten. Blocking weight and
 * provisional state are DERIVED at read time from the participating asks, so a
 * terminated asker never leaves a zombie "blocking" issue.
 */
export const decisionIssues = sqliteTable(
  "decision_issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** The session in which the issue was raised — attribution, never the key. */
    userSessionId: text("user_session_id").notNull(),
    /** Normalized explicit attach key; null = unkeyed (single-ask issue unless merged into). */
    issueKey: text("issue_key"),
    /** The shared human question, in the first asker's words. */
    subject: text("subject").notNull(),
    status: text("status", { enum: ["open", "resolved", "superseded"] })
      .notNull()
      .default("open"),
    /** Union of the participating asks' requirement ids. */
    requirementIds: text("requirement_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Append-only resolution history; last entry = current answer. */
    resolutions: text("resolutions", { mode: "json" })
      .$type<import("@agentique-console/shared").DecisionIssueResolution[]>()
      .notNull()
      .default([]),
    /** Set when merged into another issue, which carries the asks from then on. */
    supersededById: text("superseded_by_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    uniqueIndex("decision_issues_open_key")
      .on(t.projectId, t.issueKey)
      .where(sql`status = 'open' AND issue_key IS NOT NULL`),
    index("decision_issues_project").on(t.projectId, t.status),
    check("decision_issues_status", sql`${t.status} IN ('open','resolved','superseded')`),
  ],
);

/** Mirror of native CronCreate jobs; the CLI's schedule is authoritative. */
export const crons = sqliteTable(
  "crons",
  {
    id: text("id").primaryKey(),
    userSessionId: text("user_session_id").notNull(),
    sdkCronId: text("sdk_cron_id").notNull(),
    schedule: text("schedule").notNull(),
    prompt: text("prompt").notNull(),
    oneShot: integer("one_shot", { mode: "boolean" }).notNull().default(false),
    /** Absolute firing time for a console-owned deadline; null for a cron. */
    dueAt: text("due_at"),
    status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("crons_session").on(t.userSessionId, t.status),
    check("crons_status", sql`${t.status} IN ('active','deleted')`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").notNull(),
    sdkSessionId: text("sdk_session_id").notNull(),
    sdkTaskId: text("sdk_task_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userSessionId: text("user_session_id").notNull(),
    agentSessionId: text("agent_session_id"),
    participant: text("participant"),
    subject: text("subject").notNull(),
    description: text("description").notNull().default(""),
    activeForm: text("active_form"),
    status: text("status", {
      enum: ["pending", "in_progress", "completed", "deleted"],
    })
      .notNull()
      .default("pending"),
    owner: text("owner"),
    blocks: text("blocks", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    blockedBy: text("blocked_by", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** The requirement this unit of work discharges; null = unlinked. */
    requirementId: text("requirement_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sdkSessionId, t.sdkTaskId] }),
    uniqueIndex("tasks_console_id").on(t.id),
    index("tasks_user_session").on(t.userSessionId),
    check("tasks_status", sql`${t.status} IN ('pending','in_progress','completed','deleted')`),
  ],
);

/**
 * Assignments recorded durably while their task's dependencies are incomplete;
 * the scheduler posts them at readiness. Terminal rows are tombstones (audit +
 * dedupe substrate) — never deleted.
 */
export const scheduledAssignments = sqliteTable(
  "scheduled_assignments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userSessionId: text("user_session_id").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    /** Console task id (`tasks.id`), never a provider task id. */
    taskId: text("task_id").notNull(),
    /** The original assigner; dispatch posts under this name. */
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    category: text("category", {
      enum: ["assignment", "update", "milestone", "failure", "final", "decision"],
    }).notNull().default("assignment"),
    /** Full draft, posted verbatim at dispatch. */
    handoff: text("handoff", { mode: "json" })
      .$type<import("@agentique-console/shared").HandoffDraft>()
      .notNull(),
    status: text("status", { enum: ["scheduled", "dispatched", "canceled"] })
      .notNull()
      .default("scheduled"),
    statusReason: text("status_reason", {
      enum: ["replaced", "task_deleted", "task_completed", "session_archived", "canceled"],
    }),
    dispatchedMessageId: text("dispatched_message_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("scheduled_assignments_live_task").on(t.taskId).where(sql`status = 'scheduled'`),
    index("scheduled_assignments_session").on(t.userSessionId, t.status),
    index("scheduled_assignments_agent_session").on(t.agentSessionId, t.status),
    check("scheduled_assignments_category", sql`${t.category} IN ('assignment','update','milestone','failure','final','decision')`),
    check("scheduled_assignments_status", sql`${t.status} IN ('scheduled','dispatched','canceled')`),
    check("scheduled_assignments_status_reason", sql`${t.statusReason} IS NULL OR ${t.statusReason} IN ('replaced','task_deleted','task_completed','session_archived','canceled')`),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    blockerTaskId: text("blocker_task_id").notNull(),
    blockedTaskId: text("blocked_task_id").notNull(),
    source: text("source", { enum: ["console", "provider", "migration"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerTaskId, t.blockedTaskId] }),
    check("task_dependencies_source", sql`${t.source} IN ('console','provider','migration')`),
  ],
);

export const agentProfileTrust = sqliteTable(
  "agent_profile_trust",
  {
    workspaceId: text("workspace_id").notNull(),
    profileId: text("profile_id").notNull(),
    revision: text("revision").notNull(),
    trustedAt: text("trusted_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.profileId, t.revision] })],
);

/**
 * Orchestrator-minted profiles: narrow-only variants of trusted bases,
 * resolved ONCE at mint time and stored complete. Journaled, no per-mint
 * operator approval — a mint grants strictly less than the per-seat
 * instructions+model overrides the orchestrator already holds. Rows persist
 * so seats resolving a mint survive a server restart.
 */
export const mintedProfiles = sqliteTable("minted_profiles", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id").notNull(),
  baseProfileId: text("base_profile_id").notNull(),
  baseRevision: text("base_revision").notNull(),
  profile: text("profile", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  why: text("why"),
  createdAt: text("created_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    workspaceId: text("workspace_id"),
    userSessionId: text("user_session_id"),
    agentSessionId: text("agent_session_id"),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("events_user_session").on(t.userSessionId, t.seq),
    index("events_agent_session").on(t.agentSessionId, t.seq),
  ],
);

/**
 * Requirement revisions: the committed STRUCTURE history of the requirement
 * graph — the run's canonical specification. Draft →
 * approved/superseded/rejected through the plan-approval card, append-only.
 * `document` is the canonical outline (renderCommitted output); `graph` is the
 * parsed form with every id resolved.
 */
export const requirementRevisions = sqliteTable(
  "requirement_revisions",
  {
    id: text("id").primaryKey(),
    /** The project whose graph this revision patches — the revision counter's scope. */
    projectId: text("project_id").notNull().references(() => projects.id),
    /** The session that proposed it — attribution, never the query key. */
    userSessionId: text("user_session_id").notNull().references(() => userSessions.id),
    /** Monotonic per PROJECT, 1-based — a continued session keeps counting. */
    revision: integer("revision").notNull(),
    /**
     * What this revision patches: `full` = intent prose + the whole
     * committed structure (only legal while the graph fits one parser-bounded
     * document); `intent` = the prose alone, statements untouched; `subtree`
     * = one subtree's committed structure (scope_id names its root), prose
     * untouched — the staged-elaboration unit the operator approves as a
     * small card. Every kind bumps the revision counter: a changed vision or
     * subtree invalidates completion currency deliberately.
     */
    kind: text("kind", { enum: ["full", "intent", "subtree"] }).notNull().default("full"),
    /** The subtree root a `subtree` revision amends; null otherwise. */
    scopeId: text("scope_id"),
    /**
     * The governing revision when this draft was proposed. Approval asserts it
     * still matches — under the sequential-continuation and single-pending-
     * proposal guards it always does; the assertion enforces the invariant.
     */
    baseRevision: integer("base_revision").notNull(),
    document: text("document").notNull(),
    graph: text("graph", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    changeNote: text("change_note"),
    status: text("status", { enum: ["draft", "approved", "superseded", "rejected"] }).notNull().default("draft"),
    origin: text("origin", { enum: ["main", "operator_edited"] }).notNull().default("main"),
    interactionId: text("interaction_id"),
    createdAt: text("created_at").notNull(),
    approvedAt: text("approved_at"),
  },
  (t) => [
    index("requirement_revisions_project").on(t.projectId, t.revision),
    check("requirement_revisions_status", sql`${t.status} IN ('draft','approved','superseded','rejected')`),
    check("requirement_revisions_origin", sql`${t.origin} IN ('main','operator_edited')`),
    check("requirement_revisions_kind", sql`${t.kind} IN ('full','intent','subtree')`),
  ],
);

/**
 * Live requirement nodes: ONE row per stable requirement id per session,
 * carrying the CURRENT statement/shape and the recorded status. Status is
 * keyed by the revisionless id, so it survives amendments by construction;
 * structure history lives in `requirement_revisions`, status history in
 * `requirement_status_changes`. Parent/root statuses are DERIVED at read time
 * (all/any composition), never stored.
 */
export const requirementNodes = sqliteTable(
  "requirement_nodes",
  {
    /** "r1", "r2", … — minted at approval or decomposition, per PROJECT, never reused. */
    id: text("id").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    parentId: text("parent_id"),
    ord: integer("ord").notNull(),
    statement: text("statement").notNull(),
    composition: text("composition", { enum: ["all", "any"] }).notNull().default("all"),
    /**
     * Declared verification expectation from the committed outline's
     * `(verify: …)` marker; NULL = the maker's evidenced claim suffices.
     * Enum rides the column type + the shared parser (a new CHECK would
     * force a table rebuild); gaps derive at read time, never stored.
     */
    verifyExpectation: text("verify_expectation", { enum: ["independent", "operator"] }),
    status: text("status", { enum: ["open", "satisfied", "violated", "infeasible", "retired"] })
      .notNull()
      .default("open"),
    /** "committed" = part of an approved revision; "refinement" = decomposed during the run. */
    origin: text("origin", { enum: ["committed", "refinement"] }).notNull().default("committed"),
    /** 0 for refinement nodes (they belong to no committed revision yet). */
    introducedInRevision: integer("introduced_in_revision").notNull(),
    retiredInRevision: integer("retired_in_revision"),
    /** The session whose entry agent authored a refinement node. */
    refinedByAgentSessionId: text("refined_by_agent_session_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index("requirement_nodes_live").on(t.projectId, t.retiredInRevision),
    check("requirement_nodes_status", sql`${t.status} IN ('open','satisfied','violated','infeasible','retired')`),
    check("requirement_nodes_composition", sql`${t.composition} IN ('all','any')`),
    check("requirement_nodes_origin", sql`${t.origin} IN ('committed','refinement')`),
  ],
);

/**
 * Append-only journal of requirement status transitions. Terminal statuses
 * (satisfied/violated/infeasible) carry evidence; `verifiedBy` records who
 * stood behind the claim — "console" only for mechanical resets (statement
 * amended, node retired), never selectable by a model.
 */
export const requirementStatusChanges = sqliteTable(
  "requirement_status_changes",
  {
    id: text("id").primaryKey(),
    /** The graph's scope — the query key; claims survive session boundaries. */
    projectId: text("project_id").notNull(),
    /** The session in which the claim landed — attribution, never the key. */
    userSessionId: text("user_session_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    evidence: text("evidence", { mode: "json" })
      .$type<{ kind: string; ref: string; label?: string }[]>()
      .notNull()
      .default([]),
    verifiedBy: text("verified_by", { enum: ["self", "independent", "operator", "console"] }).notNull(),
    /** "main", an agent name, "operator", or "console". */
    actor: text("actor").notNull(),
    agentSessionId: text("agent_session_id"),
    /** The approved requirement revision in force when the change landed (0 = none yet). */
    atRevision: integer("at_revision").notNull(),
    /**
     * Per-project monotonic ordinal, shared with assumption resolutions —
     * the deterministic clock invalidation flags compare (never wall time):
     * a claim is suspect when something it depends on carries a LATER ord.
     */
    ord: integer("ord").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("requirement_status_changes_req").on(t.projectId, t.requirementId, t.createdAt),
    check("requirement_status_changes_verified_by", sql`${t.verifiedBy} IN ('self','independent','operator','console')`),
  ],
);

/**
 * Assumptions: recorded premises the work proceeds on — a default taken
 * where the operator was not asked, a belief about the world a requirement
 * rests on. Recording one is what PREVENTS silent invention, so recording is
 * never approval-gated; ids ("a1", …) are project-lifetime and never reused,
 * exactly like requirement ids. `rests_on` rows in requirement_links join
 * requirements to the assumptions under them; a falsified assumption
 * decorates and wakes — it never rewrites requirement status.
 */
export const assumptions = sqliteTable(
  "assumptions",
  {
    /** "a1", "a2", … — minted per project, never reused. */
    id: text("id").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    text: text("text").notNull(),
    status: text("status", { enum: ["open", "confirmed", "falsified", "retired"] })
      .notNull()
      .default("open"),
    /** Who introduced it: the operator's own words, main's inference, or a seat's. */
    source: text("source", { enum: ["operator", "main", "agent"] }).notNull(),
    agentSessionId: text("agent_session_id"),
    /** The ask that raised it or whose answer resolved it, when one exists. */
    interactionId: text("interaction_id"),
    /** "main", an agent name, or "operator". */
    actor: text("actor").notNull(),
    resolutionNote: text("resolution_note"),
    resolutionEvidence: text("resolution_evidence", { mode: "json" })
      .$type<{ kind: string; ref: string; label?: string }[]>(),
    /** Same monotonic sequence as requirement_status_changes.ord. */
    resolvedOrd: integer("resolved_ord"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index("assumptions_project").on(t.projectId, t.status),
    check("assumptions_status", sql`${t.status} IN ('open','confirmed','falsified','retired')`),
    check("assumptions_source", sql`${t.source} IN ('operator','main','agent')`),
  ],
);

/**
 * Requirement relationships beyond the parent/child tree. NEVER part of
 * derivation — deriveComposedStatus stays purely tree-based; links feed the
 * frontier's blocked annotation, delegation context selection, and the
 * invalidation flags. `depends_on` is directed and acyclic; `conflicts_with`
 * is symmetric, stored once with the numerically smaller id as from_id (the
 * unique index then also blocks inverse duplicates); `rests_on` points a
 * requirement at an assumption. Requirement retirement retires its links.
 */
export const requirementLinks = sqliteTable(
  "requirement_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** Always a requirement id. */
    fromId: text("from_id").notNull(),
    toKind: text("to_kind", { enum: ["requirement", "assumption"] }).notNull(),
    toId: text("to_id").notNull(),
    kind: text("kind", { enum: ["depends_on", "conflicts_with", "rests_on"] }).notNull(),
    createdByActor: text("created_by_actor").notNull(),
    agentSessionId: text("agent_session_id"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    retiredAt: text("retired_at"),
  },
  (t) => [
    uniqueIndex("requirement_links_pair").on(t.projectId, t.kind, t.fromId, t.toKind, t.toId),
    index("requirement_links_project").on(t.projectId, t.retiredAt),
    check("requirement_links_to_kind", sql`${t.toKind} IN ('requirement','assumption')`),
    check("requirement_links_kind", sql`${t.kind} IN ('depends_on','conflicts_with','rests_on')`),
  ],
);

/**
 * Delegations: which agent session was commissioned against which requirement
 * — the sub-scope join behind delegation traceability AND the subtree scoping
 * of seat-side requirement tools. Append-only; the frontier reads only OPEN
 * sessions, so archival needs no cleanup here.
 */
export const requirementDelegations = sqliteTable(
  "requirement_delegations",
  {
    id: text("id").primaryKey(),
    userSessionId: text("user_session_id").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    source: text("source", { enum: ["commission", "assignment", "child"] }).notNull(),
    handoffId: text("handoff_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("requirement_delegations_session").on(t.agentSessionId),
    uniqueIndex("requirement_delegations_pair").on(t.agentSessionId, t.requirementId),
    check("requirement_delegations_source", sql`${t.source} IN ('commission','assignment','child')`),
  ],
);

/**
 * The change-impact ledger: one row per meaning-changing event (approved
 * amendment, falsified assumption, withdrawn terminal claim) whose computed
 * transitive blast radius touched prior evidence or active work. `affected`
 * snapshots console facts AT THE MOMENT of the change (links and delegations
 * move later, so recomputation would not be faithful); `dispositions` records
 * main/operator judgment per affected item. Open/reconciled is DERIVED at
 * read time — a later claim on a suspect requirement or an archived session
 * clears its item mechanically, so nothing here ever rewrites a status.
 * Project-scoped like requirements; rows persist for the project's lifetime.
 */
export const changeImpacts = sqliteTable(
  "change_impacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** The session in which the change landed — attribution, never the key. */
    userSessionId: text("user_session_id").notNull(),
    sourceKind: text("source_kind", { enum: ["amendment", "assumption_falsified", "claim_withdrawn"] }).notNull(),
    /** "rev:<n>" | assumption id | status-change id — the idempotency key with sourceKind. */
    sourceRef: text("source_ref").notNull(),
    /** Governing requirement revision when the impact was computed. */
    atRevision: integer("at_revision").notNull(),
    /** The shared invalidation-clock ordinal at computation (see requirement_status_changes.ord). */
    computedAtOrd: integer("computed_at_ord").notNull(),
    note: text("note"),
    affected: text("affected", { mode: "json" })
      .$type<import("@agentique-console/shared").ChangeImpactAffected>()
      .notNull(),
    dispositions: text("dispositions", { mode: "json" })
      .$type<import("@agentique-console/shared").ChangeImpactDispositionEntry[]>()
      .notNull()
      .default([]),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("change_impacts_source").on(t.projectId, t.sourceKind, t.sourceRef),
    index("change_impacts_project").on(t.projectId),
    check("change_impacts_source_kind", sql`${t.sourceKind} IN ('amendment','assumption_falsified','claim_withdrawn')`),
  ],
);

/**
 * Workstream dependency links: the project-portfolio claim that one open
 * AgentSession (the consumer) depends on another (the producer) for a named
 * interface or artifact. Workstream granularity only — AgentSession task DAGs
 * stay local; these edges never schedule anything. Status is DERIVED at read
 * time from console-owned facts (producer open → pending, producer reported
 * final → satisfied, producer archived without reporting → broken), never
 * stored. Released rows are historical records of a judgment (superseded,
 * re-pointed at a successor) and keep their note; rows persist for the
 * project's lifetime.
 */
export const workstreamLinks = sqliteTable(
  "workstream_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** The session in which the link was authored — attribution, never the key. */
    userSessionId: text("user_session_id").notNull(),
    consumerAgentSessionId: text("consumer_agent_session_id").notNull(),
    producerAgentSessionId: text("producer_agent_session_id").notNull(),
    /** The interface/artifact that crosses the boundary, in one line. */
    subject: text("subject").notNull(),
    /** "main" today; a future controller path would name the seat. */
    createdBy: text("created_by").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at"),
    releasedBy: text("released_by"),
    releaseNote: text("release_note"),
  },
  (t) => [
    uniqueIndex("workstream_links_live_pair")
      .on(t.consumerAgentSessionId, t.producerAgentSessionId, t.subject)
      .where(sql`released_at IS NULL`),
    index("workstream_links_project").on(t.projectId, t.releasedAt),
    index("workstream_links_producer").on(t.producerAgentSessionId),
    index("workstream_links_consumer").on(t.consumerAgentSessionId),
  ],
);

/**
 * Continuation checkpoints: the project-level operational handoff written at a
 * run boundary — when a UserSession is archived — for the NEXT session on the
 * same project. `facts` is console-derived from durable rows (references and
 * bounded summaries: unreported workstreams, standing suspect claims, open
 * decision issues, granted waivers, salvage pointers); `synthesis` is the
 * source main's own last recorded working state, snapshotted verbatim and
 * labeled model-authored at every read. Immutable once written; ONE row per
 * source session (the unique index is the idempotency substrate), so retried
 * archival and the attach-time backstop can both record safely. Project truth
 * (requirements, decisions, assumptions) stays authoritative in its own
 * stores — a checkpoint is context, never governing meaning.
 */
export const continuationCheckpoints = sqliteTable(
  "continuation_checkpoints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** The archived session this checkpoint snapshots — also the idempotency key. */
    sourceUserSessionId: text("source_user_session_id").notNull(),
    /** Governing requirement revision at record time (0 = none governed) — the currency watermark. */
    atRevision: integer("at_revision").notNull(),
    /** Decision-ledger length at record time — a second currency hint. */
    decisionCount: integer("decision_count").notNull().default(0),
    /** The source session's runState at the boundary: completed = accepted sign-off. */
    runState: text("run_state", { enum: ["active", "awaiting_signoff", "completed"] }).notNull(),
    synthesis: text("synthesis", { mode: "json" })
      .$type<import("@agentique-console/shared").ContinuationSynthesis | null>(),
    facts: text("facts", { mode: "json" })
      .$type<import("@agentique-console/shared").ContinuationFacts>()
      .notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("continuation_checkpoints_source").on(t.sourceUserSessionId),
    index("continuation_checkpoints_project").on(t.projectId),
    check("continuation_checkpoints_run_state", sql`${t.runState} IN ('active','awaiting_signoff','completed')`),
  ],
);

/**
 * The orchestrator's model-authored working state: strategy, uncertainties,
 * assumptions, risks — section-replace revisions updated on material events
 * (never per-turn ceremony). Append-only: the history is the review surface,
 * and rationale cannot be retro-edited, only superseded. A trigger of
 * 'completion' carries the criteria→evidence justification in `completion`.
 *
 * Deliberately NO agentSessionId column: commission↔state attribution rides
 * the journal (`incorporating` refs on the state.updated event payload), and
 * the evaluation treats refs as use-when-present, never required. Revisit
 * only if a live series shows journal-level refs insufficient for the joins.
 */
export const orchestrationStateRevisions = sqliteTable(
  "orchestration_state_revisions",
  {
    id: text("id").primaryKey(),
    userSessionId: text("user_session_id").notNull().references(() => userSessions.id),
    revision: integer("revision").notNull(),
    trigger: text("trigger", { enum: ["commission", "discovery", "alarm", "direction_change", "completion", "operator"] }).notNull(),
    strategy: text("strategy").notNull().default(""),
    strategyWhy: text("strategy_why").notNull().default(""),
    uncertainties: text("uncertainties", { mode: "json" }).$type<string[]>().notNull().default([]),
    assumptions: text("assumptions", { mode: "json" }).$type<string[]>().notNull().default([]),
    risks: text("risks", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** What occasioned THIS update, one line. */
    note: text("note"),
    /** Only on trigger='completion': {criteria:[{criterion,met,evidence}],knownGaps,nonGaps}. */
    completion: text("completion", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("orchestration_state_session").on(t.userSessionId, t.revision),
    check("orchestration_state_trigger", sql`${t.trigger} IN ('commission','discovery','alarm','direction_change','completion','operator')`),
  ],
);

/** One durable delivery record per addressed transcript message. */
export const mailboxDeliveries = sqliteTable(
  "mailbox_deliveries",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().references(() => messages.id),
    userSessionId: text("user_session_id").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    category: text("category", {
      enum: ["assignment", "update", "milestone", "failure", "final", "decision"],
    }).notNull(),
    status: text("status", {
      enum: ["queued", "delivered", "acknowledged", "cancelled"],
    }).notNull().default("queued"),
    /** Idempotence key for console-authored deliveries (answers, notices, redrives). */
    dedupeKey: text("dedupe_key"),
    deliveredAt: text("delivered_at"),
    acknowledgedAt: text("acknowledged_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("mailbox_message_recipient").on(t.messageId, t.recipient),
    index("mailbox_recipient_status").on(t.agentSessionId, t.recipient, t.status),
    check("mailbox_category", sql`${t.category} IN ('assignment','update','milestone','failure','final','decision')`),
    check("mailbox_status", sql`${t.status} IN ('queued','delivered','acknowledged','cancelled')`),
  ],
);

/** Full payloads live here; event rows contain only a bounded preview + id. */
export const eventArtifacts = sqliteTable("event_artifacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  userSessionId: text("user_session_id"),
  agentSessionId: text("agent_session_id"),
  mediaType: text("media_type").notNull(),
  bytes: integer("bytes").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Eager, console-owned mirror used by the SDK SessionStore. */
export const providerEntries = sqliteTable(
  "provider_entries",
  {
    ord: integer("ord").primaryKey({ autoIncrement: true }),
    projectKey: text("project_key").notNull(),
    sessionId: text("session_id").notNull(),
    subpath: text("subpath").notNull().default(""),
    uuid: text("uuid"),
    type: text("type").notNull(),
    entry: text("entry", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("provider_entries_session").on(t.projectKey, t.sessionId, t.subpath, t.ord),
    uniqueIndex("provider_entries_uuid")
      .on(t.projectKey, t.sessionId, t.subpath, t.uuid)
      .where(sql`uuid IS NOT NULL`),
  ],
);

export const usageSamples = sqliteTable("usage_samples", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id").notNull(),
  agentSessionId: text("agent_session_id"),
  participant: text("participant").notNull(),
  profileId: text("profile_id"),
  generation: integer("generation").notNull(),
  turnId: text("turn_id").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  uncachedInputTokens: integer("uncached_input_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd"),
  model: text("model"),
  effort: text("effort"),
  trigger: text("trigger"),
  durationMs: integer("duration_ms"),
  apiDurationMs: integer("api_duration_ms"),
  sdkDurationMs: integer("sdk_duration_ms"),
  status: text("status"),
  stopReason: text("stop_reason"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("usage_user_session").on(t.userSessionId, t.createdAt),
  /** The commission-budget SUM keys off the agent session alone. */
  index("usage_agent_session").on(t.agentSessionId),
]);

/** Lossless canonical handoffs. Transcript messages carry only a compact projection. */
export const handoffRecords = sqliteTable(
  "handoff_records",
  {
    id: text("id").primaryKey(),
    userSessionId: text("user_session_id").notNull(),
    agentSessionId: text("agent_session_id"),
    messageId: text("message_id"),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    profileId: text("profile_id"),
    generation: integer("generation").notNull().default(0),
    turnId: text("turn_id"),
    trigger: text("trigger", { enum: ["assignment", "update", "milestone", "decision", "failure", "final", "rotation", "recovery"] }).notNull(),
    parentHandoffId: text("parent_handoff_id"),
    rootHandoffId: text("root_handoff_id").notNull(),
    checkpoint: integer("checkpoint", { mode: "boolean" }).notNull().default(false),
    /** Console-authored notice, not a participant's report; mirrors `extension.data.consoleSynthesized`. */
    synthetic: integer("synthetic", { mode: "boolean" }).notNull().default(false),
    core: text("core", { mode: "json" }).$type<import("@agentique-console/shared").HandoffCore>().notNull(),
    extension: text("extension", { mode: "json" }).$type<import("@agentique-console/shared").HandoffExtension>().notNull(),
    bytes: integer("bytes").notNull(),
    referenceWarnings: text("reference_warnings", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("handoffs_user_created").on(t.userSessionId, t.createdAt),
    index("handoffs_agent_recipient").on(t.agentSessionId, t.recipient, t.createdAt),
    check("handoffs_trigger", sql`${t.trigger} IN ('assignment','update','milestone','decision','failure','final','rotation','recovery')`),
  ],
);
