import os from "node:os";
import path from "node:path";

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
   * Orchestrator-lane model (also the profile-manager lane and the lane's
   * rotation checkpoint). Seats carry their own profile models; they never
   * read this. CONSOLE_MODEL overrides.
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
    model: env.CONSOLE_MODEL ?? "claude-sonnet-5",
    improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
    effort: env.CONSOLE_EFFORT,
    profilesFile:
      env.CONSOLE_PROFILES_FILE ?? path.join(dataDir, "profiles.json"),
    seatIdleReapMs: Number(env.CONSOLE_SEAT_IDLE_REAP_MS ?? 300_000),
    seatMaxResident: Number(env.CONSOLE_MAX_RESIDENT_SEATS ?? 8),
    seatMaxResidentPerSession: Number(env.CONSOLE_MAX_RESIDENT_SEATS_PER_SESSION ?? 4),
    sendWakeTimeoutMs: Number(env.CONSOLE_SEND_WAKE_TIMEOUT_MS ?? 30_000),
    deliveryHoldLeaseMs: Number(env.CONSOLE_DELIVERY_HOLD_LEASE_MS ?? 60_000),
    peerNamePrefix: env.CONSOLE_PEER_NAME_PREFIX ?? "console-",
    contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
    contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
    seatWorktrees: env.CONSOLE_SEAT_WORKTREES !== "0",
    allowedDomains: env.CONSOLE_ALLOWED_DOMAINS === undefined
      ? DEFAULT_ALLOWED_DOMAINS
      : env.CONSOLE_ALLOWED_DOMAINS.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
  };
}
