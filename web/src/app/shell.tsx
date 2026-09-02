import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";
import { Topbar } from "@/app/topbar";
import { Spinner } from "@/components/ui/spinner";

const ConversationsView = lazy(() => import("@/conversation/view").then((m) => ({ default: m.ConversationsView })));
const RunView = lazy(() => import("@/run/view").then((m) => ({ default: m.RunView })));
const AgentsView = lazy(() => import("@/agents/view").then((m) => ({ default: m.AgentsView })));
const SystemView = lazy(() => import("@/system/view").then((m) => ({ default: m.SystemView })));

export function Shell({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden">
      <Topbar workspace={workspace} />
      <main className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          }
        >
          <Routes>
            <Route path="/conversations" element={<ConversationsView workspace={workspace} />} />
            <Route path="/conversations/:conversationId" element={<ConversationsView workspace={workspace} />} />
            <Route path="/runs/:runId" element={<RunView />} />
            <Route path="/runs/:runId/:tab" element={<RunView />} />
            <Route path="/runs/:runId/:tab/:entityId" element={<RunView />} />
            <Route path="/agents" element={<AgentsView workspace={workspace} />} />
            <Route path="/system" element={<SystemView />} />
            <Route path="*" element={<Navigate to="/conversations" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
