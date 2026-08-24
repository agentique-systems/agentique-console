/**
 * The single source of truth for main's console tools — the orchestrator-lane
 * counterpart of `agent-sessions/grants.ts`.
 *
 * Both consumers read THIS: `buildConsoleMcpServer` registers the tools and
 * self-checks its registrations against this list (a drift throws at lane
 * spawn, in tests and in production alike), and `buildOrchestratorOptions`
 * derives the `mcp__console__*` allow-list from it — one list, so
 * registration and the allow-list cannot drift.
 */
export const MAIN_TOOL_NAMES = [
  "send_to_coordinator",
  "set_deadline",
  "ask_operator",
  "task_create",
  "task_update",
  "task_list",
  "create_agent_session",
  "read_agent_session",
  "list_agent_sessions",
  "list_agent_profiles",
  "read_handoff",
  "report_handoff_discrepancy",
  "session_activity",
  "interrupt_agent",
  "close_agent_session",
  "read_artifact",
  "add_agent",
  "specialize_profile",
  "propose_requirements",
  "read_requirements",
  "reconcile_change_impact",
  "report_requirement",
  "decompose_requirement",
  "record_assumption",
  "resolve_assumption",
  "link_requirements",
  "unlink_requirements",
  "update_orchestration_state",
  "record_completion",
] as const;

export type MainToolName = (typeof MAIN_TOOL_NAMES)[number];
