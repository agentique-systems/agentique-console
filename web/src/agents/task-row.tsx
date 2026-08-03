/**
 * One task in the strip's ledger: status dot, the live activeForm while in
 * progress (subject otherwise), owner in the corner, and the blocked chip.
 * A task with an agent session is a door — clicking it selects that session
 * in the inspector.
 */
import type { Task } from "@agentique-console/shared";
import { STATUS_DOT, taskStatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

export function TaskRow({ task }: { task: Task }) {
  const selectAgentSession = useUiStore((s) => s.selectAgentSession);
  const agentSessionId = task.agentSessionId;
  const clickable = agentSessionId !== null;

  const body = (
    <>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          STATUS_DOT[taskStatusTone(task.status)],
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px]",
          task.status === "completed" && "text-muted-foreground",
        )}
      >
        {task.status === "in_progress"
          ? (task.activeForm ?? task.subject)
          : task.subject}
      </span>
      {task.status === "pending" && task.blockedBy.length > 0 && (
        <span className="shrink-0 text-[10px] text-status-waiting">
          blocked by {task.blockedBy.length}
        </span>
      )}
      {task.owner !== null && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {task.owner}
        </span>
      )}
    </>
  );

  const className = cn(
    "flex w-full items-center gap-2 rounded px-2 py-1 text-left",
    clickable && "transition-colors hover:bg-accent",
  );

  if (!clickable) {
    return (
      <div data-testid="task-row" className={className}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="task-row"
      className={className}
      onClick={() => selectAgentSession(task.userSessionId, agentSessionId)}
    >
      {body}
    </button>
  );
}
