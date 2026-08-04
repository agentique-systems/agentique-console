/**
 * The conversation header: inline-editable title, the phase chip while gated,
 * the transcript export, and the busy spinner. Busy is fold-derived
 * (turn.started/settled + queuedJobs), not guessed from HTTP in-flight state.
 * Mode switching and interrupting live in the composer, next to the textarea
 * they act on.
 */
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { usePatchUserSession } from "@/api/mutations";
import type { SessionMode, UserSession } from "@agentique-console/shared";
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

/** Shared by the composer and the draft view — the one mode picker. */
export function ModeToggle({
  mode,
  disabled = false,
  onChange,
}: {
  mode: SessionMode;
  disabled?: boolean;
  onChange: (mode: SessionMode) => void;
}) {
  return (
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
}

export function SessionHeader({
  session,
  busy,
}: {
  session: UserSession;
  busy: boolean;
}) {
  const patch = usePatchUserSession();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

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
        {busy && <Spinner className="size-3.5 text-status-running" />}

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
