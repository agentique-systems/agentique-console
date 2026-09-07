import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Per-browser layout preferences: the sidebar rail state. Nothing here is state of the system. */
interface UiState {
  readonly sidebarCollapsed: boolean;
  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    }),
    { name: "agentique-console.ui", partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }) },
  ),
);
