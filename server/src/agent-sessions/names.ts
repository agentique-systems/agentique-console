/**
 * Deterministic peer-session names for console-owned SDK sessions.
 *
 * Every console session process registers in the machine-wide peer registry
 * (~/.claude/sessions/<pid>.json) under CLAUDE_CODE_SESSION_NAME and binds a
 * UDS inbox; the name is the SendMessage address. Names do three jobs at once:
 * routing (to → agent), attribution (from → agent), and namespacing — the
 * registry is shared with the operator's own CLI sessions, so the console
 * prefix keeps console traffic distinguishable and inbound trust checkable.
 *
 * Names are console-assigned via env, never model-supplied. That distinction
 * is what buries the spawn-plan era's failure mode (the model dropped the
 * `name` param on all 11 spawns of the first real multi-agent run).
 */

/** The reserved coordination agent's name; also its speaker name. */
export const COORDINATOR_AGENT = "coordinator";

/** The virtual recipient for reports up to the user-session lane. */
export const MAIN_RECIPIENT = "main";

/**
 * Sender-name prefix for cross-session boundary hops: a child AgentSession's
 * report lands in its parent under `child:<childAgentSessionId>`. Reserved at
 * agent-name validation so no operator-named agent can squat the namespace.
 */
export const CHILD_SENDER_PREFIX = "child:";

/** Registry name rules: start alnum; alnum/underscore/hyphen only; max 64. */
function sanitize(part: string): string {
  const safe = part.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[_-]+/, "");
  return safe === "" ? "agent" : safe;
}

/**
 * The Console's own sending identity: console-authored deliveries (operator
 * answers, close-out asks, parent-final releases) post under this name, which
 * `#assertRoute` accepts toward any agent.
 */
export const CONSOLE_SENDER = "console";

/** Six id chars past the `as_`/`us_` prefix — enough to disambiguate sessions. */
export function sessionSuffix(sessionId: string): string {
  const sep = sessionId.indexOf("_");
  const start = sep === -1 ? 0 : sep + 1;
  return sessionId.slice(start, start + 6);
}

/** The peer name of the user session's orchestrator lane. */
export function mainPeerName(prefix: string, userSessionId: string): string {
  return `${sanitize(`${prefix}main`)}-${sessionSuffix(userSessionId)}`.slice(0, 64);
}


