/**
 * The "still working" row for a participant that is busy but silent.
 *
 * A turn can spend minutes inside one provider call (retry backoff, rate
 * limits, a long tool), and a bare shimmer makes that indistinguishable from a
 * hang. This shows what the provider last said it was doing plus a ticking
 * elapsed clock, so waiting always looks different from stuck.
 */
import { useEffect, useState } from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import type { SeatRuntime } from "@/stores/runtime";

/** Elapsed time only becomes interesting once a turn stops feeling instant. */
const SHOW_ELAPSED_AFTER_MS = 5_000;

function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, now - since);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** What the seat is doing, in the operator's words rather than the SDK's. */
export function describeRuntime(name: string, runtime: SeatRuntime): string {
  if (runtime.detail !== undefined) return `${name} · ${runtime.detail}`;
  if (runtime.state === "tool") {
    return `${name} is running ${runtime.toolName ?? "a tool"}…`;
  }
  if (runtime.state === "responding") return `${name} is replying…`;
  if (runtime.state === "waiting") return `${name} is waiting…`;
  return `${name} is thinking…`;
}

export function WorkingLine({
  name,
  runtime,
}: {
  name: string;
  runtime: SeatRuntime;
}) {
  const elapsed = useElapsed(runtime.since);
  return (
    <div className="flex items-baseline gap-2 py-1">
      <Shimmer className="text-xs">{describeRuntime(name, runtime)}</Shimmer>
      {elapsed >= SHOW_ELAPSED_AFTER_MS && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}
