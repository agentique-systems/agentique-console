/**
 * Assembles SDK Options for one orchestrator turn. Hermetic by construction:
 * settingSources [] keeps filesystem CLAUDE.md/hooks/skills out; the tool
 * surface is the main agent's working set plus Console-managed delegation.
 * Native SDK subagents and SendMessage are denied: they bypass the durable
 * mailbox and authoritative event journal.
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
  "create_agent_session",
  "send_agent_message",
  "read_agent_session",
  "list_agent_sessions",
  "list_agent_profiles",
  "read_handoff",
  "report_handoff_discrepancy",
  "task_create",
  "task_update",
  "task_list",
] as const;

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
        ? ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : "")
        : ORCHESTRATOR_BRIEF + (input.contextMemory ? `\n\n## Rotation checkpoint (or read-only legacy memory)\n${input.contextMemory}` : ""),
    },
    settingSources: [],
    includePartialMessages: true,
    permissionMode: planning ? "plan" : "default",
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, filesystem: { allowManagedReadPathsOnly: true, allowRead: [input.workspaceRoot], allowWrite: [input.workspaceRoot] } },
    ...(planning ? { planModeInstructions: PLAN_MODE_BODY } : {}),
    allowedTools: [
      ...MAIN_WORK_TOOLS,
      ...(withDelegation
        ? CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`)
        : []),
    ],
    disallowedTools: ["Agent", "Task", "SendMessage", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "Bash", "Write", "Edit", "NotebookEdit"],
    // In streaming mode maxTurns counts cumulatively over the whole session
    // run — any default here would kill a long-lived lane. Callers opt in.
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    // Never inherit the launching session's agent settings (see sdkEnv).
    env: sdkEnv(),
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
            console: input.mcpServer as never,
          },
        }),
  };
  return options;
}
