import { useMemo, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, BotIcon, ChevronDownIcon, MessageSquareIcon, MessageSquarePlusIcon, SearchIcon, SendIcon } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import type { ConversationResponse, Run, WorkspaceResponse } from "@agentique-console/core";

import { useCreateConversation, usePostMessage } from "@/api/mutations";
import { itemsOf, useConversation, useConversationRuns, useWorkspaceConversations } from "@/api/queries";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { PagedList } from "@/components/paging";
import { Panel, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { PhaseBadge, StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { RunLauncher } from "@/conversation/launcher";
import { useConversationMessages } from "@/conversation/messages";
import { MOD_KEY } from "@/lib/hotkeys";
import { count, rowPhaseLabel, rowPhaseOf, shortId } from "@/lib/format";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

/**
 * Conversations: the list beside the open thread on a desktop (resizable), one
 * at a time on a narrow viewport. A Conversation is the operator's thread with
 * the Orchestrator; Runs start from it.
 */
export function ConversationsView({ workspace }: { workspace: WorkspaceResponse }) {
  const { conversationId } = useParams();
  const desktop = useIsDesktop();
  const list = <ConversationList workspace={workspace} conversationId={conversationId ?? null} />;
  const pane = conversationId === undefined ? <NoConversation workspace={workspace} /> : <ConversationPane key={conversationId} conversationId={conversationId} workspace={workspace} />;
  if (!desktop) {
    return <div className="flex h-full min-h-0 flex-col">{conversationId === undefined ? list : pane}</div>;
  }
  return (
    <ResizableGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize={300} minSize={220} maxSize={520} className="bg-sidebar/40">
        {list}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={360}>{pane}</ResizablePanel>
    </ResizableGroup>
  );
}

function ConversationList({ workspace, conversationId }: { workspace: WorkspaceResponse; conversationId: string | null }) {
  const conversations = useWorkspaceConversations(workspace.workspace.id);
  const create = useCreateConversation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const startNew = () =>
    create.mutate(
      { workspaceId: workspace.workspace.id, title: null },
      {
        onSuccess: (c) => void navigate(`/conversations/${c.conversation.id}`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border" data-testid="conversation-list" aria-label="Conversations">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-sm font-medium">Conversations</h2>
        <Button size="sm" variant="outline" disabled={create.isPending} onClick={startNew} data-testid="new-conversation">
          <MessageSquarePlusIcon />
          New
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
                      <Link to={`/conversations/${row.conversation.id}`} aria-current={active ? "page" : undefined} className={cn("flex flex-col gap-1 rounded-md px-2 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60", active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}>
                        <span className="flex items-center gap-2">
                          <span className={cn("min-w-0 flex-1 truncate text-sm", active ? "font-medium" : row.conversation.title === null && "text-muted-foreground")}>{row.conversation.title ?? "Untitled conversation"}</span>
                          <RelativeTime iso={row.conversation.updatedAt} className="shrink-0 text-2xs text-muted-foreground" />
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                          {row.activeRun !== null ? <PhaseBadge phase={rowPhaseOf(row.activeRun)} label={rowPhaseLabel(rowPhaseOf(row.activeRun))} size="sm" /> : <span>{count(row.runs, "Run")}</span>}
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

function NoConversation({ workspace }: { workspace: WorkspaceResponse }) {
  const create = useCreateConversation();
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="conversation-empty">
      <EmptyState
        icon={MessageSquareIcon}
        title="Pick a Conversation, or start a new one"
        description="A Conversation is your thread with the Orchestrator inside this Workspace. Each Run is one bounded execution you start from it, follow, sign off, and publish."
        action={
          <Button disabled={create.isPending} onClick={() => create.mutate({ workspaceId: workspace.workspace.id, title: null }, { onSuccess: (c) => void navigate(`/conversations/${c.conversation.id}`), onError: (error) => toast.error(errorMessage(error)) })}>
            <MessageSquarePlusIcon />
            New Conversation
          </Button>
        }
      />
    </div>
  );
}

function ConversationPane({ conversationId, workspace }: { conversationId: string; workspace: WorkspaceResponse }) {
  const conversation = useConversation(conversationId);
  const desktop = useIsDesktop();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation-pane">
      <Panel query={conversation} className="p-4">
        {(c) => (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 md:px-4">
              {!desktop && (
                <Button asChild size="icon-sm" variant="ghost" aria-label="Back to Conversations">
                  <Link to="/conversations">
                    <ArrowLeftIcon />
                  </Link>
                </Button>
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <h1 className="truncate text-sm font-semibold">{c.conversation.title ?? "Untitled conversation"}</h1>
                <span className="text-2xs text-muted-foreground">
                  {count(c.runs, "Run")} · created <RelativeTime iso={c.conversation.createdAt} />
                </span>
              </div>
              {c.activeRun !== null && (
                <Button asChild size="sm" variant="outline">
                  <Link to={`/runs/${c.activeRun.id}`} data-testid="active-run-link">
                    <PhaseBadge phase={rowPhaseOf(c.activeRun)} label={rowPhaseLabel(rowPhaseOf(c.activeRun))} size="sm" className="-ml-1" />
                    Open Run
                    <ArrowRightIcon />
                  </Link>
                </Button>
              )}
            </header>
            <RunsStrip conversationId={conversationId} activeRunId={c.activeRun?.id ?? null} />
            <Thread conversationId={conversationId} />
            <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-background p-3 md:px-4">
              {c.activeRun !== null ? (
                <Callout
                  tone="info"
                  icon={BotIcon}
                  testId="start-run-blocked"
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/runs/${c.activeRun.id}`}>
                        Follow the Run
                        <ArrowRightIcon />
                      </Link>
                    </Button>
                  }
                >
                  A Run is active in this Conversation. Messages you send steer its Orchestrator; another Run can start once it ends.
                </Callout>
              ) : (
                <RunLauncher conversation={c} workspace={workspace} />
              )}
              <Composer conversation={c} />
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

/** The Conversation's Runs, newest first, as a compact strip that folds away. */
function RunsStrip({ conversationId, activeRunId }: { conversationId: string; activeRunId: string | null }) {
  const runs = useConversationRuns(conversationId);
  const [open, setOpen] = useState(true);
  const rows = useMemo(() => itemsOf(runs.data, (r) => r.id), [runs.data]);
  if (runs.isPending || rows.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border-subtle bg-muted/30 px-3 md:px-4" data-testid="runs-list">
      <button type="button" className="flex h-8 w-full items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {count(rows.length, "Run")}
        {runs.hasNextPage && " loaded"}
      </button>
      {open && (
        <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
          {rows.map((run: Run) => {
            const phase = rowPhaseOf(run);
            return (
              <Link key={run.id} to={`/runs/${run.id}`} className={cn("flex shrink-0 items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs hover:bg-accent", run.id === activeRunId ? "border-foreground/40" : "border-border")} title={run.id}>
                <PhaseBadge phase={phase} label={rowPhaseLabel(phase)} size="sm" className="-ml-1" />
                <span className="font-mono text-2xs text-muted-foreground">{shortId(run.id)}</span>
                <RelativeTime iso={run.createdAt} className="text-2xs text-muted-foreground" />
              </Link>
            );
          })}
          {runs.hasNextPage && (
            <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage} data-testid="runs-more">
              {runs.isFetchingNextPage ? "Loading…" : "Older Runs"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The message thread: the newest page at once, older history on demand above it, and every later message as it is posted. */
function Thread({ conversationId }: { conversationId: string }) {
  const thread = useConversationMessages(conversationId);
  if (thread.status === "pending") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" data-testid="messages-loading" aria-busy="true">
        <Skeleton className="h-14 w-3/5" />
        <Skeleton className="ml-auto h-10 w-2/5" />
        <Skeleton className="h-20 w-4/5" />
      </div>
    );
  }
  if (thread.status === "error") {
    return (
      <div className="flex-1 p-4" data-testid="messages-error">
        <Callout tone="error">{errorMessage(thread.error)}</Callout>
      </div>
    );
  }
  return (
    <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="instant">
      <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3 md:p-4">
        <div className="flex flex-col gap-3" data-testid="messages" data-count={thread.messages.length}>
          {thread.hasOlder && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={thread.loadOlder} disabled={thread.isLoadingOlder} data-testid="messages-older">
                <ArrowUpIcon />
                {thread.isLoadingOlder ? "Loading…" : "Load older messages"}
              </Button>
            </div>
          )}
          {thread.messages.length === 0 && <EmptyState compact icon={MessageSquareIcon} title="No messages yet" description="Start a Run below, or leave a note for this Conversation." />}
          {thread.messages.map((message) => {
            const operator = message.author === "operator";
            return (
              <article key={message.id} data-message={message.id} data-author={message.author} className={cn("flex max-w-[88%] flex-col gap-1", operator ? "ml-auto items-end" : "items-start")}>
                <div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
                  {!operator && <BotIcon className="size-3" aria-hidden />}
                  <span className="font-medium">{operator ? "You" : "Orchestrator"}</span>
                  <RelativeTime iso={message.createdAt} />
                  {message.runId !== null && (
                    <Link to={`/runs/${message.runId}`} className="font-mono underline decoration-dotted underline-offset-2 hover:text-foreground" title={message.runId}>
                      {shortId(message.runId)}
                    </Link>
                  )}
                </div>
                <div className={cn("rounded-lg px-3.5 py-2.5 text-sm", operator ? "bg-secondary text-secondary-foreground" : "surface-raised border border-border bg-card")}>
                  <Markdown text={message.content} />
                </div>
              </article>
            );
          })}
          {thread.isFollowing && (
            <div className="flex items-center justify-center gap-1.5 text-2xs text-muted-foreground">
              <StatusDot tone="running" />
              Loading newer messages…
            </div>
          )}
        </div>
      </StickToBottom.Content>
      <JumpToLatest />
    </StickToBottom>
  );
}

function JumpToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button size="xs" variant="outline" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm" onClick={() => void scrollToBottom()}>
      <ChevronDownIcon />
      Latest
    </Button>
  );
}

function Composer({ conversation }: { conversation: ConversationResponse }) {
  const post = usePostMessage(conversation.conversation.id);
  const [content, setContent] = useState("");
  const active = conversation.activeRun !== null;
  const submit = () => {
    if (content.trim() === "" || post.isPending) return;
    post.mutate({ content }, { onSuccess: () => setContent(""), onError: (error) => toast.error(errorMessage(error)) });
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      data-testid="composer"
    >
      <div className="flex items-end gap-2 rounded-lg border border-input bg-background p-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 dark:bg-input/30">
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
          placeholder={active ? "Steer the Orchestrator: delivered to its next turn." : "Leave a note on this Conversation."}
          aria-label="message"
          rows={2}
          className="min-h-9 resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon-sm" disabled={post.isPending || content.trim() === ""} data-testid="send-message" aria-label="Send">
          <SendIcon />
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 px-1 text-2xs text-muted-foreground">
        <span>{active ? "The active Run's Orchestrator receives this as a typed input of its next turn." : "No Run is active: the message is recorded on the Conversation."}</span>
        <span className="hidden items-center gap-1 sm:flex">
          <Kbd>{MOD_KEY}</Kbd>
          <Kbd>↵</Kbd>
        </span>
      </div>
    </form>
  );
}
