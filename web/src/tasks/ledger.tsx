import { useRunTasks } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { timeAgo } from "@/lib/format";

export function TaskLedger({ runId }: { runId: string }) {
  const tasks = useRunTasks(runId);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2" data-testid="task-ledger">
      <Panel query={tasks} empty={(t) => t.tasks.length === 0}>
        {(ledger) => (
          <table className="w-full text-xs">
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
              {ledger.tasks.map((view) => (
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
        )}
      </Panel>
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
