import { useState } from "react";
import { ArrowRightIcon, ChevronDownIcon, CircleCheckIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { Link } from "react-router";
import type { DecisionView, RunOverview } from "@agentique-console/core";

import { useDecisionActions } from "@/api/mutations";
import { useRunDecisions } from "@/api/queries";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { PagedList } from "@/components/paging";
import { Section, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { sentence, words } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The Run's Decisions: the open ones first, as their own bounded page (they are
 * never behind history, however long it is), then the history newest first.
 */
export function DecisionsPanel({ overview }: { overview: RunOverview }) {
  const open = useRunDecisions(overview.run.id, "open");
  const history = useRunDecisions(overview.run.id);
  return (
    <div className="flex flex-col gap-6" data-testid="decisions-panel">
      <Section title="Open" description="Your resolution is needed; work that depends on a Decision waits for it.">
        <PagedList
          query={open}
          idOf={(view) => view.decision.id}
          skeleton={<Skeleton className="h-32" />}
          empty={
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <CircleCheckIcon className="size-4 text-status-completed" />
              No open Decision.
            </div>
          }
          more={{ label: "Load more open Decisions", testId: "decisions-open-more" }}
        >
          {(views) => (
            <div className="flex flex-col gap-3" data-testid="decisions-open">
              {views.map((view) => (
                <DecisionCard key={view.decision.id} view={view} overview={overview} />
              ))}
            </div>
          )}
        </PagedList>
      </Section>
      <Section title="History" description="Every Decision of the Run, newest first, with who resolved it and how.">
        <PagedList query={history} idOf={(view) => view.decision.id} skeleton={<Skeleton className="h-24" />} empty={<EmptyState compact icon={MessageCircleQuestionMarkIcon} title="No Decision yet" />} more={{ label: "Load older Decisions", testId: "decisions-more" }}>
          {(views) => {
            const closed = views.filter((view) => view.decision.status !== "open");
            return (
              <div className="flex flex-col gap-1.5" data-testid="decisions-history">
                {closed.length === 0 && <p className="text-xs text-muted-foreground">No resolved Decision among the loaded ones.</p>}
                {closed.map((view) => (
                  <HistoryRow key={view.decision.id} view={view} overview={overview} />
                ))}
              </div>
            );
          }}
        </PagedList>
      </Section>
    </div>
  );
}

function dedicatedOf(action: DecisionView["action"]): { tab: string; label: string } | null {
  if (action === "budget_increase") return { tab: "usage", label: "Budget & usage" };
  if (action === "signoff" || action === "publish") return { tab: "publish", label: "Signoff & publish" };
  return null;
}

function DecisionMeta({ view }: { view: DecisionView }) {
  const { decision } = view;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">{sentence(words(decision.kind))}</span>
      <span aria-hidden>·</span>
      <span>asked by {decision.requestedBy.kind === "invocation" ? `an Invocation (${decision.requestedBy.invocationId.slice(0, 12)})` : `the ${decision.requestedBy.kind}`}</span>
      <span aria-hidden>·</span>
      <span>{decision.resolutionPolicy === "operator_required" ? "operator required" : "default applies after the deadline"}</span>
      {decision.deadlineAt !== null && (
        <>
          <span aria-hidden>·</span>
          <span>
            deadline <RelativeTime iso={decision.deadlineAt} />
          </span>
        </>
      )}
      <span aria-hidden>·</span>
      <RelativeTime iso={decision.createdAt} />
    </div>
  );
}

/** An open (or supersedable) Decision with its resolution form. */
function DecisionCard({ view, overview }: { view: DecisionView; overview: RunOverview }) {
  const { decision, action } = view;
  const actions = useDecisionActions(overview.run.id);
  const [rationale, setRationale] = useState("");
  const [chosen, setChosen] = useState<string | null>(decision.recommendedOptionId);
  const dedicated = dedicatedOf(action);
  const mutation = action === "supersede" ? actions.supersede : actions.resolve;
  const waiver = decision.kind === "requirement_waiver";
  return (
    <article className="surface-raised flex flex-col gap-3 rounded-lg border border-status-waiting/40 bg-card p-4" data-decision={decision.id} data-action={action}>
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={decision.status} variant="pill" />
          <DecisionMeta view={view} />
        </div>
        <h3 className="text-sm font-medium leading-5">{decision.question}</h3>
        {decision.rationale !== null && <p className="text-xs text-muted-foreground">{decision.rationale}</p>}
      </header>
      {dedicated !== null && (
        <Callout
          tone="info"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to={`/runs/${overview.run.id}/${dedicated.tab}`} data-testid="decision-dedicated">
                {dedicated.label}
                <ArrowRightIcon />
              </Link>
            </Button>
          }
        >
          This Decision is resolved from its own section, with the facts it needs beside it.
        </Callout>
      )}
      {(action === "resolve" || action === "supersede") && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen === null) return;
            mutation.mutate({ decisionId: decision.id, body: { optionId: chosen, rationale: rationale.trim() === "" ? null : rationale } });
          }}
          data-testid="decision-form"
        >
          {action === "supersede" && <Callout tone="info">This Decision was resolved by its default policy; you may supersede it with your own choice.</Callout>}
          <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="options">
            {decision.options.map((option) => {
              const selected = chosen === option.id;
              return (
                <label key={option.id} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors", selected ? "border-foreground/50 bg-accent/50" : "border-border hover:bg-accent/30")}>
                  <input type="radio" name={`option-${decision.id}`} checked={selected} onChange={() => setChosen(option.id)} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 font-medium">
                      {option.label}
                      {option.id === decision.recommendedOptionId && <span className="rounded-sm bg-muted px-1 text-2xs font-normal text-muted-foreground">recommended</span>}
                    </span>
                    {option.description !== null && <span className="text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder={waiver ? "Rationale (required for a waiver)" : "Rationale (optional; recorded with the resolution)"} aria-label="rationale" />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={chosen === null || mutation.isPending} data-testid="decision-submit">
              {mutation.isPending ? "Saving…" : action === "supersede" ? "Supersede" : "Resolve"}
            </Button>
            <span className="text-2xs text-muted-foreground">The Orchestrator learns the resolution in its next turn.</span>
            {mutation.isError && <span className="text-xs text-status-failed">{errorMessage(mutation.error)}</span>}
          </div>
        </form>
      )}
    </article>
  );
}

/** A resolved or superseded Decision: one line, opening to its options and resolution. */
function HistoryRow({ view, overview }: { view: DecisionView; overview: RunOverview }) {
  const { decision, action } = view;
  const [open, setOpen] = useState(false);
  const chosen = decision.resolution === null ? null : (decision.options.find((o) => o.id === decision.resolution!.chosenOptionId)?.label ?? decision.resolution.chosenOptionId);
  return (
    <article className={cn("rounded-lg border bg-card", open ? "border-foreground/30" : "border-border")} data-decision={decision.id} data-action={action}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/40">
        <StatusBadge status={decision.status} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">{decision.question}</span>
          <span className="text-2xs text-muted-foreground">
            {sentence(words(decision.kind))}
            {chosen !== null && (
              <>
                {" "}
                · chose <span className="font-medium text-foreground">{chosen}</span> ({decision.resolution!.resolvedBy})
              </>
            )}
            {decision.supersessionReason !== null && ` · superseded: ${words(decision.supersessionReason)}`}
          </span>
        </span>
        <RelativeTime iso={decision.resolution?.resolvedAt ?? decision.createdAt} className="mt-0.5 shrink-0 text-2xs text-muted-foreground" />
        <ChevronDownIcon className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border-subtle px-3 py-3">
          <DecisionMeta view={view} />
          {decision.rationale !== null && <p className="text-xs text-muted-foreground">{decision.rationale}</p>}
          <ul className="flex flex-col gap-1 text-sm">
            {decision.options.map((option) => (
              <li key={option.id} className={cn("flex items-start gap-2 rounded-md border px-2.5 py-1.5", decision.resolution?.chosenOptionId === option.id ? "border-foreground/40" : "border-border-subtle text-muted-foreground")}>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{option.label}</span>
                  {option.description !== null && <span className="text-xs text-muted-foreground">{option.description}</span>}
                </span>
                {option.id === decision.recommendedOptionId && <span className="ml-auto text-2xs">recommended</span>}
              </li>
            ))}
          </ul>
          {decision.resolution?.rationale && <p className="text-xs">Rationale: {decision.resolution.rationale}</p>}
          {action === "supersede" && <DecisionCard view={view} overview={overview} />}
        </div>
      )}
    </article>
  );
}
