/**
 * Assembles SDK Options for one orchestrator turn. Hermetic by construction:
 * settingSources [] keeps filesystem CLAUDE.md/hooks/skills out, and the tool
 * surface is the console MCP tools plus explicitly allowed builtins — every
 * messaging/task/scheduling path is console-owned and journaled.
 */
import type { SessionMode, SessionPhase } from "@agentique-console/shared";
import { sdkEnv } from "../sdk/env.ts";
import type { SdkOptions } from "../sdk/types.ts";
import {
  ORCHESTRATOR_BRIEF,
  ORCHESTRATOR_DELEGATION_BRIEF,
  PLAN_MODE_BODY,
} from "./prompt.ts";

export const CONSOLE_TOOL_NAMES = [
  "send_to_coordinator",
  "set_deadline",
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
  "propose_spec",
  "read_spec",
  "update_orchestration_state",
  "record_completion",
] as const;

/**
 * Never available to main, in any configuration. `SendMessage` bypasses the
 * journal; `ScheduleWakeup`/`Monitor`/`TaskStop` wake a console-owned lane with
 * no mailbox row, no handoff and no turn attribution.
 */
const MAIN_DENIED_TOOLS = ["Agent", "Task", "Bash", "Write", "Edit", "NotebookEdit", "SendMessage", "ScheduleWakeup", "Monitor", "TaskStop",
  // The native ledger is keyed on the provider session id, which changes at
  // every rotation.
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"];

const MAIN_WORK_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

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
  /** The console MCP server instance. */
  mcpServer?: unknown;
  sessionStore?: unknown;
  contextMemory?: string;
  /**
   * The operator's decisions, appended AFTER the rotation checkpoint. Main
   * must not contradict a call the operator already made, and must not relay
   * one — every agent has it already.
   */
  decisionDigest?: string;
  /** The approved living spec, injected AFTER decisions (both authoritative). */
  specDigest?: string;
  /** Main's own working state — the durable memory of the orchestration loop. */
  stateDigest?: string;
  /** "away" injects one line: prefer proceeding on recommendations. */
  autonomy?: "standard" | "away";
  purpose?: "work" | "profile_manager";
  /** The lane's registry address (CLAUDE_CODE_SESSION_NAME). */
  peerName?: string;
  /** Governance/mirror hooks (SendMessage middleware, task + cron mirrors). */
  hooks?: SdkOptions["hooks"];
}

const MANAGER_BRIEF = `# Profile Manager

You work directly with the Human Operator to design Agentique agent profiles.
Inspect the workspace read-only so the profile fits the project. All profile
changes must go through the profile_manager staging tools. During planning,
stage a complete bundle, inspect its diff and validation, then use ExitPlanMode
to ask the operator to Apply or discard it. After approval call apply_profile.
Never modify files outside the staged profile bundle.`;

const MANAGER_PLAN_MODE_BODY = `This is an interactive profile-editing session.
Inspect the selected profile and workspace read-only, then build the complete
candidate bundle only with the profile_manager staging tools. Keep the proposal
valid as you work. Summarize the exact file diff, validation findings, and
security-relevant capabilities, then use ExitPlanMode to request explicit Apply
approval. After approval, call apply_profile once. Do not create Console tasks
or AgentSessions for this workflow.`;

export function buildOrchestratorOptions(
  input: OrchestratorOptionsInput,
): SdkOptions {
  const planning = input.mode === "plan_execute" && input.phase === "planning";
  const manager = input.purpose === "profile_manager";
  const withDelegation = input.mcpServer !== undefined;
  const options: SdkOptions = {
    cwd: input.workspaceRoot,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: (manager ? MANAGER_BRIEF + (input.contextMemory ? `\n\n## Selected profile (read-only baseline)\n${input.contextMemory}` : "") : withDelegation
        ? ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : "")
        : ORCHESTRATOR_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : ""))
        + (input.decisionDigest ? `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not relay them to seats — they already have them.\n${input.decisionDigest}` : "")
        + (input.specDigest ? `\n\n${input.specDigest}` : "")
        + (input.stateDigest ? `\n\n${input.stateDigest}` : "")
        + (input.autonomy === "away" ? "\n\nThe operator is AWAY: prefer proceeding on recommendations and provisional decisions; queue only irreversible choices for their return." : ""),
    },
    settingSources: [],
    includePartialMessages: true,
    permissionMode: planning ? "plan" : "default",
    ...(planning ? { planModeInstructions: manager ? MANAGER_PLAN_MODE_BODY : PLAN_MODE_BODY } : {}),
    allowedTools: [
      ...MAIN_WORK_TOOLS,
      ...(withDelegation
        ? manager
          ? ["read_profile_proposal", "stage_profile_file", "delete_profile_file", "apply_profile"].map((name) => `mcp__profile_manager__${name}`)
          : CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`)
        : []),
    ],
    disallowedTools: [...MAIN_DENIED_TOOLS, "CronCreate", "CronList", "CronDelete"],
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    settings: { crossSessionInbound: "accept" } as unknown as SdkOptions["settings"],
    // In streaming mode maxTurns counts cumulatively over the whole session
    // run — any default here would kill a long-lived lane. Callers opt in.
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    // Never inherit the launching session's agent settings (see sdkEnv).
    env: sdkEnv(input.peerName === undefined ? {} : { sessionName: input.peerName }),
    ...(input.effort === undefined
      ? {}
      : { effort: input.effort as SdkOptions["effort"] }),
    canUseTool: input.canUseTool,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.resume === null ? {} : { resume: input.resume }),
    // persistSession defaults true: transcripts live in ~/.claude/projects/…
    // exactly like the CLI, and `resume` reads them natively. The SQLite
    // mirror below (provider_entries_v2, eager flush) is a deliberate second
    // copy: it backs journal-kind evidence verification and run forensics.
    abortController: input.abortController,
    ...(input.sessionStore === undefined ? {} : {
      persistSession: true,
      sessionStore: input.sessionStore as SdkOptions["sessionStore"],
      sessionStoreFlush: "eager" as const,
    }),
    ...(input.mcpServer === undefined
      ? {}
      : {
          mcpServers: {
            [manager ? "profile_manager" : "console"]: input.mcpServer as never,
          },
        }),
  };
  return options;
}
