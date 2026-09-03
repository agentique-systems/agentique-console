import { useRunTasks } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { PagedList } from "@/components/paging";
import { StatusBadge } from "@/components/status-badge";
import { timeAgo } from "@/lib/format";

/** The Run's Task ledger, one page at a time in creation order; every loaded page refreshes as the Run's Events arrive. */
export function TaskLedger({ runId }: { runId: string }) {
  const tasks = useRunTasks(runId);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2" data-testid="task-ledger">
      <PagedList query={tasks} idOf={(view) => view.task.id} more={{ label: "Load more Tasks", testId: "tasks-more" }}>
        {(views) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-xs">
              <thead className="text-left text-3xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1">Task</th>
                  <th>Status</th>
                  <th>Origin</th>
                  <th>Depends on</th>
                  <th>Outputs / Evidence</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {views.map((view) => (
                  <tr key={view.task.id} className="border-t border-border align-top" data-task={view.task.id}>
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">{view.task.subject}</div>
                      {view.task.blockReason !== null && <div className="text-2xs text-status-waiting">blocked: {describeBlock(view.task.blockReason)}</div>}
                      {view.task.failureReason !== null && <div className="text-2xs text-status-failed">{view.task.failureReason}</div>}
                      {view.supersededBy !== null && <div className="text-3xs text-muted-foreground">replaced by {view.supersededBy.slice(0, 12)}</div>}
                    </td>
                    <td className="pr-2">
                      <StatusBadge status={view.task.status} />
                      {view.state !== null && <div className="text-3xs text-muted-foreground">{view.state.kind}</div>}
                    </td>
                    <td className="pr-2 text-muted-foreground">{view.task.origin}</td>
                    <td className="pr-2 font-mono text-3xs text-muted-foreground">{view.dependencies.map((d) => d.slice(0, 12)).join(", ") || "—"}</td>
                    <td className="pr-2">
                      <ul className="flex flex-col gap-0.5">
                        {view.outputs.map((a) => (
                          <li key={a.id}>
                            <ArtifactLink artifact={a} />
                          </li>
                        ))}
                        {view.task.evidence.map((e, i) => (
                          <li key={i} className="text-3xs text-muted-foreground">
                            {e.kind === "command" ? `$ ${e.command} → ${e.exitCode}` : e.kind}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="text-3xs text-muted-foreground">{timeAgo(view.task.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PagedList>
    </div>
  );
}

function describeBlock(reason: NonNullable<import("@agentique-console/core").Task["blockReason"]>): string {
  switch (reason.kind) {
    case "decision":
      return `Decision ${reason.decisionId.slice(0, 12)}`;
    case "input":
    case "replan":
      return reason.description;
    case "dependency_failed":
      return `dependency failed (${reason.taskId.slice(0, 12)})`;
    case "dependency_cancelled":
      return `dependency cancelled (${reason.taskId.slice(0, 12)})`;
  }
}
