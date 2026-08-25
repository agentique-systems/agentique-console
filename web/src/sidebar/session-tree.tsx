import { Bot, MessagesSquare, Plus } from "lucide-react";
import type { AgentSession, UserSession } from "@agentique-console/shared";
import { useSessionTree } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/status";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

/**
 * Depth-first pre-order over the whole forest — every session directly after
 * its parent, at ANY depth the runtime permits (a grandchild must never
 * vanish from the tree). Siblings by (createdAt, id); a row whose parent is
 * missing from the list renders as a root rather than disappearing.
 */
function orderTree(agentSessions: AgentSession[]): { session: AgentSession; depth: number }[] {
  const ids = new Set(agentSessions.map((agent) => agent.id));
  const childrenOf = (parentId: string | null) => agentSessions
    .filter((agent) => parentId === null
      ? agent.parentAgentSessionId === null || !ids.has(agent.parentAgentSessionId)
      : agent.parentAgentSessionId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const rows: { session: AgentSession; depth: number }[] = [];
  const visit = (session: AgentSession, depth: number) => {
    rows.push({ session, depth });
    for (const child of childrenOf(session.id)) visit(child, depth + 1);
  };
  for (const root of childrenOf(null)) visit(root, 0);
  return rows;
}

export function SessionTree({ showAll = false, allSelected = false, onSelectAll, onSelectUser, onSelectAgent, allowNew = false }: {
  showAll?: boolean; allSelected?: boolean; onSelectAll?: () => void;
  onSelectUser?: (session: UserSession) => void; onSelectAgent?: (session: AgentSession) => void; allowNew?: boolean;
}) {
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId); const tree = useSessionTree(workspaceId);
  const activeUser = useUiStore((s) => s.activeUserSessionId); const activeAgent = useUiStore((s) => s.activeAgentSessionId);
  const openUser = useUiStore((s) => s.openSession); const openAgent = useUiStore((s) => s.openAgentSession); const beginDraft = useUiStore((s) => s.beginDraft);
  const branches = tree.data ?? [];
  return <aside data-testid="session-tree" className="flex min-h-0 flex-col border-r border-border bg-sidebar">
    <div className="flex h-9 items-center justify-between border-b border-border px-3">
      <span className="text-3xs uppercase tracking-wider text-muted-foreground">Sessions</span>
      {allowNew && <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-2xs" onClick={beginDraft}><Plus className="size-3" /> new</Button>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label="Workspace sessions">
      {showAll && <button role="treeitem" aria-selected={allSelected} className={cn("flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs hover:bg-accent", allSelected && "bg-accent")} onClick={onSelectAll}><MessagesSquare className="size-3.5" />All sessions</button>}
      {branches.length === 0 ? <div className="px-3 py-8 text-center text-2xs text-muted-foreground">No sessions yet</div> : branches.map(({ session, agentSessions }) => <div key={session.id} role="treeitem" aria-expanded="true" aria-selected={!allSelected && session.id === activeUser && activeAgent === null}>
        <button data-session-row={session.id} className={cn("flex w-full flex-col border-b border-border/50 px-3 py-2 text-left hover:bg-accent", !allSelected && session.id === activeUser && activeAgent === null && "bg-accent")} onClick={() => onSelectUser ? onSelectUser(session) : openUser(session.id)}>
          <span className="truncate text-xs">{session.title ?? "untitled"}</span><span className="text-3xs text-muted-foreground">{timeAgo(session.updatedAt)} · {agentSessions.length} agent session{agentSessions.length === 1 ? "" : "s"}</span>
        </button>
        <div role="group" className="border-b border-border/50 bg-background/20 py-1">
          {orderTree(agentSessions).map(({ session: agent, depth }) => <button key={agent.id} role="treeitem" aria-selected={!allSelected && agent.id === activeAgent} className={cn("flex w-full items-center gap-2 border-l pr-3 py-1.5 text-left hover:bg-accent", !allSelected && agent.id === activeAgent && "border-l-primary bg-accent")} style={{ paddingLeft: `${1.5 + depth * 0.75}rem` }} onClick={() => onSelectAgent ? onSelectAgent(agent) : openAgent(agent.userSessionId, agent.id)}>
            <Bot className={cn("size-3 shrink-0", agent.activity === "working" ? "text-status-running" : agent.activity === "reported" ? "text-status-completed" : "text-muted-foreground")} />
            <span className="min-w-0 flex-1 truncate text-2xs">{agent.title}</span><span className="text-3xs text-muted-foreground">{agent.agents.length}</span>
          </button>)}
        </div>
      </div>)}
    </div>
  </aside>;
}
