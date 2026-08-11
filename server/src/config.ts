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
   * Browse roots for the workspace directory picker, and the containment
   * allow-list for workspace creation. Defaults to the whole filesystem with
   * home as a shortcut; narrow it with CONSOLE_FS_ROOTS (colon-separated).
   */
  fsRoots: { path: string; label: string }[];
  /**
   * Default orchestrator-lane model (also the profile-manager lane and the
   * lane's rotation checkpoint). A session that records its own `model` wins
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
   * Hosts sandboxed commands may reach, workspace-wide. Profiles narrow this
   * or opt out entirely. Nothing here is a security boundary on its own — the
   * filesystem scope is — it exists so a coding agent can install and fetch
   * what the work actually needs. CONSOLE_ALLOWED_DOMAINS overrides
   * (comma-separated; empty string means fully offline).
   */
  allowedDomains: string[];
  /**
   * `git init` a non-repo workspace so agent isolation can engage. Off makes
   * the Console leave operator directories alone at the cost of running every
   * agent in one shared tree.
   */
  autoInitGit: boolean;
}

/** How the console orchestrates: budgets, timers, caps, protocol knobs. */
export interface PolicyConfig {
  /** Close an idle agent's process (socket included) after this long; resume-on-wake. */
  agentIdleReapMs: number;
  /** Max resident agent processes machine-wide. */
  agentMaxResident: number;
  /**
   * Resident agent processes per session TREE (a parent and its children share
   * this budget). Defaults to the per-session cap, so childless sessions are
   * unchanged and a parent that spawns children shares its slots rather than
   * multiplying its footprint.
   */
  agentMaxResidentPerTree: number;
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
  /** Identical consecutive tool calls before the watchdog kills an agent's turn. */
  watchdogIdenticalCalls: number;
  /** Consecutive tool errors before the watchdog kills an agent's turn. */
  watchdogErrorStreak: number;
  /** Failed-turn redeliveries per delivery row before the console gives up. */
  maxRedeliveryAttempts: number;
  /** Governance sweep period: stale-ask detach + pattern stall checks. */
  governanceSweepIntervalMs: number;
  /** Rotation blocks every sender to the agent; a checkpoint may not run forever. */
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
  /** Agent-authored handoffs per session before the console asks for a close-out. */
  patternHandoffCap: number;
  /** Quiet-time stall: unreported session with no hop for this long trips. 0 = off. */
  patternStallMs: number;
  /** Kill switch for nesting: gates only the create_child_session grant. */
  enableChildSessions: boolean;
  /** Open child sessions one parent may have at a time. */
  maxChildSessionsPerParent: number;
}

export interface Config {
  infra: InfraConfig;
  policy: PolicyConfig;
}

/**
 * Package registries and the CDNs their docs point at. Deliberately not
 * "everything": egress stays enumerable, and an operator who needs more sets
 * CONSOLE_ALLOWED_DOMAINS. The db-live-1 run failed its own brief because this
 * list was effectively empty and nothing said so.
 */
const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org", "*.npmjs.org",
  "pypi.org", "*.pythonhosted.org",
  "crates.io", "*.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "github.com", "*.githubusercontent.com", "codeload.github.com",
  "unpkg.com", "cdn.jsdelivr.net", "esm.sh", "cdnjs.cloudflare.com",
];

/**
 * Env names retired by THE RENAME. A retired name that is still set fails the
 * boot loudly: the alternative is the knob silently falling back to its
 * default, which is indistinguishable from working until it matters.
 */
const RETIRED_ENV_NAMES: Record<string, string> = {
  CONSOLE_SEAT_IDLE_REAP_MS: "CONSOLE_AGENT_IDLE_REAP_MS",
  CONSOLE_MAX_RESIDENT_SEATS: "CONSOLE_MAX_RESIDENT_AGENTS",
  CONSOLE_MAX_RESIDENT_SEATS_PER_TREE: "CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE",
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
 * typo'd id used to be accepted at boot and silently dropped every session's
 * rotation ceiling to the conservative 68K default.
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
      fsRoots: parseRoots(env.CONSOLE_FS_ROOTS, home),
      model: validatedModel(env.CONSOLE_MODEL),
      improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
      effort: env.CONSOLE_EFFORT,
      allowedDomains: env.CONSOLE_ALLOWED_DOMAINS === undefined
        ? DEFAULT_ALLOWED_DOMAINS
        : env.CONSOLE_ALLOWED_DOMAINS.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
      autoInitGit: env.CONSOLE_AUTO_INIT_GIT !== "0",
    },
    policy: {
      agentIdleReapMs: Number(env.CONSOLE_AGENT_IDLE_REAP_MS ?? 300_000),
      agentMaxResident: Number(env.CONSOLE_MAX_RESIDENT_AGENTS ?? 8),
      agentMaxResidentPerTree: Number(env.CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE ?? 4),
      agentSpawnTimeoutMs: Number(env.CONSOLE_AGENT_SPAWN_TIMEOUT_MS ?? 30_000),
      agentWorktrees: env.CONSOLE_AGENT_WORKTREES !== "0",
      operatorAskDetachMs: Number(env.CONSOLE_OPERATOR_ASK_DETACH_MS ?? 300_000),
      peerNamePrefix: env.CONSOLE_PEER_NAME_PREFIX ?? "console-",
      watchdogIdenticalCalls: Number(env.CONSOLE_WATCHDOG_IDENTICAL_CALLS ?? 5),
      watchdogErrorStreak: Number(env.CONSOLE_WATCHDOG_ERROR_STREAK ?? 10),
      maxRedeliveryAttempts: Number(env.CONSOLE_MAX_REDELIVERY_ATTEMPTS ?? 2),
      governanceSweepIntervalMs: Number(env.CONSOLE_GOVERNANCE_SWEEP_MS ?? 30_000),
      checkpointTimeoutMs: Number(env.CONSOLE_CHECKPOINT_TIMEOUT_MS ?? 90_000),
      completionQuietWindowMs: Number(env.CONSOLE_COMPLETION_QUIET_MS ?? 2_000),
      contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
      contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
      patternHandoffCap: Number(env.CONSOLE_PATTERN_HANDOFF_CAP ?? 40),
      patternStallMs: Number(env.CONSOLE_PATTERN_STALL_MS ?? 600_000),
      enableChildSessions: env.CONSOLE_CHILD_SESSIONS !== "0",
      maxChildSessionsPerParent: Number(env.CONSOLE_MAX_CHILD_SESSIONS ?? 3),
    },
  };
}
