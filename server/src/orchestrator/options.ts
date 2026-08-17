/**
 * Assembles SDK Options for one orchestrator turn. Main sees the workspace
 * exactly as an interactive Claude Code session would — CLAUDE.md, user and
 * project settings, skills — and adds the console MCP tools on top; every
 * messaging/task/scheduling path stays console-owned and journaled. Only the
 * checkpoint and composer-rewrite queries are hermetic.
 */
import type { SessionMode, SessionPhase } from "@agentique-console/shared";
import type { EffortLevel } from "../sdk/effort.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { SdkOptions } from "../sdk/types.ts";
import {
  ORCHESTRATOR_BRIEF,
  ORCHESTRATOR_DELEGATION_BRIEF,
  PLAN_MODE_BODY,
} from "./prompt.ts";

/**
 * Main's own effort when the operator sets no CONSOLE_EFFORT: the lane that
 * specifies, plans, judges evidence and decides when to stop deserves the
 * deepest reasoning the model offers.
 */
export const MAIN_DEFAULT_EFFORT: EffortLevel = "xhigh";

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
  "specialize_profile",
  "propose_spec",
  "read_spec",
  "update_orchestration_state",
  "record_completion",
] as const;

/**
 * Never available to main, in any configuration. `SendMessage` bypasses the
 * journal; `ScheduleWakeup`/`Monitor`/`TaskStop` wake a console-owned lane with
 * no mailbox row, no handoff and no turn attribution. Write/Edit stay denied
 * — implementation goes through seats — but NOT Bash: see MAIN_WORK_TOOLS.
 */
const MAIN_DENIED_TOOLS = ["Agent", "Task", "Write", "Edit", "NotebookEdit", "SendMessage", "ScheduleWakeup", "Monitor", "TaskStop",
  // The native ledger is keyed on the provider session id, which changes at
  // every rotation.
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"];

const MAIN_WORK_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  // Infrastructure surgery, by operator directive: two live runs wedged on
  // one-command git blockers (a stray uncommitted edit; a leaked seat
  // branch) that main had diagnosed exactly and could not fix — one ended
  // in the operator running git by hand, the other in a blocking question
  // whose own recommendation read "it is one safe command". The charter
  // bounds usage (unblock and verify, never a seat's implementation work);
  // every call is journaled as a tool event.
  "Bash",
];

export interface OrchestratorOptionsInput {
  workspaceRoot: string;
  resume: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  model: string | undefined;
  effort: EffortLevel | undefined;
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
  /** The lane's registry address (CLAUDE_CODE_SESSION_NAME). */
  peerName?: string;
  /** Governance/mirror hooks (SendMessage middleware, task + cron mirrors). */
  hooks?: SdkOptions["hooks"];
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
      append: (withDelegation
        ? ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : "")
        : ORCHESTRATOR_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : ""))
        + (input.decisionDigest ? `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not relay them to seats — they already have them.\n${input.decisionDigest}` : "")
        + (input.specDigest ? `\n\n${input.specDigest}` : "")
        + (input.stateDigest ? `\n\n${input.stateDigest}` : "")
        + (input.autonomy === "away" ? "\n\nThe operator is AWAY: prefer proceeding on recommendations and provisional decisions; queue only irreversible choices for their return." : ""),
    },
    // CLI parity: without "project" the CLI never loads CLAUDE.md, and the
    // agent re-derives per session what the operator wrote down once.
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    permissionMode: planning ? "plan" : "default",
    ...(planning ? { planModeInstructions: PLAN_MODE_BODY } : {}),
    allowedTools: [
      ...MAIN_WORK_TOOLS,
      ...(withDelegation ? CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`) : []),
    ],
    disallowedTools: [...MAIN_DENIED_TOOLS, "CronCreate", "CronList", "CronDelete"],
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    settings: { crossSessionInbound: "accept" } as unknown as SdkOptions["settings"],
    // In streaming mode maxTurns counts cumulatively over the whole session
    // run — any default here would kill a long-lived lane. Callers opt in.
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    // Never inherit the launching session's agent settings (see sdkEnv).
    env: sdkEnv(input.peerName === undefined ? {} : { sessionName: input.peerName }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
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
            console: input.mcpServer as never,
          },
        }),
  };
  return options;
}
