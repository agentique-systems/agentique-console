/**
 * One state per session, so the four things that mattered stop looking alike.
 *
 * db-live-2's ending rendered as a spinner that stopped — and so did a crash,
 * a stall, and a run blocked on a question the operator never saw. Those are
 * four different situations with four different responses, and the UI drew one
 * pixel for all of them.
 *
 * `AnyStatus` in `./status.ts` stays the visual vocabulary; this is the mapping
 * onto it.
 */
import type { RunState } from "@agentique-console/shared";
import type { AnyStatus } from "./status";

export type SessionState = "working" | "needs_you" | "blocked" | "done" | "ready";

export interface SessionStateInput {
  runState: RunState;
  archived: boolean;
  /** Open cards, or a proposed completion — anything only the operator resolves. */
  needsYou: boolean;
  posture: { busy: boolean; blocked: boolean };
  lastTurnErrored: boolean;
  spineOpen: boolean;
}

/**
 * First match wins, and the order is the point.
 *
 * `needs_you` beats `working` deliberately: an orchestrator can be mid-turn AND
 * blocked on the operator — that is precisely db-live-2's final state — and the
 * thing the operator can act on outranks the thing they cannot.
 */
export function deriveSessionState(input: SessionStateInput): SessionState {
  if (input.runState === "completed") return "done";
  if (input.needsYou || input.runState === "awaiting_signoff" || input.posture.blocked) return "needs_you";
  if (input.lastTurnErrored || !input.spineOpen) return "blocked";
  if (input.posture.busy) return "working";
  return "ready";
}

export const SESSION_STATE_TONE: Record<SessionState, AnyStatus> = {
  working: "running",
  // `needs_you` gets --attention in the components, not this tone: it is the
  // only state that means "you, now", and it already has a colour reserved.
  needs_you: "waiting",
  blocked: "failed",
  done: "completed",
  ready: "pending",
};

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  working: "working",
  needs_you: "needs you",
  blocked: "blocked",
  done: "done",
  ready: "ready",
};
