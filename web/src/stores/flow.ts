import { create } from "zustand";

/**
 * The flow indicator's pulse ledger: flow.delegation / flow.result events
 * become one-shot pulses per agent session (the strip's stem dot + card glow)
 * plus one shared edge glow (the conversation pane's right-edge tick). Pure
 * state — all animation is CSS keyed by nonce; idle costs zero JS per frame.
 */
export type FlowDirection = "delegation" | "result";

export interface FlowPulse {
  readonly direction: FlowDirection;
  /** Monotonic — keys the one-shot animation so repeats restart it. */
  readonly nonce: number;
  /** Client clock at pulse time — components ignore pulses older than ~4s. */
  readonly at: number;
}

/**
 * Freshness guard: reconnect replay re-delivers persisted flow events, and a
 * replayed delegation from minutes ago must not animate. Events older than
 * this (by their own ts) are dropped at the pulse door.
 */
export const FLOW_FRESH_MS = 3_000;

interface FlowState {
  readonly byAgentSession: Readonly<Record<string, FlowPulse>>;
  readonly edgeGlow: FlowPulse | null;
  /** Bumps the nonce; `eventTs` (the wire ts) gates out stale replays. */
  pulse(agentSessionId: string, direction: FlowDirection, eventTs?: string): void;
}

let nonce = 0;

export const useFlowStore = create<FlowState>((set) => ({
  byAgentSession: {},
  edgeGlow: null,
  pulse: (agentSessionId, direction, eventTs) => {
    if (
      eventTs !== undefined &&
      Date.now() - Date.parse(eventTs) > FLOW_FRESH_MS
    ) {
      return;
    }
    nonce += 1;
    const pulse: FlowPulse = { direction, nonce, at: Date.now() };
    set((state) => ({
      byAgentSession: { ...state.byAgentSession, [agentSessionId]: pulse },
      edgeGlow: pulse,
    }));
  },
}));
