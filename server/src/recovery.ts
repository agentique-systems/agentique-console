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
 * - a specialist agent gets the missing settle and nothing else. Its provider
 *   session survives in agents.sdk_session_id, and the journal's
 *   unacknowledged rows redeliver when the agent's lane next wakes.
 *
 * This is a boot pass only. An agent whose background task dies inside a LIVE
 * server is settled by the task-terminal path in the runner — if that ever
 * regresses, the symptom is a pane that spins until the next restart.
 *
 * Writing the settle is what makes this idempotent: a recovered turn can never
 * be recovered again.
 */
import { toWireMessage } from "./api/wire.ts";
import type { Db } from "./db/client.ts";
import type { Repo } from "./db/repo.ts";
import type { EventBus } from "./events/bus.ts";
import { findUnsettledTurns } from "./events/projections.ts";

const RESTART_NOTE = "interrupted by a server restart";

export interface RecoveredAgentTurn {
  userSessionId: string;
  agentSessionId: string;
  agent: string;
  turnId: string;
}

export function recoverInterruptedTurns(deps: {
  db: Db;
  repo: Repo;
  bus: EventBus;
}): { count: number; agentTurns: RecoveredAgentTurn[] } {
  const { repo, bus } = deps;
  const unsettled = findUnsettledTurns(deps.db);
  const agentTurns: RecoveredAgentTurn[] = [];

  for (const turn of unsettled) {
    if (turn.kind === "user") {
      bus.append({
        type: "user_session.turn.settled",
        userSessionId: turn.userSessionId,
        payload: {
          userSessionId: turn.userSessionId,
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
        type: "user_session.message.appended",
        userSessionId: turn.userSessionId,
        payload: {
          userSessionId: turn.userSessionId,
          message: toWireMessage(row),
        },
      });
      continue;
    }

    // The seat's provider session survives (resume handle in the DB); only
    // its in-flight turn died. Settle it, SAY so on the agent transcript
    // (silent recovery reads as a wedge), and report it upward so boot can
    // wake main with a resume digest.
    bus.append({
      type: "agent_session.turn.settled",
      userSessionId: turn.userSessionId,
      agentSessionId: turn.agentSessionId,
      payload: {
        agentSessionId: turn.agentSessionId,
        agent: turn.agent,
        turnId: turn.turnId,
        status: "aborted",
        errorMessage: RESTART_NOTE,
      },
    });
    bus.append({
      type: "agent_session.runtime.noted",
      userSessionId: turn.userSessionId,
      agentSessionId: turn.agentSessionId,
      payload: { agentSessionId: turn.agentSessionId, agent: turn.agent,
        detail: `${turn.agent}'s turn was ${RESTART_NOTE}; its provider session is retained and queued deliveries will redeliver` },
    });
    agentTurns.push({ userSessionId: turn.userSessionId, agentSessionId: turn.agentSessionId,
      agent: turn.agent, turnId: turn.turnId });
  }

  return { count: unsettled.length, agentTurns };
}

/** Rebuild event projections after a crash between an authoritative row and its journal append. */
export async function reconcileDurableCommunication(deps: { repo: Repo; bus: EventBus }): Promise<number> {
  const existing = new Set<string>();
  for await (const event of deps.bus.readWithSeq({})) {
    // Envelope ids, not payload ids: the 0003_glossary migration rewrote
    // historical rows onto the renamed types, so matching the CURRENT names
    // covers every era of the journal.
    if (event.type === "user_session.message.appended") existing.add(`message:user:${event.userSessionId}:${event.payload.message.seq}`);
    else if (event.type === "agent_session.message.appended") existing.add(`message:agent:${event.agentSessionId}:${event.payload.message.seq}`);
    else if (event.type === "agent_session.delivery.updated") existing.add(`delivery:${event.payload.deliveryId}:${event.payload.status}`);
  }
  let recovered = 0;
  for (const row of deps.repo.listAllMessages()) {
    const key = `message:${row.sessionKind}:${row.sessionId}:${row.seq}`;
    if (existing.has(key)) continue;
    if (row.sessionKind === "user") deps.bus.append({ type: "user_session.message.appended", userSessionId: row.sessionId, payload: { userSessionId: row.sessionId, message: toWireMessage(row) } });
    else {
      const session = deps.repo.getAgentSession(row.sessionId); if (!session) continue;
      deps.bus.append({ type: "agent_session.message.appended", userSessionId: session.userSessionId, agentSessionId: row.sessionId, payload: { agentSessionId: row.sessionId, message: toWireMessage(row) } });
    }
    recovered += 1;
  }
  for (const delivery of deps.repo.listAllDeliveries()) {
    const key = `delivery:${delivery.id}:${delivery.status}`; if (existing.has(key)) continue;
    const message = deps.repo.getMessageById(delivery.messageId);
    deps.bus.append({ type: "agent_session.delivery.updated", userSessionId: delivery.userSessionId, agentSessionId: delivery.agentSessionId,
      payload: { agentSessionId: delivery.agentSessionId, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status: delivery.status } });
    recovered += 1;
  }
  return recovered;
}
