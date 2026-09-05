import { useMemo, useState } from "react";
import { ActivityIcon, ChevronRightIcon, MessageSquarePlusIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import type { Run, WorkspaceResponse } from "@agentique-console/core";

import { useCreateConversation } from "@/api/mutations";
import { itemsOf, useWorkspaceConversations, useWorkspaceRuns } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page";
import { PagedList } from "@/components/paging";
import { errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { PhaseBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { rowPhaseLabel, rowPhaseOf, runIsActive, runNeedsOperator, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

type Filter = "needs_you" | "active" | "finished" | "all";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "active", label: "Active" },
  { id: "finished", label: "Finished" },
  { id: "all", label: "All" },
];

function matches(run: Run, filter: Filter): boolean {
  switch (filter) {
    case "needs_you":
      return runNeedsOperator(run);
    case "active":
      return runIsActive(run);
    case "finished":
      return !runIsActive(run);
    case "all":
      return true;
  }
}

/**
 * Every Run of the Workspace, newest first, with the ones that need the
 * operator surfaced: the console's home when work is under way.
 */
export function RunsView({ workspace }: { workspace: WorkspaceResponse }) {
  const runs = useWorkspaceRuns(workspace.workspace.id);
  const conversations = useWorkspaceConversations(workspace.workspace.id);
  const [filter, setFilter] = useState<Filter>("all");
  const loaded = useMemo(() => itemsOf(runs.data, (r) => r.id), [runs.data]);
  const titles = useMemo(() => new Map(itemsOf(conversations.data, (c) => c.conversation.id).map((c) => [c.conversation.id, c.conversation.title] as const)), [conversations.data]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, loaded.filter((r) => matches(r, f.id)).length])) as Record<Filter, number>, [loaded]);
  const create = useCreateConversation();
  const navigate = useNavigate();
  const startConversation = () =>
    create.mutate(
      { workspaceId: workspace.workspace.id, title: null },
      {
        onSuccess: (c) => void navigate(`/conversations/${c.conversation.id}`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="runs-view">
      <PageHeader
        title="Runs"
        description="Every Run of this Workspace, newest first. Runs that need you are marked."
        actions={
          <Button size="sm" variant="outline" onClick={startConversation} disabled={create.isPending} data-testid="new-conversation">
            <MessageSquarePlusIcon />
            New Conversation
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Filter Runs">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60", filter === f.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
            >
              {f.label}
              <span className={cn("font-mono text-2xs", f.id === "needs_you" && counts[f.id] > 0 ? "text-alert" : "text-muted-foreground")}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </PageHeader>
      <PageBody>
        <PagedList
          query={runs}
          idOf={(run) => run.id}
          more={{ label: "Load older Runs", testId: "runs-more" }}
          skeleton={
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          }
          empty={
            <EmptyState
              icon={ActivityIcon}
              title="No Runs yet"
              description="A Run is one bounded execution you start from a Conversation: the Orchestrator proposes Requirements, plans the work, and runs it in isolated worktrees."
              action={
                <Button onClick={startConversation} disabled={create.isPending}>
                  <MessageSquarePlusIcon />
                  Start a Conversation
                </Button>
              }
            />
          }
        >
          {(items) => {
            const visible = items.filter((run) => matches(run, filter));
            if (visible.length === 0) {
              return <EmptyState compact title={filter === "needs_you" ? "Nothing needs you right now" : `No ${filter} Runs among the loaded ones`} description={runs.hasNextPage ? "Older Runs may match; load more below." : undefined} />;
            }
            return (
              <ul className="surface-raised flex flex-col overflow-hidden rounded-lg border border-border bg-card" data-testid="runs-list">
                {visible.map((run) => (
                  <RunRow key={run.id} run={run} title={titles.get(run.conversationId) ?? null} />
                ))}
              </ul>
            );
          }}
        </PagedList>
      </PageBody>
    </div>
  );
}

function RunRow({ run, title }: { run: Run; title: string | null }) {
  const phase = rowPhaseOf(run);
  const needsOperator = runNeedsOperator(run);
  return (
    <li className="border-t border-border-subtle first:border-t-0" data-run={run.id} data-needs-operator={needsOperator || undefined}>
      <Link to={`/runs/${run.id}`} className={cn("group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none", needsOperator && "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r before:bg-alert")}>
        <PhaseBadge phase={phase} label={rowPhaseLabel(phase)} size="sm" className="w-[9.5rem] justify-start" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{title ?? (title === null ? "Untitled conversation" : "")}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{shortId(run.id)}</span>
            <span aria-hidden>·</span>
            <span>{run.kind === "code" ? "coding Run" : "Run"}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{run.target.kind === "branch" ? `→ ${run.target.branch}` : "→ directory"}</span>
          </span>
        </span>
        <span className="hidden shrink-0 flex-col items-end text-2xs text-muted-foreground sm:flex">
          <RelativeTime iso={run.createdAt} prefix="started" />
          {run.endedAt !== null && <RelativeTime iso={run.endedAt} prefix="ended" />}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </Link>
    </li>
  );
}
