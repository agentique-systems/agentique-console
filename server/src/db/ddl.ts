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
  hop_limit INTEGER NOT NULL DEFAULT 12,
  hop_count INTEGER NOT NULL DEFAULT 0,
  last_routed_seq INTEGER NOT NULL DEFAULT 0,
  owed_to_orchestrator INTEGER NOT NULL DEFAULT 0,
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
  sdk_session_id TEXT,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  pending_turn_seq INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS sdk_session_entries (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT NOT NULL DEFAULT '',
  uuid TEXT,
  type TEXT NOT NULL,
  entry TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sdk_entries_session ON sdk_session_entries(project_key, session_id, subpath);
CREATE UNIQUE INDEX IF NOT EXISTS sdk_entries_uuid
  ON sdk_session_entries(project_key, session_id, subpath, uuid)
  WHERE uuid IS NOT NULL;
`;
