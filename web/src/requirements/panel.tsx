import { useState } from "react";
import type { ProposedRequirement, RequirementProposal, RequirementView, RunOverview } from "@agentique-console/core";
import { useProposalReview } from "@/api/mutations";
import { useConversationRequirements, useRunProposals } from "@/api/queries";
import { PagedList } from "@/components/paging";
import { Notice, Panel, Section, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function RequirementsPanel({ overview }: { overview: RunOverview }) {
  const requirements = useConversationRequirements(overview.conversation.id);
  const proposals = useRunProposals(overview.run.id);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {/* The open proposal is the overview's own fact: never behind a page of history. */}
      {overview.openProposal !== null && <ProposalReview key={overview.openProposal.id} proposal={overview.openProposal} overview={overview} />}
      <Section title="Proposals (newest first)">
        <PagedList query={proposals} idOf={(p) => p.id} empty={<div className="px-3 py-4 text-xs text-muted-foreground">No proposal yet.</div>} more={{ label: "Load older proposals", testId: "proposals-more" }}>
          {(items) => (
            <ul className="flex flex-col gap-1 text-xs" data-testid="proposals">
              {items.map((p) => (
                <li key={p.id} className="flex items-center gap-2" data-proposal={p.id}>
                  <StatusBadge status={p.status} />
                  <span className="text-muted-foreground">
                    {p.entries.length} entr{p.entries.length === 1 ? "y" : "ies"} · {p.rationale}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PagedList>
      </Section>
      <Section title="Requirements (current revision)">
        <Panel query={requirements} empty={(r) => r.requirements.length === 0}>
          {(r) => (
            <div className="flex flex-col gap-1" data-testid="requirements-tree">
              <div className="text-3xs text-muted-foreground">Revision {r.revision?.number ?? "—"}</div>
              {r.requirements.map((view) => (
                <RequirementRow key={view.requirement.id} view={view} depth={depthOf(view, r.requirements)} />
              ))}
            </div>
          )}
        </Panel>
      </Section>
    </div>
  );
}

function depthOf(view: RequirementView, all: RequirementView[]): number {
  let depth = 0;
  let parent = view.entry?.parentId ?? null;
  while (parent !== null && depth < 20) {
    depth += 1;
    parent = all.find((v) => v.requirement.id === parent)?.entry?.parentId ?? null;
  }
  return depth;
}

function RequirementRow({ view, depth }: { view: RequirementView; depth: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs" style={{ marginLeft: depth * 16 }} data-requirement={view.requirement.id}>
      <div className="flex items-center gap-2">
        <StatusBadge status={view.requirement.status} />
        <span className="font-medium">{view.entry?.statement ?? "(not in the current revision)"}</span>
        {view.entry?.composition !== null && view.entry !== null && <span className="text-3xs text-muted-foreground">{view.entry.composition}</span>}
      </div>
      {view.criteria.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
          {view.criteria.map((c) => (
            <li key={c.id} className="font-mono">
              {c.check.kind === "deterministic" ? `$ ${c.check.command} (exit ${c.check.expectedExitCode})` : `evaluated: ${c.check.question}`}
            </li>
          ))}
        </ul>
      )}
      {view.history.length > 0 && <div className="text-3xs text-muted-foreground">last change: {view.history.at(-1)!.from} → {view.history.at(-1)!.to} by {view.history.at(-1)!.actor}</div>}
    </div>
  );
}

function ProposalReview({ proposal, overview }: { proposal: RequirementProposal; overview: RunOverview }) {
  const review = useProposalReview(overview.run.id, overview.conversation.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(proposal.entries, null, 2));
  const [rationale, setRationale] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const approve = () => {
    let entries: ProposedRequirement[] | undefined;
    if (editing) {
      try {
        entries = JSON.parse(draft) as ProposedRequirement[];
        setParseError(null);
      } catch (error) {
        setParseError(errorMessage(error));
        return;
      }
    }
    review.approve.mutate({ proposalId: proposal.id, body: { ...(entries === undefined ? {} : { entries }), rationale: rationale.trim() === "" ? null : rationale } });
  };
  return (
    <Section title="Proposed Requirements: your approval is needed">
      <div className="flex flex-col gap-3 rounded-md border border-status-waiting/40 p-3 text-xs" data-testid="proposal-review">
        <p className="text-muted-foreground">{proposal.rationale}</p>
        {!editing ? (
          <ul className="flex flex-col gap-1">
            {proposal.entries.map((entry) => (
              <li key={entry.key} className="flex flex-col" style={{ marginLeft: (entry.parentKey === null ? 0 : 1) * 16 }}>
                <span>
                  {entry.requirementId !== null ? <span className="mr-1 text-3xs text-muted-foreground">(kept)</span> : <span className="mr-1 text-3xs text-status-completed">(new)</span>}
                  {entry.statement}
                </span>
                {entry.acceptanceCriteria.map((check, i) => (
                  <span key={i} className="font-mono text-2xs text-muted-foreground">
                    {check.kind === "deterministic" ? `$ ${check.command}` : `evaluated: ${check.question}`}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} className="font-mono text-2xs" aria-label="edited proposal" />
        )}
        {parseError !== null && <span className="text-status-failed">{parseError}</span>}
        <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (optional)" rows={2} aria-label="rationale" />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={approve} disabled={review.approve.isPending} data-testid="proposal-approve">
            {editing ? "Approve edited" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
            {editing ? "Back to proposal" : "Edit before approving"}
          </Button>
          <Button size="sm" variant="ghost" className="text-status-failed" onClick={() => review.reject.mutate({ proposalId: proposal.id, body: { rationale: rationale.trim() === "" ? null : rationale } })} disabled={review.reject.isPending} data-testid="proposal-reject">
            Reject
          </Button>
          {(review.approve.isError || review.reject.isError) && <span className="text-status-failed">{errorMessage(review.approve.error ?? review.reject.error)}</span>}
        </div>
        <Notice>Approval creates a new Requirement revision (kept Requirements keep their ids); the Orchestrator learns the outcome in its next turn.</Notice>
      </div>
    </Section>
  );
}
