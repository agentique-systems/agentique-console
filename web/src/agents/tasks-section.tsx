/**
 * The strip's task ledger for the active user session: live work first
 * (in_progress → pending), the done pile collapsed behind a count toggle,
 * deleted hidden entirely.
 */
import { useState } from "react";

import type { Task } from "@agentique-console/shared";

import { TaskRow } from "./task-row";

/** Stable render identity — sdkTaskId is only unique within its SDK session. */
function taskKey(task: Task): string {
  return `${task.sdkSessionId}:${task.sdkTaskId}`;
}

export function TasksSection({ tasks }: { tasks: readonly Task[] }) {
  const [showDone, setShowDone] = useState(false);

  const inProgress = tasks.filter((task) => task.status === "in_progress");
  const pending = tasks.filter((task) => task.status === "pending");
  const done = tasks.filter((task) => task.status === "completed");
  const count = inProgress.length + pending.length + done.length;

  return (
    <div className="flex max-h-[45%] flex-col border-t border-border">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Tasks
        </span>
        <span className="text-[10px] text-muted-foreground">{count}</span>
      </div>
      <div className="min-h-0 overflow-y-auto px-1 pb-2">
        {count === 0 ? (
          <div className="px-2 py-1 text-center text-[11px] text-muted-foreground">
            no tasks yet
          </div>
        ) : (
          <>
            {inProgress.map((task) => (
              <TaskRow key={taskKey(task)} task={task} />
            ))}
            {pending.map((task) => (
              <TaskRow key={taskKey(task)} task={task} />
            ))}
            {done.length > 0 && (
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent"
                onClick={() => setShowDone((value) => !value)}
              >
                {showDone ? "hide" : "show"} {done.length} done
              </button>
            )}
            {showDone &&
              done.map((task) => <TaskRow key={taskKey(task)} task={task} />)}
          </>
        )}
      </div>
    </div>
  );
}
