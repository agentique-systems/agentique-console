import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Which workspace the console is looking at. Everything below the gate is
 * scoped to it.
 *
 * Deliberately its own store rather than a field on some ui store: scope is
 * persisted and read by the DATA layer — which should not have to import UI
 * posture to build a query key. The id is re-validated against
 * /api/workspaces on every boot (in App), so a workspace deleted elsewhere
 * cannot wedge the app.
 */
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
    {
      name: "agentique-console.scope",
      partialize: (s) => ({ selectedWorkspaceId: s.selectedWorkspaceId }),
    },
  ),
);
