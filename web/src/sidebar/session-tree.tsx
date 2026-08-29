import { useMemo, useState } from "react";
import { Bot, MessagesSquare, Plus, Search } from "lucide-react";
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
  const [query, setQuery] = useState("");
  const visibleBranches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return branches;
    return branches.filter(({ session, agentSessions }) => (session.title ?? "untitled").toLowerCase().includes(normalized) || agentSessions.some((agent) => agent.title.toLowerCase().includes(normalized)));
  }, [branches, query]);
  return <aside data-testid="session-tree" className="flex h-full min-h-0 flex-col border-r border-border bg-sidebar">
    <div className="flex h-12 items-center justify-between border-b border-border px-3">
      <div><div className="text-xs font-semibold">Runs</div><div className="text-3xs text-muted-foreground">{branches.length} sessions</div></div>
      {allowNew && <Button size="sm" className="h-7 gap-1 px-2.5 text-2xs" onClick={() => beginDraft()}><Plus className="size-3" />New</Button>}
    </div>
    <div className="border-b border-border p-2"><label className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-muted-foreground focus-within:border-ring"><Search className="size-3.5" /><span className="sr-only">Search sessions</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs…" className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" /></label></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="tree" aria-label="Workspace sessions">
      {showAll && <button role="treeitem" aria-selected={allSelected} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent", allSelected && "bg-accent text-accent-foreground")} onClick={onSelectAll}><MessagesSquare className="size-3.5" />All sessions</button>}
      {visibleBranches.length === 0 ? <div className="px-3 py-10 text-center text-2xs text-muted-foreground">{branches.length === 0 ? "No sessions yet" : "No matching sessions"}</div> : visibleBranches.map(({ session, agentSessions }) => <div className="mb-1 overflow-hidden rounded-md border border-transparent" key={session.id} role="treeitem" aria-expanded="true" aria-selected={!allSelected && session.id === activeUser && activeAgent === null}>
        <button data-session-row={session.id} className={cn("flex w-full flex-col rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent", !allSelected && session.id === activeUser && activeAgent === null && "bg-accent text-accent-foreground")} onClick={() => onSelectUser ? onSelectUser(session) : openUser(session.id)}>
          <span className="truncate text-xs font-medium">{session.title ?? "untitled"}</span><span className="mt-0.5 text-3xs text-muted-foreground">{timeAgo(session.updatedAt)} · {agentSessions.length} agent{agentSessions.length === 1 ? "" : "s"}</span>
        </button>
        <div role="group" className="ml-3 border-l border-border py-1">
          {orderTree(agentSessions).map(({ session: agent, depth }) => <button key={agent.id} role="treeitem" aria-selected={!allSelected && agent.id === activeAgent} className={cn("flex w-full items-center gap-2 rounded-r-md py-1.5 pr-2 text-left hover:bg-accent", !allSelected && agent.id === activeAgent && "bg-accent text-accent-foreground")} style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }} onClick={() => onSelectAgent ? onSelectAgent(agent) : openAgent(agent.userSessionId, agent.id)}>
            <Bot className={cn("size-3 shrink-0", agent.activity === "working" ? "text-status-running" : agent.activity === "reported" ? "text-status-completed" : "text-muted-foreground")} />
            <span className="min-w-0 flex-1 truncate text-2xs">{agent.title}</span><span className="text-3xs text-muted-foreground">{agent.agents.length}</span>
          </button>)}
        </div>
      </div>)}
    </div>
  </aside>;
}
