import { PauseIcon, PlayIcon } from "lucide-react";

import type { SystemPauseState } from "@agentique-console/shared";

import { usePauseSystem, useResumeSystem } from "@/api/mutations";
import { useSystemPause } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * The install-wide Pause. One switch for every lane: the main orchestrator
 * and every seat in every session. Pressing it interrupts in-flight turns
 * (their work redelivers on Resume) and mints nothing new anywhere; nothing
 * is cancelled. The same state also shows a capacity/budget pause, since the
 * server runs all three through one switch.
 */

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The banner's one line, per reason. Exported for the unit test. */
export function pauseLine(state: SystemPauseState): string {
  if (!state.paused || state.reason === null) return "";
  const since = state.since === null ? "" : ` since ${clock(state.since)}`;
  if (state.reason === "operator") return `Paused by operator${since} · nothing cancelled — queued work redelivers on Resume`;
  if (state.reason === "capacity") {
    const detail = state.detail === undefined ? "" : ` (${state.detail})`;
    const until = state.until === null ? "on the next probe" : `at ${clock(state.until)}`;
    return `Paused — provider capacity limit${detail} · resumes automatically ${until}`;
  }
  return `Paused — ${state.detail ?? "budget ceiling reached"} · raise the budget or Resume`;
}

const PAUSE_TITLE = "Pause the whole system: no new turns anywhere; in-flight turns are interrupted and their work redelivers on Resume. Nothing is cancelled.";
const RESUME_TITLE = "Resume: queued work redelivers, paused seats continue where they were.";

/** The top-bar toggle. Reads as "Pause" until the system is paused, then "Resume". */
export function SystemPauseControl() {
  const state = useSystemPause();
  const pause = usePauseSystem();
  const resume = useResumeSystem();
  const paused = state.data?.paused === true;
  const pending = pause.isPending || resume.isPending;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={paused}
      data-testid="system-pause-toggle"
      title={paused ? RESUME_TITLE : PAUSE_TITLE}
      disabled={pending || state.data === undefined}
      className={cn("text-2xs", paused && "border-attention text-attention")}
      onClick={() => { if (paused) resume.mutate(); else pause.mutate({ mode: "hard" }); }}
    >
      {pending ? <Spinner className="size-3" /> : paused ? <PlayIcon /> : <PauseIcon />}
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}

/** A full-width strip under the top bar while the system is paused; null otherwise. */
export function SystemPauseBanner() {
  const state = useSystemPause();
  const resume = useResumeSystem();
  if (state.data?.paused !== true) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="system-pause-banner"
      className="flex h-7 shrink-0 items-center gap-3 border-b border-attention/50 bg-attention/10 px-3 text-2xs"
    >
      <PauseIcon className="size-3 text-attention" />
      <span className="text-foreground">{pauseLine(state.data)}</span>
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="xs" className="text-2xs" disabled={resume.isPending} onClick={() => resume.mutate()}>
        {resume.isPending ? <Spinner className="size-3" /> : <PlayIcon />}
        Resume
      </Button>
    </div>
  );
}
