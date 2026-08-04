import { create } from "zustand";

/** The three rails that can be folded away. The conversation always stays. */
export type CollapsiblePanel = "sidebar" | "strip" | "inspector";

export const PANEL_LABEL: Record<CollapsiblePanel, string> = {
  sidebar: "sessions",
  strip: "agent sessions",
  inspector: "inspector",
};

/**
 * Runtime mirror of which rails are folded, so the topbar can render the right
 * icon state and drive the imperative collapse/expand API.
 *
 * Deliberately NOT persisted: react-resizable-panels already saves the layout
 * (collapsed size included) via useDefaultLayout, and a second persisted copy
 * would be a second source of truth to disagree with it. The shell seeds this
 * from the panels' own onResize on mount.
 */
interface PanelsState {
  readonly collapsed: Readonly<Record<CollapsiblePanel, boolean>>;
  /** Called by the shell from onResize — a no-op when nothing changed. */
  syncCollapsed(panel: CollapsiblePanel, collapsed: boolean): void;
  /** Called by the topbar; the shell effect turns this into collapse/expand. */
  toggle(panel: CollapsiblePanel): void;
}

export const usePanelsStore = create<PanelsState>((set) => ({
  collapsed: { sidebar: false, strip: false, inspector: false },
  syncCollapsed: (panel, collapsed) =>
    set((state) =>
      state.collapsed[panel] === collapsed
        ? state
        : { collapsed: { ...state.collapsed, [panel]: collapsed } },
    ),
  toggle: (panel) =>
    set((state) => ({
      collapsed: { ...state.collapsed, [panel]: !state.collapsed[panel] },
    })),
}));
