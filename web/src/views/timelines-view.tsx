import { useEffect, useMemo, useRef } from "react";
import { DataSet } from "vis-data";
import { Timeline } from "vis-timeline/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";
import type { TimelineItem } from "@agentique-console/shared";
import { useSessionTree, useTimeline } from "@/api/queries";
import { SessionTree } from "@/sidebar/session-tree";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { Badge } from "@/components/ui/badge";

export function TimelinesView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const tree = useSessionTree(workspace); const userId = useUiStore((s) => s.activeUserSessionId);
  useEffect(() => { if (!userId && tree.data?.[0]) useUiStore.getState().openSession(tree.data[0].session.id); }, [tree.data, userId]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:timelines` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="tree" defaultSize="240px" minSize="190px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><SessionTree onSelectUser={(s) => useUiStore.getState().openSession(s.id)} onSelectAgent={(s) => useUiStore.getState().openAgentSession(s.userSessionId, s.id)} /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="timeline" minSize="480px"><TimelineCanvas /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="details" defaultSize="340px" minSize="280px" maxSize="500px" groupResizeBehavior="preserve-pixel-size"><TimelineDetails /></ResizablePanel>
  </ResizableGroup>;
}

function TimelineCanvas() {
  const id = useUiStore((s) => s.activeUserSessionId); const focusAgent = useUiStore((s) => s.activeAgentSessionId); const query = useTimeline(id); const host = useRef<HTMLDivElement>(null); const instance = useRef<Timeline | null>(null);
  useEffect(() => { if (!host.current || !query.data) return; const groups = query.data.lanes.map((lane) => ({ id: lane.id, content: lane.label, order: lane.order, ...(lane.kind === "agent_session" ? { nestedGroups: query.data!.lanes.filter((l) => l.parentId === lane.id).map((l) => l.id), showNested: true } : {}) }));
    const items = query.data.items.map((item) => ({ id: item.id, group: item.laneId, content: item.label, start: item.start, ...(item.end || item.kind === "turn" || item.kind === "tool" || item.kind === "process" ? { end: item.end ?? new Date(), type: "range" } : { type: "point" }), className: `timeline-${item.kind} timeline-status-${item.status ?? "none"}`, title: item.label }));
    const timeline = new Timeline(host.current, new DataSet(items as never[]), new DataSet(groups as never[]), { stack: false, zoomMin: 1_000, zoomMax: 1000 * 60 * 60 * 24 * 90, showCurrentTime: true, horizontalScroll: true, verticalScroll: true, multiselect: false, selectable: true, margin: { item: 6, axis: 8 } });
    timeline.on("select", (event) => useUiStore.getState().selectTimelineItem((event.items?.[0] as string | undefined) ?? null)); instance.current = timeline;
    if (focusAgent) { const group = `agent-session:${focusAgent}`; const laneItems = items.filter((item) => String(item.group).startsWith(`agent:${focusAgent}:`)); if (laneItems[0]) timeline.focus(laneItems[0].id, { animation: true }); const el = host.current?.querySelector(`[data-groupid="${group}"]`); el?.scrollIntoView({ block: "center" }); }
    return () => { timeline.destroy(); instance.current = null; };
  }, [query.data, focusAgent]);
  if (!id) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a UserSession.</div>;
  return <div className="flex h-full min-h-0 flex-col"><div className="flex h-9 items-center justify-between border-b px-3 text-3xs uppercase tracking-wider text-muted-foreground"><span>Swimlane timeline</span><span className="flex items-center gap-3">{query.hasNextPage && <button className="normal-case text-foreground hover:underline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "loading…" : "load earlier"}</button>}<span>{query.data?.items.length ?? 0} items</span></span></div><div ref={host} className="min-h-0 flex-1 bg-background" /></div>;
}

function TimelineDetails() {
  const userId = useUiStore((s) => s.activeUserSessionId); const selectedId = useUiStore((s) => s.selectedTimelineItemId); const query = useTimeline(userId);
  const item = useMemo(() => query.data?.items.find((candidate) => candidate.id === selectedId) ?? null, [query.data, selectedId]);
  if (!item) return <aside className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">Select an activity for event details.</aside>;
  return <aside className="h-full overflow-y-auto bg-sidebar/30 p-4"><div className="flex items-start justify-between gap-2"><h2 className="text-sm font-medium">{item.label}</h2><Badge variant="outline">{item.kind}</Badge></div><p className="mt-2 font-mono text-2xs text-muted-foreground">{new Date(item.start).toLocaleString()}{item.end ? ` → ${new Date(item.end).toLocaleString()}` : ""}</p>{item.status && <Badge className="mt-2" variant="outline">{item.status}</Badge>}<pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded border bg-card p-3 font-mono text-3xs">{JSON.stringify(item.detail, null, 2)}</pre></aside>;
}
