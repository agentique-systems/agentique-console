/**
 * The end-of-run card: what the Console believes it built, and the operator's
 * verdict on it.
 *
 * Modelled on PlanCard deliberately: same skeleton, same two verbs, same
 * attention border while unresolved. The one that says "your call" should look
 * like the other one that says "your call".
 */
import { CheckCircle2Icon } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { useResolveSignoff } from "@/api/mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { RunSummaryStats } from "@agentique-console/shared";
import type { RunSummaryItem } from "./user-fold";

const VERDICT_LABEL: Record<RunSummaryStats["verdict"], string> = {
  completed: "completed",
  completed_with_caveats: "completed with caveats",
  failed: "failed",
};

const VERDICT_TONE: Record<RunSummaryStats["verdict"], string> = {
  completed: "text-status-completed",
  completed_with_caveats: "text-status-waiting",
  failed: "text-status-failed",
};

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

/**
 * A cost figure the operator can trust, or an honest admission that it is
 * partial. `coverage` is recorded-turns over observed-turns.
 */
function formatCost(usd: number | null, coverage: number): string {
  if (usd === null) return "cost not recorded";
  const amount = `$${usd.toFixed(2)}`;
  return coverage >= 0.9 ? amount : `~${amount} (partial)`;
}

export function RunSummaryCard({
  sessionId,
  item,
  onRequestChanges,
}: {
  sessionId: string;
  item: RunSummaryItem;
  /** Focuses the composer — the next chat message IS the change request. */
  onRequestChanges: () => void;
}) {
  const signoff = useResolveSignoff();
  const resolution = item.resolution;
  const resolved = resolution !== undefined;
  const { stats } = item;

  const accept = () => {
    signoff.mutate(
      { sessionId, body: { decision: "accept" } },
      {
        onError: (error) => {
          toast.error(
            error instanceof ApiError && error.status === 409
              ? "Already resolved elsewhere."
              : `Accept failed: ${error.message}`,
          );
        },
      },
    );
  };

  return (
    <Card
      data-testid="run-summary-card"
      className={cn("my-2", !resolved && "border-attention/50")}
    >
      <CardHeader>
        <CardEyebrow className={cn(!resolved && "text-attention")}>
          <CheckCircle2Icon className="size-3.5 shrink-0" />
          <span>{resolved ? "run complete" : "run complete — your call"}</span>
        </CardEyebrow>
        <Badge variant="outline" className={cn("text-3xs uppercase", VERDICT_TONE[stats.verdict])}>
          {VERDICT_LABEL[stats.verdict]}
        </Badge>
      </CardHeader>

      <CardContent className="pt-0">
        <p className="text-sm">{stats.headline}</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span>{stats.filesChanged} file{stats.filesChanged === 1 ? "" : "s"}</span>
          <span>{stats.tasks.completed}/{stats.tasks.total} tasks</span>
          <span>
            {formatDuration(stats.durationMs)}
            {stats.deadAirMs > 0 && ` (${formatDuration(stats.deadAirMs)} idle)`}
          </span>
          <span>{formatCost(stats.costUsd, stats.costCoverage)}</span>
          {stats.openUncertainty > 0 && (
            <span className="text-status-waiting">
              {stats.openUncertainty} open item{stats.openUncertainty === 1 ? "" : "s"}
            </span>
          )}
          {stats.reaped.seats > 0 && (
            <span>
              released {stats.reaped.seats} agent{stats.reaped.seats === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {resolution?.note !== undefined && (
          <div className="mt-2 text-2xs text-muted-foreground">note: {resolution.note}</div>
        )}
      </CardContent>

      <CardFooter className="pt-0">
        {resolved ? (
          <Badge
            variant="outline"
            className={cn(
              "text-3xs uppercase",
              resolution.decision === "accept" ? "text-status-completed" : "text-status-waiting",
            )}
          >
            {resolution.decision === "accept" ? "accepted" : "changes requested"}
          </Badge>
        ) : (
          <>
            <Button type="button" size="xs" onClick={accept} disabled={signoff.isPending}>
              {signoff.isPending && <Spinner className="size-3" />}
              Accept
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onRequestChanges} disabled={signoff.isPending}>
              Request changes
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
