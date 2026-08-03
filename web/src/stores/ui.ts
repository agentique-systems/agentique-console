import { create } from "zustand";

/** Small UI postures that aren't scope: the active session, the draft form. */
interface UiState {
  /**
   * The session the conversation column shows. null = auto-land: the region
   * falls back to the most recent list row without writing it here, so a new
   * "most recent" keeps winning until the operator picks one explicitly.
   */
  readonly activeUserSessionId: string | null;
  /**
   * The draft-session posture: the conversation column shows mode toggle +
   * composer, and NOTHING persists until the first send.
   */
  readonly draftOpen: boolean;
  /** Which agent session each user session's inspector reads — stub for M6/M7. */
  readonly selectedAgentSessionByUserSession: Readonly<Record<string, string>>;
  /**
   * Sessions with a pending question/plan card. Client-side on purpose: the
   * list endpoint doesn't carry "awaiting input", and fetching GET /:id per
   * row would be wasteful — so the event router feeds this map from
   * question.asked/plan.proposed (set) and answered/resolved/message (clear).
   * Cold-boot sessions that were already awaiting show no dot until an event
   * arrives; the active session's detail query still shows its cards inline.
   */
  readonly awaitingInput: ReadonlySet<string>;
  openSession(id: string): void;
  beginDraft(): void;
  cancelDraft(): void;
  selectAgentSession(userSessionId: string, agentSessionId: string | null): void;
  setAwaitingInput(sessionId: string, awaiting: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  activeUserSessionId: null,
  draftOpen: false,
  selectedAgentSessionByUserSession: {},
  awaitingInput: new Set<string>(),
  openSession: (id) => set({ activeUserSessionId: id, draftOpen: false }),
  beginDraft: () => set({ draftOpen: true }),
  cancelDraft: () => set({ draftOpen: false }),
  selectAgentSession: (userSessionId, agentSessionId) =>
    set((state) => {
      const next = { ...state.selectedAgentSessionByUserSession };
      if (agentSessionId === null) delete next[userSessionId];
      else next[userSessionId] = agentSessionId;
      return { selectedAgentSessionByUserSession: next };
    }),
  setAwaitingInput: (sessionId, awaiting) =>
    set((state) => {
      if (state.awaitingInput.has(sessionId) === awaiting) return state;
      const next = new Set(state.awaitingInput);
      if (awaiting) next.add(sessionId);
      else next.delete(sessionId);
      return { awaitingInput: next };
    }),
}));
