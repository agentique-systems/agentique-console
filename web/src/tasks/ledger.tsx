import { useMemo, useState } from "react";
import { ListIcon } from "lucide-react";
import { Link } from "react-router";
import type { Task, TaskView } from "@agentique-console/core";

import { useRunTasks } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { EmptyState } from "@/components/empty-state";
import { PagedList } from "@/components/paging";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortId, words } from "@/lib/format";
import { cn } from "@/lib/utils";

type Filter = "all" | "active" | "blocked" | "completed" | "failed";

const FILTERS: readonly { id: Filter; label: string; match: (task: Task) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "active", label: "Active", match: (t) => t.status === "pending" || t.status === "ready" || t.status === "running" },
  { id: "blocked", label: "Blocked", match: (t) => t.status === "blocked" },
  { id: "completed", label: "Completed", match: (t) => t.status === "completed" },
  { id: "failed", label: "Failed or cancelled", match: (t) => t.status === "failed" || t.status === "cancelled" },
];

/** The Run's Task ledger, one page at a time in creation order; every loaded page refreshes as the Run's Events arrive. */
export function TaskLedger({ runId }: { runId: string }) {
  const tasks = useRunTasks(runId);
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <div className="flex flex-col gap-3" data-testid="task-ledger">
      <PagedList
        query={tasks}
        idOf={(view) => view.task.id}
        more={{ label: "Load more Tasks", testId: "tasks-more" }}
        skeleton={<Skeleton className="h-40" />}
        empty={<EmptyState icon={ListIcon} title="No Tasks yet" description="Tasks are the bounded units of work the Orchestrator and Coordinators create for Workers; each carries its own evidence." />}
      >
        {(views) => <TaskTable views={views} runId={runId} filter={filter} setFilter={setFilter} />}
      </PagedList>
    </div>
  );
}

function TaskTable({ views, runId, filter, setFilter }: { views: TaskView[]; runId: string; filter: Filter; setFilter: (f: Filter) => void }) {
  const counts = useMemo(() => new Map(FILTERS.map((f) => [f.id, views.filter((v) => f.match(v.task)).length] as const)), [views]);
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!;
  const visible = views.filter((v) => active.match(v.task));
  return (
    <>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter Tasks">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60", filter === f.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
            {f.label}
            <span className="font-mono text-2xs text-muted-foreground">{counts.get(f.id) ?? 0}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <EmptyState compact title={`No ${active.label.toLowerCase()} Tasks among the loaded ones`} />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Depends on</TableHead>
                <TableHead>Outputs &amp; evidence</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((view) => (
                <TableRow key={view.task.id} data-task={view.task.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{view.task.subject}</span>
                      {view.task.blockReason !== null && <span className="text-xs text-status-waiting">Blocked: {describeBlock(view.task.blockReason)}</span>}
                      {view.task.failureReason !== null && <span className="text-xs text-status-failed">{words(view.task.failureReason)}</span>}
                      {view.supersededBy !== null && <span className="text-2xs text-muted-foreground">Replaced by {shortId(view.supersededBy)}</span>}
                      {view.task.requiredOutputs.length > 0 && <span className="text-2xs text-muted-foreground">Requires: {view.task.requiredOutputs.join(", ")}</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <StatusBadge status={view.task.status} />
                      {view.state !== null && <span className="text-2xs text-muted-foreground">{words(view.state.kind)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{view.task.origin}</TableCell>
                  <TableCell className="text-xs">
                    {view.task.planNodeId === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Link to={`/runs/${runId}/plan/${view.task.planNodeId}`} className="font-mono text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
                        {shortId(view.task.planNodeId)}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {view.dependencies.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help font-mono text-muted-foreground underline decoration-dotted underline-offset-2">{view.dependencies.length}</span>
                        </TooltipTrigger>
                        <TooltipContent className="font-mono">{view.dependencies.map(shortId).join(", ")}</TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    {view.outputs.length === 0 && view.task.evidence.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-xs">
                        {view.outputs.map((a) => (
                          <li key={a.id}>
                            <ArtifactLink artifact={a} />
                          </li>
                        ))}
                        {view.task.evidence.map((e, i) => (
                          <li key={i} className="font-mono text-2xs text-muted-foreground">
                            {e.kind === "command" ? `$ ${e.command} → ${e.exitCode}` : words(e.kind)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-2xs text-muted-foreground whitespace-nowrap">
                    <RelativeTime iso={view.task.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

function describeBlock(reason: NonNullable<Task["blockReason"]>): string {
  switch (reason.kind) {
    case "decision":
      return `Decision ${shortId(reason.decisionId)}`;
    case "input":
    case "replan":
      return reason.description;
    case "dependency_failed":
      return `dependency failed (${shortId(reason.taskId)})`;
    case "dependency_cancelled":
      return `dependency cancelled (${shortId(reason.taskId)})`;
  }
}
