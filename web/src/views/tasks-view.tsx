import { useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import "@xyflow/react/dist/base.css";
import type { Task } from "@agentique-console/shared";
import { useWorkspaceTasks } from "@/api/queries";
import { useCancelAssignment } from "@/api/mutations";
import { SessionTree } from "@/sidebar/session-tree";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Scope = { kind: "all" } | { kind: "user"; id: string } | { kind: "agent"; id: string; userId: string };
type TaskNodeData = { task: Task };
const nodeTypes = { task: TaskNode };

export function TasksView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const [scope, setScope] = useState<Scope>({ kind: "all" });
  const data = useWorkspaceTasks(workspace); const selectedTaskId = useUiStore((s) => s.selectedTaskId); const selectTask = useUiStore((s) => s.selectTask);
  const [nodes, setNodes] = useState<Node<TaskNodeData>[]>([]); const [edges, setEdges] = useState<Edge[]>([]);
  const topology = useMemo(() => JSON.stringify({ ids: data.data?.tasks.map((t) => t.id), deps: data.data?.dependencies }), [data.data]);
  const inScope = (task: Task) => scope.kind === "all" || (scope.kind === "user" ? task.userSessionId === scope.id : task.agentSessionId === scope.id);
  useEffect(() => { let cancelled = false; const run = async () => { const allTasks = data.data?.tasks.filter((t) => t.status !== "deleted") ?? []; const primary = allTasks.filter(inScope); const visible = new Map(primary.map((t) => [t.id, t]));
    if (scope.kind !== "all" && data.data) for (const dep of data.data.dependencies) { if (!visible.has(dep.blockerTaskId) && !visible.has(dep.blockedTaskId)) continue; const blocker = allTasks.find((t) => t.id === dep.blockerTaskId); const blocked = allTasks.find((t) => t.id === dep.blockedTaskId); if (blocker) visible.set(blocker.id, blocker); if (blocked) visible.set(blocked.id, blocked); }
    const graph = { id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "50", "elk.layered.spacing.nodeNodeBetweenLayers": "80" }, children: [...visible.values()].map((task) => ({ id: task.id, width: 220, height: 82 })), edges: (data.data?.dependencies ?? []).filter((d) => visible.has(d.blockerTaskId) && visible.has(d.blockedTaskId)).map((d) => ({ id: `${d.blockerTaskId}->${d.blockedTaskId}`, sources: [d.blockerTaskId], targets: [d.blockedTaskId] })) };
    const layout = await new ELK().layout(graph); if (cancelled) return; setNodes((layout.children ?? []).map((child) => ({ id: child.id, type: "task", position: { x: child.x ?? 0, y: child.y ?? 0 }, data: { task: visible.get(child.id)! } })));
    // A satisfied edge (blocker completed) is history, not a constraint — mute it.
    setEdges((data.data?.dependencies ?? []).filter((d) => visible.has(d.blockerTaskId) && visible.has(d.blockedTaskId)).map((d) => ({ id: `${d.blockerTaskId}->${d.blockedTaskId}`, source: d.blockerTaskId, target: d.blockedTaskId, animated: visible.get(d.blockedTaskId)?.status === "in_progress", ...(visible.get(d.blockerTaskId)?.status === "completed" ? { style: { opacity: 0.3 } } : {}) })));
  }; void run(); return () => { cancelled = true; }; }, [topology, scope.kind, scope.kind === "all" ? "all" : scope.id]);
  const displayedNodes = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedTaskId })), [nodes, selectedTaskId]);
  const selected = data.data?.tasks.find((task) => task.id === selectedTaskId) ?? null; const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:tasks` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="tree" defaultSize="240px" minSize="190px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><SessionTree showAll allSelected={scope.kind === "all"} onSelectAll={() => setScope({ kind: "all" })} onSelectUser={(s) => { setScope({ kind: "user", id: s.id }); useUiStore.getState().openSession(s.id); }} onSelectAgent={(s) => { setScope({ kind: "agent", id: s.id, userId: s.userSessionId }); useUiStore.getState().openAgentSession(s.userSessionId, s.id); }} /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="graph" minSize="420px"><div className="console-grid relative h-full bg-background"><div className="absolute left-4 top-4 z-10 rounded-lg border bg-card/90 px-3 py-2 shadow-sm backdrop-blur"><div className="text-xs font-medium">Task topology</div><div className="mt-0.5 text-3xs text-muted-foreground">{data.data?.tasks.filter((t) => t.status !== "deleted" && inScope(t)).length ?? 0} tasks · {scope.kind} scope</div></div><ReactFlow nodes={displayedNodes} edges={edges} nodeTypes={nodeTypes} fitView onNodeClick={(_e, node) => selectTask(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable><Background gap={20} size={1} /><Controls showInteractive={false} /></ReactFlow></div></ResizablePanel><ResizableHandle />
    <ResizablePanel id="details" defaultSize="320px" minSize="260px" maxSize="460px" groupResizeBehavior="preserve-pixel-size"><TaskDetails task={selected} /></ResizablePanel>
  </ResizableGroup>;
}

function TaskNode({ data, selected }: NodeProps<Node<TaskNodeData>>) { const task = data.task; return <div className={cn("w-[220px] rounded-md border bg-card p-3 text-left", selected && "border-primary", task.status === "in_progress" && "console-running-ring")}><Handle type="target" position={Position.Left} /><div className="truncate text-xs font-medium">{task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}</div><div className="mt-2 flex items-center gap-1"><Badge variant="outline" className="text-3xs">{task.status}</Badge>{task.scheduledAssignment !== null && <Badge variant="outline" className="text-3xs text-status-waiting">scheduled</Badge>}<span className="truncate font-mono text-3xs text-muted-foreground">{task.owner ?? task.agent ?? "orchestrator"}</span></div><Handle type="source" position={Position.Right} /></div>; }
function TaskDetails({ task }: { task: Task | null }) {
  const cancel = useCancelAssignment();
  if (!task) return <aside className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">Select a task node for details.</aside>;
  const assignment = task.scheduledAssignment;
  return <aside className="h-full overflow-y-auto bg-sidebar/30 p-4"><h2 className="text-sm font-medium">{task.subject}</h2><div className="mt-2 flex gap-1"><Badge variant="outline">{task.status}</Badge>{task.owner && <Badge variant="outline">{task.owner}</Badge>}</div>
    {assignment !== null && (
      <div className="mt-4 rounded-md border border-status-waiting/40 p-3 text-2xs">
        <div className="text-status-waiting">scheduled assignment</div>
        <div className="mt-1 font-mono">{assignment.sender} → {assignment.recipient}</div>
        <div className="mt-1 text-muted-foreground">dispatches when this task's dependencies complete</div>
        <button type="button" className="mt-2 rounded border px-2 py-1 text-2xs hover:bg-accent disabled:opacity-50" disabled={cancel.isPending}
          onClick={() => cancel.mutate(assignment.id)}>
          {cancel.isPending ? "Canceling…" : "Cancel"}
        </button>
      </div>
    )}
    <p className="mt-4 whitespace-pre-wrap text-xs text-muted-foreground">{task.description || "No description."}</p><dl className="mt-5 grid gap-3 text-2xs"><div><dt className="text-muted-foreground">Session</dt><dd className="font-mono">{task.userSessionId}</dd></div><div><dt className="text-muted-foreground">Agent session</dt><dd className="font-mono">{task.agentSessionId ?? "orchestrator"}</dd></div><div><dt className="text-muted-foreground">Dependencies</dt><dd>{task.dependencyIds.join(", ") || "none"}</dd></div><div><dt className="text-muted-foreground">Dependents</dt><dd>{task.dependentIds.join(", ") || "none"}</dd></div><div><dt className="text-muted-foreground">Provider key</dt><dd className="break-all font-mono">{task.sdkSessionId}:{task.sdkTaskId}</dd></div></dl></aside>;
}
