/**
 * Deterministic peer-session names for console-owned SDK sessions.
 *
 * Every console session process registers in the machine-wide peer registry
 * (~/.claude/sessions/<pid>.json) under CLAUDE_CODE_SESSION_NAME and binds a
 * UDS inbox; the name is the SendMessage address. Names do three jobs at once:
 * routing (to → seat), attribution (from → seat), and namespacing — the
 * registry is shared with the operator's own CLI sessions, so the console
 * prefix keeps console traffic distinguishable and inbound trust checkable.
 *
 * Names are host-assigned via env, never model-supplied. That distinction is
 * what buries the spawn-plan era's failure mode (the model dropped the `name`
 * param on all 11 spawns of the first real multi-seat run).
 */

/** The coordinator seat every agent session has; also its speaker name. */
export const ORCHESTRATOR_SEAT = "orchestrator";

/** The virtual recipient for reports up to the user-session lane. */
export const MAIN_RECIPIENT = "main";

/** Registry name rules: start alnum; alnum/underscore/hyphen only; max 64. */
function sanitize(part: string): string {
  const safe = part.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[_-]+/, "");
  return safe === "" ? "seat" : safe;
}

/** Six id chars past the `as_`/`us_` prefix — enough to disambiguate sessions. */
export function sessionSuffix(sessionId: string): string {
  return sessionId.slice(3, 9);
}

/** The peer name a seat's session process registers under. */
export function peerNameOf(prefix: string, agentSessionId: string, seat: string): string {
  return `${sanitize(prefix + seat)}-${sessionSuffix(agentSessionId)}`.slice(0, 64);
}

/** The peer name of the user session's orchestrator lane. */
export function mainPeerName(prefix: string, userSessionId: string): string {
  return `${sanitize(`${prefix}main`)}-${sessionSuffix(userSessionId)}`.slice(0, 64);
}


/** Reverses peerNameOf against a seat list; null if the name is not ours. */
export function seatOfPeerName(
  prefix: string,
  peerName: string,
  agentSessionId: string,
  seats: readonly string[],
): string | null {
  for (const seat of [...seats, ORCHESTRATOR_SEAT]) {
    if (peerNameOf(prefix, agentSessionId, seat) === peerName) return seat;
  }
  return null;
}
