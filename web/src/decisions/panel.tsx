import { useState } from "react";
import { Link } from "react-router";
import type { DecisionView, RunOverview } from "@agentique-console/core";
import { useDecisionActions } from "@/api/mutations";
import { useRunDecisions } from "@/api/queries";
import { Notice, Panel, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/format";

export function DecisionsPanel({ overview }: { overview: RunOverview }) {
  const decisions = useRunDecisions(overview.run.id);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3" data-testid="decisions-panel">
      <Panel query={decisions} empty={(page) => page.items.length === 0}>
        {(page) => (
          <>
            {[...page.items]
              .sort((a, b) => (a.action !== "none" ? -1 : 1) - (b.action !== "none" ? -1 : 1) || b.decision.createdAt.localeCompare(a.decision.createdAt))
              .map((view) => (
                <DecisionCard key={view.decision.id} view={view} overview={overview} />
              ))}
          </>
        )}
      </Panel>
    </div>
  );
}

function DecisionCard({ view, overview }: { view: DecisionView; overview: RunOverview }) {
  const { decision, action } = view;
  const actions = useDecisionActions(overview.run.id);
  const [rationale, setRationale] = useState("");
  const [chosen, setChosen] = useState<string | null>(decision.recommendedOptionId);
  const dedicated = action === "budget_increase" ? "usage" : action === "signoff" || action === "publish" ? "publish" : null;
  const mutation = action === "supersede" ? actions.supersede : actions.resolve;
  return (
    <article className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs" data-decision={decision.id} data-action={action}>
      <div className="flex items-center gap-2">
        <StatusBadge status={decision.status} />
        <span className="font-medium">{decision.kind.replaceAll("_", " ")}</span>
        <span className="text-3xs text-muted-foreground">
          requested by {decision.requestedBy.kind} · {decision.resolutionPolicy} · {timeAgo(decision.createdAt)}
        </span>
      </div>
      <p>{decision.question}</p>
      {decision.rationale !== null && <p className="text-muted-foreground">{decision.rationale}</p>}
      {decision.resolution !== null && (
        <p className="text-muted-foreground">
          Resolved by {decision.resolution.resolvedBy}: <span className="font-medium text-foreground">{decision.options.find((o) => o.id === decision.resolution!.chosenOptionId)?.label ?? decision.resolution.chosenOptionId}</span>
          {decision.resolution.rationale !== null && ` — ${decision.resolution.rationale}`}
        </p>
      )}
      {decision.supersessionReason !== null && <p className="text-muted-foreground">Superseded: {decision.supersessionReason}</p>}
      {dedicated !== null && (
        <Link to={`/runs/${overview.run.id}/${dedicated}`} className="underline" data-testid="decision-dedicated">
          Resolve it in {dedicated === "usage" ? "Budget & usage" : "Signoff & publish"}
        </Link>
      )}
      {(action === "resolve" || action === "supersede") && (
        <form
          className="flex flex-col gap-2 rounded-md border border-status-waiting/40 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen === null) return;
            mutation.mutate({ decisionId: decision.id, body: { optionId: chosen, rationale: rationale.trim() === "" ? null : rationale } });
          }}
          data-testid="decision-form"
        >
          {action === "supersede" && <Notice>This Decision was resolved by its default policy; you may supersede it with your own choice.</Notice>}
          <div className="flex flex-col gap-1" role="radiogroup" aria-label="options">
            {decision.options.map((option) => (
              <label key={option.id} className="flex items-start gap-2">
                <input type="radio" name={`option-${decision.id}`} checked={chosen === option.id} onChange={() => setChosen(option.id)} />
                <span>
                  <span className="font-medium">{option.label}</span>
                  {option.id === decision.recommendedOptionId && <span className="ml-1 text-3xs text-muted-foreground">(recommended)</span>}
                  {option.description !== null && <span className="block text-muted-foreground">{option.description}</span>}
                </span>
              </label>
            ))}
          </div>
          <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="Rationale (optional; required for a waiver)" aria-label="rationale" />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={chosen === null || mutation.isPending} data-testid="decision-submit">
              {action === "supersede" ? "Supersede" : "Resolve"}
            </Button>
            {mutation.isError && <span className="text-status-failed">{errorMessage(mutation.error)}</span>}
          </div>
        </form>
      )}
    </article>
  );
}
