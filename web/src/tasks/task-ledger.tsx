/**
 * The task ledger: every task the SDK's TaskCreate/TaskUpdate tools have
 * mirrored for the active user session, in one place.
 *
 * README.md has promised tasks in the centre strip since M1, but the strip only
 * ever rendered a COUNT on each agent card. The rows were already on the wire —
 * `useTasks` fetches them for those counts — so this is a rendering gap, not a
 * data one.
 *
 * Read-only, like everything else about agent sessions: the orchestrator and
 * its coordinators own the board. The one interaction is that clicking a task
 * points the inspector at the session that owns it.
 */
import { useMemo } from "react";
import { CircleDashedIcon, ListTodoIcon } from "lucide-react";

import { useTasks } from "@/api/queries";
import type { Task, TaskStatus } from "@agentique-console/shared";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

/** in_progress reads as the activeForm the SDK carries for exactly this. */
function titleOf(task: Task): string {
  if (task.status === "in_progress" && task.activeForm !== null) {
    return task.activeForm;
  }
  return task.subject;
}

/** createdAt asc so the board reads in the order it was planned. */
function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.sdkTaskId.localeCompare(b.sdkTaskId),
  );
}

function TaskRow({ task }: { task: Task }) {
  const openAgentSession = useUiStore((s) => s.openAgentSession);
  const completed = task.status === "completed";
  const blocked = task.blockedBy.length > 0 && task.status === "pending";
  // Orchestrator-owned tasks (agentSessionId null) have no pane to open.
  const target = task.agentSessionId;

  return (
    <QueueItem>
      <button
        type="button"
        disabled={target === null}
        className={cn(
          "flex min-w-0 items-start gap-2 text-left",
          target !== null && "cursor-pointer",
        )}
        onClick={() => {
          if (target !== null) openAgentSession(task.userSessionId, target);
        }}
      >
        <QueueItemIndicator completed={completed} />
        <QueueItemContent completed={completed}>
          {titleOf(task)}
        </QueueItemContent>
      </button>
      {(task.participant !== null || blocked) && (
        <QueueItemDescription completed={completed}>
          <span className="flex flex-wrap items-center gap-1.5">
            {task.participant !== null && (
              <span className="font-mono">{task.participant}</span>
            )}
            {blocked && (
              <span className="text-status-waiting">
                blocked by {task.blockedBy.length}
              </span>
            )}
          </span>
        </QueueItemDescription>
      )}
    </QueueItem>
  );
}

const SECTIONS: readonly {
  status: TaskStatus;
  label: string;
  defaultOpen: boolean;
}[] = [
  { status: "in_progress", label: "in progress", defaultOpen: true },
  { status: "pending", label: "queued", defaultOpen: true },
  { status: "completed", label: "done", defaultOpen: false },
];

export function TaskLedger({ userSessionId, agentSessionId }: { userSessionId: string | null; agentSessionId?: string | null }) {
  const tasks = useTasks(userSessionId);

  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>();
    for (const task of tasks.data ?? []) {
      if (agentSessionId && task.agentSessionId !== agentSessionId) continue;
      // `deleted` is a tombstone the SDK keeps; it is not a state to show.
      if (task.status === "deleted") continue;
      const bucket = groups.get(task.status);
      if (bucket) bucket.push(task);
      else groups.set(task.status, [task]);
    }
    for (const [status, bucket] of groups) groups.set(status, sortTasks(bucket));
    return groups;
  }, [tasks.data]);

  const total = [...byStatus.values()].reduce(
    (sum, bucket) => sum + bucket.length,
    0,
  );

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-3xs uppercase tracking-wider text-muted-foreground">
          <ListTodoIcon className="size-3" />
          Tasks
        </span>
        <span className="text-3xs text-muted-foreground">{total}</span>
      </div>

      {total === 0 ? (
        <div className="px-3 pb-3 text-3xs text-muted-foreground">
          no tasks on the board yet
        </div>
      ) : (
        <Queue className="min-h-0 overflow-y-auto px-1 pb-2">
          {SECTIONS.map(({ status, label, defaultOpen }) => {
            const bucket = byStatus.get(status) ?? [];
            if (bucket.length === 0) return null;
            return (
              <QueueSection key={status} defaultOpen={defaultOpen}>
                <QueueSectionTrigger>
                  <QueueSectionLabel
                    count={bucket.length}
                    label={label}
                    icon={
                      status === "in_progress" ? (
                        <CircleDashedIcon className="size-3 text-status-running" />
                      ) : undefined
                    }
                  />
                </QueueSectionTrigger>
                <QueueSectionContent>
                  <QueueList>
                    {bucket.map((task) => (
                      <TaskRow
                        key={`${task.sdkSessionId}:${task.sdkTaskId}`}
                        task={task}
                      />
                    ))}
                  </QueueList>
                </QueueSectionContent>
              </QueueSection>
            );
          })}
        </Queue>
      )}
    </div>
  );
}
