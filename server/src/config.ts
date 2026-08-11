import os from "node:os";
import path from "node:path";

import { DEFAULT_ORCHESTRATOR_MODEL, isOrchestratorModel } from "@agentique-console/shared";

export interface Config {
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
   * over this; sessions created internally record none and land here. Seats
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
   * Peer-mesh knobs. Seats are persistent, name-addressed SDK sessions; these
   * bound resident CLI processes and the delivery/wake protocol around them.
   */
  /** Close an idle seat's process (socket included) after this long; resume-on-wake. */
  seatIdleReapMs: number;
  /** Max resident seat processes machine-wide / per agent session. */
  seatMaxResident: number;
  /**
   * How long a seat may sit parked inside `ask_operator` before the Console
   * detaches the wait. The question stays open and answerable; only the held
   * process is released, so a worst case is a seat idle for this long rather
   * than one pinned until a human happens to return.
   */
  operatorAskDetachMs: number;
  /**
   * `git init` a non-repo workspace so seat isolation can engage. Off makes the
   * Console leave operator directories alone at the cost of running every seat
   * in one shared tree.
   */
  autoInitGit: boolean;
  /** How long a delivery waits for its recipient seat to spawn or unpark. */
  seatSpawnTimeoutMs: number;
  /** Registry namespace for console session names ("console-scout-8fbb2c"). */
  peerNamePrefix: string;
  /** Identical consecutive tool calls before the watchdog kills a seat's turn. */
  watchdogIdenticalCalls: number;
  /** Consecutive tool errors before the watchdog kills a seat's turn. */
  watchdogErrorStreak: number;
  /** Failed-turn redeliveries per delivery row before the console gives up. */
  maxRedeliveryAttempts: number;
  /** Governance sweep period: stale-ask detach + pattern stall checks. */
  governanceSweepIntervalMs: number;
  /** Rotation blocks every sender to the seat; a checkpoint may not run forever. */
  checkpointTimeoutMs: number;
  /**
   * Debounce before the run-completion predicate re-evaluates. Long enough
   * that a settle followed 1ms later by the next turn is a non-event, short
   * enough that the operator does not notice it.
   */
  completionQuietWindowMs: number;
  /** Rotate a participant onto a fresh provider session before the next turn. */
  contextTokenLimit: number;
  contextTurnLimit: number;
  /**
   * Write-profile seats in git workspaces work in isolated worktrees with
   * atomic merge-on-completion. CONSOLE_SEAT_WORKTREES=0 disables.
   */
  seatWorktrees: boolean;
  /** Agent-authored handoffs per session before the console asks for a close-out. */
  patternHandoffCap: number;
  /** Quiet-time stall: unreported session with no hop for this long trips. 0 = off. */
  patternStallMs: number;
  /** Kill switch for nesting: gates only the create_child_session grant. */
  enableChildSessions: boolean;
  /** Open child sessions one parent may have at a time. */
  maxChildSessionsPerParent: number;
  /**
   * Resident seat processes per session TREE (a parent and its children share
   * this budget). Defaults to the per-session cap, so childless sessions are
   * unchanged and a parent that spawns children shares its slots rather than
   * multiplying its footprint.
   */
  seatMaxResidentPerTree: number;
  /**
   * Hosts sandboxed commands may reach, workspace-wide. Profiles narrow this
   * or opt out entirely. Nothing here is a security boundary on its own — the
   * filesystem scope is — it exists so a coding agent can install and fetch
   * what the work actually needs. CONSOLE_ALLOWED_DOMAINS overrides
   * (comma-separated; empty string means fully offline).
   */
  allowedDomains: string[];
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
  const dataDir =
    env.CONSOLE_DATA_DIR ?? path.join(os.homedir(), ".agentique-console");
  const home = os.homedir();
  return {
    dataDir,
    dbFile: path.join(dataDir, "console.db"),
    port: Number(env.CONSOLE_PORT ?? 4400),
    host: env.CONSOLE_HOST ?? "127.0.0.1",
    webDir: path.resolve(import.meta.dirname, "../../web/dist"),
    fsRoots: parseRoots(env.CONSOLE_FS_ROOTS, home),
    model: validatedModel(env.CONSOLE_MODEL),
    improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
    effort: env.CONSOLE_EFFORT,
    seatIdleReapMs: Number(env.CONSOLE_SEAT_IDLE_REAP_MS ?? 300_000),
    seatMaxResident: Number(env.CONSOLE_MAX_RESIDENT_SEATS ?? 8),
    operatorAskDetachMs: Number(env.CONSOLE_OPERATOR_ASK_DETACH_MS ?? 300_000),
    autoInitGit: env.CONSOLE_AUTO_INIT_GIT !== "0",
    seatSpawnTimeoutMs: Number(env.CONSOLE_SEAT_SPAWN_TIMEOUT_MS ?? 30_000),
    peerNamePrefix: env.CONSOLE_PEER_NAME_PREFIX ?? "console-",
    watchdogIdenticalCalls: Number(env.CONSOLE_WATCHDOG_IDENTICAL_CALLS ?? 5),
    watchdogErrorStreak: Number(env.CONSOLE_WATCHDOG_ERROR_STREAK ?? 10),
    maxRedeliveryAttempts: Number(env.CONSOLE_MAX_REDELIVERY_ATTEMPTS ?? 2),
    governanceSweepIntervalMs: Number(env.CONSOLE_GOVERNANCE_SWEEP_MS ?? 30_000),
    checkpointTimeoutMs: Number(env.CONSOLE_CHECKPOINT_TIMEOUT_MS ?? 90_000),
    completionQuietWindowMs: Number(env.CONSOLE_COMPLETION_QUIET_MS ?? 2_000),
    contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
    contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
    seatWorktrees: env.CONSOLE_SEAT_WORKTREES !== "0",
    patternHandoffCap: Number(env.CONSOLE_PATTERN_HANDOFF_CAP ?? 40),
    patternStallMs: Number(env.CONSOLE_PATTERN_STALL_MS ?? 600_000),
    enableChildSessions: env.CONSOLE_CHILD_SESSIONS !== "0",
    maxChildSessionsPerParent: Number(env.CONSOLE_MAX_CHILD_SESSIONS ?? 3),
    seatMaxResidentPerTree: Number(env.CONSOLE_MAX_RESIDENT_SEATS_PER_TREE ?? 4),
    allowedDomains: env.CONSOLE_ALLOWED_DOMAINS === undefined
      ? DEFAULT_ALLOWED_DOMAINS
      : env.CONSOLE_ALLOWED_DOMAINS.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
  };
}
