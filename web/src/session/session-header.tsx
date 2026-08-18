/**
 * The conversation header: inline-editable title, the phase chip while gated,
 * the transcript export, and the session-state chip. The state is the shared
 * five-value model (`lib/session-state.ts`) — "working", "needs you",
 * "blocked", "done" and "ready" stopped being the same pixels. Mode switching
 * and interrupting live in the composer, next to the textarea they act on.
 */
import { ArchiveIcon, BellIcon, DownloadIcon, MoonIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { usePatchUserSession } from "@/api/mutations";
import type { SessionMode, UserSession } from "@agentique-console/shared";
import {
  SESSION_STATE_LABEL,
  type SessionState,
} from "@/lib/session-state";
import {
  downloadMarkdown,
  messagesToMarkdown,
} from "@/components/ai-elements/conversation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { userStreamKey } from "@/live/watched";
import { cn } from "@/lib/utils";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";

import { foldUserItems } from "./user-fold";

const MODES: readonly SessionMode[] = ["execute", "plan_execute"];
const MODE_LABEL: Record<SessionMode, string> = {
  execute: "execute",
  plan_execute: "plan + execute",
};

/** The Shift+Tab step. Two modes today, so cycling is a flip. */
export function nextMode(mode: SessionMode): SessionMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] as SessionMode;
}

/**
 * Shared by the composer and the draft view — the one mode picker. The
 * Shift+Tab gesture is taught by the tooltip rather than a line of text beside
 * it: the footer now carries a model chip too, and two chips plus a sentence
 * wrap at the panel widths the operator actually uses.
 */
export function ModeToggle({
  mode,
  disabled = false,
  onChange,
}: {
  mode: SessionMode;
  disabled?: boolean;
  onChange: (mode: SessionMode) => void;
}) {
  const group = (
    <div
      role="radiogroup"
      aria-label="session mode"
      className="flex items-center rounded-md border border-border p-0.5"
    >
      {MODES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="radio"
          aria-checked={candidate === mode}
          disabled={disabled}
          className={cn(
            "rounded-sm px-2 py-0.5 text-3xs uppercase tracking-wide transition-colors",
            candidate === mode
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
          onClick={() => {
            if (candidate !== mode) onChange(candidate);
          }}
        >
          {MODE_LABEL[candidate]}
        </button>
      ))}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{group}</TooltipTrigger>
      <TooltipContent>
        session mode
        <span className="ml-2 font-mono text-muted-foreground">shift+tab</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The one visual per state. `needs_you` uses --attention, not a status tone:
 * it is the only state that means "you, now", and it has a colour reserved.
 */
function StateChip({ state }: { state: SessionState }) {
  if (state === "working") return <Spinner className="size-3.5 text-status-running" />;
  if (state === "ready") return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-3xs uppercase",
        state === "needs_you" && "border-attention text-attention",
        state === "blocked" && "text-status-failed",
        state === "done" && "text-status-completed",
      )}
    >
      {SESSION_STATE_LABEL[state]}
    </Badge>
  );
}

export function SessionHeader({
  session,
  state,
}: {
  session: UserSession;
  state: SessionState;
}) {
  const patch = usePatchUserSession();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const busy = state === "working";
  // The Notification API only grants permission from a user gesture — asking
  // unprompted on load is exactly the dialog everyone reflexively declines.
  // One small bell, shown only while the choice is still open.
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  /**
   * Folded lazily, on click: the header renders on every stream tick, and
   * folding the whole transcript each time to keep an export button warm would
   * be a real cost for a rarely-used affordance.
   */
  const exportTranscript = () => {
    const stream =
      useUserSessionStreamsStore.getState().streams[userStreamKey(session.id)];
    const messages = foldUserItems(stream?.items ?? [])
      .filter((item) => item.type === "message" && item.kind !== "notice")
      .map((item) => {
        const message = item as Extract<typeof item, { type: "message" }>;
        return {
          role: message.speaker.name,
          parts: [{ type: "text", text: message.text }],
        };
      });

    if (messages.length === 0) {
      toast.error("Nothing to export yet.");
      return;
    }

    const slug = (session.title ?? session.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    downloadMarkdown(messagesToMarkdown(messages), `${slug || "transcript"}.md`);
  };

  const commitTitle = () => {
    setEditing(false);
    const title = draftTitle.trim();
    if (title === "" || title === session.title) return;
    patch.mutate(
      { id: session.id, title },
      {
        onError: (error) => toast.error(`Rename failed: ${error.message}`),
      },
    );
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      {editing ? (
        <input
          autoFocus
          value={draftTitle}
          aria-label="session title"
          className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-sm outline-none focus-visible:border-ring"
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
            if (event.key === "Escape") setEditing(false);
          }}
          onBlur={commitTitle}
        />
      ) : (
        <button
          type="button"
          title="rename this session"
          className={cn(
            "min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-foreground",
            session.title === null && "italic text-muted-foreground",
          )}
          onClick={() => {
            setDraftTitle(session.title ?? "");
            setEditing(true);
          }}
        >
          {session.title ?? "untitled"}
        </button>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <StateChip state={state} />

        {session.lifecycle === "open" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={session.autonomy === "away" ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={session.autonomy === "away" ? "away mode on — click to return" : "enable away mode"}
                aria-pressed={session.autonomy === "away"}
                disabled={patch.isPending}
                onClick={() => {
                  patch.mutate(
                    { id: session.id, autonomy: session.autonomy === "away" ? "standard" : "away" },
                    { onError: (error) => toast.error(`Autonomy change failed: ${error.message}`) },
                  );
                }}
              >
                <MoonIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {session.autonomy === "away"
                ? "away mode: the run proceeds on recommendations and queues only irreversible decisions"
                : "away mode: let the run proceed on recommendations while you are gone"}
            </TooltipContent>
          </Tooltip>
        )}

        {notifPermission === "default" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="enable desktop notifications"
                onClick={() => {
                  void Notification.requestPermission().then((granted) => setNotifPermission(granted));
                }}
              >
                <BellIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              get a desktop notification when a run needs you and this tab is hidden
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="export transcript"
              onClick={exportTranscript}
            >
              <DownloadIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>export transcript as markdown</TooltipContent>
        </Tooltip>

        {session.lifecycle === "open" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="archive this session"
                // Archiving reaps the run's agents, managed processes and
                // browsers — the only operator-driven end-of-run action.
                disabled={busy || patch.isPending}
                onClick={() => {
                  if (!window.confirm("Archive this session? Its agents stop and any servers they started are shut down.")) return;
                  patch.mutate(
                    { id: session.id, lifecycle: "archived" },
                    {
                      onSuccess: () => toast.success("Session archived."),
                      onError: () => toast.error("Could not archive the session."),
                    },
                  );
                }}
              >
                <ArchiveIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {busy ? "still working — interrupt before archiving" : "archive: stop the agents and reap their processes"}
            </TooltipContent>
          </Tooltip>
        )}

        {session.mode === "plan_execute" && (
          <Badge
            variant="outline"
            className={cn(
              "text-3xs uppercase",
              session.phase === "planning"
                ? "text-status-waiting"
                : "text-status-running",
            )}
          >
            {session.phase}
          </Badge>
        )}
      </div>
    </div>
  );
}
