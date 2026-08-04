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
  /** Model override for every session; undefined = SDK default. */
  model: string | undefined;
  /**
   * Model for the composer's rewrite pass. Deliberately NOT `model`: this is a
   * one-shot text edit, so it runs on a cheaper tier than the orchestrator.
   */
  improveModel: string;
  /** Reasoning effort for every session; undefined = SDK default. */
  effort: string | undefined;
  /** Optional operator-owned profile overrides. Built-ins remain immutable. */
  profilesFile: string;
  /** Hard scheduler caps; queued work is durable and resumes when capacity frees. */
  globalAgentTurns: number;
  perAgentSessionTurns: number;
  /** Rotate a participant onto a fresh provider session before the next turn. */
  contextTokenLimit: number;
  contextTurnLimit: number;
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
    model: env.CONSOLE_MODEL,
    improveModel: env.CONSOLE_IMPROVE_MODEL ?? "claude-sonnet-5",
    effort: env.CONSOLE_EFFORT,
    profilesFile:
      env.CONSOLE_PROFILES_FILE ?? path.join(dataDir, "profiles.json"),
    globalAgentTurns: Number(env.CONSOLE_GLOBAL_AGENT_TURNS ?? 4),
    perAgentSessionTurns: Number(env.CONSOLE_PER_SESSION_AGENT_TURNS ?? 2),
    contextTokenLimit: Number(env.CONSOLE_CONTEXT_TOKEN_LIMIT ?? 120_000),
    contextTurnLimit: Number(env.CONSOLE_CONTEXT_TURN_LIMIT ?? 30),
  };
}
