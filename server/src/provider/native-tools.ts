/**
 * The adapter's stance on every native tool of the pinned Claude Agent SDK:
 * the one place a native capability is classified, and the only source the
 * adapter derives its exposure and denial lists from.
 *
 * Two layers, computed separately and never mixed:
 *
 * 1. The console's neutral capability names (execution-model §6.4, §11:
 *    `read`, `search`, `write`, `shell`, `web`) map to the native tools that
 *    implement them. An Attempt exposes exactly the native tools of its
 *    effective capability set — Agent Definition ∩ role policy ∩ Workspace
 *    policy, resolved by the runtime into the manifest — and nothing is ever
 *    added because a tool would be convenient.
 * 2. Every other native tool is denied by name for every Attempt: native
 *    coordination (subagents, messaging, workflows), native task state,
 *    scheduling, human-interaction and host surfaces, native worktrees,
 *    background waits, and capability discovery. None of them has a place
 *    in a runtime that owns Tasks, Decisions, scheduling, Workspaces, and
 *    operator interaction canonically.
 *
 * The exposure list and the denial list are both handed to the SDK, and the
 * `PreToolUse` hook re-checks every call against the exposed set before it
 * consults the runtime's authorization port; a tool in neither list is
 * unknown to the SDK and denied by the hook if it ever reaches it.
 */

/** Neutral capability name → the native tools that implement it, in canonical order. */
export const CAPABILITY_NATIVE_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ["Read"],
  search: ["Glob", "Grep"],
  write: ["Edit", "Write", "NotebookEdit"],
  shell: ["Bash"],
  web: ["WebFetch", "WebSearch"],
});

/** Every native tool a capability can expose. */
export const CAPABILITY_TOOL_SURFACE: readonly string[] = Object.freeze(Object.values(CAPABILITY_NATIVE_TOOLS).flat());

const CAPABILITY_OF_NATIVE: ReadonlyMap<string, string> = new Map(Object.entries(CAPABILITY_NATIVE_TOOLS).flatMap(([capability, tools]) => tools.map((tool) => [tool, capability] as const)));

/** Native coordination: subagents, messaging, and workflows are the runtime's own product and never a model's. */
export const DENIED_COORDINATION = ["Agent", "Task", "SendMessage", "ListAgents", "Workflow"] as const;
/** Native task state: the canonical Task ledger is the one Task surface. */
export const DENIED_TASK_STATE = ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TodoWrite"] as const;
/** Native scheduling: nothing wakes a model outside the scheduler. */
export const DENIED_SCHEDULING = ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete", "RemoteTrigger"] as const;
/** Native human-interaction surfaces: the operator is reached through canonical Decisions only. */
export const DENIED_HUMAN_SURFACE = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] as const;
/** Host and product surfaces of the interactive Claude apps. */
export const DENIED_HOST_SURFACE = ["Artifact", "PushNotification", "SendFeedback", "ClaudeDesign", "Projects", "ShowOnboardingRolePicker", "ProposeSkills", "ReportFindings", "REPL"] as const;
/** Native worktrees: the runtime owns Workspaces, Snapshots, and worktrees. */
export const DENIED_WORKTREES = ["EnterWorktree", "ExitWorktree"] as const;
/** Background waits: an Attempt's shell work is synchronous within the Attempt. */
export const DENIED_BACKGROUND = ["Monitor", "TaskOutput", "TaskStop"] as const;
/** Capability discovery: skills, deferred schemas, and MCP resource browsing are not part of an Attempt. */
export const DENIED_DISCOVERY = ["Skill", "ToolSearch", "SlashCommand", "ListMcpResources", "ReadMcpResource", "ReadMcpResourceDir", "RefreshMcpTools"] as const;

/** Every native tool denied for every Attempt, in canonical order. */
export const ALWAYS_DENIED_NATIVE_TOOLS: readonly string[] = Object.freeze([
  ...DENIED_COORDINATION,
  ...DENIED_TASK_STATE,
  ...DENIED_SCHEDULING,
  ...DENIED_HUMAN_SURFACE,
  ...DENIED_HOST_SURFACE,
  ...DENIED_WORKTREES,
  ...DENIED_BACKGROUND,
  ...DENIED_DISCOVERY,
]);

/** Every classified native tool, in canonical order: option assembly iterates this so lists stay byte-stable. */
export const NATIVE_TOOL_SURFACE: readonly string[] = Object.freeze([...CAPABILITY_TOOL_SURFACE, ...ALWAYS_DENIED_NATIVE_TOOLS]);

/**
 * Classified names absent from the SDK's generated schema union: meta tools
 * the union does not carry. The tripwire test reconciles the union against
 * `NATIVE_TOOL_SURFACE` and this set.
 */
export const KNOWN_META_TOOLS: ReadonlySet<string> = new Set(["Task", "SendMessage", "ListAgents", "Skill", "ToolSearch", "SlashCommand"]);

/** Schema names in the union that are wire aliases, not callable tools (`Mcp` is the carrier of dynamic `mcp__*` tools). */
export const SCHEMA_NAME_ALIASES: Readonly<Record<string, string | null>> = Object.freeze({ FileEdit: "Edit", FileRead: "Read", FileWrite: "Write", Mcp: null });

/** The prefix of every MCP tool name the SDK presents: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** The server an MCP tool name belongs to, or `null` for a native name. */
export function mcpServerOf(name: string): string | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf("__");
  return end <= 0 ? null : rest.slice(0, end);
}

export interface NativeExposure {
  /** The native tools to expose, in canonical order. */
  tools: string[];
  /** Capability names with no native mapping (recorded as diagnostics; nothing is exposed for them). */
  unmapped: string[];
}

/** The native tools of an effective capability set: exactly the mapped ones, in canonical order. */
export function nativeExposureOf(capabilityTools: readonly string[]): NativeExposure {
  const wanted = new Set<string>();
  const unmapped: string[] = [];
  for (const capability of capabilityTools) {
    const natives = CAPABILITY_NATIVE_TOOLS[capability];
    if (natives === undefined) {
      // An MCP tool named directly in the capability set is exposed by its server, not as a native tool.
      if (!isMcpToolName(capability)) unmapped.push(capability);
      continue;
    }
    for (const tool of natives) wanted.add(tool);
  }
  return { tools: CAPABILITY_TOOL_SURFACE.filter((tool) => wanted.has(tool)), unmapped: unmapped.sort() };
}

/**
 * The console's capability name for a native or MCP tool call: the neutral
 * name for a mapped native tool, the exact `mcp__<server>__<tool>` name for
 * an MCP tool (which a definition declares verbatim), `null` for a native
 * tool no capability maps to.
 */
export function capabilityToolOf(nativeName: string): string | null {
  if (isMcpToolName(nativeName)) return nativeName;
  return CAPABILITY_OF_NATIVE.get(nativeName) ?? null;
}

/** Every classified native tool the Attempt does not expose, denied by name, in canonical order. */
export function disallowedNativeTools(exposed: readonly string[]): string[] {
  const set = new Set(exposed);
  return NATIVE_TOOL_SURFACE.filter((tool) => !set.has(tool));
}
