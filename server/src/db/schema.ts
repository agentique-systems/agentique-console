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

export const userSessions = sqliteTable("user_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
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
   * This session's orchestrator model. NULL falls back to `config.model`, which
   * is what internally-created sessions (the profile manager) carry. Seats are
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
    verdict: text("verdict", { enum: ["completed", "completed_with_caveats", "failed"] }).notNull(),
    document: text("document", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["proposed", "accepted", "changes_requested"] })
      .notNull()
      .default("proposed"),
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
  /** NULL = top-level. One level of nesting only. */
  parentAgentSessionId: text("parent_agent_session_id"),
  /** Agent in the PARENT that receives this child's boundary traffic; snapshotted at spawn. */
  parentControllerAgent: text("parent_controller_agent"),
  depth: integer("depth").notNull().default(0),
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
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (t) => [
  index("interactions_session_status").on(t.userSessionId, t.status),
  index("interactions_agent_open").on(t.agentSessionId, t.status, t.urgency),
  check("interactions_kind", sql`${t.kind} IN ('question','plan_approval')`),
  check("interactions_status", sql`${t.status} IN ('pending','answered','rejected','dismissed','stale')`),
  check("interactions_urgency", sql`${t.urgency} IN ('blocking','deferred')`),
  check("interactions_source", sql`${t.source} IN ('agent','console')`),
]);

// Operator decisions are NOT a table: a decision is a resolved `interactions`
// row, and `orchestrator/decisions.ts` is a read-model over them. (A legacy
// `operator_decisions` table may exist in older databases; it is simply
// unused.)

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
}, (t) => [index("usage_user_session").on(t.userSessionId, t.createdAt)]);

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
