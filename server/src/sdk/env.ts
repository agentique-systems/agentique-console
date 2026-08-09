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
 * `sessionName` sets CLAUDE_CODE_SESSION_NAME, the name this session's process
 * registers under in the machine peer registry — its SendMessage address. It is
 * always stripped from the inherited env first so a console session is either
 * deliberately named or unnamed, never accidentally wearing the operator's.
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
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "AI_AGENT",
  // Overrides how the child agent behaves — ours to decide, not the host's.
  "CLAUDE_EFFORT",
]);

export function sdkEnv(
  options: { sessionName?: string; source?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOST_SESSION_VARS.has(key)) continue;
    env[key] = value;
  }
  // In-process subagents stay console-disabled; never propagate their knobs.
  delete env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION;
  // Attempts 7-10 of the observed schedule were flat ~34s each and bought
  // nothing; the console's own wall-clock budget is the real control, and this
  // stops the CLI from spending three minutes before that budget can act.
  env.CLAUDE_CODE_MAX_RETRIES = env.CLAUDE_CODE_MAX_RETRIES ?? "5";
  if (options.sessionName !== undefined) {
    env.CLAUDE_CODE_SESSION_NAME = options.sessionName;
  }
  return env;
}
