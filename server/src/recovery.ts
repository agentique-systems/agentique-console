/**
 * Boot recovery for turns that died with a previous process.
 *
 * A turn is an in-memory thing: one `query()` inside one process. When the
 * process goes away mid-turn (a crash, a dev-server restart, Ctrl-C), the
 * spine is left with a `turn.started` and no `turn.settled` — the UI spins
 * forever and, worse, an agent session goes quiet owing nothing, so nobody is
 * ever told. This pass closes those turns and puts each session back into a
 * state it can move from:
 *
 * - the operator's session gets the missing settle plus a notice, so the
 *   composer frees up and the silence is explained rather than mysterious;
 * - a specialist seat gets the missing settle and is re-armed — it kept its
 *   resume handle, so it can carry on from where it was.
 *
 * Writing the settle is what makes this idempotent: a recovered turn can never
 * be recovered again.
 */
import { Repo, toWireMessage } from "./db/repo.ts";
import type { EventBus } from "./events/bus.ts";

const RESTART_NOTE = "interrupted by a server restart";

export function recoverInterruptedTurns(deps: {
  repo: Repo;
  bus: EventBus;
}): number {
  const { repo, bus } = deps;
  const unsettled = repo.findUnsettledTurns();

  for (const turn of unsettled) {
    if (turn.kind === "user") {
      bus.append({
        type: "user_session.turn.settled",
        userSessionId: turn.userSessionId,
        payload: {
          sessionId: turn.userSessionId,
          turnId: turn.turnId,
          status: "aborted",
          errorMessage: RESTART_NOTE,
          queuedJobs: 0,
        },
      });
      const row = repo.appendMessage({
        sessionKind: "user",
        sessionId: turn.userSessionId,
        speaker: { kind: "system", name: "system" },
        kind: "notice",
        text: `The previous turn was ${RESTART_NOTE}. Send your message again to retry.`,
      });
      bus.append({
        type: "user_session.message",
        userSessionId: turn.userSessionId,
        payload: {
          sessionId: turn.userSessionId,
          message: toWireMessage(row),
        },
      });
      continue;
    }

    // Native subagents die with the process and have no resume handle — the
    // settle closes the spinner; the Orchestrator respawns via the spawn plan.
    bus.append({
      type: "agent_session.turn.settled",
      userSessionId: turn.userSessionId,
      agentSessionId: turn.agentSessionId,
      payload: {
        agentSessionId: turn.agentSessionId,
        participant: turn.participant,
        turnId: turn.turnId,
        status: "aborted",
        errorMessage: RESTART_NOTE,
      },
    });
  }

  return unsettled.length;
}
