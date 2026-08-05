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
  sdk_session_id TEXT,
  sdk_generation INTEGER NOT NULL DEFAULT 0,
  sdk_turn_count INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '',
  latest_handoff_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL REFERENCES user_sessions(id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('execute','plan_execute')),
  phase TEXT NOT NULL DEFAULT 'executing' CHECK (phase IN ('planning','executing')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived')),
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
  generation INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '',
  latest_handoff_id TEXT,
  checkpoint_ready INTEGER NOT NULL DEFAULT 1,
  pending_turn_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_session_id, name)
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

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  user_session_id TEXT NOT NULL REFERENCES user_sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('question','plan_approval')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','rejected','dismissed','stale')),
  payload TEXT NOT NULL,
  response TEXT,
  tool_use_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
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
  dedupe_key TEXT,
  delivered_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_message_recipient ON mailbox_deliveries(message_id, recipient);
CREATE INDEX IF NOT EXISTS mailbox_recipient_status ON mailbox_deliveries(agent_session_id, recipient, status);

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
