/**
 * The sessions sidebar: workspace header + switch, every session in the
 * workspace (server-sorted, newest activity first), the "new session" door
 * (draft posture — nothing persists until the first send), and the connection
 * dot footer.
 */
import { MessagesSquare, Plus } from "lucide-react";

import { useUserSessions, useWorkspaces } from "@/api/queries";
import type { UserSession } from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useConnectionStore, type ConnectionStatus } from "@/stores/connection";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

export function Sidebar() {
  const selectedWorkspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const clearScope = useScopeStore((s) => s.clear);
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find(
    (candidate) => candidate.id === selectedWorkspaceId,
  );

  const sessions = useUserSessions(selectedWorkspaceId);
  const activeId = useUiStore((s) => s.activeUserSessionId);
  const draftOpen = useUiStore((s) => s.draftOpen);
  const beginDraft = useUiStore((s) => s.beginDraft);

  const items = sessions.data ?? [];
  // The auto-land rule: with no explicit pick, the conversation column shows
  // the most recent row — the highlight must agree with it.
  const effectiveActiveId = draftOpen ? null : (activeId ?? items[0]?.id);

  return (
    <div
      data-testid="sidebar"
      className="flex min-h-0 flex-col border-r border-border bg-sidebar"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {workspace?.name ?? "—"}
        </span>
        <Button variant="ghost" size="xs" onClick={clearScope}>
          switch
        </Button>
      </div>

      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Sessions
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-[11px]"
          data-testid="new-session"
          onClick={beginDraft}
        >
          <Plus className="size-3" /> new
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !draftOpen ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <MessagesSquare className="size-6 text-muted-foreground" />
            <div className="text-[11px] text-muted-foreground">
              No sessions yet — start one and tell the orchestrator what you
              want done.
            </div>
          </div>
        ) : (
          <ul>
            {draftOpen && (
              <li className="border-b border-border/50 bg-accent/40 px-3 py-2 text-[11px] italic text-muted-foreground">
                drafting a new session…
              </li>
            )}
            {items.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === effectiveActiveId}
              />
            ))}
          </ul>
        )}
      </div>

      <ConnectionFooter />
    </div>
  );
}

function SessionRow({
  session,
  active,
}: {
  session: UserSession;
  active: boolean;
}) {
  const openSession = useUiStore((s) => s.openSession);
  // Attention is a CLIENT-SIDE derivation: the list endpoint doesn't carry
  // pending interactions, and a GET /:id per row would be wasteful — so the
  // event router maintains ui.awaitingInput from question.asked/plan.proposed
  // (set) and answered/resolved/message (clear). See stores/ui.ts.
  const awaiting = useUiStore((s) => s.awaitingInput.has(session.id));
  const archived = session.status === "archived";

  return (
    <li>
      <button
        type="button"
        data-session-row={session.id}
        className={cn(
          "flex w-full flex-col gap-0.5 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-accent",
          active && "bg-accent",
          archived && "opacity-60",
        )}
        onClick={() => openSession(session.id)}
      >
        <span className="flex items-center gap-1.5">
          {awaiting && !archived && (
            <span
              aria-label="needs you"
              className="size-1.5 shrink-0 rounded-full bg-attention"
            />
          )}
          <span
            className={cn(
              "truncate text-[12px]",
              session.title === null && "italic text-muted-foreground",
            )}
          >
            {session.title ?? "untitled"}
          </span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(session.updatedAt)}
        </span>
      </button>
    </li>
  );
}

const CONNECTION_DOT: Record<ConnectionStatus, string> = {
  open: "bg-status-completed",
  connecting: "bg-status-waiting",
  closed: "bg-status-failed",
};
const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  open: "live",
  connecting: "connecting…",
  closed: "offline",
};

function ConnectionFooter() {
  const status = useConnectionStore((s) => s.status);
  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      <span
        aria-label={`connection ${status}`}
        className={cn("size-1.5 rounded-full", CONNECTION_DOT[status])}
      />
      {CONNECTION_LABEL[status]}
    </div>
  );
}
