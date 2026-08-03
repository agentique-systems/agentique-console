/**
 * The environment handed to the SDK subprocess.
 *
 * The server may itself be launched from inside a Claude Code session (a
 * terminal, an agent, a task runner), and that session exports variables that
 * bind a child CLI to it or override how it thinks — `CLAUDE_EFFORT` alone can
 * turn a one-line reply into minutes of reasoning. The console configures its
 * own agents, so those variables are stripped and everything else (PATH, HOME,
 * credentials, proxies, Bedrock/Vertex settings) passes through untouched.
 *
 * The SDK's `env` option REPLACES the child environment rather than extending
 * it, so this returns the complete env to use.
 */
const HOST_SESSION_VARS: ReadonlySet<string> = new Set([
  // Couples the child to the launching session.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "AI_AGENT",
  // Overrides how the child agent behaves — ours to decide, not the host's.
  "CLAUDE_EFFORT",
]);

/**
 * Knobs the console pins deliberately (subagent defaults have moved several
 * times across SDK patch releases — never inherit them from the host): the
 * per-session subagent cap counts finished subagents and long-lived
 * UserSessions never /clear, so the default (200) would eventually starve
 * delegation.
 */
const PINNED_VARS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "1000",
};

export function sdkEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOST_SESSION_VARS.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...PINNED_VARS };
}
