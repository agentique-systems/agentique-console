import { useState } from "react";
import { WalletIcon } from "lucide-react";
import { Link } from "react-router";
import type { BudgetIncreasePartition, BudgetResponse, RunOverview } from "@agentique-console/core";

import { useBudgetActions } from "@/api/mutations";
import { useRunBudget, useRunPlan, useRunUsage } from "@/api/queries";
import { Callout } from "@/components/callout";
import { KeyValue } from "@/components/key-value";
import { MeterRow } from "@/components/meter";
import { Panel, Section, errorMessage } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allocation, duration, tokens, usageTokensIn, usd, words } from "@/lib/format";

export function UsagePanel({ overview }: { overview: RunOverview }) {
  const budget = useRunBudget(overview.run.id);
  return (
    <div className="flex flex-col gap-6">
      {overview.phase === "waiting_budget" && (
        <Callout tone="warning" testId="budget-wait" title="The Run is waiting on budget">
          The next work cannot be funded from the ordinary capacity. Approve an increase below, or cancel the Run.
        </Callout>
      )}
      <Panel query={budget} skeleton={<Skeleton className="h-48" />}>
        {(b) => (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section card title="Ordinary capacity" description="What Plan Node allocations may draw on: the base Budget plus approved ordinary increases.">
                <PartitionMeters used={b.capacity.ordinary.consumed} limit={b.capacity.ordinary.limit} />
                <KeyValue dense columns={2} items={[{ label: "Available", value: allocation(b.capacity.ordinary.effectiveAvailable), mono: true }, { label: "Reserved", value: allocation(b.capacity.ordinary.reserved), mono: true }]} />
              </Section>
              <Section card title="Final reserve" description="Held for completion work only: final synthesis and the Run-completion Gate Evaluator.">
                <PartitionMeters used={b.capacity.final.consumed} limit={b.capacity.final.limit} />
                <KeyValue dense columns={2} items={[{ label: "Available", value: allocation(b.capacity.final.effectiveAvailable), mono: true }, { label: "Completion needs", value: allocation(b.requiredFinalAllocation), mono: true, hint: "The least final-reserve allocation the Run's completion needs" }]} />
              </Section>
            </div>
            <Section card title="Run Budget" description="Effective = base + approved increases. The effective limit bounds both partitions together.">
              <KeyValue
                columns={2}
                dense
                items={[
                  { label: "Base", value: allocation(b.capacity.baseLimit), mono: true },
                  { label: "Effective", value: allocation(b.capacity.limit), mono: true },
                  { label: "Base final reserve", value: allocation(b.capacity.baseFinalReserve), mono: true },
                  { label: "Effective final reserve", value: allocation(b.capacity.finalReserve), mono: true },
                  { label: "Wall clock", value: overview.run.budget.maxWallClockMs === null ? "unbounded" : duration(overview.run.budget.maxWallClockMs) },
                  { label: "Concurrency", value: overview.run.budget.maxConcurrency === null ? "unbounded" : String(overview.run.budget.maxConcurrency) },
                ]}
              />
            </Section>
            {b.openDecision !== null && (
              <Callout
                tone="warning"
                title="A Budget Increase awaits your approval"
                testId="budget-decision"
                action={<BudgetDecisionActions runId={overview.run.id} decisionId={b.openDecision.decisionId} />}
              >
                Add {allocation(b.openDecision.added)} to the {b.openDecision.partition === "ordinary" ? "ordinary capacity" : "final reserve"}?
              </Callout>
            )}
            {b.allowedActions.some((a) => a.startsWith("request")) && <RequestIncrease runId={overview.run.id} budget={b} />}
            <UsageBreakdown overview={overview} />
            <Section title="History" description="Approved and denied increases, and the Allocation Extensions the runtime granted nodes.">
              {b.decisions.length === 0 && b.extensions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No Budget Increases or Allocation Extensions.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {b.decisions.map((d) => (
                    <li key={d.decisionId} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
                      <StatusBadge status={d.status} />
                      <span>
                        {d.partition === "ordinary" ? "Ordinary" : "Final reserve"} increase: <span className="font-mono text-xs">{allocation(d.added)}</span>
                      </span>
                      {d.chosenOptionId !== null && <span className="text-2xs text-muted-foreground">→ {d.chosenOptionId}</span>}
                    </li>
                  ))}
                  {b.extensions.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-muted-foreground">
                      <span>
                        Allocation Extension on{" "}
                        <Link to={`/runs/${overview.run.id}/plan/${e.planNodeId}`} className="font-mono text-xs underline decoration-dotted hover:text-foreground">
                          {e.planNodeId.slice(0, 12)}
                        </Link>
                        : <span className="font-mono text-xs">{allocation(e.added)}</span>
                      </span>
                      <span className="text-2xs">({words(String(e.trigger))})</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </Panel>
    </div>
  );
}

function PartitionMeters({ used, limit }: { used: { costUsd: number; tokens: number; attempts: number }; limit: { costUsd: number; tokens: number; attempts: number } }) {
  return (
    <div className="flex flex-col gap-2.5">
      <MeterRow label="Cost" used={used.costUsd} limit={limit.costUsd} format={usd} />
      <MeterRow label="Tokens" used={used.tokens} limit={limit.tokens} format={tokens} />
      <MeterRow label="Attempts" used={used.attempts} limit={limit.attempts} format={String} />
    </div>
  );
}

function BudgetDecisionActions({ runId, decisionId }: { runId: string; decisionId: string }) {
  const actions = useBudgetActions(runId);
  return (
    <span className="flex items-center gap-1.5">
      <Button size="sm" variant="ghost" onClick={() => actions.resolve.mutate({ decisionId, body: { option: "deny" } })} disabled={actions.resolve.isPending}>
        Deny
      </Button>
      <Button size="sm" onClick={() => actions.resolve.mutate({ decisionId, body: { option: "approve" } })} disabled={actions.resolve.isPending} data-testid="budget-approve">
        Approve
      </Button>
      {actions.resolve.isError && <span className="text-xs text-status-failed">{errorMessage(actions.resolve.error)}</span>}
    </span>
  );
}

function RequestIncrease({ runId, budget }: { runId: string; budget: BudgetResponse }) {
  const actions = useBudgetActions(runId);
  const partitions = (["ordinary", "final_reserve"] as const).filter((p) => budget.allowedActions.includes(p === "ordinary" ? "request_ordinary" : "request_final_reserve"));
  const [partition, setPartition] = useState<BudgetIncreasePartition>(partitions[0] ?? "ordinary");
  const [costUsd, setCostUsd] = useState("5");
  const [tokenCount, setTokenCount] = useState("500000");
  const [attempts, setAttempts] = useState("5");
  return (
    <Section card title="Request a Budget Increase" description="Opens a budget_increase Decision you then approve; the increase applies only once approved.">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          actions.request.mutate({ partition, added: { costUsd: Number(costUsd), tokens: Number(tokenCount), attempts: Number(attempts) } });
        }}
        data-testid="budget-request"
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Partition</span>
          <NativeSelect value={partition} onChange={(event) => setPartition(event.target.value as BudgetIncreasePartition)} aria-label="partition" className="w-40 text-xs">
            {partitions.map((p) => (
              <option key={p} value={p}>
                {p === "ordinary" ? "ordinary capacity" : "final reserve"}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">USD</span>
          <Input value={costUsd} onChange={(e) => setCostUsd(e.target.value)} className="w-24 font-mono text-xs" inputMode="decimal" aria-label="added cost" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Tokens</span>
          <Input value={tokenCount} onChange={(e) => setTokenCount(e.target.value)} className="w-28 font-mono text-xs" inputMode="numeric" aria-label="added tokens" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Attempts</span>
          <Input value={attempts} onChange={(e) => setAttempts(e.target.value)} className="w-20 font-mono text-xs" inputMode="numeric" aria-label="added attempts" />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={actions.request.isPending}>
          <WalletIcon />
          Request
        </Button>
        {actions.request.isError && <span className="text-xs text-status-failed">{errorMessage(actions.request.error)}</span>}
      </form>
    </Section>
  );
}

function UsageBreakdown({ overview }: { overview: RunOverview }) {
  const totals = useRunUsage(overview.run.id);
  const plan = useRunPlan(overview.run.id);
  const titles = new Map((plan.data?.graph.nodes ?? []).map((n) => [n.id, n.kind === "pattern" ? n.title : "join"] as const));
  return (
    <Section card title="Usage" description="What has actually been spent, by Plan Node.">
      <Panel query={totals} skeleton={<Skeleton className="h-24" />}>
        {(u) => (
          <div className="flex flex-col gap-3">
            <KeyValue
              dense
              columns={2}
              items={[
                { label: "Cost", value: usd(u.run.costUsd), mono: true },
                { label: "Attempts with usage", value: String(u.run.rows), mono: true },
                { label: "Input tokens", value: `${tokens(usageTokensIn(u.run))} (${tokens(u.run.cacheReadTokens)} cache reads)`, mono: true },
                { label: "Output tokens", value: tokens(u.run.outputTokens), mono: true },
                { label: "Wall clock", value: duration(u.run.wallClockMs), mono: true },
                { label: "Provider time", value: duration(u.run.providerMs), mono: true },
              ]}
            />
            {u.byPlanNode.some((n) => n.totals.rows > 0) && (
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Node</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead className="text-right">In</TableHead>
                      <TableHead className="text-right">Out</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.byPlanNode
                      .filter((n) => n.totals.rows > 0)
                      .map((n) => (
                        <TableRow key={n.planNodeId}>
                          <TableCell>
                            <Link to={`/runs/${overview.run.id}/plan/${n.planNodeId}`} className="hover:underline">
                              {titles.get(n.planNodeId) ?? n.planNodeId.slice(0, 12)}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{n.totals.rows}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{tokens(usageTokensIn(n.totals))}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{tokens(n.totals.outputTokens)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(n.totals.costUsd)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </Panel>
    </Section>
  );
}
