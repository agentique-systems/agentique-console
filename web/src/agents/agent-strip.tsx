/**
 * The center strip: every agent session the orchestrator has delegated under
 * the ACTIVE user session, newest first, each on a flow stem off the left
 * rail. Selection feeds the inspector via the ui store's per-user-session
 * memory. Below the cards sits the task ledger — the same `useTasks` corpus
 * the cards count, rendered in full.
 */
import { useMemo } from "react";

import { useAgentSessions, useTasks } from "@/api/queries";
import { useUiStore } from "@/stores/ui";
import { TaskLedger } from "@/tasks/task-ledger";

import { useActiveUserSessionId } from "./active-session";
import { AgentCard } from "./agent-card";
import { FlowStem } from "./flow-stem";

export function AgentStrip() {
  const userSessionId = useActiveUserSessionId();
  const agentSessions = useAgentSessions(userSessionId);
  const tasks = useTasks(userSessionId);
  const selectedId = useUiStore((s) =>
    userSessionId === null
      ? undefined
      : s.selectedAgentSessionByUserSession[userSessionId],
  );

  // Top-level sessions createdAt desc (a stable order that never reshuffles
  // mid-glance when updatedAt churns); each followed by its children,
  // createdAt asc, indented one level under their parent.
  const cards = useMemo(() => {
    const all = agentSessions.data ?? [];
    const children = new Map<string, typeof all>();
    for (const session of all) {
      if (session.parentAgentSessionId === null) continue;
      const siblings = children.get(session.parentAgentSessionId) ?? [];
      siblings.push(session);
      children.set(session.parentAgentSessionId, siblings);
    }
    const roots = all
      .filter((session) => session.parentAgentSessionId === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return roots.flatMap((root) => [
      { session: root, nested: false },
      ...(children.get(root.id) ?? [])
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((child) => ({ session: child, nested: true })),
    ]);
  }, [agentSessions.data]);

  const taskRows = tasks.data ?? [];
  const taskCountBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of taskRows) {
      if (task.status === "deleted" || task.agentSessionId === null) continue;
      counts.set(task.agentSessionId, (counts.get(task.agentSessionId) ?? 0) + 1);
    }
    return counts;
  }, [taskRows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-r border-border bg-sidebar/50">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          Agent sessions
        </span>
        <span className="text-3xs text-muted-foreground">{cards.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2 pl-3 pr-2">
        {cards.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-2xs text-muted-foreground">
            the orchestrator hasn't delegated yet
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-l border-border">
            {cards.map(({ session, nested }) => (
              <div key={session.id} className={nested ? "border-l border-border-subtle pl-4" : undefined}>
                <FlowStem agentSessionId={session.id}>
                  <AgentCard
                    session={session}
                    taskCount={taskCountBySession.get(session.id) ?? 0}
                    selected={session.id === selectedId}
                  />
                </FlowStem>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Capped so a long board can never starve the cards above it. */}
      <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col">
        <TaskLedger userSessionId={userSessionId} />
      </div>
    </div>
  );
}
