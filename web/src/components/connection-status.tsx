import { useHealth } from "@/api/queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

/**
 * The live connection and the process's admission, side by side: an operator
 * sees at once when the console cannot take work. `compact` shows the dot alone.
 */
export function ConnectionStatus({ compact = false, className }: { compact?: boolean; className?: string }) {
  const status = useConnectionStore((s) => s.status);
  const health = useHealth();
  const admission = health.data?.admission ?? null;
  const problem = admission !== null && admission !== "ready";
  const label = status === "open" ? "live" : status === "connecting" ? "connecting" : "disconnected";
  const detail = status === "open" ? "Event stream connected; changes arrive as they happen." : status === "connecting" ? "Connecting to the event stream…" : "Event stream disconnected; reconnecting with the last sequence seen.";
  const admissionLabel = admission === "recovery_incomplete" ? "recovery incomplete: restart the console" : admission === "stopping" ? "stopping" : "starting";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-2 text-xs", className)} data-testid="connection-status" aria-live="polite">
          <span className={cn("size-2 shrink-0 rounded-full", status === "open" ? "console-live-dot bg-status-completed text-status-completed" : status === "connecting" ? "bg-status-waiting" : "bg-status-failed")} aria-label={`event stream ${label}`} role="img" />
          {!compact && <span className={cn("capitalize", status === "open" ? "text-muted-foreground" : "text-foreground")}>{label}</span>}
          {problem && (
            <span className="rounded-sm bg-status-failed/12 px-1.5 py-0.5 text-2xs font-medium text-status-failed" data-testid="admission-warning">
              {compact ? "!" : admissionLabel}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {detail}
        {problem && ` Admission: ${admissionLabel}.`}
      </TooltipContent>
    </Tooltip>
  );
}
