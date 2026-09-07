import { useMemo } from "react";
import { Link } from "react-router";

import { LogView } from "@/components/log-view";
import { shortId } from "@/lib/format";
import { useOutputStore } from "@/stores/output";

/**
 * The transient provider output of the Run's running Attempts, as it streams:
 * display only, never stored, cleared on reconnect. `attemptId` narrows to one.
 */
export function LiveOutput({ runId, attemptId, maxHeight }: { runId: string; attemptId?: string; maxHeight?: string }) {
  // The store slice is selected as-is: a filtered array built inside the selector would be a new snapshot on every read.
  const byAttempt = useOutputStore((s) => s.byAttempt);
  const live = useMemo(() => Object.entries(byAttempt).filter(([id, o]) => o.runId === runId && (attemptId === undefined || id === attemptId)), [byAttempt, runId, attemptId]);
  if (live.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="live-output">
      {live.map(([id, output]) => (
        <div key={id} className="flex flex-col gap-1">
          {attemptId === undefined && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Attempt</span>
              <span className="font-mono">{shortId(id)}</span>
              <span aria-hidden>·</span>
              <Link to={`/runs/${runId}/plan/${output.invocationId}`} className="font-mono underline decoration-dotted underline-offset-2 hover:text-foreground">
                {shortId(output.invocationId)}
              </Link>
            </div>
          )}
          <LogView chunks={output.chunks} live title={`attempt ${shortId(id)}`} maxHeight={maxHeight ?? "14rem"} />
        </div>
      ))}
    </div>
  );
}

/** Whether any output is streaming for the Run right now. */
export function useHasLiveOutput(runId: string): boolean {
  const byAttempt = useOutputStore((s) => s.byAttempt);
  return useMemo(() => Object.values(byAttempt).some((o) => o.runId === runId), [byAttempt, runId]);
}
