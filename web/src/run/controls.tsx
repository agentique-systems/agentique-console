import { useState } from "react";
import { ChevronDownIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import type { RunOverview } from "@agentique-console/core";

import { useRunControl } from "@/api/mutations";
import { errorMessage } from "@/components/panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Cancel, pause (soft or hard), and resume: the three operator controls, each
 * through its canonical service. Pause is one click (soft); the hard variant
 * sits one menu away; cancelling asks first.
 */
export function RunControls({ overview }: { overview: RunOverview }) {
  const control = useRunControl(overview.run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = overview.run.status;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const paused = overview.run.operatorPause !== null;
  const pausable = !terminal && status !== "created";
  const fail = (error: unknown) => toast.error(errorMessage(error));
  return (
    <div className="flex items-center gap-1.5" data-testid="run-controls">
      {pausable && !paused && (
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-r-none border-r-0" onClick={() => control.pause.mutate({ mode: "soft" }, { onError: fail })} disabled={control.pause.isPending} data-testid="pause-soft">
                <PauseIcon />
                Pause
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop admitting new work; running Attempts finish.</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="outline" className="rounded-l-none" aria-label="Pause options" disabled={control.pause.isPending} data-testid="pause-menu">
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem onSelect={() => control.pause.mutate({ mode: "soft" }, { onError: fail })} className="flex-col items-start gap-0.5">
                <span className="font-medium">Pause</span>
                <span className="text-xs text-muted-foreground">Stop admitting new work; running Attempts finish and their results are kept.</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => control.pause.mutate({ mode: "hard" }, { onError: fail })} className="flex-col items-start gap-0.5" data-testid="pause-hard">
                <span className="font-medium">Hard pause</span>
                <span className="text-xs text-muted-foreground">Also interrupt running Attempts now; they are retried after you resume.</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {pausable && paused && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" onClick={() => control.resume.mutate(undefined, { onError: fail })} disabled={control.resume.isPending} data-testid="resume">
              <PlayIcon />
              Resume
            </Button>
          </TooltipTrigger>
          <TooltipContent>{overview.run.operatorPause === "hard" ? "Hard-paused: interrupted Attempts retry once resumed." : "Soft-paused: new work resumes admission."}</TooltipContent>
        </Tooltip>
      )}
      {!terminal && (
        <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-status-failed" onClick={() => setConfirmCancel(true)} data-testid="cancel">
                <SquareIcon />
                Cancel
              </Button>
            </TooltipTrigger>
            <TooltipContent>End the Run; nothing is published.</TooltipContent>
          </Tooltip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this Run?</AlertDialogTitle>
              <AlertDialogDescription>Running Attempts are interrupted and the Run ends as cancelled. Its worktrees are released; the Target is not touched. This cannot be undone, but a new Run can start from the same Conversation.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep running</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => control.cancel.mutate(undefined, { onError: fail })} disabled={control.cancel.isPending} data-testid="cancel-confirm">
                Cancel the Run
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
