/**
 * Assembles SDK Options for one orchestrator turn. Hermetic by construction:
 * settingSources [] keeps filesystem CLAUDE.md/hooks/skills out; the tool
 * surface is read-only plus task tools plus the console MCP tools; Write/Edit/
 * Bash are delegation-first denials (D4).
 */
import type { SessionMode, SessionPhase } from "@agentique-console/shared";
import { PRESETS, SESSION_PROTOCOL } from "../agent-sessions/presets.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { SdkOptions } from "../sdk/types.ts";
import {
  ORCHESTRATOR_BRIEF,
  ORCHESTRATOR_DELEGATION_BRIEF,
  PLAN_MODE_BODY,
  SUB_ORCHESTRATOR_BRIEF,
} from "./prompt.ts";

export const CONSOLE_TOOL_NAMES = [
  "create_agent_session",
  "read_agent_session",
  "list_agent_sessions",
] as const;

/**
 * The coordinator's console tool surface: the task board (coordinator-only —
 * permissions.ts denies task_* to the parent, which has the SDK-native
 * TaskCreate family) plus transcript reads. Messaging is native SendMessage.
 */
export const COORDINATOR_TOOL_NAMES = [
  "read_agent_session",
  "task_create",
  "task_update",
  "task_list",
] as const;

export const SESSION_ORCHESTRATOR_AGENT = "session-orchestrator";

/**
 * B2: every console agent is a native SDK subagent type. Specialists get the
 * full working surface explicitly (an omitted `tools` would inherit the
 * PARENT's read-only allowlist — useless for implementers); the background
 * filter intersects this with its own builtin allowlist + all MCP tools.
 * `Agent` is deliberately absent everywhere → no nesting, all seats flat.
 * permissionMode bypass mirrors D6 (local trust; B0-verified honored under a
 * default-mode parent). Planning variants are read-only agents that SEND their
 * plan and stop — B0 showed ExitPlanMode never survives into an SDK-session
 * subagent, so approval means spawning the execute variant with the approved
 * plan in its prompt (the SDK's own consent pattern).
 */
const SPECIALIST_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "SendMessage",
];

export const PRESET_AGENT_TYPES = [
  "explorer",
  "implementer",
  "reviewer",
  "researcher",
  "adhoc",
] as const;

const ADHOC_BRIEF =
  "You are a specialist agent; your spawn prompt carries your full brief and assignment.";

const PLANNING_POSTFIX = `
## Planning assignment

You are the PLANNING pass for this seat: survey read-only, draft the plan for
the work named in your spawn prompt, SendMessage it to your coordinator in
full, then stop. You will NOT execute — on approval a fresh execute agent is
spawned with the approved plan; on revision you may be messaged with notes and
should reply with the updated plan.`;

function specialistAgent(
  brief: string,
  planning: boolean,
): NonNullable<SdkOptions["agents"]>[string] {
  return {
    description:
      "Console specialist seat — spawned only via a create_agent_session spawn plan, never ad hoc.",
    prompt: `${brief}\n${SESSION_PROTOCOL}${planning ? PLANNING_POSTFIX : ""}`,
    tools: planning
      ? ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "SendMessage"]
      : SPECIALIST_TOOLS,
    permissionMode: "bypassPermissions",
  };
}

function sessionOrchestratorAgent(): NonNullable<SdkOptions["agents"]>[string] {
  return {
    description:
      "Coordinates one agent session on the Orchestrator's behalf: briefs the seats via SendMessage, routes work, keeps the task board, and reports results upward. Spawn one per created agent session, LAST (so its roster lists the seats), named per the spawn plan.",
    prompt: SUB_ORCHESTRATOR_BRIEF,
    tools: [
      "Read",
      "Glob",
      "Grep",
      "SendMessage",
      ...COORDINATOR_TOOL_NAMES.map((name) => `mcp__console__${name}`),
    ],
  };
}

/** All console agent types, keyed exactly as the spawn plan names them. */
export function consoleAgents(): NonNullable<SdkOptions["agents"]> {
  const agents: NonNullable<SdkOptions["agents"]> = {
    [SESSION_ORCHESTRATOR_AGENT]: sessionOrchestratorAgent(),
  };
  for (const type of PRESET_AGENT_TYPES) {
    const brief = type === "adhoc" ? ADHOC_BRIEF : (PRESETS[type] as string);
    agents[type] = specialistAgent(brief, false);
    agents[`${type}-planning`] = specialistAgent(brief, true);
  }
  return agents;
}

export interface OrchestratorOptionsInput {
  workspaceRoot: string;
  resume: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  model: string | undefined;
  effort: string | undefined;
  maxTurns?: number;
  abortController: AbortController;
  canUseTool: NonNullable<SdkOptions["canUseTool"]>;
  hooks?: SdkOptions["hooks"];
  /** The console MCP server instance (absent until M6 wires delegation). */
  mcpServer?: unknown;
}

export function buildOrchestratorOptions(
  input: OrchestratorOptionsInput,
): SdkOptions {
  const planning = input.mode === "plan_execute" && input.phase === "planning";
  const withDelegation = input.mcpServer !== undefined;
  const options: SdkOptions = {
    cwd: input.workspaceRoot,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: withDelegation
        ? ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF
        : ORCHESTRATOR_BRIEF,
    },
    settingSources: [],
    includePartialMessages: true,
    // A4: the coordinator's narration/thinking stream through, tagged with
    // parent_tool_use_id, and render inside its agent session's pane.
    forwardSubagentText: true,
    permissionMode: planning ? "plan" : "default",
    ...(planning ? { planModeInstructions: PLAN_MODE_BODY } : {}),
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "TaskCreate",
      "TaskUpdate",
      "TaskGet",
      "TaskList",
      ...(withDelegation
        ? [
            "Agent",
            "SendMessage",
            ...CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`),
          ]
        : []),
    ],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
    // In streaming mode maxTurns counts cumulatively over the whole session
    // run — any default here would kill a long-lived lane. Callers opt in.
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    // Never inherit the launching session's agent settings (see sdkEnv).
    env: sdkEnv(),
    ...(input.effort === undefined
      ? {}
      : { effort: input.effort as SdkOptions["effort"] }),
    canUseTool: input.canUseTool,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.resume === null ? {} : { resume: input.resume }),
    // persistSession defaults true: transcripts live in ~/.claude/projects/…
    // exactly like the CLI, and `resume` reads them natively (B1 dropped the
    // SQLite mirror — it was always a second copy).
    abortController: input.abortController,
    ...(input.mcpServer === undefined
      ? {}
      : {
          mcpServers: {
            console: input.mcpServer as never,
          },
          agents: consoleAgents(),
        }),
  };
  return options;
}
