/**
 * The single source of truth for which console tools an agent gets.
 *
 * Both consumers read THIS: `buildAgentTools` registers a tool iff its name is
 * granted, and `#spawnSeat`'s allow-list is `runtimeToolNames(granted)` — one
 * list, so registration and the allow-list cannot drift.
 *
 * Pattern say ends at `RoleSpec.grants`; profile capabilities (shell, browser,
 * screenshots) and service availability stay orthogonal inputs.
 */
import type { RoleSpec } from "./topology-contract.ts";
import type { AgentProfile } from "../agent-profiles/registry.ts";

export type AgentToolName =
  | "send_handoff" | "read_artifact" | "write_note" | "ask_operator" | "roster_status"
  | "read_handoff" | "report_handoff_discrepancy" | "forward_message"
  | "task_list" | "task_create" | "task_update"
  | "http_probe" | "process_start" | "process_read" | "process_stop"
  | "browser_open" | "browser_snapshot" | "browser_click" | "browser_fill"
  | "browser_console" | "browser_press" | "browser_evaluate" | "browser_screenshot"
  | "dispatch_work_items" | "create_child_session" | "abandon_child_session";

/** Which console services exist — availability, not permission. */
export interface AgentGrantDeps {
  tasks: boolean;
  handoffs: boolean;
  processes: boolean;
  browsers: boolean;
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
  profile: AgentProfile,
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
    if (grants.has("tasks_write")) { tools.add("task_create"); tools.add("task_update"); }
  }
  if (profile.runtime.shell) {
    tools.add("http_probe");
    if (deps.processes) { tools.add("process_start"); tools.add("process_read"); tools.add("process_stop"); }
  }
  if (profile.runtime.browser && deps.browsers) {
    tools.add("browser_open"); tools.add("browser_snapshot"); tools.add("browser_click"); tools.add("browser_fill");
    tools.add("browser_console"); tools.add("browser_press"); tools.add("browser_evaluate");
    if (profile.runtime.screenshots) tools.add("browser_screenshot");
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
