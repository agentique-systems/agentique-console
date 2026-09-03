import { useHealth } from "@/api/queries";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

/** The live connection and the process's admission, side by side: an operator sees at once when the console cannot take work. */
export function ConnectionStatus() {
  const status = useConnectionStore((s) => s.status);
  const health = useHealth();
  const admission = health.data?.admission ?? null;
  const problem = admission !== null && admission !== "ready";
  return (
    <div className="flex items-center gap-2" data-testid="connection-status" title={`events: ${status}; admission: ${admission ?? "unknown"}`}>
      <span className={cn("size-2 rounded-full", status === "open" ? "bg-status-completed" : status === "connecting" ? "bg-status-waiting" : "bg-status-failed")} aria-label={`event stream ${status}`} />
      <span className="text-muted-foreground">{status === "open" ? "live" : status === "connecting" ? "connecting" : "disconnected"}</span>
      {problem && (
        <span className="rounded-sm border border-status-failed/40 px-1.5 py-0.5 text-status-failed" data-testid="admission-warning">
          {admission === "recovery_incomplete" ? "recovery incomplete: restart the console" : admission === "stopping" ? "stopping" : "starting"}
        </span>
      )}
    </div>
  );
}
