import { useState } from "react";
import type { BudgetIncreasePartition, RunOverview } from "@agentique-console/core";
import { useBudgetActions } from "@/api/mutations";
import { useRunBudget, useRunUsage } from "@/api/queries";
import { Facts, Notice, Panel, Section, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { allocation, usage } from "@/lib/format";

export function UsagePanel({ overview }: { overview: RunOverview }) {
  const budget = useRunBudget(overview.run.id);
  const totals = useRunUsage(overview.run.id);
  const actions = useBudgetActions(overview.run.id);
  const [partition, setPartition] = useState<BudgetIncreasePartition>("ordinary");
  const [costUsd, setCostUsd] = useState("5");
  const [tokens, setTokens] = useState("500000");
  const [attempts, setAttempts] = useState("5");
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Panel query={budget}>
        {(b) => (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Run Budget (effective = base + approved increases)">
                <Facts
                  items={[
                    ["Base", allocation(b.capacity.baseLimit)],
                    ["Effective", allocation(b.capacity.limit)],
                    ["Ordinary available", allocation(b.capacity.ordinary.effectiveAvailable)],
                    ["Final reserve", allocation(b.capacity.finalReserve)],
                    ["Final available", allocation(b.capacity.final.effectiveAvailable)],
                    ["Completion needs", allocation(b.requiredFinalAllocation)],
                  ]}
                />
              </Section>
              <Section title="Usage">
                <Panel query={totals}>{(u) => <Facts items={[["Run", usage(u.run)], ["Attempts", u.run.rows], ["Wall clock", `${Math.round(u.run.wallClockMs / 1000)}s`], ...u.byPlanNode.filter((n) => n.totals.rows > 0).map((n): [string, string] => [n.planNodeId.slice(0, 12), usage(n.totals)])]} />}</Panel>
              </Section>
            </div>
            {overview.phase === "waiting_budget" && (
              <Notice tone="warning" testId="budget-wait">
                The Run is waiting on budget: the next work cannot be funded from the ordinary capacity. Approve an increase below, or cancel the Run.
              </Notice>
            )}
            {b.openDecision !== null && (
              <Section title="Budget Increase awaiting your approval">
                <div className="flex items-center gap-3 rounded-md border border-border p-3 text-xs" data-testid="budget-decision">
                  <span className="flex-1">
                    Add {allocation(b.openDecision.added)} to the {b.openDecision.partition === "ordinary" ? "ordinary pool" : "final reserve"}?
                  </span>
                  <Button size="sm" onClick={() => actions.resolve.mutate({ decisionId: b.openDecision!.decisionId, body: { option: "approve" } })} disabled={actions.resolve.isPending} data-testid="budget-approve">
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => actions.resolve.mutate({ decisionId: b.openDecision!.decisionId, body: { option: "deny" } })} disabled={actions.resolve.isPending}>
                    Deny
                  </Button>
                </div>
              </Section>
            )}
            {b.allowedActions.some((a) => a.startsWith("request")) && (
              <Section title="Request a Budget Increase">
                <form
                  className="flex flex-wrap items-end gap-2 text-xs"
                  onSubmit={(event) => {
                    event.preventDefault();
                    actions.request.mutate({ partition, added: { costUsd: Number(costUsd), tokens: Number(tokens), attempts: Number(attempts) } });
                  }}
                  data-testid="budget-request"
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Partition</span>
                    <select value={partition} onChange={(event) => setPartition(event.target.value as BudgetIncreasePartition)} className="h-8 rounded-md border border-border bg-background px-2" aria-label="partition">
                      {b.allowedActions.includes("request_ordinary") && <option value="ordinary">ordinary</option>}
                      {b.allowedActions.includes("request_final_reserve") && <option value="final_reserve">final reserve</option>}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">USD</span>
                    <Input value={costUsd} onChange={(e) => setCostUsd(e.target.value)} className="h-8 w-24 font-mono text-xs" inputMode="decimal" aria-label="added cost" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Tokens</span>
                    <Input value={tokens} onChange={(e) => setTokens(e.target.value)} className="h-8 w-28 font-mono text-xs" inputMode="numeric" aria-label="added tokens" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Attempts</span>
                    <Input value={attempts} onChange={(e) => setAttempts(e.target.value)} className="h-8 w-20 font-mono text-xs" inputMode="numeric" aria-label="added attempts" />
                  </label>
                  <Button type="submit" size="sm" disabled={actions.request.isPending}>
                    Request
                  </Button>
                  {actions.request.isError && <span className="text-status-failed">{errorMessage(actions.request.error)}</span>}
                  {actions.resolve.isError && <span className="text-status-failed">{errorMessage(actions.resolve.error)}</span>}
                </form>
              </Section>
            )}
            <Section title="History">
              <ul className="flex flex-col gap-1 text-xs">
                {b.decisions.map((d) => (
                  <li key={d.decisionId} className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    <span>
                      {d.partition}: {allocation(d.added)}
                    </span>
                    {d.chosenOptionId !== null && <span className="text-muted-foreground">→ {d.chosenOptionId}</span>}
                  </li>
                ))}
                {b.extensions.map((e) => (
                  <li key={e.id} className="text-muted-foreground">
                    Allocation Extension on {e.planNodeId.slice(0, 12)}: {allocation(e.added)} ({e.trigger})
                  </li>
                ))}
                {b.decisions.length === 0 && b.extensions.length === 0 && <li className="text-muted-foreground">No Budget Increases or Allocation Extensions.</li>}
              </ul>
            </Section>
          </>
        )}
      </Panel>
    </div>
  );
}
