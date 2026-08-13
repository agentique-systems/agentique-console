/**
 * The single source of truth for which console tools an agent gets.
 *
 * Both consumers read THIS: `buildAgentTools` registers a tool iff its name is
 * granted, and `#spawnSeat`'s allow-list is `runtimeToolNames(granted)` — one
 * list, so registration and the allow-list cannot drift.
 *
 * Every name below is COORDINATION. The Console has no capability tools: shell
 * and background work are native `Bash`, and anything else — a browser, a
 * database client — is an MCP server the profile declares. The console-built
 * browser and process tools that used to live here were deleted; owning a
 * second-rate copy of somebody else's capability cost a live run its
 * verification (`browser_evaluate` failed on every call behind a green suite)
 * and most of its wall clock (one keypress per round trip).
 *
 * Pattern say ends at `RoleSpec.grants`; service availability stays orthogonal.
 */
import type { RoleSpec } from "./topology-contract.ts";
import type { AgentProfile } from "../agent-profiles/registry.ts";

export type AgentToolName =
  | "send_handoff" | "read_artifact" | "write_note" | "ask_operator" | "roster_status"
  | "read_handoff" | "report_handoff_discrepancy" | "forward_message"
  | "task_list" | "task_create" | "task_update" | "assignment_cancel"
  | "dispatch_work_items" | "create_child_session" | "abandon_child_session";

/** Which console services exist — availability, not permission. */
export interface AgentGrantDeps {
  tasks: boolean;
  handoffs: boolean;
  worktrees: boolean;
  user: boolean;
  /**
   * True only at depth 0 with nesting enabled: the depth cap IS this bit —
   * a child session's agents never see the spawn tools, so there is no
   * counter to forget.
   */
  childSessions: boolean;
}

export function grantedTools(
  role: Pick<RoleSpec, "grants"> | undefined,
  _profile: AgentProfile,
  deps: AgentGrantDeps,
): Set<AgentToolName> {
  const grants = new Set(role?.grants ?? []);
  const tools = new Set<AgentToolName>(["send_handoff", "read_artifact", "write_note", "ask_operator", "roster_status"]);
  if (deps.handoffs) {
    tools.add("read_handoff"); tools.add("report_handoff_discrepancy");
    if (grants.has("forward_message")) tools.add("forward_message");
  }
  if (deps.tasks && deps.user) {
    tools.add("task_list");
    if (grants.has("tasks_write")) { tools.add("task_create"); tools.add("task_update"); tools.add("assignment_cancel"); }
  }
  if (grants.has("map_dispatch")) tools.add("dispatch_work_items");
  if (grants.has("child_sessions") && deps.childSessions) {
    tools.add("create_child_session"); tools.add("abandon_child_session");
  }
  return tools;
}

export function runtimeToolNames(tools: ReadonlySet<AgentToolName>): string[] {
  return [...tools].map((name) => `mcp__console_agent__${name}`);
}
