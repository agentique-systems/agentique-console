import { create } from "zustand";

import type {
  AgentActivityChangedPayload,
  AgentRuntimeState,
} from "@agentique-console/shared";

export interface SeatRuntime {
  readonly state: AgentRuntimeState;
  readonly toolName?: string;
  /** Provider liveness under this state (retry, rate limit, tool tick). */
  readonly detail?: string;
  readonly at: number;
  /**
   * When this STATE began — held across detail-only updates, so an elapsed
   * counter measures the wait rather than restarting on every ping.
   */
  readonly since: number;
}

/**
 * Live per-agent runtime states from `agent_session.activity.changed` frames,
 * keyed session → agent. Never replayed, so a reconnect clears the lot —
 * the next frames repaint it.
 */
interface RuntimeState {
  readonly bySession: Readonly<
    Record<string, Readonly<Record<string, SeatRuntime>>>
  >;
  ingest(payload: AgentActivityChangedPayload): void;
  clearAll(): void;
}

export const useRuntimeStore = create<RuntimeState>((set) => ({
  bySession: {},
  ingest: (payload) =>
    set((state) => {
      const now = Date.now();
      const sessionId =
        payload.scope.kind === "user"
          ? payload.scope.userSessionId
          : payload.scope.agentSessionId;
      const previous = state.bySession[sessionId]?.[payload.agent];
      const sameState =
        previous !== undefined &&
        previous.state === payload.state &&
        previous.toolName === payload.toolName;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...state.bySession[sessionId],
            [payload.agent]: {
              state: payload.state,
              ...(payload.toolName === undefined
                ? {}
                : { toolName: payload.toolName }),
              ...(payload.detail === undefined
                ? {}
                : { detail: payload.detail }),
              at: now,
              since: sameState ? previous.since : now,
            },
          },
        },
      };
    }),
  clearAll: () => set({ bySession: {} }),
}));
