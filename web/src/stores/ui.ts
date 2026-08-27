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
  /**
   * A continuation pre-seed for the draft: the project the new session should
   * continue, set by a session's "continue in a fresh session" affordance.
   * `handoffSessionId` names the still-open session the send will hand off
   * (archive with its checkpoint); null when the predecessor is already
   * archived. Cleared whenever the draft closes.
   */
  readonly draftContinuation: { projectId: string; handoffSessionId: string | null } | null;
  /**
   * Which agent session each user session's inspector reads. Per-user-session
   * memory on purpose: switching user sessions restores that session's pick.
   */
  readonly selectedAgentSessionByUserSession: Readonly<Record<string, string>>;
  readonly activeAgentSessionId: string | null;
  readonly selectedTaskId: string | null;
  readonly selectedTimelineItemId: string | null;
  readonly selectedProfileId: string | null;
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
  beginDraft(continuation?: { projectId: string; handoffSessionId: string | null }): void;
  cancelDraft(): void;
  selectAgentSession(userSessionId: string, agentSessionId: string | null): void;
  openAgentSession(userSessionId: string, agentSessionId: string): void;
  selectTask(id: string | null): void;
  selectTimelineItem(id: string | null): void;
  selectProfile(id: string | null): void;
  setAwaitingInput(sessionId: string, awaiting: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  activeUserSessionId: null,
  draftOpen: false,
  draftContinuation: null,
  selectedAgentSessionByUserSession: {},
  activeAgentSessionId: null,
  selectedTaskId: null,
  selectedTimelineItemId: null,
  selectedProfileId: null,
  awaitingInput: new Set<string>(),
  openSession: (id) => set({ activeUserSessionId: id, activeAgentSessionId: null, draftOpen: false, draftContinuation: null }),
  beginDraft: (continuation) => set({ draftOpen: true, draftContinuation: continuation ?? null }),
  cancelDraft: () => set({ draftOpen: false, draftContinuation: null }),
  selectAgentSession: (userSessionId, agentSessionId) =>
    set((state) => {
      const next = { ...state.selectedAgentSessionByUserSession };
      if (agentSessionId === null) delete next[userSessionId];
      else next[userSessionId] = agentSessionId;
      return { selectedAgentSessionByUserSession: next, activeAgentSessionId: agentSessionId };
    }),
  openAgentSession: (activeUserSessionId, activeAgentSessionId) => set({ activeUserSessionId, activeAgentSessionId, draftOpen: false }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectTimelineItem: (selectedTimelineItemId) => set({ selectedTimelineItemId }),
  selectProfile: (selectedProfileId) => set({ selectedProfileId }),
  setAwaitingInput: (sessionId, awaiting) =>
    set((state) => {
      if (state.awaitingInput.has(sessionId) === awaiting) return state;
      const next = new Set(state.awaitingInput);
      if (awaiting) next.add(sessionId);
      else next.delete(sessionId);
      return { awaitingInput: next };
    }),
}));
