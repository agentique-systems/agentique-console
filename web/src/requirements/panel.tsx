import { useState } from "react";
import { ChevronDownIcon, ListChecksIcon, TerminalIcon, ScaleIcon } from "lucide-react";
import type { AcceptanceCheck, ProposedRequirement, RequirementProposal, RequirementView, RunOverview } from "@agentique-console/core";

import { useProposalReview } from "@/api/mutations";
import { useConversationRequirements, useRunProposals } from "@/api/queries";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { PagedList } from "@/components/paging";
import { Panel, Section, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { count, words } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RequirementsPanel({ overview }: { overview: RunOverview }) {
  const requirements = useConversationRequirements(overview.conversation.id);
  const proposals = useRunProposals(overview.run.id);
  return (
    <div className="flex flex-col gap-6">
      {/* The open proposal is the overview's own fact: never behind a page of history. */}
      {overview.openProposal !== null && <ProposalReview key={overview.openProposal.id} proposal={overview.openProposal} overview={overview} />}
      <Section title="Requirements" description="The current revision: what the Run must achieve, each with the checks that decide it.">
        <Panel query={requirements} skeleton={<Skeleton className="h-32" />}>
          {(r) => (
            <div className="flex flex-col gap-1.5" data-testid="requirements-tree">
              <div className="text-xs text-muted-foreground">Revision {r.revision?.number ?? "—"}{r.revision !== null && (<> · <RelativeTime iso={r.revision.createdAt} /></>)}</div>
              {r.requirements.length === 0 ? (
                <EmptyState compact icon={ListChecksIcon} title="No Requirements yet" description="The goal becomes the first Requirement when a Run starts; the Orchestrator proposes more." />
              ) : (
                r.requirements.map((view) => <RequirementRow key={view.requirement.id} view={view} depth={depthOf(view, r.requirements)} />)
              )}
            </div>
          )}
        </Panel>
      </Section>
      <Section title="Proposals" description="What the Orchestrator proposed, newest first, and what became of it.">
        <PagedList query={proposals} idOf={(p) => p.id} skeleton={<Skeleton className="h-16" />} empty={<p className="text-xs text-muted-foreground">No proposal yet.</p>} more={{ label: "Load older proposals", testId: "proposals-more" }}>
          {(items) => (
            <ul className="flex flex-col gap-1.5" data-testid="proposals">
              {items.map((p) => (
                <ProposalRow key={p.id} proposal={p} />
              ))}
            </ul>
          )}
        </PagedList>
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

function CheckChip({ check }: { check: AcceptanceCheck }) {
  return check.kind === "deterministic" ? (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground" title={`exit code ${check.expectedExitCode} expected`}>
      <TerminalIcon className="size-3 shrink-0" />
      <span className="truncate">{check.command}</span>
      <span className="opacity-70">→ {check.expectedExitCode}</span>
    </span>
  ) : (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground" title={check.rubric ?? undefined}>
      <ScaleIcon className="size-3 shrink-0" />
      <span className="truncate">{check.question}</span>
    </span>
  );
}

function RequirementRow({ view, depth }: { view: RequirementView; depth: number }) {
  const last = view.history.at(-1);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5" style={{ marginLeft: depth * 20 }} data-requirement={view.requirement.id}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={view.requirement.status} />
        <span className="min-w-0 flex-1 text-sm font-medium">{view.entry?.statement ?? "(not in the current revision)"}</span>
        {view.entry?.composition != null && <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground">{words(String(view.entry.composition))}</span>}
      </div>
      {view.criteria.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {view.criteria.map((c) => (
            <CheckChip key={c.id} check={c.check} />
          ))}
        </div>
      )}
      {last !== undefined && (
        <div className="text-2xs text-muted-foreground">
          {words(last.from)} → {words(last.to)} by {last.actor} <RelativeTime iso={last.createdAt} />
          {view.historyCount > 1 && ` · ${count(view.historyCount, "change")}`}
        </div>
      )}
    </div>
  );
}

function ProposalRow({ proposal }: { proposal: RequirementProposal }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border bg-card" data-proposal={proposal.id}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40">
        <StatusBadge status={proposal.status} />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {count(proposal.entries.length, "entry", "entries")} · {proposal.rationale}
        </span>
        <RelativeTime iso={proposal.createdAt} className="shrink-0 text-2xs text-muted-foreground" />
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-border-subtle px-3 py-2.5">
          <EntryList entries={proposal.entries} />
        </div>
      )}
    </li>
  );
}

function EntryList({ entries }: { entries: ProposedRequirement[] }) {
  const depth = (entry: ProposedRequirement): number => {
    let d = 0;
    let parent = entry.parentKey;
    while (parent !== null && d < 20) {
      d += 1;
      parent = entries.find((e) => e.key === parent)?.parentKey ?? null;
    }
    return d;
  };
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry) => (
        <li key={entry.key} className="flex flex-col gap-1" style={{ marginLeft: depth(entry) * 20 }} data-entry={entry.requirementId !== null ? "kept" : "new"}>
          <span className="flex items-start gap-2 text-sm">
            <span className={cn("mt-0.5 shrink-0 rounded-sm px-1 text-2xs font-medium", entry.requirementId !== null ? "bg-muted text-muted-foreground" : "bg-status-completed/12 text-status-completed")}>{entry.requirementId !== null ? "kept" : "new"}</span>
            <span className="min-w-0 flex-1">{entry.statement}</span>
          </span>
          {entry.acceptanceCriteria.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-10">
              {entry.acceptanceCriteria.map((check, i) => (
                <CheckChip key={i} check={check} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
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
  const kept = proposal.entries.filter((e) => e.requirementId !== null).length;
  return (
    <section className="surface-raised flex flex-col gap-3 rounded-lg border border-status-waiting/40 bg-card p-4" data-testid="proposal-review" aria-labelledby="proposal-title">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <ListChecksIcon className="size-4 text-alert" aria-hidden />
          <h2 id="proposal-title" className="text-sm font-semibold">
            Proposed Requirements need your approval
          </h2>
          <span className="text-2xs text-muted-foreground">
            {count(proposal.entries.length, "entry", "entries")} · {kept} kept · {proposal.entries.length - kept} new · <RelativeTime iso={proposal.createdAt} />
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{proposal.rationale}</p>
      </header>
      {!editing ? <EntryList entries={proposal.entries} /> : <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} className="font-mono text-xs" aria-label="edited proposal" />}
      {parseError !== null && <Callout tone="error">{parseError}</Callout>}
      <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (optional; recorded with your decision)" rows={2} aria-label="rationale" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={approve} disabled={review.approve.isPending} data-testid="proposal-approve">
          {review.approve.isPending ? "Approving…" : editing ? "Approve edited" : "Approve"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
          {editing ? "Back to the proposal" : "Edit before approving"}
        </Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-status-failed" onClick={() => review.reject.mutate({ proposalId: proposal.id, body: { rationale: rationale.trim() === "" ? null : rationale } })} disabled={review.reject.isPending} data-testid="proposal-reject">
          Reject
        </Button>
        <span className="text-2xs text-muted-foreground">Approval creates a new revision (kept Requirements keep their ids); the Orchestrator learns the outcome in its next turn.</span>
        {(review.approve.isError || review.reject.isError) && <span className="text-xs text-status-failed">{errorMessage(review.approve.error ?? review.reject.error)}</span>}
      </div>
    </section>
  );
}
