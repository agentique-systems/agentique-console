import os from "node:os";
import path from "node:path";

export interface Config {
  dataDir: string;
  dbFile: string;
  port: number;
  host: string;
  /** Browse roots for the workspace directory picker. */
  fsRoots: { path: string; label: string }[];
  /** Model override for every session; undefined = SDK default. */
  model: string | undefined;
  hopLimit: number;
  /** Max concurrent specialist turns per agent session. */
  perSessionTurnCap: number;
  /** Max concurrent specialist turns across the whole process. */
  globalTurnCap: number;
  /** Run against the in-process fake SDK (credential-free). */
  fakeSdk: boolean;
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
    fsRoots: [{ path: home, label: "Home" }],
    model: env.CONSOLE_MODEL,
    hopLimit: Number(env.CONSOLE_HOP_LIMIT ?? 12),
    perSessionTurnCap: 3,
    globalTurnCap: 6,
    fakeSdk: env.CONSOLE_FAKE_SDK === "1",
  };
}
