import { useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { RunOverview } from "@agentique-console/core";
import { useRunControl } from "@/api/mutations";
import { errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";

/** Cancel, pause (soft or hard), and resume: the three operator controls, each through its canonical service. */
export function RunControls({ overview }: { overview: RunOverview }) {
  const control = useRunControl(overview.run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = overview.run.status;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const paused = overview.run.operatorPause !== null;
  const pausable = !terminal && status !== "created";
  const error = control.cancel.error ?? control.pause.error ?? control.resume.error;
  return (
    <div className="flex items-center gap-1" data-testid="run-controls">
      {error !== null && <span className="text-2xs text-status-failed">{errorMessage(error)}</span>}
      {pausable && !paused && (
        <>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => control.pause.mutate({ mode: "soft" })} disabled={control.pause.isPending} data-testid="pause-soft" title="Stop admitting new work; running Attempts finish">
            <Pause className="size-3.5" />
            Pause
          </Button>
          <Button size="sm" variant="ghost" onClick={() => control.pause.mutate({ mode: "hard" })} disabled={control.pause.isPending} data-testid="pause-hard" title="Also interrupt running Attempts (retried after resume)">
            Hard pause
          </Button>
        </>
      )}
      {pausable && paused && (
        <Button size="sm" variant="outline" className="gap-1" onClick={() => control.resume.mutate()} disabled={control.resume.isPending} data-testid="resume">
          <Play className="size-3.5" />
          Resume ({overview.run.operatorPause})
        </Button>
      )}
      {!terminal &&
        (confirmCancel ? (
          <span className="flex items-center gap-1 text-xs">
            Cancel the Run?
            <Button size="sm" variant="destructive" onClick={() => control.cancel.mutate(undefined, { onSettled: () => setConfirmCancel(false) })} disabled={control.cancel.isPending} data-testid="cancel-confirm">
              Yes, cancel
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep running
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" className="gap-1 text-status-failed" onClick={() => setConfirmCancel(true)} data-testid="cancel">
            <Square className="size-3.5" />
            Cancel
          </Button>
        ))}
    </div>
  );
}
