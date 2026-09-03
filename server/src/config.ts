/**
 * The console's configuration (legacy-removal §9): every value the process
 * runs with, read from `CONSOLE_*` environment variables, validated once at
 * startup with an error that names the variable, and never re-read. Unknown
 * `CONSOLE_*` names are ignored; nothing translates a retired name, and no
 * value selects an alternative behaviour.
 *
 *   CONSOLE_DATA_DIR                  state directory (database, blobs, continuations, Workspace state); ~/.agentique-console
 *   CONSOLE_PORT, CONSOLE_HOST        the HTTP listener; 4400 on 127.0.0.1
 *   CONSOLE_FS_ROOTS                  browse roots for Workspace creation, path-separator separated; home and the filesystem root
 *   CONSOLE_MODEL, CONSOLE_EFFORT     the model and effort of the built-in Agent Definitions
 *   CONSOLE_CONTINUATION              1/0: provider session resumption for retries (1)
 *   CONSOLE_CONTINUATION_TTL_MS       how long a continuation payload stays resumable; unset: unbounded
 *   CONSOLE_MCP_DISABLED              approved MCP servers dropped from the catalog, comma separated (names: browser); unknown names are refused
 *   CONSOLE_MCP_TOOL_TIMEOUT_MS       the bound on one MCP tool call of an Attempt (at least 1000); unset: the SDK's default
 *   CONSOLE_BROWSER_MCP               the `browser` MCP server command, whitespace separated
 *   CONSOLE_PROVIDER_MAX_CONCURRENCY  concurrent provider Attempts (4)
 *   CONSOLE_PROCESS_MAX_ATTEMPTS      concurrent Attempts in this process (6)
 *   CONSOLE_MAX_WORKTREES             concurrent Invocation worktrees; unset: unlimited
 *   CONSOLE_MAX_CONCURRENT_RUNS       Runs the host drives at once (4)
 *   CONSOLE_DEFAULT_MAX_COST_USD, CONSOLE_DEFAULT_MAX_TOKENS, CONSOLE_DEFAULT_MAX_ATTEMPTS,
 *   CONSOLE_DEFAULT_MAX_WALL_CLOCK_MS, CONSOLE_DEFAULT_MAX_CONCURRENCY      the default Run Budget
 *   CONSOLE_DEFAULT_COMPLETION_CHECK  the default deterministic completion command of a coding Run ("npm test"); "" for none
 *   CONSOLE_DEFAULT_EVALUATOR         reviewer|none: the default Gate Evaluator of a Run (reviewer)
 *   CONSOLE_ORCHESTRATOR_COST_USD, CONSOLE_ORCHESTRATOR_TOKENS, CONSOLE_ORCHESTRATOR_ATTEMPTS  the Orchestrator's allocation per turn
 *   CONSOLE_NODE_COST_USD, CONSOLE_NODE_TOKENS, CONSOLE_NODE_ATTEMPTS                          the default Plan Node allocation
 *   CONSOLE_ATTEMPT_MAX_WALL_CLOCK_MS the default Invocation wall-clock bound of the built-in definitions (600000)
 *   CONSOLE_CHECK_TIMEOUT_MS          the deterministic check command deadline (600000)
 *   CONSOLE_DIAGNOSTICS_RETAINED      diagnostics kept in memory for the health view (500)
 */
import os from "node:os";
import path from "node:path";
import { MODEL_EFFORTS, type Allocation, type BudgetLimits, type ModelEffort, type RunKind } from "@agentique-console/core";

export interface McpServerCommand {
  command: string;
  args: string[];
}

/** The approved MCP server names a `CONSOLE_MCP_DISABLED` entry may name. */
export const APPROVED_MCP_SERVERS = ["browser"] as const;

export interface Config {
  dataDir: string;
  databaseFile: string;
  blobRoot: string;
  continuationRoot: string;
  stateRoot: string;
  port: number;
  host: string;
  /** The built web bundle, served at `/` when present. */
  webDir: string;
  fsRoots: { path: string; label: string }[];
  provider: {
    model: string;
    effort: ModelEffort;
    continuation: boolean;
    continuationTtlMs: number | null;
    /** The approved MCP server catalog an Attempt may receive by capability name. */
    mcpServers: Record<string, McpServerCommand>;
    /** The wall-clock bound on one MCP tool call of an Attempt (the SDK's per-call limit), or `null` for the SDK's default. */
    mcpToolTimeoutMs: number | null;
  };
  governor: { providerMaxConcurrency: number; processMaxAttempts: number; maxWorktrees: number | null };
  driver: { maxConcurrentRuns: number; diagnosticsRetained: number };
  defaults: {
    runKind: RunKind;
    budget: BudgetLimits;
    orchestratorAllocation: Allocation;
    nodeAllocation: Allocation;
    maxWallClockMs: number;
    completionCheck: { command: string; expectedExitCode: number } | null;
    evaluator: "reviewer" | "none";
  };
  checks: { commandTimeoutMs: number; maxOutputBytes: number };
}

export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(`${variable}: ${message}`);
    this.name = "ConfigError";
  }
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(name, `expected an integer, got ${JSON.stringify(raw)}`);
  if (options.min !== undefined && value < options.min) throw new ConfigError(name, `expected at least ${options.min}, got ${value}`);
  if (options.max !== undefined && value > options.max) throw new ConfigError(name, `expected at most ${options.max}, got ${value}`);
  return value;
}

function decimal(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ConfigError(name, `expected a non-negative number, got ${JSON.stringify(raw)}`);
  return value;
}

function optionalInteger(env: NodeJS.ProcessEnv, name: string, options: { min?: number } = {}): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return integer(env, name, 0, options);
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ConfigError(name, `expected 1 or 0, got ${JSON.stringify(raw)}`);
}

function effort(env: NodeJS.ProcessEnv): ModelEffort {
  const raw = env.CONSOLE_EFFORT;
  if (raw === undefined || raw.trim() === "") return "medium";
  if (!(MODEL_EFFORTS as readonly string[]).includes(raw)) throw new ConfigError("CONSOLE_EFFORT", `expected one of ${MODEL_EFFORTS.join(", ")}, got ${JSON.stringify(raw)}`);
  return raw as ModelEffort;
}

function roots(env: NodeJS.ProcessEnv, home: string): { path: string; label: string }[] {
  const raw = env.CONSOLE_FS_ROOTS;
  if (raw !== undefined && raw.trim() !== "") {
    const entries = raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    for (const entry of entries) if (!path.isAbsolute(entry)) throw new ConfigError("CONSOLE_FS_ROOTS", `every root is an absolute path; got ${JSON.stringify(entry)}`);
    if (entries.length === 0) throw new ConfigError("CONSOLE_FS_ROOTS", "at least one root is required when set");
    return entries.map((entry) => ({ path: entry, label: entry }));
  }
  return [
    { path: home, label: "Home" },
    { path: path.parse(home).root, label: "Filesystem" },
  ];
}

function mcpServers(env: NodeJS.ProcessEnv): Record<string, McpServerCommand> {
  const catalog: Record<string, McpServerCommand> = {};
  const browser = env.CONSOLE_BROWSER_MCP;
  if (browser !== undefined && browser.trim() !== "") {
    const [command, ...args] = browser.split(/\s+/).filter((entry) => entry !== "");
    if (command === undefined) throw new ConfigError("CONSOLE_BROWSER_MCP", "expected a command");
    catalog.browser = { command, args };
  }
  const disabled = (env.CONSOLE_MCP_DISABLED ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const name of disabled) {
    if (!(APPROVED_MCP_SERVERS as readonly string[]).includes(name)) throw new ConfigError("CONSOLE_MCP_DISABLED", `expected approved MCP server names (${APPROVED_MCP_SERVERS.join(", ")}), got ${JSON.stringify(name)}`);
    delete catalog[name];
  }
  return catalog;
}

function completionCheck(env: NodeJS.ProcessEnv): Config["defaults"]["completionCheck"] {
  const raw = env.CONSOLE_DEFAULT_COMPLETION_CHECK;
  if (raw === undefined) return { command: "npm test", expectedExitCode: 0 };
  if (raw.trim() === "") return null;
  return { command: raw.trim(), expectedExitCode: 0 };
}

function evaluator(env: NodeJS.ProcessEnv): "reviewer" | "none" {
  const raw = env.CONSOLE_DEFAULT_EVALUATOR;
  if (raw === undefined || raw.trim() === "") return "reviewer";
  if (raw !== "reviewer" && raw !== "none") throw new ConfigError("CONSOLE_DEFAULT_EVALUATOR", `expected reviewer or none, got ${JSON.stringify(raw)}`);
  return raw;
}

/** Reads and validates the configuration; throws `ConfigError` naming the offending variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Config {
  const dataDir = path.resolve(env.CONSOLE_DATA_DIR ?? path.join(home, ".agentique-console"));
  const orchestratorAllocation: Allocation = { costUsd: decimal(env, "CONSOLE_ORCHESTRATOR_COST_USD", 5), tokens: integer(env, "CONSOLE_ORCHESTRATOR_TOKENS", 500_000, { min: 1 }), attempts: integer(env, "CONSOLE_ORCHESTRATOR_ATTEMPTS", 8, { min: 1 }) };
  const nodeAllocation: Allocation = { costUsd: decimal(env, "CONSOLE_NODE_COST_USD", 4), tokens: integer(env, "CONSOLE_NODE_TOKENS", 400_000, { min: 1 }), attempts: integer(env, "CONSOLE_NODE_ATTEMPTS", 4, { min: 1 }) };
  const budget: BudgetLimits = {
    maxCostUsd: decimal(env, "CONSOLE_DEFAULT_MAX_COST_USD", 50),
    maxTokens: integer(env, "CONSOLE_DEFAULT_MAX_TOKENS", 5_000_000, { min: 1 }),
    maxAttempts: integer(env, "CONSOLE_DEFAULT_MAX_ATTEMPTS", 60, { min: 1 }),
    maxWallClockMs: optionalInteger(env, "CONSOLE_DEFAULT_MAX_WALL_CLOCK_MS", { min: 1 }),
    maxConcurrency: integer(env, "CONSOLE_DEFAULT_MAX_CONCURRENCY", 3, { min: 1 }),
  };
  const port = integer(env, "CONSOLE_PORT", 4400, { min: 0, max: 65_535 });
  const model = env.CONSOLE_MODEL?.trim() || "claude-fable-5-1";
  return {
    dataDir,
    databaseFile: path.join(dataDir, "console.db"),
    blobRoot: path.join(dataDir, "blobs"),
    continuationRoot: path.join(dataDir, "continuations"),
    stateRoot: dataDir,
    port,
    host: env.CONSOLE_HOST?.trim() || "127.0.0.1",
    webDir: path.resolve(import.meta.dirname, "../../web/dist"),
    fsRoots: roots(env, home),
    provider: {
      model,
      effort: effort(env),
      continuation: flag(env, "CONSOLE_CONTINUATION", true),
      continuationTtlMs: optionalInteger(env, "CONSOLE_CONTINUATION_TTL_MS", { min: 1 }),
      mcpServers: mcpServers(env),
      mcpToolTimeoutMs: optionalInteger(env, "CONSOLE_MCP_TOOL_TIMEOUT_MS", { min: 1_000 }),
    },
    governor: {
      providerMaxConcurrency: integer(env, "CONSOLE_PROVIDER_MAX_CONCURRENCY", 4, { min: 1 }),
      processMaxAttempts: integer(env, "CONSOLE_PROCESS_MAX_ATTEMPTS", 6, { min: 1 }),
      maxWorktrees: optionalInteger(env, "CONSOLE_MAX_WORKTREES", { min: 1 }),
    },
    driver: {
      maxConcurrentRuns: integer(env, "CONSOLE_MAX_CONCURRENT_RUNS", 4, { min: 1 }),
      diagnosticsRetained: integer(env, "CONSOLE_DIAGNOSTICS_RETAINED", 500, { min: 10, max: 100_000 }),
    },
    defaults: {
      runKind: "code",
      budget,
      orchestratorAllocation,
      nodeAllocation,
      maxWallClockMs: integer(env, "CONSOLE_ATTEMPT_MAX_WALL_CLOCK_MS", 600_000, { min: 1_000 }),
      completionCheck: completionCheck(env),
      evaluator: evaluator(env),
    },
    checks: { commandTimeoutMs: integer(env, "CONSOLE_CHECK_TIMEOUT_MS", 600_000, { min: 1_000 }), maxOutputBytes: 65_536 },
  };
}
