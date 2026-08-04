import { useEffect, useRef } from "react";
import { useGroupRef } from "react-resizable-panels";

import { ConversationRegion } from "@/app/conversation-region";
import { InspectorRegion } from "@/app/inspector-region";
import { SidebarRegion } from "@/app/sidebar-region";
import { StripRegion } from "@/app/strip-region";
import { Topbar } from "@/app/topbar";
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
  useDefaultLayout,
} from "@/components/ui/resizable";
import { usePanelsStore, type CollapsiblePanel } from "@/stores/panels";
import { useScopeStore } from "@/stores/scope";

const RAILS: readonly CollapsiblePanel[] = ["sidebar", "strip", "inspector"];

/** Fallback share (%) if a rail is folded before it ever reported a width. */
const FALLBACK_PCT: Record<CollapsiblePanel, number> = {
  sidebar: 15,
  strip: 20,
  inspector: 24,
};

/**
 * A full-width topbar over the four-region cockpit: sessions | conversation |
 * agent sessions | inspector.
 *
 * The three rails drag and fold away; the conversation is the one panel that
 * always stays, so it absorbs every fold. Layout is persisted per workspace —
 * a different repo is a different job and deserves its own arrangement.
 */
export function Shell() {
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  // A different workspace is a different saved layout, so the group remounts
  // on the key below rather than trying to swap defaultLayout in place.
  return <Cockpit key={workspaceId ?? "none"} workspaceId={workspaceId} />;
}

function Cockpit({ workspaceId }: { workspaceId: string | null }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `agentique-console.panels:${workspaceId ?? "none"}`,
  });

  const groupRef = useGroupRef();
  const collapsed = usePanelsStore((s) => s.collapsed);
  const syncCollapsed = usePanelsStore((s) => s.syncCollapsed);
  /** Last expanded share per rail, so folding is reversible to where it was. */
  const lastOpen = useRef<Partial<Record<CollapsiblePanel, number>>>({});

  /**
   * Folding is driven through the GROUP's layout rather than each panel's
   * `collapse()`/`expand()`. Those hand the freed space to the adjacent panel,
   * so folding a rail whose neighbour is already folded finds no absorber and
   * silently does nothing — which is exactly the strip, sitting between the
   * agent cards and the inspector. Moving the space to the conversation
   * explicitly makes every rail foldable in any order.
   */
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const layout = group.getLayout();
    const next = { ...layout };
    let changed = false;

    for (const rail of RAILS) {
      const size = next[rail] ?? 0;
      const open = size > 0;
      if (collapsed[rail] === !open) continue;

      if (collapsed[rail]) {
        lastOpen.current[rail] = size;
        next[rail] = 0;
        next["conversation"] = (next["conversation"] ?? 0) + size;
      } else {
        const restore = lastOpen.current[rail] ?? FALLBACK_PCT[rail];
        next[rail] = restore;
        next["conversation"] = Math.max(0, (next["conversation"] ?? 0) - restore);
      }
      changed = true;
    }

    if (changed) group.setLayout(next);
  }, [collapsed, groupRef]);

  const onResize =
    (rail: CollapsiblePanel) => (size: { asPercentage: number }) => {
      // The panels are the source of truth; the store only mirrors them, so a
      // drag-to-collapse updates the topbar too.
      if (size.asPercentage > 0) lastOpen.current[rail] = size.asPercentage;
      syncCollapsed(rail, size.asPercentage === 0);
    };

  return (
    <div className="flex h-screen min-w-[720px] flex-col overflow-hidden">
      <Topbar />
      <ResizableGroup
        orientation="horizontal"
        className="min-h-0 flex-1 overflow-hidden"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        groupRef={groupRef}
      >
        <ResizablePanel
          id="sidebar"
          collapsible
          collapsedSize={0}
          defaultSize="240px"
          minSize="180px"
          maxSize="360px"
          groupResizeBehavior="preserve-pixel-size"
          onResize={onResize("sidebar")}
        >
          <SidebarRegion />
        </ResizablePanel>

        <ResizableHandle />

        {/* The only elastic panel: every rail keeps its pixel width when the
            window resizes, and this takes the slack. */}
        <ResizablePanel id="conversation" minSize="360px">
          <ConversationRegion />
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          id="strip"
          collapsible
          collapsedSize={0}
          defaultSize="320px"
          minSize="240px"
          maxSize="460px"
          groupResizeBehavior="preserve-pixel-size"
          onResize={onResize("strip")}
        >
          <StripRegion />
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          id="inspector"
          collapsible
          collapsedSize={0}
          defaultSize="380px"
          minSize="300px"
          groupResizeBehavior="preserve-pixel-size"
          onResize={onResize("inspector")}
        >
          <InspectorRegion />
        </ResizablePanel>
      </ResizableGroup>
    </div>
  );
}
