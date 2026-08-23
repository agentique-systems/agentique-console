/**
 * The console's stance on every native tool of the pinned Claude runtime —
 * the single place a native capability is classified, and the only source
 * any runtime decision about native tool availability may derive from.
 *
 * Four governance layers, computed separately and never mixed into one list:
 *   1. The NATIVE-DEFINITION CEILING — what the profile's author granted
 *      (`tools` minus `disallowedTools`; omitted `tools` preserves the native
 *      "inherits all tools" meaning).
 *   2. The PRODUCT-POLICY CEILING — this module's DENIED_* categories.
 *   3. CONSOLE TOOL GRANTS — `agent-sessions/grants.ts`, a separate surface
 *      (`mcp__console_agent__*`) orchestration hands out by role.
 *   4. RUNTIME CONTAINMENT — the worktree. Containment is never
 *      authorization: a worktree changes what a seat can touch, never what
 *      it is granted.
 *
 * The effective native set is a pure intersection of 1 and 2. Nothing is
 * ever ADDED because the console finds a tool convenient — a profile that
 * wants Skill, ToolSearch, or Monitor declares them; the built-ins do.
 */

/** Ordinary workspace work: files, shell, web. */
export const WORKSPACE_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch",
] as const;

/**
 * Capability discovery and progressive disclosure: skill bodies load through
 * Skill, deferred tool schemas through ToolSearch, MCP resources through the
 * resource readers. Inside native `tools` semantics like everything else —
 * granted by declaration, never auto-added.
 */
export const DISCOVERY_TOOLS = [
  "Skill", "ToolSearch",
  "ListMcpResources", "ReadMcpResource", "ReadMcpResourceDir", "RefreshMcpTools",
  "SlashCommand",
] as const;

/** Reading back backgrounded Bash work without polling. */
export const BACKGROUND_WAIT_TOOLS = ["Monitor", "TaskOutput", "TaskStop"] as const;

/** Native worktree tools — auto-APPROVED for declaring profiles; the console's own worktrees are plain git. */
export const WORKTREE_TOOLS = ["EnterWorktree", "ExitWorktree"] as const;

/**
 * Native coordination. Denied everywhere: `Agent`/`Task` fork ungoverned
 * context, `SendMessage` bypasses the journal, `Workflow` orchestrates whole
 * agent fleets outside the console's route law. Coordination is the
 * console's own product (send_handoff, sessions, the mailroom).
 */
export const DENIED_COORDINATION = ["Agent", "Task", "SendMessage", "ListAgents", "Workflow"] as const;

/**
 * Native task state. Denied everywhere: the native ledger is keyed to the
 * provider session (dies with it), and TodoWrite is a second task surface
 * beside the console-owned ledger every seat reads.
 */
export const DENIED_TASK_STATE = ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TodoWrite"] as const;

/**
 * Native scheduling. Denied everywhere: these wake a provider session with
 * no mailbox row, no handoff, and no turn attribution. `set_deadline` is the
 * console-owned wakeup.
 */
export const DENIED_SCHEDULING = ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete", "RemoteTrigger"] as const;

/**
 * Native human-interaction surfaces. Seats have exactly one operator path —
 * `ask_operator` (journaled, resumable, requirement-scoped) — so these are
 * denied for every seat. Main deliberately keeps AskUserQuestion and
 * ExitPlanMode: its canUseTool intercepts both into operator cards.
 * EnterPlanMode stays denied even for main — phase is console-owned.
 */
export const DENIED_HUMAN_SURFACE = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] as const;

/**
 * Host/product surfaces of the interactive Claude apps — not part of this
 * console's product. Denied everywhere until a deliberate classification
 * says otherwise.
 */
export const DENIED_HOST_SURFACE = [
  "Artifact", "PushNotification", "SendFeedback", "ClaudeDesign", "Projects",
  "ShowOnboardingRolePicker", "ProposeSkills", "ReportFindings", "REPL",
] as const;

export type GovernedTool = (typeof WORKSPACE_TOOLS)[number];

/**
 * Every classified native tool, in canonical (category) order. Option
 * assembly iterates THIS order so allow/deny lists stay byte-stable across
 * spawns of the same profile.
 */
export const NATIVE_TOOL_SURFACE: ReadonlySet<string> = new Set([
  ...WORKSPACE_TOOLS, ...DISCOVERY_TOOLS, ...BACKGROUND_WAIT_TOOLS, ...WORKTREE_TOOLS,
  ...DENIED_COORDINATION, ...DENIED_TASK_STATE, ...DENIED_SCHEDULING,
  ...DENIED_HUMAN_SURFACE, ...DENIED_HOST_SURFACE,
]);

const DENIED_EVERY_LANE: readonly string[] = [
  ...DENIED_COORDINATION, ...DENIED_TASK_STATE, ...DENIED_SCHEDULING, ...DENIED_HOST_SURFACE,
];

/**
 * The product-policy ceiling per lane. For main, AskUserQuestion and
 * ExitPlanMode are POLICY-ALLOWED but deliberately absent from main's
 * auto-approve list: they must reach canUseTool, which turns them into
 * operator cards. Monitor/TaskStop stay main-denied (a background wait
 * belongs to the seat that started the work, never to main's turn).
 */
export function policyAllowedNativeTools(lane: "seat" | "main"): ReadonlySet<string> {
  const denied = new Set<string>(DENIED_EVERY_LANE);
  if (lane === "seat") {
    for (const name of DENIED_HUMAN_SURFACE) denied.add(name);
  } else {
    denied.add("EnterPlanMode");
    denied.add("Monitor");
    denied.add("TaskStop");
  }
  return new Set([...NATIVE_TOOL_SURFACE].filter((name) => !denied.has(name)));
}

/**
 * The author's ceiling. `tools` omitted preserves the native meaning —
 * "inherits all tools" — reported as `"inherit"` so callers never confuse
 * omission with an empty grant.
 */
export function nativeToolCeiling(
  profile: { tools?: readonly string[]; disallowedTools?: readonly string[] },
): ReadonlySet<string> | "inherit" {
  if (profile.tools === undefined) return "inherit";
  const disallowed = new Set(profile.disallowedTools ?? []);
  return new Set(profile.tools.filter((name) => !disallowed.has(name)));
}

/**
 * ceiling ∩ policy: the native tools a lane actually holds. The author's
 * `disallowedTools` bind in the inherit case too — a restriction is honored
 * whether or not `tools` was spelled out. Canonical surface order (see
 * NATIVE_TOOL_SURFACE) for cache-stable option assembly.
 */
export function effectiveNativeTools(
  profile: { tools?: readonly string[]; disallowedTools?: readonly string[] },
  lane: "seat" | "main",
): ReadonlySet<string> {
  const allowed = policyAllowedNativeTools(lane);
  const ceiling = nativeToolCeiling(profile);
  const disallowed = new Set(profile.disallowedTools ?? []);
  return new Set([...NATIVE_TOOL_SURFACE].filter((name) =>
    allowed.has(name) && !disallowed.has(name) && (ceiling === "inherit" || ceiling.has(name))));
}

/** Everything classified that the seat does not hold, denied by name — one formula covers policy denials, the author's disallowedTools, and every tool an explicit `tools:` list left out. */
export function seatDisallowedNativeTools(effective: ReadonlySet<string>): string[] {
  return [...NATIVE_TOOL_SURFACE].filter((name) => !effective.has(name));
}

/** Main's deny list: the surface minus main's policy ceiling. AskUserQuestion/ExitPlanMode are neither denied nor auto-approved — canUseTool decides. */
export function mainDisallowedNativeTools(): string[] {
  const allowed = policyAllowedNativeTools("main");
  return [...NATIVE_TOOL_SURFACE].filter((name) => !allowed.has(name));
}

/**
 * Tripwire bookkeeping — see native-capability-policy.test.ts, which
 * enumerates the installed SDK's tool surface (the `ToolInputSchemas` union
 * in sdk-tools.d.ts) and fails when an SDK upgrade introduces a native
 * capability this module has not classified.
 *
 * Classified names absent from the generated schema union: runtime meta
 * tools and legacy aliases the union does not carry.
 */
export const KNOWN_META_TOOLS: ReadonlySet<string> = new Set([
  "Task",        // legacy alias of Agent (renamed CLI-side); kept denied by name
  "SendMessage", // cross-session mesh tool; not in the generated union
  "ListAgents",  // cross-session mesh tool; not in the generated union
  "Skill",       // skill invocation; enabled via Options.skills, not in the union
  "ToolSearch",  // deferred-schema loader; not in the union
  "SlashCommand",// command invocation; not in the union
]);

/**
 * Schema names in the union that are wire-format aliases, not callable
 * tools: File* are the schemas behind Edit/Read/Write, and Mcp is the
 * carrier schema for dynamic `mcp__*` tools (governed by the mcp__ grants,
 * never by a tool literally named "Mcp").
 */
export const SCHEMA_NAME_ALIASES: Readonly<Record<string, string | null>> = {
  FileEdit: "Edit",
  FileRead: "Read",
  FileWrite: "Write",
  Mcp: null,
};
