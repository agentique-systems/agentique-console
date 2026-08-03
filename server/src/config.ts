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
  /** Reasoning effort for every session; undefined = SDK default. */
  effort: string | undefined;
  hopLimit: number;
  /** Max concurrent specialist turns per agent session. */
  perSessionTurnCap: number;
  /** Max concurrent specialist turns across the whole process. */
  globalTurnCap: number;
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
    effort: env.CONSOLE_EFFORT,
    hopLimit: Number(env.CONSOLE_HOP_LIMIT ?? 12),
    perSessionTurnCap: 3,
    globalTurnCap: 6,
  };
}
