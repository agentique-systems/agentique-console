import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Play, Send } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import type { ConversationResponse, Run, WorkspaceResponse } from "@agentique-console/core";
import { useCreateConversation, useCreateRun, usePostMessage } from "@/api/mutations";
import { useConfig, useConversation, useConversationRuns, useWorkspaceConversations } from "@/api/queries";
import { Markdown } from "@/components/markdown";
import { PagedList } from "@/components/paging";
import { Notice, Panel, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConversationMessages } from "@/conversation/messages";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ConversationsView({ workspace }: { workspace: WorkspaceResponse }) {
  const { conversationId } = useParams();
  const conversations = useWorkspaceConversations(workspace.workspace.id);
  const create = useCreateConversation();
  const navigate = useNavigate();
  return (
    <div className={cn("grid h-full min-h-0 grid-cols-1 md:grid-cols-[18rem_1fr]", conversationId !== undefined && "max-md:grid-rows-[auto_1fr]")}>
      <aside className={cn("flex min-h-0 flex-col border-b border-border bg-sidebar md:border-b-0 md:border-r", conversationId !== undefined && "max-md:max-h-40")} data-testid="conversation-list">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Conversations</span>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={create.isPending}
            onClick={() => create.mutate({ workspaceId: workspace.workspace.id, title: null }, { onSuccess: (c) => void navigate(`/conversations/${c.conversation.id}`) })}
            data-testid="new-conversation"
          >
            <MessageSquarePlus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PagedList query={conversations} idOf={(row) => row.conversation.id} more={{ label: "Load more Conversations", testId: "conversations-more" }}>
            {(rows) => (
              <ul className="flex flex-col">
                {rows.map((row) => (
                  <li key={row.conversation.id}>
                    <Link to={`/conversations/${row.conversation.id}`} className={cn("flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-muted/40", row.conversation.id === conversationId && "bg-accent")}>
                      <span className="truncate font-medium">{row.conversation.title ?? "Untitled conversation"}</span>
                      <span className="flex items-center gap-2 text-3xs text-muted-foreground">
                        {row.runs} Run{row.runs === 1 ? "" : "s"} · {timeAgo(row.conversation.updatedAt)}
                        {row.activeRun !== null && <StatusBadge status={row.activeRun.status} />}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </PagedList>
          {create.isError && <div className="px-3 py-2 text-2xs text-status-failed">{errorMessage(create.error)}</div>}
        </div>
      </aside>
      <section className="min-h-0 overflow-y-auto">
        {conversationId === undefined ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground" data-testid="conversation-empty">
            <p>Pick a Conversation, or start a new one.</p>
            <p className="max-w-md text-xs">A Conversation is your thread with the Orchestrator inside this Workspace. Each Run is one bounded execution you start from it, follow, sign off, and publish.</p>
          </div>
        ) : (
          <ConversationPane key={conversationId} conversationId={conversationId} workspace={workspace} />
        )}
      </section>
    </div>
  );
}

function ConversationPane({ conversationId, workspace }: { conversationId: string; workspace: WorkspaceResponse }) {
  const conversation = useConversation(conversationId);
  const runs = useConversationRuns(conversationId);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4 md:p-6" data-testid="conversation-pane">
      <Panel query={conversation}>
        {(c) => (
          <>
            <header className="flex items-center justify-between gap-3">
              <h1 className="text-base font-medium">{c.conversation.title ?? "Untitled conversation"}</h1>
              {c.activeRun !== null && (
                <Link to={`/runs/${c.activeRun.id}`} className="text-xs underline" data-testid="active-run-link">
                  Active Run: <StatusBadge status={c.activeRun.status} />
                </Link>
              )}
            </header>
            <Messages conversationId={conversationId} />
            <Composer conversation={c} />
            <RunsList query={runs} />
            <StartRun conversation={c} workspace={workspace} />
          </>
        )}
      </Panel>
    </div>
  );
}

/** The message thread: the newest page at once, older history on demand above it, and every later message as it is posted. */
function Messages({ conversationId }: { conversationId: string }) {
  const thread = useConversationMessages(conversationId);
  const end = useRef<HTMLDivElement>(null);
  const newest = thread.messages.at(-1)?.id ?? null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [newest]);
  if (thread.status === "pending") {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground" data-testid="messages-loading">
        Loading messages…
      </div>
    );
  }
  if (thread.status === "error") {
    return (
      <div className="rounded-md border border-status-failed/40 p-3 text-xs text-status-failed" data-testid="messages-error">
        {errorMessage(thread.error)}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="messages" data-count={thread.messages.length}>
      {thread.hasOlder && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={thread.loadOlder} disabled={thread.isLoadingOlder} data-testid="messages-older">
            {thread.isLoadingOlder ? "Loading…" : "Load older messages"}
          </Button>
        </div>
      )}
      {thread.messages.length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">No messages yet.</div>}
      {thread.messages.map((message) => (
        <article key={message.id} data-message={message.id} data-author={message.author} className={cn("flex max-w-[90%] flex-col gap-1 rounded-lg px-4 py-3 text-sm", message.author === "operator" ? "ml-auto bg-secondary" : "border border-border")}>
          <div className="flex items-center gap-2 text-3xs text-muted-foreground">
            <span className="font-medium">{message.author === "operator" ? "You" : "Orchestrator"}</span>
            <span>{timeAgo(message.createdAt)}</span>
            {message.runId !== null && (
              <Link to={`/runs/${message.runId}`} className="underline">
                Run
              </Link>
            )}
          </div>
          <Markdown text={message.content} />
        </article>
      ))}
      {thread.isFollowing && <div className="text-center text-3xs text-muted-foreground">Loading newer messages…</div>}
      <div ref={end} />
    </div>
  );
}

function Composer({ conversation }: { conversation: ConversationResponse }) {
  const post = usePostMessage(conversation.conversation.id);
  const [content, setContent] = useState("");
  const active = conversation.activeRun !== null;
  const submit = () => {
    if (content.trim() === "") return;
    post.mutate({ content }, { onSuccess: () => setContent("") });
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      data-testid="composer"
    >
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
        placeholder={active ? "Steer the Orchestrator: the message is delivered to its next turn." : "A message for this Conversation. Start a Run below to get work done."}
        aria-label="message"
        rows={3}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-3xs text-muted-foreground">{active ? "The active Run's Orchestrator receives this as a typed input of its next turn." : "No Run is active: the message is recorded on the Conversation."}</span>
        {post.isError && <span className="text-2xs text-status-failed">{errorMessage(post.error)}</span>}
        <Button type="submit" size="sm" className="gap-1" disabled={post.isPending || content.trim() === ""} data-testid="send-message">
          <Send className="size-3.5" />
          Send
        </Button>
      </div>
    </form>
  );
}

function RunsList({ query }: { query: ReturnType<typeof useConversationRuns> }) {
  return (
    <section className="flex flex-col gap-2" data-testid="runs-list">
      <h2 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Runs</h2>
      <PagedList query={query} idOf={(run) => run.id} more={{ label: "Load older Runs", testId: "runs-more" }}>
        {(runs) => (
          <ul className="flex flex-col gap-1">
            {runs.map((run: Run) => (
              <li key={run.id}>
                <Link to={`/runs/${run.id}`} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted/40">
                  <StatusBadge status={run.status} />
                  <span className="truncate font-mono text-2xs text-muted-foreground">{run.id}</span>
                  <span className="flex-1" />
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {run.kind} · {timeAgo(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PagedList>
    </section>
  );
}

function StartRun({ conversation, workspace }: { conversation: ConversationResponse; workspace: WorkspaceResponse }) {
  const config = useConfig();
  const create = useCreateRun(conversation.conversation.id);
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [check, setCheck] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [maxCostUsd, setMaxCostUsd] = useState<string>("");
  const defaults = config.data?.defaults;
  const command = check ?? defaults?.completionCheck?.command ?? "";
  const disabled = conversation.activeRun !== null;
  const submit = () => {
    if (goal.trim() === "") return;
    const budget = defaults && maxCostUsd.trim() !== "" ? { ...defaults.budget, maxCostUsd: Number(maxCostUsd) } : undefined;
    create.mutate({ goal, completionCheck: command.trim() === "" ? null : { command: command.trim(), expectedExitCode: 0 }, ...(budget === undefined ? {} : { budget }) }, { onSuccess: (overview) => void navigate(`/runs/${overview.run.id}`) });
  };
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4" data-testid="start-run">
      <h2 className="text-sm font-medium">Start a Run</h2>
      {disabled ? (
        <Notice testId="start-run-blocked">
          A Run is already active in this Conversation. Follow it, steer it with a message, or wait for it to end before starting another.
        </Notice>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Describe the goal. The Orchestrator reads the Workspace, proposes Requirements for your review, plans the work, and runs it in isolated worktrees on <span className="font-mono">{workspace.defaultTarget?.kind === "branch" ? workspace.defaultTarget.branch : "the directory"}</span>; nothing touches your checkout until you sign off and publish.
          </p>
          <Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Add a --version flag to the CLI that prints the package version." aria-label="goal" rows={3} data-testid="goal" />
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Completion check (a command whose exit code decides completion)</span>
            <Input value={command} onChange={(event) => setCheck(event.target.value)} aria-label="completion check" className="h-8 font-mono text-xs" placeholder="npm test" />
          </label>
          <button type="button" className="self-start text-2xs text-muted-foreground underline" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "Hide" : "Show"} budget
          </button>
          {advanced && defaults && (
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Max cost (USD)</span>
                <Input value={maxCostUsd} onChange={(event) => setMaxCostUsd(event.target.value)} placeholder={String(defaults.budget.maxCostUsd)} aria-label="max cost" className="h-8 font-mono text-xs" inputMode="decimal" />
              </label>
              <div className="flex flex-col gap-1 text-3xs text-muted-foreground">
                <span>Orchestrator allocation per turn: ${defaults.orchestratorAllocation.costUsd}</span>
                <span>Final reserve (completion work): ${defaults.finalReserve.code.costUsd}</span>
                <span>Evaluator: {defaults.evaluator}</span>
              </div>
            </div>
          )}
          {create.isError && (
            <Notice tone="error" testId="start-run-error">
              {errorMessage(create.error)}
            </Notice>
          )}
          <div className="flex justify-end">
            <Button size="sm" className="gap-1" disabled={create.isPending || goal.trim() === ""} onClick={submit} data-testid="start-run-button">
              <Play className="size-3.5" />
              {create.isPending ? "Starting…" : "Start Run"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
