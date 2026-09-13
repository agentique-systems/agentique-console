import { useParams } from "react-router";
import { useLayoutEffect } from "react";
import { ArrowUpIcon, BotIcon, ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import type { ConversationResponse, WorkspaceResponse } from "@agentique-console/core";
import { useConversation } from "@/api/queries";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { Panel, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConversationMessages } from "@/conversation/messages";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { usePreferences } from "@/settings/preferences";
import { ConversationWorkflow } from "./workflow";

/**
 * One continuous operator thread; history lives in the application sidebar.
 * Work controls and results are projected beside the messages they belong to.
 */
export function ConversationsView({ workspace }: { workspace: WorkspaceResponse }) {
  const { conversationId } = useParams();
  return conversationId === undefined ? <NoConversation workspace={workspace} /> : <ConversationPane key={conversationId} conversationId={conversationId} workspace={workspace} />;
}

function NoConversation({ workspace }: { workspace: WorkspaceResponse }) {
  return <div className="flex h-full min-h-0 flex-col" data-testid="conversation-empty">
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <BotIcon className="size-9 text-muted-foreground" />
      <h1 className="text-2xl font-semibold">What would you like to work on?</h1>
      <p className="max-w-md text-sm text-muted-foreground">Talk through an idea, ask a question, or ask the Orchestrator to get something done.</p>
    </div>
    <Composer workspaceId={workspace.workspace.id} />
  </div>;
}

function ConversationPane({ conversationId, workspace }: { conversationId: string; workspace: WorkspaceResponse }) {
  const conversation = useConversation(conversationId);
  return <div className="flex h-full min-h-0 flex-col" data-testid="conversation-pane">
    <Panel query={conversation} className="p-4">{(c) => <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{c.conversation.title ?? "New conversation"}</h1>
      </header>
      <Thread conversationId={conversationId} conversation={c} />
      <Composer workspaceId={workspace.workspace.id} conversation={c} />
    </>}</Panel>
  </div>;
}

/** The message thread: the newest page at once, older history on demand above it, and every later message as it is posted. */
function Thread({ conversationId, conversation }: { conversationId: string; conversation: ConversationResponse }) {
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
      <FollowPreference />
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
          {thread.messages.length === 0 && <EmptyState compact icon={MessageSquareIcon} title="No messages yet" description="Ask a question or describe what you would like to do." />}
          <ConversationWorkflow conversation={conversation} messages={thread.messages}>{(message) => {
            const operator = message.author === "operator";
            return (
              <article key={message.id} data-message={message.id} data-author={message.author} className={cn("flex max-w-[88%] flex-col gap-1", operator ? "ml-auto items-end" : "items-start")}>
                <div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
                  {!operator && <BotIcon className="size-3" aria-hidden />}
                  <span className="font-medium">{operator ? "You" : "Orchestrator"}</span>
                  <RelativeTime iso={message.createdAt} />
                </div>
                <div className={cn("rounded-lg px-3.5 py-2.5 text-sm", operator ? "bg-secondary text-secondary-foreground" : "surface-raised border border-border bg-card")}>
                  <Markdown text={message.content} />
                </div>
              </article>
            );
          }}</ConversationWorkflow>
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

function FollowPreference() {
  const enabled = usePreferences((s) => s.autoScroll);
  const { stopScroll } = useStickToBottomContext();
  useLayoutEffect(() => { if (!enabled) stopScroll(); }, [enabled, stopScroll]);
  return null;
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
