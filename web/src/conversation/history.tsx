import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { MessageSquareIcon, MessageSquarePlusIcon, SearchIcon } from "lucide-react";
import type { WorkspaceResponse } from "@agentique-console/core";
import { useCreateConversation } from "@/api/mutations";
import { useWorkspaceConversations } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PagedList } from "@/components/paging";
import { errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ConversationList({ workspace, conversationId, onNavigate }: { workspace: WorkspaceResponse; conversationId: string | null; onNavigate?: () => void }) {
  const conversations = useWorkspaceConversations(workspace.workspace.id);
  const create = useCreateConversation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const startNew = () =>
    create.mutate(
      { workspaceId: workspace.workspace.id, title: null },
      {
        onSuccess: (c) => { onNavigate?.(); void navigate(`/conversations/${c.conversation.id}`); },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border" data-testid="conversation-list" aria-label="Conversations">
      <div className="flex shrink-0 flex-col gap-2 px-3 py-3">
        <h2 className="sr-only">Conversations</h2>
        <Button size="sm" variant="outline" disabled={create.isPending} onClick={startNew} data-testid="new-conversation">
          <MessageSquarePlusIcon />
          New conversation
        </Button>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter loaded…" aria-label="Filter Conversations" className="h-7 pl-7 text-xs" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <PagedList
          query={conversations}
          idOf={(row) => row.conversation.id}
          more={{ label: "Load more", testId: "conversations-more", className: "flex justify-center pt-1" }}
          skeleton={
            <div className="flex flex-col gap-1 px-1">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          }
          empty={<EmptyState compact icon={MessageSquareIcon} title="No Conversations yet" description="Start one to talk to the Orchestrator about this Workspace." action={<Button size="sm" onClick={startNew} disabled={create.isPending}>New Conversation</Button>} />}
        >
          {(rows) => {
            const needle = filter.trim().toLowerCase();
            const visible = needle === "" ? rows : rows.filter((row) => (row.conversation.title ?? "untitled conversation").toLowerCase().includes(needle));
            if (visible.length === 0) return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No loaded Conversation matches.</p>;
            return (
              <ul className="flex flex-col gap-0.5">
                {visible.map((row) => {
                  const active = row.conversation.id === conversationId;
                  return (
                    <li key={row.conversation.id}>
                      <Link onClick={onNavigate} to={`/conversations/${row.conversation.id}`} aria-current={active ? "page" : undefined} className={cn("flex flex-col gap-1 rounded-md px-2 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60", active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}>
                        <span className="flex items-center gap-2">
                          <span className={cn("min-w-0 flex-1 truncate text-sm", active ? "font-medium" : row.conversation.title === null && "text-muted-foreground")}>{row.conversation.title ?? "Untitled conversation"}</span>
                          <RelativeTime iso={row.conversation.updatedAt} className="shrink-0 text-2xs text-muted-foreground" />
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                          {row.activeRun !== null ? <span>{row.activeRun.operatorPause ? "Paused" : row.activeRun.status === "awaiting_signoff" ? "Ready to review" : row.activeRun.status === "waiting" ? "Waiting" : "Working"}</span> : <span>Conversation</span>}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            );
          }}
        </PagedList>
      </div>
    </aside>
  );
}

