import { create } from "zustand";

import type {
  AgentRuntimeState,
  AgentStatePayload,
} from "@agentique-console/shared";

export interface SeatRuntime {
  readonly state: AgentRuntimeState;
  readonly toolName?: string;
  readonly at: number;
}

/**
 * Live per-participant runtime states from transient `agent.state` frames,
 * keyed session → participant. Never replayed, so a reconnect clears the lot —
 * the next frames repaint it.
 */
interface RuntimeState {
  readonly bySession: Readonly<
    Record<string, Readonly<Record<string, SeatRuntime>>>
  >;
  ingest(payload: AgentStatePayload): void;
  clearAll(): void;
}

export const useRuntimeStore = create<RuntimeState>((set) => ({
  bySession: {},
  ingest: (payload) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [payload.scope.sessionId]: {
          ...state.bySession[payload.scope.sessionId],
          [payload.participant]: {
            state: payload.state,
            ...(payload.toolName === undefined
              ? {}
              : { toolName: payload.toolName }),
            at: Date.now(),
          },
        },
      },
    })),
  clearAll: () => set({ bySession: {} }),
}));
