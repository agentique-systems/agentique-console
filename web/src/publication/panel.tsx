import { useState } from "react";
import type { PublicationView, RunOverview } from "@agentique-console/core";
import { usePublicationActions, useSignoffActions } from "@/api/mutations";
import { useRunPublications, useRunSignoff } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Facts, Notice, Panel, Section, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo, usage } from "@/lib/format";

/** Signoff and publication: two separate operator actions, each through its own service, never one click for both. */
export function PublicationPanel({ overview }: { overview: RunOverview }) {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <SignoffSection overview={overview} />
      <PublicationSection overview={overview} />
    </div>
  );
}

function SignoffSection({ overview }: { overview: RunOverview }) {
  const signoff = useRunSignoff(overview.run.id);
  const actions = useSignoffActions(overview.run.id);
  const [message, setMessage] = useState("");
  return (
    <Section title="Signoff">
      <Panel query={signoff}>
        {(s) => {
          if (s.signoff === null) {
            return <Notice testId="signoff-none">{overview.run.status === "completed" ? "Signed off." : "The Run has not reached its signoff boundary yet: signoff opens once the completion check and Gate Evaluator pass."}</Notice>;
          }
          const view = s.signoff;
          const open = view.allowedActions.length > 0;
          return (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-xs" data-testid="signoff">
              <Facts
                items={[
                  ["Gate", <StatusBadge key="g" status={view.gate.status} />],
                  ["Verified Snapshot", view.verifiedSnapshotId],
                  ["Requirements", view.requirements.map((r) => `${r.requirementId.slice(0, 12)}: ${r.status}`).join("; ")],
                  ["Usage", usage(view.usage)],
                  ["Report", <ArtifactLink key="r" artifactId={view.report.artifactId} label="final report" />],
                  ["Resolution", view.resolution === null ? "open" : `${view.resolution.outcome} at ${timeAgo(view.resolution.resolvedAt)}`],
                ]}
              />
              {view.blockers.length > 0 && (
                <Notice tone="warning" testId="signoff-blockers">
                  Signoff cannot be accepted now: {view.blockers.map((b) => (typeof b === "object" && b !== null && "kind" in b ? String((b as { kind: string }).kind) : String(b))).join(", ")}
                </Notice>
              )}
              {open && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => actions.accept.mutate({ gateId: view.gate.id, decisionId: view.decision.id })} disabled={actions.accept.isPending} data-testid="signoff-accept">
                      Accept the result
                    </Button>
                    <span className="text-muted-foreground">Accepting records the final Changeset and completes the Run. It does not publish.</span>
                  </div>
                  <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="What should change? (required to request changes)" aria-label="change request" />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => actions.requestChanges.mutate({ gateId: view.gate.id, decisionId: view.decision.id, message })} disabled={actions.requestChanges.isPending || message.trim() === ""} data-testid="signoff-request-changes">
                      Request changes
                    </Button>
                    {(actions.accept.isError || actions.requestChanges.isError) && <span className="text-status-failed">{errorMessage(actions.accept.error ?? actions.requestChanges.error)}</span>}
                  </div>
                </div>
              )}
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
    <Section title="Publication">
      <Panel query={publications}>
        {(p) => (
          <div className="flex flex-col gap-3" data-testid="publication">
            {!p.capability.supported && (
              <Notice tone="warning" testId="publication-unsupported">
                This {overview.workspace.kind} Workspace cannot be published: {p.capability.reason}. The accepted result stays available as the final Changeset below and in the Run's Integration Workspace.
              </Notice>
            )}
            {p.runStatus !== "completed" && <Notice testId="publication-not-yet">Publication becomes available once the Run is signed off and completed.</Notice>}
            {p.capability.supported && p.runStatus === "completed" && p.allowedActions.includes("request_publish") && (
              <div className="flex items-center gap-2 text-xs">
                <Button size="sm" onClick={() => actions.request.mutate({ requestedStrategy: { kind: "automatic" } })} disabled={actions.request.isPending} data-testid="publish-request">
                  Publish to {p.target.kind === "branch" ? p.target.branch : "the directory"}
                </Button>
                <span className="text-muted-foreground">Opens a publish Decision; the Target moves only after you confirm it, in one atomic update.</span>
              </div>
            )}
            {p.openDecision !== null && (
              <div className="flex items-center gap-2 rounded-md border border-status-waiting/40 p-2 text-xs" data-testid="publish-decision">
                <span className="flex-1">Confirm the publication ({p.openDecision.requestedStrategy.kind})? The candidate is prepared and verified first; a Target that moved meanwhile refuses the update.</span>
                <Button size="sm" onClick={() => actions.resolve.mutate({ decisionId: p.openDecision!.decisionId, body: { option: "publish" } })} disabled={actions.resolve.isPending} data-testid="publish-confirm">
                  Publish
                </Button>
                <Button size="sm" variant="ghost" onClick={() => actions.resolve.mutate({ decisionId: p.openDecision!.decisionId, body: { option: "cancel" } })} disabled={actions.resolve.isPending}>
                  Cancel
                </Button>
              </div>
            )}
            {(actions.request.isError || actions.resolve.isError || actions.advance.isError) && <Notice tone="error">{errorMessage(actions.request.error ?? actions.resolve.error ?? actions.advance.error)}</Notice>}
            {p.finalChangesetId !== null && (
              <div className="text-xs">
                Final Changeset: <ArtifactLink changesetId={p.finalChangesetId} label="download the diff" runId={overview.run.id} />
              </div>
            )}
            {p.publications.map((view) => (
              <PublicationCard key={view.publication.id} view={view} onRetry={() => actions.advance.mutate(view.publication.id)} retrying={actions.advance.isPending} />
            ))}
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
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs" data-publication={publication.id} data-status={publication.status}>
      <div className="flex items-center gap-2">
        <StatusBadge status={publication.status} />
        <span className="font-medium">{describeStatus(publication.status)}</span>
        <span className="text-3xs text-muted-foreground">
          {publication.strategy?.kind ?? publication.requestedStrategy.kind} · {timeAgo(publication.createdAt)}
        </span>
        {!terminal && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry} disabled={retrying} data-testid="publish-advance">
            Retry now
          </Button>
        )}
      </div>
      {publication.failure !== null && <div className="text-status-failed">{describeFailure(publication.failure)}</div>}
      {report !== null && report.checkout !== null && <div className="text-muted-foreground">{describeCheckout(report.checkout)}</div>}
      {publication.reportArtifactId !== null && <ArtifactLink artifactId={publication.reportArtifactId} label="publication report" />}
    </div>
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
