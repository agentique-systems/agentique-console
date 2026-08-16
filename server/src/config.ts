import os from "node:os";
import path from "node:path";

import { DEFAULT_ORCHESTRATOR_MODEL, isOrchestratorModel } from "@agentique-console/shared";

/** Where the console runs: paths, network, models, filesystem reach. */
export interface InfraConfig {
  dataDir: string;
  dbFile: string;
  port: number;
  host: string;
  /** The built web bundle; served at / when present (absent in vite dev). */
  webDir: string;
  /**
   * The console's own skills plugin (server/skills). Shipped with the
   * server, trusted like builtin profiles; loaded into every seat, where the
   * SDK's `skills` filter decides what each seat actually sees.
   */
  skillsPluginDir: string;
  /**
   * Browse roots for the workspace directory picker, and the containment
   * allow-list for workspace creation. Defaults to the whole filesystem with
   * home as a shortcut; narrow it with CONSOLE_FS_ROOTS (colon-separated).
   */
  fsRoots: { path: string; label: string }[];
  /**
   * Default orchestrator-lane model (also the lane's rotation checkpoint). A session that records its own `model` wins
   * over this; sessions created internally record none and land here. Agents
   * carry their own profile models; they never read this. CONSOLE_MODEL
   * overrides the default for new sessions.
   */
  model: string;
  /**
   * Model for the composer's rewrite pass. Deliberately NOT `model`: this is a
   * one-shot text edit, so it runs on a cheaper tier than the orchestrator.
   */
  improveModel: string;
  /** Reasoning effort for every session; undefined = SDK default. */
  effort: string | undefined;
  /**
   * `git init` a non-repo workspace so agent isolation can engage. Off makes
   * the Console leave operator directories alone at the cost of running every
   * agent in one shared tree.
   */
  autoInitGit: boolean;
  /**
   * MCP servers to drop from every profile that declares them, by name.
   * CONSOLE_MCP_DISABLED (comma-separated). Capability is declared per profile
   * and launched by the Console; this is the operator's off switch.
   */
  mcpDisabled: string[];
  /**
   * Replaces the `browser` server's command for every profile that declares
   * one, as `[command, ...args]`. CONSOLE_BROWSER_MCP, whitespace-separated.
   * Undefined leaves each profile's own declaration alone.
   */
  browserMcp: string[] | undefined;
}

/** How the console orchestrates: budgets, timers, caps, protocol knobs. */
export interface PolicyConfig {
  /** Close an idle agent's process (socket included) after this long; resume-on-wake. */
  agentIdleReapMs: number;
  /** Max resident agent processes machine-wide. */
  agentMaxResident: number;
  /**
   * Resident agent processes per SESSION. Deliberately not per tree: a child
   * session brings its own residency (under the global cap), so nesting adds
   * parallel capacity — the old shared-tree budget was one of five structural
   * reasons a 12-hour live run created zero child sessions.
   */
  agentMaxResidentPerSession: number;
  /** How long a delivery waits for its recipient agent to spawn or unpark. */
  agentSpawnTimeoutMs: number;
  /**
   * Write-profile agents in git workspaces work in isolated worktrees with
   * atomic merge-on-completion. CONSOLE_AGENT_WORKTREES=0 disables.
   */
  agentWorktrees: boolean;
  /**
   * How long an agent may sit parked inside `ask_operator` before the Console
   * detaches the wait. The question stays open and answerable; only the held
   * process is released, so a worst case is an agent idle for this long rather
   * than one pinned until a human happens to return.
   */
  operatorAskDetachMs: number;
  /** Registry namespace for console session names ("console-scout-8fbb2c"). */
  peerNamePrefix: string;
  /**
   * Hard wall-clock cap per MCP tool call on the DECLARED capability servers
   * (browser, database, …). Applied per-server via the SDK's `timeout` field —
   * never as the blanket MCP_TOOL_TIMEOUT env, which would also bound the
   * console's own server, where `ask_operator` legitimately parks for up to
   * operatorAskDetachMs. A timed-out call returns an error result the agent
   * can adapt to (and the error-streak watchdog bounds the retries). 0 = off.
   */
  mcpToolTimeoutMs: number;
  /**
   * Liveness alarm: an in-flight tool call older than this wakes MAIN with a
   * console-authored failure handoff carrying the call's name, preview and
   * age. Deliberately ABOVE the mechanical mcpToolTimeoutMs floor: declared
   * MCP calls fail mechanically first, so the alarm covers only floor-less
   * calls (foreground Bash, native tools). It was once below the floor "so
   * main can act with judgment first" — a live run showed what that buys:
   * 20 of 21 alarms fired on healthy cargo builds (which routinely run 5–9
   * minutes) and main killed them. 0 = off.
   */
  toolCallAlarmMs: number;
  /** Liveness alarm: a live turn with no stream event for this long. 0 = off. */
  turnQuietAlarmMs: number;
  /** Identical consecutive tool calls before the watchdog kills an agent's turn. */
  watchdogIdenticalCalls: number;
  /** Consecutive tool errors before the watchdog kills an agent's turn. */
  watchdogErrorStreak: number;
  /** Failed-turn redeliveries per delivery row before the console gives up. */
  maxRedeliveryAttempts: number;
  /** Governance sweep period: stale-ask detach + pattern stall checks. */
  governanceSweepIntervalMs: number;
  /**
   * A pending DEFERRED ask with a recommendation auto-resolves to that
   * recommendation after this long, as a provisional (operator-overridable)
   * decision. "Deferred" means "you can keep going" — a live run held 5h23m
   * behind four deferred asks because nothing enforced that. 0 = off.
   */
  deferredAutoProceedMs: number;
  /**
   * A pending BLOCKING ask older than this escalates once (main is woken to
   * re-route work); in "away" autonomy a blocking ask WITH a recommendation
   * auto-proceeds instead. 0 = off.
   */
  blockingAskEscalateMs: number;
  /**
   * Rotation blocks every sender to the agent; a checkpoint may not run
   * forever. Sized for a checkpoint over a ~120k-token context, which
   * routinely needs minutes: a live run whose cap was 90s aborted 31 of 35
   * seat checkpoints mid-query and paid ~$62 re-deriving what they knew.
   */
  checkpointTimeoutMs: number;
  /**
   * Debounce before the run-completion predicate re-evaluates. Long enough
   * that a settle followed 1ms later by the next turn is a non-event, short
   * enough that the operator does not notice it.
   */
  completionQuietWindowMs: number;
  /** Rotate a lane onto a fresh provider session before the next turn. */
  contextTokenLimit: number;
  contextTurnLimit: number;
  /**
   * Agent-authored handoffs per session before the console asks MAIN to
   * re-brief (which resets the budgets) or close. Sized for a real multi-seat
   * session: 40 counted every assignment, update, and report, and three
   * healthy sessions in one live run died at 40/40 mid-productive-work.
   * 0 = off.
   */
  patternHandoffCap: number;
  /** Quiet-time stall: unreported session with no hop for this long trips. 0 = off. */
  patternStallMs: number;
  /** Kill switch for nesting: gates only the create_child_session grant. */
  enableChildSessions: boolean;
  /** Open child sessions one parent may have at a time. */
  maxChildSessionsPerParent: number;
  /**
   * Maximum session-tree depth (0 = top-level). Controllers in sessions with
   * depth < cap receive create_child_session; the cap IS the granting. The
   * resident-process budgets still bound machine load whatever the shape.
   */
  maxSessionDepth: number;
}

export interface Config {
  infra: InfraConfig;
  policy: PolicyConfig;
}

/**
 * Env names retired by THE RENAME. A retired name that is still set fails the
 * boot loudly: the alternative is the knob silently falling back to its
 * default, which is indistinguishable from working until it matters.
 */
const RETIRED_ENV_NAMES: Record<string, string> = {
  CONSOLE_SEAT_IDLE_REAP_MS: "CONSOLE_AGENT_IDLE_REAP_MS",
  CONSOLE_MAX_RESIDENT_SEATS: "CONSOLE_MAX_RESIDENT_AGENTS",
  CONSOLE_MAX_RESIDENT_SEATS_PER_TREE: "CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION",
  CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE: "CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION",
  CONSOLE_SEAT_SPAWN_TIMEOUT_MS: "CONSOLE_AGENT_SPAWN_TIMEOUT_MS",
  CONSOLE_SEAT_WORKTREES: "CONSOLE_AGENT_WORKTREES",
};

function rejectRetiredEnvNames(env: NodeJS.ProcessEnv): void {
  const found = Object.keys(RETIRED_ENV_NAMES).filter((name) => env[name] !== undefined);
  if (found.length === 0) return;
  throw new Error(
    "retired environment variable name(s) set: " +
      found.map((name) => `${name} (use ${RETIRED_ENV_NAMES[name]})`).join(", "),
  );
}

function parseRoots(
  configured: string | undefined,
  home: string,
): { path: string; label: string }[] {
  if (configured !== undefined && configured.trim() !== "") {
    return configured
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => ({ path: entry, label: entry }));
  }
  // Home first so the picker opens somewhere useful; "/" makes the whole
  // filesystem reachable, since a workspace may live anywhere on this machine.
  return [
    { path: home, label: "Home" },
    { path: "/", label: "Filesystem" },
  ];
}

/**
 * CONSOLE_MODEL goes through the same validation the API route enforces: a
 * typo'd id must fail at boot, not silently drop every session's rotation
 * ceiling to the conservative default.
 */
function validatedModel(id: string | undefined): string {
  if (id === undefined) return DEFAULT_ORCHESTRATOR_MODEL;
  if (!isOrchestratorModel(id)) {
    throw new Error(`CONSOLE_MODEL "${id}" is not an orchestrator model (expected one of the ids in shared/models.ts)`);
  }
  return id;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  rejectRetiredEnvNames(env);
  const dataDir =
    env.CONSOLE_DATA_DIR ?? path.join(os.homedir(), ".agentique-console");
  const home = os.homedir();
  return {
    infra: {
      dataDir,
      dbFile: path.join(dataDir, "console.db"),
      port: Number(env.CONSOLE_PORT ?? 4400),
      host: env.CONSOLE_HOST ?? "127.0.0.1",
      webDir: path.resolve(import.meta.dirname, "../../web/dist"),
      skillsPluginDir: env.CONSOLE_SKILLS_DIR ?? path.resolve(import.meta.dirname, "../skills"),
      fsRoots: parseRoots(env.CONSOLE_FS_ROOTS, home),
      model: validatedModel(env.CONSOLE_MODEL),
      improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
      effort: env.CONSOLE_EFFORT,
      autoInitGit: env.CONSOLE_AUTO_INIT_GIT !== "0",
      mcpDisabled: (env.CONSOLE_MCP_DISABLED ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
      browserMcp: env.CONSOLE_BROWSER_MCP === undefined ? undefined
        : env.CONSOLE_BROWSER_MCP.split(/\s+/).filter((entry) => entry !== ""),
    },
    policy: {
      agentIdleReapMs: Number(env.CONSOLE_AGENT_IDLE_REAP_MS ?? 300_000),
      agentMaxResident: Number(env.CONSOLE_MAX_RESIDENT_AGENTS ?? 12),
      agentMaxResidentPerSession: Number(env.CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION ?? 4),
      agentSpawnTimeoutMs: Number(env.CONSOLE_AGENT_SPAWN_TIMEOUT_MS ?? 30_000),
      agentWorktrees: env.CONSOLE_AGENT_WORKTREES !== "0",
      operatorAskDetachMs: Number(env.CONSOLE_OPERATOR_ASK_DETACH_MS ?? 300_000),
      peerNamePrefix: env.CONSOLE_PEER_NAME_PREFIX ?? "console-",
      mcpToolTimeoutMs: Number(env.CONSOLE_MCP_TOOL_TIMEOUT_MS ?? 300_000),
      toolCallAlarmMs: Number(env.CONSOLE_TOOL_ALARM_MS ?? 600_000),
      turnQuietAlarmMs: Number(env.CONSOLE_TURN_QUIET_ALARM_MS ?? 300_000),
      watchdogIdenticalCalls: Number(env.CONSOLE_WATCHDOG_IDENTICAL_CALLS ?? 5),
      watchdogErrorStreak: Number(env.CONSOLE_WATCHDOG_ERROR_STREAK ?? 10),
      maxRedeliveryAttempts: Number(env.CONSOLE_MAX_REDELIVERY_ATTEMPTS ?? 2),
      governanceSweepIntervalMs: Number(env.CONSOLE_GOVERNANCE_SWEEP_MS ?? 30_000),
      deferredAutoProceedMs: Number(env.CONSOLE_DEFERRED_AUTO_PROCEED_MS ?? 900_000),
      blockingAskEscalateMs: Number(env.CONSOLE_BLOCKING_ASK_ESCALATE_MS ?? 900_000),
      checkpointTimeoutMs: Number(env.CONSOLE_CHECKPOINT_TIMEOUT_MS ?? 300_000),
      completionQuietWindowMs: Number(env.CONSOLE_COMPLETION_QUIET_MS ?? 2_000),
      contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
      contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
      patternHandoffCap: Number(env.CONSOLE_PATTERN_HANDOFF_CAP ?? 120),
      patternStallMs: Number(env.CONSOLE_PATTERN_STALL_MS ?? 600_000),
      enableChildSessions: env.CONSOLE_CHILD_SESSIONS !== "0",
      maxChildSessionsPerParent: Number(env.CONSOLE_MAX_CHILD_SESSIONS ?? 5),
      maxSessionDepth: Number(env.CONSOLE_MAX_SESSION_DEPTH ?? 2),
    },
  };
}
