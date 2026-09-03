/**
 * The environment handed to the Claude Code subprocess (migration-contract
 * rule 7: the one legacy mechanic worth keeping, moved here from the retired
 * SDK layer).
 *
 * The console may itself run inside a Claude Code session — a terminal, an
 * agent, a task runner — and that session exports variables that bind a
 * child CLI to it or change how it reasons (`CLAUDE_EFFORT` alone can turn a
 * short answer into minutes of thinking). The runtime configures every
 * Attempt itself, so those variables are stripped and everything else
 * (PATH, HOME, credentials, proxies, cloud-provider settings) passes through
 * untouched. Inherited flags that would widen native coordination behind
 * the adapter's tool policy never propagate either.
 *
 * The SDK's `env` option REPLACES the child environment rather than
 * extending it, so this returns the complete environment to use. Nothing
 * here reads or prints a credential: values pass through by key alone.
 */

/** Variables that couple a child CLI to the launching session or override its behaviour. */
const HOST_COUPLING_VARIABLES: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "AI_AGENT",
  "CLAUDE_EFFORT",
]);

/** Inherited flags that would enable native coordination the adapter denies by tool name. */
export const STRIPPED_FEATURE_FLAGS: readonly string[] = ["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"];

/**
 * The transport retry cap the CLI applies to one API request. The runtime's
 * own retry policy and wall-clock deadline are the real controls; this only
 * stops the CLI from spending minutes in its own backoff before the runtime
 * can act. Every retried request's consumption is reported in the same
 * result and accounted to the Attempt.
 */
export const DEFAULT_SDK_MAX_RETRIES = "3";

/** Variables the adapter fixes for every Attempt (an inherited value never overrides them). */
const FIXED_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  // No update checks, telemetry, or other non-essential traffic from an Attempt's subprocess.
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

export interface ProviderEnvironmentOptions {
  /** The console's bound on one MCP tool call (`CONSOLE_MCP_TOOL_TIMEOUT_MS`), set as the SDK's `MCP_TOOL_TIMEOUT`; `null` leaves the inherited value or the SDK's default. */
  mcpToolTimeoutMs?: number | null;
}

/** The SDK's environment variable bounding one MCP tool call, in milliseconds. */
export const MCP_TOOL_TIMEOUT_VARIABLE = "MCP_TOOL_TIMEOUT";

export function providerEnvironment(source: NodeJS.ProcessEnv = process.env, options: ProviderEnvironmentOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOST_COUPLING_VARIABLES.has(key)) continue;
    env[key] = value;
  }
  for (const flag of STRIPPED_FEATURE_FLAGS) delete env[flag];
  env.CLAUDE_CODE_MAX_RETRIES = env.CLAUDE_CODE_MAX_RETRIES ?? DEFAULT_SDK_MAX_RETRIES;
  for (const [key, value] of Object.entries(FIXED_VARIABLES)) env[key] = value;
  if (options.mcpToolTimeoutMs !== undefined && options.mcpToolTimeoutMs !== null) env[MCP_TOOL_TIMEOUT_VARIABLE] = String(options.mcpToolTimeoutMs);
  return env;
}

/** True when the key names a variable this module strips; tests and the tripwire use it to prove the isolation. */
export function isStrippedVariable(key: string): boolean {
  return HOST_COUPLING_VARIABLES.has(key) || STRIPPED_FEATURE_FLAGS.includes(key);
}
