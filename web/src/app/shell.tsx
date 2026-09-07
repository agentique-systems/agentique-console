import { lazy, Suspense, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";

import { CommandPalette } from "@/app/command-palette";
import { Sidebar } from "@/app/sidebar";
import { Topbar } from "@/app/topbar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useHotkeys, type Hotkey } from "@/lib/hotkeys";
import { useIsDesktop } from "@/lib/use-media-query";

const RunsView = lazy(() => import("@/runs/list").then((m) => ({ default: m.RunsView })));
const ConversationsView = lazy(() => import("@/conversation/view").then((m) => ({ default: m.ConversationsView })));
const RunView = lazy(() => import("@/run/view").then((m) => ({ default: m.RunView })));
const AgentsView = lazy(() => import("@/agents/view").then((m) => ({ default: m.AgentsView })));
const SystemView = lazy(() => import("@/system/view").then((m) => ({ default: m.SystemView })));

/** The application frame around a chosen Workspace: navigation rail, top bar, the page, and the command palette. */
export function Shell({ workspace }: { workspace: WorkspaceResponse }) {
  const desktop = useIsDesktop();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const hotkeys = useMemo<Hotkey[]>(() => [{ key: "k", mod: true, inEditor: true, handler: () => setPaletteOpen((v) => !v) }], []);
  useHotkeys(hotkeys);
  return (
    <div className="flex h-screen min-w-0 overflow-hidden bg-background">
      {desktop && <Sidebar workspace={workspace} onOpenPalette={() => setPaletteOpen(true)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar workspace={workspace} onOpenMenu={() => setMenuOpen(true)} onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="p-6" data-testid="page-loading">
                <SkeletonLines lines={4} className="max-w-md" />
              </div>
            }
          >
            <Routes>
              <Route path="/runs" element={<RunsView workspace={workspace} />} />
              <Route path="/conversations" element={<ConversationsView workspace={workspace} />} />
              <Route path="/conversations/:conversationId" element={<ConversationsView workspace={workspace} />} />
              <Route path="/runs/:runId" element={<RunView />} />
              <Route path="/runs/:runId/:tab" element={<RunView />} />
              <Route path="/runs/:runId/:tab/:entityId" element={<RunView />} />
              <Route path="/agents" element={<AgentsView workspace={workspace} />} />
              <Route path="/system" element={<SystemView />} />
              <Route path="*" element={<Navigate to="/runs" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      {!desktop && (
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-64 p-0" aria-describedby={undefined}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Pages of the console and the Workspace switcher.</SheetDescription>
            <Sidebar key={pathname} workspace={workspace} inSheet onNavigate={() => setMenuOpen(false)} onOpenPalette={() => { setMenuOpen(false); setPaletteOpen(true); }} />
          </SheetContent>
        </Sheet>
      )}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} workspace={workspace} />
    </div>
  );
}
