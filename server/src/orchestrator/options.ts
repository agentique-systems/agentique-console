/**
 * Assembles SDK Options for one orchestrator turn. Hermetic by construction:
 * settingSources [] keeps filesystem CLAUDE.md/hooks/skills out; the tool
 * surface is read-only plus task tools plus the console MCP tools; Write/Edit/
 * Bash are delegation-first denials (D4).
 */
import type { SessionMode, SessionPhase } from "@agentique-console/shared";
import type { SdkOptions } from "../sdk/types.ts";
import {
  ORCHESTRATOR_BRIEF,
  ORCHESTRATOR_DELEGATION_BRIEF,
  PLAN_MODE_BODY,
} from "./prompt.ts";

export const CONSOLE_TOOL_NAMES = [
  "create_agent_session",
  "send_to_agent_session",
  "read_agent_session",
  "list_agent_sessions",
  "approve_agent_plan",
] as const;

export interface OrchestratorOptionsInput {
  workspaceRoot: string;
  resume: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  model: string | undefined;
  maxTurns?: number;
  abortController: AbortController;
  canUseTool: NonNullable<SdkOptions["canUseTool"]>;
  hooks?: SdkOptions["hooks"];
  sessionStore: unknown;
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
        ? CONSOLE_TOOL_NAMES.map((name) => `mcp__console__${name}`)
        : []),
    ],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
    maxTurns: input.maxTurns ?? 80,
    canUseTool: input.canUseTool,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.resume === null ? {} : { resume: input.resume }),
    persistSession: true,
    sessionStore: input.sessionStore as SdkOptions["sessionStore"],
    sessionStoreFlush: "eager",
    abortController: input.abortController,
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
