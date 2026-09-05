import { useMemo } from "react";
import { MousePointerClickIcon, WorkflowIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { PlanResponse, RunOverview } from "@agentique-console/core";

import { useRunPlan } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, usd, words } from "@/lib/format";
import { useIsWide } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { PlanGraph, PlanLegend } from "@/plan/graph";
import { NodeInspector } from "@/plan/inspector";
import { InvocationView } from "@/plan/invocation";

export { layout } from "@/plan/layout";

/**
 * The Plan: the graph, and beside it an inspector for the selected node or
 * Invocation (a table of every node when nothing is selected). Side by side on
 * a wide viewport, stacked elsewhere; the selection lives in the URL.
 */
export function PlanPanel({ overview, entityId }: { overview: RunOverview; entityId: string | null }) {
  const plan = useRunPlan(overview.run.id);
  const navigate = useNavigate();
  const wide = useIsWide();
  const selectedNode = entityId !== null && entityId.startsWith("pn_") ? entityId : null;
  const selectedInvocation = entityId !== null && entityId.startsWith("inv_") ? entityId : null;
  const current = useMemo(() => new Set(overview.projection?.nodes.filter((n) => n.current).map((n) => n.planNodeId) ?? []), [overview.projection]);
  const inspector =
    selectedInvocation !== null ? (
      <InvocationView invocationId={selectedInvocation} runId={overview.run.id} />
    ) : selectedNode !== null ? (
      <NodeInspector planNodeId={selectedNode} runId={overview.run.id} />
    ) : (
      <Panel query={plan} skeleton={<Skeleton className="h-40" />}>
        {(p) => <NodeTable plan={p} runId={overview.run.id} current={current} />}
      </Panel>
    );
  const graph = (
    <Panel query={plan} className="p-4" skeleton={<Skeleton className="m-4 h-48" />}>
      {(p) =>
        p.graph.nodes.length === 0 ? (
          <EmptyState icon={WorkflowIcon} title="No plan yet" description="The Orchestrator plans from its turns once the Requirements are agreed; accepted nodes appear here as a graph." />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-2 text-xs text-muted-foreground">
              <span>
                Revision {p.revisionNumber} of {p.revisionCount} · {count(p.nodes.length, "node")} · the Orchestrator revises the plan from its turns
              </span>
              <PlanLegend />
            </div>
            <PlanGraph plan={p} selected={selectedNode} current={current} onSelect={(id) => void navigate(`/runs/${overview.run.id}/plan/${id}`)} />
          </div>
        )
      }
    </Panel>
  );
  if (!wide) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex min-h-64 flex-col border-b border-border">{graph}</div>
        <div className="p-4">{inspector}</div>
      </div>
    );
  }
  return (
    <ResizableGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="58" minSize={320} className="min-h-0">
        <div className="flex h-full min-h-0 flex-col">{graph}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={320} className="min-h-0">
        <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="plan-inspector">
          {inspector}
        </div>
      </ResizablePanel>
    </ResizableGroup>
  );
}

/** Every node at a glance, for scanning before selecting one. */
function NodeTable({ plan, runId, current }: { plan: PlanResponse; runId: string; current: ReadonlySet<string> }) {
  if (plan.nodes.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MousePointerClickIcon className="size-3.5" />
        Select a node on the graph, or from this list, to inspect it.
      </div>
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Invocations</TableHead>
              <TableHead className="text-right">Tasks</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.nodes.map((summary) => {
              const node = summary.node;
              return (
                <TableRow key={node.id} className={cn(current.has(node.id) && "bg-status-running/5")}>
                  <TableCell>
                    <Link to={`/runs/${runId}/plan/${node.id}`} className="flex flex-col hover:underline">
                      <span className="font-medium">{node.kind === "pattern" ? node.title : "join"}</span>
                      <span className="text-2xs text-muted-foreground">{node.kind === "pattern" ? words(node.pattern) : `join · ${words(node.fanInPolicy)}`}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={node.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{summary.invocations.length}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{summary.tasks}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{usd(summary.usage.costUsd)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
