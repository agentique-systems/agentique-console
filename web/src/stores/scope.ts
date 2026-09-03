import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Which Workspace the console is looking at; persisted and re-validated against the Workspace list on every load. */
interface ScopeState {
  readonly selectedWorkspaceId: string | null;
  select(workspaceId: string): void;
  clear(): void;
}

export const useScopeStore = create<ScopeState>()(
  persist(
    (set) => ({
      selectedWorkspaceId: null,
      select: (selectedWorkspaceId) => set({ selectedWorkspaceId }),
      clear: () => set({ selectedWorkspaceId: null }),
    }),
    { name: "agentique-console.scope", partialize: (s) => ({ selectedWorkspaceId: s.selectedWorkspaceId }) },
  ),
);
