/**
 * Liveness alarms: the sweep that watches the IN-FLIGHT dimension nothing else
 * covers. Every prior guard counted completed actions — identical-call and
 * error-streak watchdogs need tool RESULTS, the pattern stall needs quiet
 * BETWEEN turns, reaping needs a settle — so a turn wedged inside one tool
 * call for 16 minutes tripped none of them (the roguelike live run died
 * exactly there, with the orchestrator saying "I can't kill it").
 *
 * Two rules, both wall-clock over live-lane state, both skipping legal
 * ask_operator parks:
 * - tool hang: an in-flight call older than `toolCallAlarmMs` (deliberately
 *   below the mechanical MCP timeout so main can act with judgment first);
 * - quiet turn: a live turn with no stream event for `turnQuietAlarmMs`.
 *
 * A trip wakes MAIN through the mailroom as a console-authored failure
 * handoff — journaled, deduped, coalesced by the runner's normal wake path —
 * carrying the facts (agent, tool, input preview, age) and the lever menu.
 * One alarm per (turn, cause): the mechanical floor guarantees termination,
 * and alarm spam trains the orchestrator to ignore alarms.
 */
import type { Config } from "../config.ts";
import type { AgentSessionRow } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { AgentLanePool } from "./lanes.ts";
import { CONSOLE_SENDER, MAIN_RECIPIENT } from "./names.ts";
import type { SimpleHandoff, Transfer } from "./seams.ts";

export interface LivenessDeps {
  config: Config;
  lanes: AgentLanePool;
  bus: EventBus;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 6_000) / 10} min`;
}

const LEVERS =
  "Levers: session_activity shows live state; send_to_coordinator (to: the agent) steers it; " +
  "interrupt_agent stops the wedged turn (queued deliveries then redeliver); close_agent_session ends the session.";

export function sweepLiveness(deps: LivenessDeps, session: AgentSessionRow): void {
  const { config, lanes } = deps;
  const toolAlarmMs = config.policy.toolCallAlarmMs;
  const quietAlarmMs = config.policy.turnQuietAlarmMs;
  if (toolAlarmMs <= 0 && quietAlarmMs <= 0) return;
  const now = Date.now();

  for (const snapshot of lanes.laneSnapshots(session.id)) {
    const turn = snapshot.turn;
    // A turn parked on an operator card is waiting on a human, legally.
    if (turn === null || turn.awaitingOperator) continue;

    if (toolAlarmMs > 0) {
      for (const call of turn.inFlight) {
        const elapsed = now - call.startedAt;
        if (elapsed < toolAlarmMs) continue;
        const key = `tool:${turn.turnId}:${call.callId}`;
        if (!lanes.latchAlarm(session.id, snapshot.agent, key)) continue;
        fire(deps, session, {
          key, agent: snapshot.agent, turnId: turn.turnId, kind: "tool_hang",
          elapsedMs: elapsed, toolName: call.name, inputPreview: call.inputPreview,
          headline: `Liveness alarm: ${snapshot.agent} has been inside ${call.name} for ${minutes(elapsed)}`,
          detail: `${snapshot.agent}'s turn ${turn.turnId} has an in-flight ${call.name} call that started ${minutes(elapsed)} ago and has not returned. ` +
            `Input preview: ${call.inputPreview || "(empty)"}. ` +
            `The per-call MCP timeout${config.policy.mcpToolTimeoutMs > 0 ? ` will force an error at ${minutes(config.policy.mcpToolTimeoutMs)}` : " is off"}; ` +
            "you can act before that with judgment the timeout does not have.",
        });
      }
    }

    if (quietAlarmMs > 0 && turn.inFlight.length === 0) {
      const quietFor = now - turn.lastEventAt;
      if (quietFor < quietAlarmMs) continue;
      const key = `quiet:${turn.turnId}`;
      if (!lanes.latchAlarm(session.id, snapshot.agent, key)) continue;
      fire(deps, session, {
        key, agent: snapshot.agent, turnId: turn.turnId, kind: "quiet_turn",
        elapsedMs: quietFor,
        headline: `Liveness alarm: ${snapshot.agent}'s turn has streamed nothing for ${minutes(quietFor)}`,
        detail: `${snapshot.agent}'s turn ${turn.turnId} is live but has produced no stream event for ${minutes(quietFor)} — ` +
          "a wedged provider call or a retry storm streaming nothing. No tool call is in flight.",
      });
    }
  }
}

function fire(
  deps: LivenessDeps,
  session: AgentSessionRow,
  alarm: { key: string; agent: string; turnId: string; kind: "tool_hang" | "quiet_turn"; elapsedMs: number;
    toolName?: string; inputPreview?: string; headline: string; detail: string },
): void {
  deps.bus.append({
    type: "agent_session.liveness.tripped",
    userSessionId: session.userSessionId,
    agentSessionId: session.id,
    payload: { agentSessionId: session.id, agent: alarm.agent, turnId: alarm.turnId, kind: alarm.kind,
      elapsedMs: alarm.elapsedMs, ...(alarm.toolName === undefined ? {} : { toolName: alarm.toolName }),
      ...(alarm.inputPreview === undefined ? {} : { inputPreview: alarm.inputPreview }) },
  });
  try {
    deps.transfer({
      agentSessionId: session.id,
      speaker: { kind: "system", name: CONSOLE_SENDER },
      to: MAIN_RECIPIENT,
      handoff: deps.simpleHandoff(alarm.headline, "blocked", `${alarm.detail}\n\n${LEVERS}`,
        "Diagnose from live state and intervene — waiting a failure out is a supervision failure."),
      category: "failure",
      dedupeKey: `liveness:${alarm.key}`,
    });
  } catch { /* best effort — the typed event above is already journaled */ }
}
