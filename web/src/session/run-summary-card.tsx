/**
 * The end-of-run card: what the Console believes it built, and the operator's
 * verdict on it.
 *
 * Modelled on PlanCard deliberately: same skeleton, same two verbs, same
 * attention border while unresolved. The one that says "your call" should look
 * like the other one that says "your call".
 */
import { useState } from "react";
import { CheckCircle2Icon, CheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { useResolveSignoff } from "@/api/mutations";
import { useRunSummaryDocument } from "@/api/queries";
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
  infeasible: "infeasible",
};

const VERDICT_TONE: Record<RunSummaryStats["verdict"], string> = {
  completed: "text-status-completed",
  completed_with_caveats: "text-status-waiting",
  failed: "text-status-failed",
  infeasible: "text-status-failed",
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

/**
 * Main's criteria→evidence record beside the console's facts, fetched on
 * expand. A null justification renders as an EXPLICIT omission line — a
 * visible absence, deliberately never a blocker.
 */
function JustificationDisclosure({ sessionId, summaryId }: { sessionId: string; summaryId: string }) {
  const [open, setOpen] = useState(false);
  const summary = useRunSummaryDocument(sessionId, summaryId, open);
  const document = summary.data?.document;
  return (
    <div className="mt-2">
      <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => setOpen((value) => !value)}>
        {open ? "hide" : "show"} completion justification
      </button>
      {open && (
        summary.isLoading ? <p className="mt-1 text-2xs text-muted-foreground">Loading…</p>
        : document === undefined ? <p className="mt-1 text-2xs text-muted-foreground">Unavailable.</p>
        : (
          <div className="mt-1 space-y-2 text-2xs" data-testid="run-summary-justification">
            {/* `!= null`: summaries persisted before this field existed have no key at all. */}
            {document.requirements != null && (
              <div>
                <p className="font-medium">Requirements (rev {document.requirements.revision}) at proposal:</p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-3xs text-muted-foreground">{document.requirements.outline}</pre>
                {(document.requirements.verificationGaps ?? []).length > 0 && (
                  <p className="mt-1 text-status-waiting">
                    Satisfied below their declared verification:{" "}
                    {(document.requirements.verificationGaps ?? [])
                      .map((gap) => `${gap.requirementId} (needs ${gap.expected}, claimed ${gap.recorded.verifiedBy})`)
                      .join("; ")}
                  </p>
                )}
              </div>
            )}
            {document.justification === null ? (
              <p className="text-status-waiting">main recorded no completion justification — the console's facts above stand alone.</p>
            ) : (
              <ul className="space-y-1">
                {document.justification.criteria.map((criterion, index) => (
                  <li key={criterion.requirement ?? criterion.criterion ?? index} className="flex items-start gap-1">
                    {criterion.met ? <CheckIcon className="mt-0.5 size-3 shrink-0 text-status-completed" /> : <XIcon className="mt-0.5 size-3 shrink-0 text-status-failed" />}
                    <span>
                      {criterion.requirement !== undefined && (
                        <span className="mr-1 font-mono text-3xs text-muted-foreground">{criterion.requirement}</span>
                      )}
                      {criterion.statement ?? criterion.criterion ?? criterion.requirement}
                      {criterion.evidence.length > 0 && (
                        <span className="ml-1 text-muted-foreground">
                          ({criterion.evidence.map((reference) => `${reference.kind}:${reference.ref}`).join(", ")})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {document.justification !== null && document.justification.knownGaps.length > 0 && (
              <p><span className="font-medium">Known gaps:</span> {document.justification.knownGaps.join("; ")}</p>
            )}
            {document.justification !== null && document.justification.nonGoals.length > 0 && (
              <p><span className="font-medium">Non-goals:</span> {document.justification.nonGoals.join("; ")}</p>
            )}
            {document.deviations.length > 0 && (
              <p><span className="font-medium">Deviations:</span> {document.deviations.join("; ")}</p>
            )}
            {document.uncertainty.length > 0 && (
              <p><span className="font-medium">Open uncertainty:</span> {document.uncertainty.join("; ")}</p>
            )}
          </div>
        )
      )}
    </div>
  );
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
        <JustificationDisclosure sessionId={sessionId} summaryId={item.summaryId} />
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
