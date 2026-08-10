import { useState } from "react";
import { useAgentSession, useUserSession } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { TaskLedger } from "@/tasks/task-ledger";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

export function SessionDetails() {
  const [tab, setTab] = useState<"overview" | "tasks">("overview");
  const userId = useUiStore((s) => s.activeUserSessionId); const agentId = useUiStore((s) => s.activeAgentSessionId);
  const user = useUserSession(userId); const agent = useAgentSession(agentId);
  return <div className="flex min-h-0 flex-col bg-sidebar/30">
    <div className="flex h-9 items-end gap-1 border-b border-border px-2">
      {(["overview", "tasks"] as const).map((value) => <button key={value} className={cn("border-b-2 border-transparent px-2 py-2 text-2xs capitalize text-muted-foreground", tab === value && "border-primary text-foreground")} onClick={() => setTab(value)}>{value}</button>)}
    </div>
    {tab === "tasks" ? <TaskLedger userSessionId={userId} agentSessionId={agentId} /> : <div className="min-h-0 overflow-y-auto p-4">
      {!userId ? <p className="text-xs text-muted-foreground">Select a session for details.</p> : agentId && agent.data ? <>
        <h2 className="text-sm font-medium">{agent.data.session.title}</h2><div className="mt-2 flex gap-1"><Badge variant="outline">{agent.data.session.status}</Badge></div>
        <dl className="mt-4 grid gap-3 text-2xs">{agent.data.runs.map((run) => <div key={run.participant}><dt className="font-mono text-foreground">{run.participant}</dt><dd className="text-muted-foreground">{run.profileId} · gen {run.generation} · {run.turnCount} turns · {run.contextTokens.toLocaleString()} tokens</dd></div>)}</dl>
      </> : user.data ? <><h2 className="text-sm font-medium">{user.data.session.title ?? "untitled"}</h2><div className="mt-2 flex gap-1"><Badge variant="outline">{user.data.session.status}</Badge><Badge variant="outline">{user.data.session.phase}</Badge><Badge variant="outline">{user.data.session.mode}</Badge></div><p className="mt-4 text-2xs text-muted-foreground">Created {new Date(user.data.session.createdAt).toLocaleString()}</p></> : <p className="text-xs text-muted-foreground">Loading session details…</p>}
    </div>}
  </div>;
}
