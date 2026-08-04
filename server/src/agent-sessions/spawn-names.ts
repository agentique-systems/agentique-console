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

/** The as_… id a spawn prompt claims membership of, if any. */
export const AGENT_SESSION_ID_RE = /\bas_[a-z0-9]{20}\b/;

/**
 * The spawn name an Agent tool call carries, preferring the `name` parameter
 * and falling back to the spawn-plan prompt templates ("(spawn name X)" /
 * "Coordinator: X.").
 *
 * The fallback exists because a model that forgets `name` is the observed
 * failure mode, not a hypothetical: it dropped the parameter on all 11 spawns
 * of the first real multi-seat run. Recovering the name here lets the
 * PreToolUse hook put it BACK on the tool call, which is what actually makes
 * the seat addressable — parsing it for observation alone leaves siblings
 * unable to SendMessage each other while the console's panes look correct.
 */
export function spawnNameFrom(input: {
  name?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
}): string | null {
  if (typeof input.name === "string" && input.name !== "") return input.name;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const seat = /\(spawn name ([A-Za-z0-9_-]+)\)/.exec(prompt)?.[1];
  if (seat !== undefined) return seat;
  if (input.subagent_type === SESSION_ORCHESTRATOR_TYPE) {
    return /Coordinator: ([A-Za-z0-9_-]+)\./.exec(prompt)?.[1] ?? null;
  }
  return null;
}

/** Kept here (not options.ts) so spawn-name logic has no orchestrator import. */
const SESSION_ORCHESTRATOR_TYPE = "session-orchestrator";

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
