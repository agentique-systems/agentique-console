import {
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
  status: text("status", { enum: ["open", "archived"] })
    .notNull()
    .default("open"),
  /** Orchestrator resume id, captured from the SDK's system:init message. */
  sdkSessionId: text("sdk_session_id"),
  sdkGeneration: integer("sdk_generation").notNull().default(0),
  sdkTurnCount: integer("sdk_turn_count").notNull().default(0),
  contextTokens: integer("context_tokens").notNull().default(0),
  memory: text("memory").notNull().default(""),
  latestHandoffId: text("latest_handoff_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id")
    .notNull()
    .references(() => userSessions.id),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["execute", "plan_execute"] }).notNull(),
  phase: text("phase", { enum: ["planning", "executing"] })
    .notNull()
    .default("executing"),
  status: text("status", { enum: ["open", "archived"] })
    .notNull()
    .default("open"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const participants = sqliteTable(
  "participants",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentSessions.id),
    /** Seat name; "orchestrator" is the reserved virtual seat. */
    name: text("name").notNull(),
    role: text("role", { enum: ["orchestrator", "agent"] }).notNull(),
    /** Preset registry key; NULL for ad-hoc agents. */
    preset: text("preset"),
    /** Resolved brief (preset + ad-hoc extension), verbatim. */
    instructions: text("instructions").notNull(),
    model: text("model"),
    profileId: text("profile_id").notNull().default("explorer"),
    profileSnapshot: text("profile_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ownership: text("ownership", { mode: "json" }).$type<string[]>().notNull().default([]),
    sdkSessionId: text("sdk_session_id"),
    generation: integer("generation").notNull().default(0),
    turnCount: integer("turn_count").notNull().default(0),
    contextTokens: integer("context_tokens").notNull().default(0),
    memory: text("memory").notNull().default(""),
    latestHandoffId: text("latest_handoff_id"),
    checkpointReady: integer("checkpoint_ready", { mode: "boolean" }).notNull().default(true),
    pendingTurnSeq: integer("pending_turn_seq").notNull().default(0),
    /** Transcript watermark: highest message seq this seat has been shown. */
    lastSeenSeq: integer("last_seen_seq").notNull().default(0),
    /** Seating order for accents and prompt listings. */
    ord: integer("ord").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentSessionId, t.name] })],
);

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
  ],
);

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  userSessionId: text("user_session_id")
    .notNull()
    .references(() => userSessions.id),
  kind: text("kind", { enum: ["question", "plan_approval"] }).notNull(),
  status: text("status", {
    enum: ["pending", "answered", "rejected", "dismissed", "stale"],
  })
    .notNull()
    .default("pending"),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  response: text("response", { mode: "json" }).$type<Record<string, unknown>>(),
  toolUseId: text("tool_use_id"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const tasks = sqliteTable(
  "tasks",
  {
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
    index("tasks_user_session").on(t.userSessionId),
  ],
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
    dedupeKey: text("dedupe_key"),
    deliveredAt: text("delivered_at"),
    acknowledgedAt: text("acknowledged_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("mailbox_message_recipient").on(t.messageId, t.recipient),
    index("mailbox_recipient_status").on(t.agentSessionId, t.recipient, t.status),
  ],
);

/** Full payloads live here; event rows contain only a bounded preview + id. */
export const eventArtifacts = sqliteTable("event_artifacts", {
  id: text("id").primaryKey(),
  eventSeq: integer("event_seq"),
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
  "provider_entries_v2",
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
    uniqueIndex("provider_entries_uuid").on(t.projectKey, t.sessionId, t.subpath, t.uuid),
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
    core: text("core", { mode: "json" }).$type<import("@agentique-console/shared").HandoffCore>().notNull(),
    extension: text("extension", { mode: "json" }).$type<import("@agentique-console/shared").HandoffExtension>().notNull(),
    bytes: integer("bytes").notNull(),
    softTargetBytes: integer("soft_target_bytes").notNull(),
    overflow: integer("overflow", { mode: "boolean" }).notNull().default(false),
    referenceWarnings: text("reference_warnings", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("handoffs_user_created").on(t.userSessionId, t.createdAt),
    index("handoffs_agent_recipient").on(t.agentSessionId, t.recipient, t.createdAt),
  ],
);
