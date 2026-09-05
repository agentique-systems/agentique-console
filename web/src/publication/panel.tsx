import { useState } from "react";
import { CheckIcon, PenLineIcon, RocketIcon, ShieldCheckIcon } from "lucide-react";
import { Link } from "react-router";
import type { PublicationView, RunOverview } from "@agentique-console/core";

import { usePublicationActions, useSignoffActions } from "@/api/mutations";
import { useRunPublications, useRunSignoff } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Callout } from "@/components/callout";
import { IdChip } from "@/components/id-chip";
import { KeyValue } from "@/components/key-value";
import { Panel, Section, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { count, usage, words } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Signoff and publication: two separate operator actions, each through its own service, never one click for both. */
export function PublicationPanel({ overview }: { overview: RunOverview }) {
  return (
    <div className="flex flex-col gap-6">
      <Steps overview={overview} />
      <SignoffSection overview={overview} />
      <PublicationSection overview={overview} />
    </div>
  );
}

type StepState = "done" | "current" | "todo" | "failed";

/** Where the Run is on its way out: verified, signed off, published. */
function Steps({ overview }: { overview: RunOverview }) {
  const p = overview.phase;
  const verified: StepState = ["awaiting_signoff", "completed_unpublished", "publishing", "publish_failed", "publish_unsupported", "published"].includes(p) ? "done" : p === "verifying" ? "current" : p === "failed" ? "failed" : "todo";
  const signed: StepState = ["completed_unpublished", "publishing", "publish_failed", "publish_unsupported", "published"].includes(p) ? "done" : p === "awaiting_signoff" ? "current" : "todo";
  const published: StepState = p === "published" ? "done" : p === "publishing" ? "current" : p === "publish_failed" ? "failed" : "todo";
  const steps: { label: string; state: StepState; Icon: typeof CheckIcon }[] = [
    { label: verified === "done" ? "Verified" : "Verification", state: verified, Icon: ShieldCheckIcon },
    { label: signed === "done" ? "Signed off" : "Signoff", state: signed, Icon: PenLineIcon },
    { label: p === "publish_unsupported" ? "Publication not supported" : published === "done" ? "Published" : "Publication", state: p === "publish_unsupported" ? "todo" : published, Icon: RocketIcon },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Signoff and publication steps">
      {steps.map((step, i) => (
        <li key={step.label} className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
              step.state === "done" && "border-status-completed/50 bg-status-completed/10 text-status-completed",
              step.state === "current" && "border-status-waiting/50 bg-status-waiting/10 font-medium text-status-waiting",
              step.state === "failed" && "border-status-failed/50 bg-status-failed/10 text-status-failed",
              step.state === "todo" && "border-border text-muted-foreground",
            )}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            {step.state === "done" ? <CheckIcon className="size-3.5" /> : <step.Icon className="size-3.5" />}
            {step.label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function SignoffSection({ overview }: { overview: RunOverview }) {
  const signoff = useRunSignoff(overview.run.id);
  const actions = useSignoffActions(overview.run.id);
  const [message, setMessage] = useState("");
  const [confirmAccept, setConfirmAccept] = useState(false);
  return (
    <Section card title="Signoff" description="Accepting records the final Changeset and completes the Run. It does not publish anything.">
      <Panel query={signoff} skeleton={<Skeleton className="h-24" />}>
        {(s) => {
          if (s.signoff === null) {
            return (
              <Callout tone={overview.run.status === "completed" ? "success" : "info"} testId="signoff-none">
                {overview.run.status === "completed" ? "Signed off." : "The Run has not reached its signoff boundary yet: signoff opens once the completion check and Gate Evaluator pass."}
              </Callout>
            );
          }
          const view = s.signoff;
          const open = view.allowedActions.length > 0;
          return (
            <div className="flex flex-col gap-4" data-testid="signoff">
              <KeyValue
                columns={2}
                dense
                items={[
                  { label: "Signoff Gate", value: <StatusBadge status={view.gate.status} /> },
                  { label: "Resolution", value: view.resolution === null ? "open" : <span>{words(view.resolution.outcome)} <RelativeTime iso={view.resolution.resolvedAt} className="text-muted-foreground" /></span> },
                  { label: "Verified Snapshot", value: <IdChip id={view.verifiedSnapshotId} /> },
                  { label: "Usage", value: usage(view.usage), mono: true },
                  { label: "Final report", value: <ArtifactLink artifactId={view.report.artifactId} label={view.report.title ?? "Open the final report"} /> },
                  { label: "Candidate Artifacts", value: view.candidate.length === 0 ? null : count(view.candidate.length, "Artifact") },
                ]}
              />
              <div className="flex flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Requirements at this Gate</span>
                <ul className="flex flex-wrap gap-1.5">
                  {view.requirements.map((r) => (
                    <li key={r.requirementId} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
                      <StatusBadge status={r.status} />
                      <span className="font-mono text-2xs text-muted-foreground">{r.requirementId.slice(0, 12)}</span>
                      {r.waiverDecisionId !== null && <span className="text-2xs text-muted-foreground">waived</span>}
                    </li>
                  ))}
                </ul>
              </div>
              {view.blockers.length > 0 && (
                <Callout tone="warning" testId="signoff-blockers" title="Signoff cannot be accepted now">
                  {view.blockers.map((b) => (typeof b === "object" && b !== null && "kind" in b ? words(String((b as { kind: string }).kind)) : String(b))).join(", ")}
                </Callout>
              )}
              {open && (
                <div className="flex flex-col gap-3 rounded-lg border border-status-waiting/40 bg-status-waiting/5 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <AlertDialog open={confirmAccept} onOpenChange={setConfirmAccept}>
                      <Button size="sm" onClick={() => setConfirmAccept(true)} disabled={actions.accept.isPending} data-testid="signoff-accept">
                        <CheckIcon />
                        Accept the result
                      </Button>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Accept the verified result?</AlertDialogTitle>
                          <AlertDialogDescription>This records the final Changeset and completes the Run. Nothing is published: the Target moves only when you request a publication and confirm it.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Not yet</AlertDialogCancel>
                          <AlertDialogAction onClick={() => actions.accept.mutate({ gateId: view.gate.id, decisionId: view.decision.id })} data-testid="signoff-accept-confirm">
                            Accept and complete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <span className="text-xs text-muted-foreground">Review the final report first; acceptance is final for this Run.</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="What should change? Your message becomes the Orchestrator's next input." aria-label="change request" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => actions.requestChanges.mutate({ gateId: view.gate.id, decisionId: view.decision.id, message })} disabled={actions.requestChanges.isPending || message.trim() === ""} data-testid="signoff-request-changes">
                        Request changes
                      </Button>
                      <span className="text-2xs text-muted-foreground">Reopens the work; a new completion cycle follows.</span>
                      {(actions.accept.isError || actions.requestChanges.isError) && <span className="text-xs text-status-failed">{errorMessage(actions.accept.error ?? actions.requestChanges.error)}</span>}
                    </div>
                  </div>
                </div>
              )}
              {s.resolutions.length > 1 && <p className="text-2xs text-muted-foreground">{count(s.resolutions.length, "signoff resolution")} recorded for this Run.</p>}
            </div>
          );
        }}
      </Panel>
    </Section>
  );
}

function PublicationSection({ overview }: { overview: RunOverview }) {
  const publications = useRunPublications(overview.run.id);
  const actions = usePublicationActions(overview.run.id);
  return (
    <Section card title="Publication" description="A separate, receipted step: the Target is updated once, atomically, only after you confirm.">
      <Panel query={publications} skeleton={<Skeleton className="h-20" />}>
        {(p) => (
          <div className="flex flex-col gap-3" data-testid="publication">
            {!p.capability.supported && (
              <Callout tone="warning" testId="publication-unsupported" title={`This ${overview.workspace.kind} Workspace cannot be published`}>
                {p.capability.reason}. The accepted result stays available as the final Changeset below and in the Run's Integration Workspace.
              </Callout>
            )}
            {p.runStatus !== "completed" && <Callout tone="info" testId="publication-not-yet">Publication becomes available once the Run is signed off and completed.</Callout>}
            {p.capability.supported && p.runStatus === "completed" && p.allowedActions.includes("request_publish") && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
                <Button size="sm" onClick={() => actions.request.mutate({ requestedStrategy: { kind: "automatic" } })} disabled={actions.request.isPending} data-testid="publish-request">
                  <RocketIcon />
                  Publish to {p.target.kind === "branch" ? p.target.branch : "the directory"}
                </Button>
                <span className="text-xs text-muted-foreground">Opens a publish Decision; the Target moves only after you confirm it. Strategy: {p.capability.strategies.join(" or ") || "automatic"}.</span>
              </div>
            )}
            {p.openDecision !== null && (
              <Callout
                tone="warning"
                title="Confirm the publication"
                testId="publish-decision"
                action={
                  <span className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => actions.resolve.mutate({ decisionId: p.openDecision!.decisionId, body: { option: "cancel" } })} disabled={actions.resolve.isPending}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => actions.resolve.mutate({ decisionId: p.openDecision!.decisionId, body: { option: "publish" } })} disabled={actions.resolve.isPending} data-testid="publish-confirm">
                      <RocketIcon />
                      Publish
                    </Button>
                  </span>
                }
              >
                Strategy {p.openDecision.requestedStrategy.kind}. The candidate is prepared and verified first; a Target that moved meanwhile refuses the update and leaves everything unchanged.
              </Callout>
            )}
            {(actions.request.isError || actions.resolve.isError || actions.advance.isError) && <Callout tone="error">{errorMessage(actions.request.error ?? actions.resolve.error ?? actions.advance.error)}</Callout>}
            {p.finalChangesetId !== null && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Final Changeset</span>
                <IdChip id={p.finalChangesetId} />
                <ArtifactLink changesetId={p.finalChangesetId} label="View the diff" runId={overview.run.id} />
                {p.finalSnapshotId !== null && (
                  <span className="text-2xs text-muted-foreground">
                    · Snapshot <IdChip id={p.finalSnapshotId} />
                  </span>
                )}
              </div>
            )}
            {p.publications.length > 0 && (
              <ul className="flex flex-col gap-2">
                {p.publications.map((view) => (
                  <PublicationCard key={view.publication.id} view={view} onRetry={() => actions.advance.mutate(view.publication.id)} retrying={actions.advance.isPending} />
                ))}
              </ul>
            )}
            {p.runStatus === "completed" && p.capability.supported && p.publications.length === 0 && p.openDecision === null && (
              <p className="text-2xs text-muted-foreground">
                No publication yet. Nothing has touched <span className="font-mono">{p.target.kind === "branch" ? p.target.branch : "the directory"}</span>.
              </p>
            )}
            {!p.capability.supported && overview.run.integrationWorkspacePath !== null && (
              <p className="text-2xs text-muted-foreground">
                Integration Workspace: <span className="font-mono">{overview.run.integrationWorkspacePath}</span>
              </p>
            )}
            <p className="text-2xs text-muted-foreground">
              Every Publication is also a Decision; see <Link to={`/runs/${overview.run.id}/decisions`} className="underline decoration-dotted hover:text-foreground">Decisions</Link> for the record.
            </p>
          </div>
        )}
      </Panel>
    </Section>
  );
}

function PublicationCard({ view, onRetry, retrying }: { view: PublicationView; onRetry: () => void; retrying: boolean }) {
  const { publication, report } = view;
  const terminal = publication.status === "succeeded" || publication.status === "failed";
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm" data-publication={publication.id} data-status={publication.status}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={publication.status} variant="pill" />
        <span className="font-medium">{describeStatus(publication.status)}</span>
        <span className="text-2xs text-muted-foreground">
          {publication.strategy?.kind ?? publication.requestedStrategy.kind} · <RelativeTime iso={publication.createdAt} />
        </span>
        {!terminal && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry} disabled={retrying} data-testid="publish-advance">
            Retry now
          </Button>
        )}
      </div>
      {publication.failure !== null && <div className="text-xs text-status-failed">{describeFailure(publication.failure)}</div>}
      {report !== null && report.checkout !== null && <div className="text-xs text-muted-foreground">{describeCheckout(report.checkout)}</div>}
      <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
        {publication.targetBeforeSnapshotId !== null && (
          <span>
            before <IdChip id={publication.targetBeforeSnapshotId} copy={false} />
          </span>
        )}
        {publication.targetAfterSnapshotId !== null && (
          <span>
            after <IdChip id={publication.targetAfterSnapshotId} copy={false} />
          </span>
        )}
        {publication.reportArtifactId !== null && <ArtifactLink artifactId={publication.reportArtifactId} label="Publication report" />}
      </div>
    </li>
  );
}

function describeStatus(status: PublicationView["publication"]["status"]): string {
  switch (status) {
    case "requested":
      return "Preparing the candidate";
    case "prepared":
      return "Verifying the candidate";
    case "verified":
      return "Committing to the Target update";
    case "applying":
      return "Applying to the Target";
    case "succeeded":
      return "Published: the Target holds the accepted result";
    case "failed":
      return "Failed: the Target was not changed by this Publication";
  }
}

function describeFailure(failure: NonNullable<PublicationView["publication"]["failure"]>): string {
  switch (failure.kind) {
    case "strategy_unsupported":
      return `The ${failure.strategy.kind === "other" ? failure.strategy.name : failure.strategy.kind} strategy is not supported for this Workspace.`;
    case "fast_forward_unavailable":
      return "The Target no longer equals the Run's base; a fast-forward is impossible. Request a new publication (automatic selects a merge) or start a new Run.";
    case "candidate_conflict":
      return "The accepted result conflicts with changes on the Target. Start a new Run to reconcile.";
    case "verification_failed":
      return `The completion check failed on the candidate (${failure.acceptanceCriterionIds.length} criteria). The Target is unchanged.`;
    case "target_changed":
      return "The Target moved between preparation and the update; nothing was applied. Request a new publication when the Target is settled.";
    case "candidate_invalid":
      return "The candidate could not be constructed from the accepted Changeset.";
  }
}

function describeCheckout(checkout: NonNullable<NonNullable<PublicationView["report"]>["checkout"]>): string {
  switch (checkout.kind) {
    case "synchronized":
      return "Your checkout of the Target branch was brought forward to the published result.";
    case "not_checked_out":
      return "The Target branch is not checked out in the Workspace; your working copy was not touched.";
    case "unknown":
      return "The Target update was recorded from its durable receipt after a restart; your checkout was not handled by that step.";
    case "unchanged":
      return checkout.reason === "local_changes"
        ? "Your checkout of the Target branch was left as it was because it carries local changes on a published path; the branch itself moved. Commit or stash your work, then check the branch out again."
        : checkout.reason === "head_moved"
          ? "Your checkout was left as it was because the branch had already moved again after the update."
          : "Your checkout was left as it was because the working-copy update could not run.";
  }
}
