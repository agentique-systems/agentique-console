/**
 * Assembles SDK Options for one orchestrator turn. Hermetic by construction:
 * settingSources [] keeps filesystem CLAUDE.md/hooks/skills out; the tool
 * surface is the main agent's working set plus Console-managed delegation.
 * Native SendMessage, task, and cron tools are ALLOWED and governed by hook
 * middleware — the journal observes every send; denial is reserved for
 * in-process subagents (Agent/Task), which would fork ungoverned context.
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
] as const;

/** Native harness tools the work lane may call; hooks govern and mirror them. */
/**
 * Native tools main may still use. `SendMessage` is NOT among them: the mesh it
 * addressed is gone, its envelope middleware was deleted, and every send it
 * made in db-live-2 failed with "No agent named … is reachable". Coordinator
 * traffic goes through the console-owned `send_to_coordinator`, which is
 * route-checked and journaled.
 */
const MAIN_NATIVE_TOOLS: string[] = [];

/**
 * Never available to main, in any configuration. `SendMessage` bypasses the
 * journal; `ScheduleWakeup`/`Monitor`/`TaskStop` wake a console-owned lane with
 * no mailbox row, no handoff and no turn attribution.
 */
const MAIN_DENIED_TOOLS = ["Agent", "Task", "Bash", "Write", "Edit", "NotebookEdit", "SendMessage", "ScheduleWakeup", "Monitor", "TaskStop",
  // The native ledger is keyed on the provider session id, which changes at
  // every rotation — the orphan-on-rotation failure seats were already spared.
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
  /** The console MCP server instance (absent until M6 wires delegation). */
  mcpServer?: unknown;
  sessionStore?: unknown;
  contextMemory?: string;
  /**
   * The operator's decisions, appended AFTER the rotation checkpoint. Main
   * must not contradict a call the operator already made, and must not relay
   * one — every seat has it already.
   */
  decisionDigest?: string;
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
        + (input.decisionDigest ? `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not relay them to seats — they already have them.\n${input.decisionDigest}` : ""),
    },
    settingSources: [],
    includePartialMessages: true,
    permissionMode: planning ? "plan" : "default",
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, filesystem: { allowManagedReadPathsOnly: true, allowRead: [input.workspaceRoot], allowWrite: [input.workspaceRoot] } },
    ...(planning ? { planModeInstructions: manager ? MANAGER_PLAN_MODE_BODY : PLAN_MODE_BODY } : {}),
    allowedTools: [
      ...MAIN_WORK_TOOLS,
      ...(withDelegation
        ? manager
          ? ["read_profile_proposal", "stage_profile_file", "delete_profile_file", "apply_profile"].map((name) => `mcp__profile_manager__${name}`)
          : [...CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`), ...MAIN_NATIVE_TOOLS]
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
    // exactly like the CLI, and `resume` reads them natively (B1 dropped the
    // SQLite mirror — it was always a second copy).
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
