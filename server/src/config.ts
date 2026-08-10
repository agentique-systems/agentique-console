import os from "node:os";
import path from "node:path";

import { DEFAULT_ORCHESTRATOR_MODEL } from "@agentique-console/shared";

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
  /** Optional operator-owned profile overrides. Built-ins remain immutable. */
  profilesFile: string;
  /**
   * Peer-mesh knobs. Seats are persistent, name-addressed SDK sessions; these
   * bound resident CLI processes and the delivery/wake protocol around them.
   */
  /** Close an idle seat's process (socket included) after this long; resume-on-wake. */
  seatIdleReapMs: number;
  /** Max resident seat processes machine-wide / per agent session. */
  seatMaxResident: number;
  seatMaxResidentPerSession: number;
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
  /**
   * Wall-clock budget for provider retries within one turn. Past it the Console
   * interrupts the turn deliberately instead of waiting out a schedule that has
   * stopped growing.
   */
  retryBudgetMs: number;
  /**
   * Deny a seat's Write/Edit outside its declared ownership. Opt-in for one
   * release: it can block a seat mid-work, and the roster's live work-state
   * already removes most of the reason a seat strays.
   */
  enforceOwnership: boolean;
  /**
   * Hold an assignment whose blocker task is incomplete, releasing it when the
   * blocker completes. The grace below stops a mis-declared dependency
   * deadlocking a run.
   */
  assignmentBlockGraceMs: number;
  /**
   * Persist reasoning blocks as artifacts. Off by default: it is more of data
   * the console already stores in tool inputs, but it is still more.
   */
  persistReasoning: boolean;
  /** How long a SendMessage waits for its recipient to spawn or unpark. */
  sendWakeTimeoutMs: number;
  /** Lease on a delivery hold (recipient pinned live) before it self-releases. */
  deliveryHoldLeaseMs: number;
  /** Registry namespace for console session names ("console-scout-8fbb2c"). */
  peerNamePrefix: string;
  /** Rotate a participant onto a fresh provider session before the next turn. */
  contextTokenLimit: number;
  contextTurnLimit: number;
  /**
   * Write-profile seats in git workspaces work in isolated worktrees with
   * atomic merge-on-completion. CONSOLE_SEAT_WORKTREES=0 disables.
   */
  seatWorktrees: boolean;
  /**
   * Pattern-level TerminationPolicy ceilings, applied when a session's
   * contract does not set its own bound. 0 disables a ceiling.
   */
  /** Agent-authored handoffs per session before the console asks for a close-out. */
  patternHandoffCap: number;
  /** Settled turns in a row without a handoff before the stall trip. */
  patternStallTurns: number;
  /** Session wall-clock bound in ms; 0 = off. */
  patternWallClockMs: number;
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
    model: env.CONSOLE_MODEL ?? DEFAULT_ORCHESTRATOR_MODEL,
    improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
    effort: env.CONSOLE_EFFORT,
    profilesFile:
      env.CONSOLE_PROFILES_FILE ?? path.join(dataDir, "profiles.json"),
    seatIdleReapMs: Number(env.CONSOLE_SEAT_IDLE_REAP_MS ?? 300_000),
    seatMaxResident: Number(env.CONSOLE_MAX_RESIDENT_SEATS ?? 8),
    seatMaxResidentPerSession: Number(env.CONSOLE_MAX_RESIDENT_SEATS_PER_SESSION ?? 4),
    operatorAskDetachMs: Number(env.CONSOLE_OPERATOR_ASK_DETACH_MS ?? 300_000),
    autoInitGit: env.CONSOLE_AUTO_INIT_GIT !== "0",
    retryBudgetMs: Number(env.CONSOLE_RETRY_BUDGET_MS ?? 90_000),
    enforceOwnership: env.CONSOLE_ENFORCE_OWNERSHIP === "1",
    assignmentBlockGraceMs: Number(env.CONSOLE_ASSIGNMENT_BLOCK_GRACE_MS ?? 600_000),
    persistReasoning: env.CONSOLE_PERSIST_REASONING === "1",
    sendWakeTimeoutMs: Number(env.CONSOLE_SEND_WAKE_TIMEOUT_MS ?? 30_000),
    deliveryHoldLeaseMs: Number(env.CONSOLE_DELIVERY_HOLD_LEASE_MS ?? 60_000),
    peerNamePrefix: env.CONSOLE_PEER_NAME_PREFIX ?? "console-",
    contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
    contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
    seatWorktrees: env.CONSOLE_SEAT_WORKTREES !== "0",
    patternHandoffCap: Number(env.CONSOLE_PATTERN_HANDOFF_CAP ?? 40),
    patternStallTurns: Number(env.CONSOLE_PATTERN_STALL_TURNS ?? 8),
    patternWallClockMs: Number(env.CONSOLE_PATTERN_WALL_CLOCK_MS ?? 0),
    enableChildSessions: env.CONSOLE_CHILD_SESSIONS !== "0",
    maxChildSessionsPerParent: Number(env.CONSOLE_MAX_CHILD_SESSIONS ?? 3),
    seatMaxResidentPerTree: Number(env.CONSOLE_MAX_RESIDENT_SEATS_PER_TREE ?? env.CONSOLE_MAX_RESIDENT_SEATS_PER_SESSION ?? 4),
    allowedDomains: env.CONSOLE_ALLOWED_DOMAINS === undefined
      ? DEFAULT_ALLOWED_DOMAINS
      : env.CONSOLE_ALLOWED_DOMAINS.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
  };
}
