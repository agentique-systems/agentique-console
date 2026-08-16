import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Topbar } from "@/app/topbar";
import { AttentionBridge } from "@/live/attention";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { Spinner } from "@/components/ui/spinner";

const SessionsView = lazy(() => import("@/views/sessions-view").then((module) => ({ default: module.SessionsView })));
const AgentsView = lazy(() => import("@/views/agents-view").then((module) => ({ default: module.AgentsView })));
const TasksView = lazy(() => import("@/views/tasks-view").then((module) => ({ default: module.TasksView })));
const TimelinesView = lazy(() => import("@/views/timelines-view").then((module) => ({ default: module.TimelinesView })));

export function Shell() {
  const workspace = useScopeStore((state) => state.selectedWorkspaceId);
  const previousWorkspace = useRef(workspace);
  useEffect(() => { if (previousWorkspace.current === workspace) return; previousWorkspace.current = workspace; useUiStore.setState({ activeUserSessionId: null, activeAgentSessionId: null, selectedTaskId: null, selectedTimelineItemId: null, selectedProfileId: null, draftOpen: false }); }, [workspace]);
  return <div className="flex h-screen min-w-[960px] flex-col overflow-hidden"><AttentionBridge /><Topbar /><main className="min-h-0 flex-1"><Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-4 text-muted-foreground" /></div>}><Routes>
    <Route path="/sessions" element={<SessionsView />} /><Route path="/agents" element={<AgentsView />} /><Route path="/tasks" element={<TasksView />} /><Route path="/timelines" element={<TimelinesView />} /><Route path="*" element={<Navigate to="/sessions" replace />} />
  </Routes></Suspense></main></div>;
}
