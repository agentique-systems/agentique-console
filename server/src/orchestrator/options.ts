/**
 * Assembles SDK Options for one orchestrator turn. Main sees the workspace
 * exactly as an interactive Claude Code session would — CLAUDE.md, user and
 * project settings, skills — and adds the console MCP tools on top; every
 * messaging/task/scheduling path stays console-owned and journaled. Only the
 * composer-rewrite queries are hermetic.
 */
import type { SessionMode, SessionPhase } from "@agentique-console/shared";
import type { EffortLevel } from "../sdk/effort.ts";
import { sdkEnv } from "../sdk/env.ts";
import { WORKSPACE_TOOLS, mainDisallowedNativeTools } from "../sdk/native-capability-policy.ts";
import type { SdkOptions } from "../sdk/types.ts";
import { MAIN_TOOL_NAMES } from "./grants.ts";
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

/**
 * Main's work tools are the full workspace set, by operator directive: two
 * live runs wedged on one-command git blockers (a stray uncommitted edit; a
 * leaked seat branch) that main had diagnosed exactly and could not fix —
 * one ended in the operator running git by hand, the other in a blocking
 * question whose own recommendation read "it is one safe command". Write and
 * Edit followed Bash for the same reason: an operator deliverable or a
 * one-line unblock is not worth a commissioned session. The charter bounds
 * usage (unblock, verify, small fixes, deliverables — never a seat's
 * implementation work); every call is journaled as a tool event.
 *
 * Everything else classified by the capability policy is either denied by
 * name (`mainDisallowedNativeTools` — coordination, task state, scheduling,
 * host surfaces, plan-mode entry, and the background waits that would wake a
 * console-owned lane with no mailbox row) or deliberately left in the
 * MIDDLE: AskUserQuestion and ExitPlanMode are neither auto-approved nor
 * denied, so they reach `canUseTool`, which turns them into operator cards.
 */

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
  /** Exact operator-authored project objective, bounded for prompt delivery. */
  objectiveDigest?: string;
  /**
   * The operator's decisions, appended after the inherited memory. Main
   * must not contradict a call the operator already made, and must not relay
   * one — every agent has it already.
   */
  decisionDigest?: string;
  /** The governing requirements digest, injected AFTER decisions (both authoritative). */
  specDigest?: string;
  /** Latest project-relative frontier judgment, below current requirements. */
  objectiveAssessmentDigest?: string;
  /** Main's own working state — the durable memory of the orchestration loop. */
  stateDigest?: string;
  /**
   * The prior run's continuation checkpoint on a continued project — advisory
   * operational context, injected AFTER the authoritative digests so its
   * placement mirrors its authority. Empty on a fresh project.
   */
  continuationDigest?: string;
  /** "away" injects one line: prefer proceeding on recommendations. */
  autonomy?: "standard" | "away";
  /** The lane's registry address (CLAUDE_CODE_SESSION_NAME). */
  peerName?: string;
  /**
   * The console's skills plugin (config.infra.skillsPluginDir). Main holds
   * the same skills every seat holds — git-gud for repo surgery above all —
   * on top of whatever the settings sources discover. Optional so hermetic
   * callers (tests, tooling) can omit it.
   */
  skillsPluginDir?: string;
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
        ? ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF + (input.contextMemory ? `\n\n## Inherited memory (from an earlier generation, read-only)\n${input.contextMemory}` : "")
        : ORCHESTRATOR_BRIEF + (input.contextMemory ? `\n\n## Inherited memory (from an earlier generation, read-only)\n${input.contextMemory}` : ""))
        + (input.objectiveDigest ? `\n\n${input.objectiveDigest}` : "")
        + (input.decisionDigest ? `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not relay them to seats — they already have them.\n${input.decisionDigest}` : "")
        + (input.specDigest ? `\n\n${input.specDigest}` : "")
        + (input.objectiveAssessmentDigest ? `\n\n${input.objectiveAssessmentDigest}` : "")
        + (input.stateDigest ? `\n\n${input.stateDigest}` : "")
        + (input.continuationDigest ? `\n\n${input.continuationDigest}` : "")
        + (input.autonomy === "away" ? "\n\nThe operator is AWAY: prefer proceeding on recommendations and provisional decisions; queue only irreversible choices for their return." : ""),
    },
    // CLI parity: without "project" the CLI never loads CLAUDE.md, and the
    // agent re-derives per session what the operator wrote down once.
    settingSources: ["user", "project", "local"],
    // Every discovered skill is visible, like the CLI and like every seat;
    // the console plugin rides alongside the user/project skills.
    ...(input.skillsPluginDir === undefined ? {} : { plugins: [{ type: "local" as const, path: input.skillsPluginDir }] }),
    skills: "all",
    includePartialMessages: true,
    permissionMode: planning ? "plan" : "default",
    ...(planning ? { planModeInstructions: PLAN_MODE_BODY } : {}),
    allowedTools: [
      ...WORKSPACE_TOOLS,
      ...(withDelegation ? MAIN_TOOL_NAMES.map((name) => `mcp__console__${name}`) : []),
    ],
    disallowedTools: mainDisallowedNativeTools(),
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
