/**
 * Deterministic subagent spawn names (B2). The SDK's agent-name registry is
 * global to the whole UserSession session and "latest wins" on collision, so
 * seat names are namespaced with a slice of their agent session id. Both the
 * spawn plan (create_agent_session) and the SeatRegistry (observation) derive
 * from these — the model copies names, it never invents them.
 */

export const COORDINATOR_SEAT = "coordinator";

/** The virtual seat the coordinator speaks as (relocated from routing.ts). */
export const ORCHESTRATOR_SEAT = "orchestrator";

/** SDK name rules: start alnum; alnum/underscore/hyphen only; max 64. */
function sanitize(seat: string): string {
  const safe = seat.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[_-]+/, "");
  return safe === "" ? "seat" : safe;
}

export function sessionSuffix(agentSessionId: string): string {
  return agentSessionId.slice(3, 9);
}

export function spawnNameOf(agentSessionId: string, seat: string): string {
  return `${sanitize(seat)}-${sessionSuffix(agentSessionId)}`.slice(0, 64);
}

/** Reverses spawnNameOf against a candidate seat list; null if no match. */
export function seatOfSpawnName(
  spawnName: string,
  agentSessionId: string,
  seats: readonly string[],
): string | null {
  for (const seat of [...seats, COORDINATOR_SEAT]) {
    if (spawnNameOf(agentSessionId, seat) === spawnName) return seat;
  }
  return null;
}
