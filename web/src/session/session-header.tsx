/**
 * The conversation header: inline-editable title, the mode segment
 * (execute | plan_execute, with the phase chip while gated), the interrupt
 * button, and the busy spinner. Busy is fold-derived (turn.started/settled +
 * queuedJobs), not guessed from HTTP in-flight state.
 */
import { OctagonXIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  useInterruptUserSession,
  usePatchUserSession,
} from "@/api/mutations";
import type { SessionMode, UserSession } from "@agentique-console/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const MODES: readonly SessionMode[] = ["execute", "plan_execute"];
const MODE_LABEL: Record<SessionMode, string> = {
  execute: "execute",
  plan_execute: "plan + execute",
};

/** Shared by the header and the draft view — the one mode picker. */
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
            "rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors",
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
  const interrupt = useInterruptUserSession();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

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
          className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-sm outline-none focus-visible:border-ring"
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

        <ModeToggle
          mode={session.mode}
          disabled={patch.isPending || session.status === "archived"}
          onChange={(mode) =>
            patch.mutate(
              { id: session.id, mode },
              {
                onError: (error) =>
                  toast.error(`Mode change failed: ${error.message}`),
              },
            )
          }
        />
        {session.mode === "plan_execute" && (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase",
              session.phase === "planning"
                ? "text-status-waiting"
                : "text-status-running",
            )}
          >
            {session.phase}
          </Badge>
        )}

        <Button
          variant="ghost"
          size="xs"
          className="gap-1"
          disabled={!busy || interrupt.isPending}
          title={busy ? "interrupt the running turn" : "nothing running"}
          onClick={() =>
            interrupt.mutate(
              { id: session.id },
              {
                onError: (error) =>
                  toast.error(`Interrupt failed: ${error.message}`),
              },
            )
          }
        >
          <OctagonXIcon className="size-3.5" />
          interrupt
        </Button>
      </div>
    </div>
  );
}
