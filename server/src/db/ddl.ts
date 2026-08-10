/**
 * Idempotent schema DDL, applied at boot. This app is self-contained and
 * single-version; boot-time CREATE IF NOT EXISTS replaces migration codegen.
 * Keep in lockstep with schema.ts.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('execute','plan_execute')),
  phase TEXT NOT NULL DEFAULT 'planning' CHECK (phase IN ('planning','executing')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived')),
  purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work','profile_manager')),
  subject_key TEXT,
  sdk_session_id TEXT,
  sdk_generation INTEGER NOT NULL DEFAULT 0,
  sdk_turn_count INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '',
  latest_handoff_id TEXT,
  -- The SDK reports cost/api-duration CUMULATIVELY per query(), and a RESUMED
  -- session continues its running total. Holding the baseline in process
  -- memory therefore mis-bills every respawn-over-resume as one enormous turn:
  -- db-live-1 recorded $4.4875 for a 55-second turn, 33.4% of that whole run.
  -- Persisted here so it survives the process that owned it.
  cumulative_cost_usd REAL NOT NULL DEFAULT 0,
  cumulative_api_duration_ms INTEGER NOT NULL DEFAULT 0,
  -- Orthogonal to status, deliberately. status (open|archived) answers
  -- "is this in the operator's active list"; run_state answers "is the work
  -- done". Overloading one column collapses two questions that have different
  -- answers: a completed run is NOT hidden, and an archived run may never have
  -- finished.
  --
  -- awaiting_signoff is its own state because it is the only one in which the
  -- Console asserts "I believe this is done" and the operator has not agreed.
  -- Collapsing it into completed recreates the db-live-2 failure (the moment
  -- passes in silence); collapsing it into active leaves the spinner spinning.
  run_state TEXT NOT NULL DEFAULT 'active' CHECK (run_state IN ('active','awaiting_signoff','completed')),
  -- HEAD when the first agent session was created; the diff base for
  -- "what was built".
  run_base_commit TEXT,
  -- The orchestrator lane's model for THIS session. NULL means "whatever
  -- config.model is now", which is what internally-created sessions (the
  -- profile manager) carry. No CHECK: the selectable list lives in
  -- shared/models.ts and a CHECK cannot widen.
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One proposed end-of-run report. Persisted rather than recomputed: the reap
-- counts are in-memory and unrecoverable a second later, and worktree diffs are
-- taken against branches that archival renames.
CREATE TABLE IF NOT EXISTS run_summaries (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL REFERENCES user_sessions(id),
  -- The events window this summary covers. After a change request the next
  -- summary starts at seq_to + 1, so a second run in one session is
  -- summarizable without double-counting the first.
  seq_from INTEGER NOT NULL,
  seq_to INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  document TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','accepted','changes_requested','superseded')),
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS run_summaries_session ON run_summaries(user_session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL REFERENCES user_sessions(id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('execute','plan_execute')),
  phase TEXT NOT NULL DEFAULT 'executing' CHECK (phase IN ('planning','executing')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived')),
  -- No CHECK on pattern: the catalog grows, and a table's CHECK cannot widen.
  pattern TEXT NOT NULL DEFAULT 'hub_and_spoke',
  -- Compiled TopologyContract snapshot; '{}' reads as the hub default.
  topology TEXT NOT NULL DEFAULT '{}',
  -- NULL = top-level. One level of nesting only.
  parent_agent_session_id TEXT,
  parent_controller_seat TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('orchestrator','agent')),
  preset TEXT,
  instructions TEXT NOT NULL,
  model TEXT,
  profile_id TEXT NOT NULL DEFAULT 'explorer',
  profile_snapshot TEXT NOT NULL DEFAULT '{}',
  ownership TEXT NOT NULL DEFAULT '[]',
  sdk_session_id TEXT,
  peer_name TEXT NOT NULL DEFAULT '',
  last_active_at TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '',
  latest_handoff_id TEXT,
  checkpoint_ready INTEGER NOT NULL DEFAULT 1,
  pending_turn_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  -- See user_sessions: the cumulative baseline must outlive the lane process,
  -- because the provider session it belongs to does.
  cumulative_cost_usd REAL NOT NULL DEFAULT 0,
  cumulative_api_duration_ms INTEGER NOT NULL DEFAULT 0,
  -- Watermark for the per-delivery operator-decision delta. NULL means the
  -- seat has been told nothing yet, so its first delivery carries everything.
  last_decision_at TEXT,
  worktree_path TEXT,
  worktree_base_commit TEXT,
  worktree_branch TEXT,
  -- Contract role binding; NULL derives from role (orchestrator→coordinator).
  pattern_role TEXT,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_session_id, name)
);

-- Per-session pattern progression: counters, join arrivals, cursor. Written
-- only by the pattern-progression module.
CREATE TABLE IF NOT EXISTS pattern_state (
  agent_session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id),
  rounds INTEGER NOT NULL DEFAULT 0,
  handoff_count INTEGER NOT NULL DEFAULT 0,
  stall_turns INTEGER NOT NULL DEFAULT 0,
  last_progress_at TEXT,
  recent_edges TEXT NOT NULL DEFAULT '[]',
  cursor TEXT,
  joins TEXT NOT NULL DEFAULT '{}',
  tripped TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('user','agent')),
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('operator','orchestrator','agent','system')),
  speaker_name TEXT NOT NULL,
  to_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message','notice','plan')),
  text TEXT NOT NULL,
  payload TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq ON messages(session_kind, session_id, seq);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_kind, session_id);

-- kind and status are FROZEN value sets. SQLite cannot widen a CHECK, and
-- migrateAdditiveColumns adds columns bare (no CHECK) -- so any new dimension
-- must arrive as a new COLUMN, never as a new enum value on these two. That is
-- why urgency, source and detached are separate columns rather than statuses.
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL REFERENCES user_sessions(id),
  -- Where it was raised. NULL/NULL = the main orchestrator lane; otherwise the
  -- seat that asked, so the card can say who wants to know and the answer can
  -- be delivered back to them.
  agent_session_id TEXT,
  participant TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('question','plan_approval')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','rejected','dismissed','stale')),
  -- blocking stops the asker until answered; deferred posts the card now and
  -- hands the answer over at the asker's next delivery.
  urgency TEXT NOT NULL DEFAULT 'blocking' CHECK (urgency IN ('blocking','deferred')),
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','uncertainty','console')),
  recommendation TEXT,
  -- Normalized (asker, question); an unresolved duplicate returns the open card
  -- instead of minting a second one, which is what keeps a re-asking seat from
  -- feeding the identical-call watchdog.
  dedupe_key TEXT,
  allow_free_text INTEGER NOT NULL DEFAULT 0,
  -- The asker's parked promise died (park, rotation, watchdog, restart). The
  -- row stays answerable; the answer arrives by mailbox instead of by return.
  detached INTEGER NOT NULL DEFAULT 0,
  -- When the ASKING SEAT was told the answer. Distinct from resolved_at, which
  -- is when the operator answered.
  flushed_at TEXT,
  payload TEXT NOT NULL,
  response TEXT,
  tool_use_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
-- Indexes on the columns above live in migrateAdditiveColumns, NOT here. This
-- block runs before the additive migration, and on an existing database
-- CREATE TABLE IF NOT EXISTS is a no-op while CREATE INDEX is not — so an
-- index naming a column the old table lacks fails the whole boot.

-- Operator decisions are not a table: a decision IS a resolved interactions
-- row (answers, asker and note all live there), and
-- orchestrator/decisions.ts reads them back into every prompt. An older
-- database may carry a legacy operator_decisions table; it is unused.

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  sdk_session_id TEXT NOT NULL,
  sdk_task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_session_id TEXT NOT NULL,
  agent_session_id TEXT,
  participant TEXT,
  subject TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active_form TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','deleted')),
  owner TEXT,
  blocks TEXT NOT NULL DEFAULT '[]',
  blocked_by TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sdk_session_id, sdk_task_id)
);
CREATE INDEX IF NOT EXISTS tasks_user_session ON tasks(user_session_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  blocker_task_id TEXT NOT NULL,
  blocked_task_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('console','provider','migration')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_task_id, blocked_task_id)
);

CREATE TABLE IF NOT EXISTS agent_profile_trust (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  trusted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, revision)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  workspace_id TEXT,
  user_session_id TEXT,
  agent_session_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user_session ON events(user_session_id, seq);
CREATE INDEX IF NOT EXISTS events_agent_session ON events(agent_session_id, seq);

CREATE TABLE IF NOT EXISTS mailbox_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_session_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('assignment','update','milestone','failure','final','decision')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','acknowledged','cancelled')),
  transport TEXT NOT NULL DEFAULT 'console' CHECK (transport IN ('console','peer')),
  dedupe_key TEXT,
  delivered_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_message_recipient ON mailbox_deliveries(message_id, recipient);
CREATE INDEX IF NOT EXISTS mailbox_recipient_status ON mailbox_deliveries(agent_session_id, recipient, status);

CREATE TABLE IF NOT EXISTS crons (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL,
  sdk_cron_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  one_shot INTEGER NOT NULL DEFAULT 0,
  -- Absolute firing time for a console-owned deadline. The cron matcher is
  -- minute-resolution, which is too coarse for a check-in timer, and a
  -- console-owned one-shot must fire whether or not the lane happens to be
  -- live -- that is the entire point of owning it.
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crons_session ON crons(user_session_id, status);

CREATE TABLE IF NOT EXISTS event_artifacts (
  id TEXT PRIMARY KEY,
  event_seq INTEGER,
  workspace_id TEXT,
  user_session_id TEXT,
  agent_session_id TEXT,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_entries_v2 (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT NOT NULL DEFAULT '',
  uuid TEXT,
  type TEXT NOT NULL,
  entry TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_entries_session ON provider_entries_v2(project_key, session_id, subpath, ord);
CREATE UNIQUE INDEX IF NOT EXISTS provider_entries_uuid ON provider_entries_v2(project_key, session_id, subpath, uuid) WHERE uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_samples (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL,
  agent_session_id TEXT,
  participant TEXT NOT NULL,
  profile_id TEXT,
  generation INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  model TEXT,
  effort TEXT,
  trigger TEXT,
  duration_ms INTEGER,
  api_duration_ms INTEGER,
  sdk_duration_ms INTEGER,
  status TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_session ON usage_samples(user_session_id, created_at);

CREATE TABLE IF NOT EXISTS handoff_records (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL,
  agent_session_id TEXT,
  message_id TEXT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  profile_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('assignment','update','milestone','decision','failure','final','rotation','recovery')),
  parent_handoff_id TEXT,
  root_handoff_id TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  core TEXT NOT NULL,
  extension TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  soft_target_bytes INTEGER NOT NULL,
  overflow INTEGER NOT NULL DEFAULT 0,
  reference_warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_user_created ON handoff_records(user_session_id, created_at);
CREATE INDEX IF NOT EXISTS handoffs_agent_recipient ON handoff_records(agent_session_id, recipient, created_at);
`;
