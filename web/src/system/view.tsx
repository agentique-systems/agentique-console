import { useCapacity, useConfig, useHealth } from "@/api/queries";
import { Callout } from "@/components/callout";
import { KeyValue } from "@/components/key-value";
import { MeterRow } from "@/components/meter";
import { PageBody, PageHeader } from "@/components/page";
import { Panel, Section } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allocation, count, tokens, usd, words } from "@/lib/format";

export function SystemView() {
  const health = useHealth();
  const capacity = useCapacity();
  const config = useConfig();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="system-view">
      <PageHeader title="System" description="The console process: whether it admits work, what capacity it has, and the defaults a Run gets." />
      <PageBody>
        <div className="grid gap-4 lg:grid-cols-2">
          <Section card title="Health">
            <Panel query={health} skeleton={<Skeleton className="h-24" />}>
              {(h) => (
                <div className="flex flex-col gap-3">
                  {h.admission === "recovery_incomplete" && (
                    <Callout tone="error" testId="recovery-incomplete" title="Startup recovery is incomplete">
                      {count(h.recovery?.blobFailures ?? 0, "pending Artifact obligation")} could not be resolved. The console serves reads only until it is restarted; the next start retries the reconciliation.
                    </Callout>
                  )}
                  <KeyValue
                    dense
                    columns={2}
                    items={[
                      { label: "Admission", value: <StatusBadge status={h.admission} tone={h.admission === "ready" ? "completed" : h.admission === "recovery_incomplete" ? "failed" : "waiting"} variant="pill" /> },
                      { label: "Started", value: <RelativeTime iso={h.startedAt} /> },
                      { label: "Database", value: `${h.database.disposition}, schema ${h.database.schemaVersion}` },
                      { label: "Recovery", value: h.recovery === null ? "not run" : h.recovery.blobsComplete ? "complete" : "incomplete" },
                    ]}
                  />
                  {h.recovery !== null && (
                    <KeyValue
                      dense
                      columns={2}
                      items={[
                        { label: "Interrupted Attempts", value: String(h.recovery.interruptedAttempts), mono: true },
                        { label: "Cancelled Attempts", value: String(h.recovery.cancelledAttempts), mono: true },
                        { label: "Retry-eligible", value: String(h.recovery.retryEligible), mono: true },
                        { label: "Worktrees released", value: `${h.recovery.workspaceReleased}${h.recovery.workspaceReleaseFailed > 0 ? ` (${h.recovery.workspaceReleaseFailed} failed)` : ""}`, mono: true },
                        { label: "Outstanding publications", value: String(h.recovery.outstandingPublications), mono: true },
                        { label: "Released leases", value: String(h.recovery.releasedLeases), mono: true },
                      ]}
                    />
                  )}
                </div>
              )}
            </Panel>
          </Section>
          <Section card title="Capacity" description="The resource governor: concurrent Attempts in this process, worktrees, and each provider's concurrency.">
            <Panel query={capacity} skeleton={<Skeleton className="h-24" />}>
              {(c) => (
                <div className="flex flex-col gap-3">
                  <MeterRow label="Attempts in process" used={c.process.active} limit={c.process.maxConcurrency} format={String} />
                  {c.worktrees.max !== null ? <MeterRow label="Worktrees" used={c.worktrees.active} limit={c.worktrees.max} format={String} /> : <KeyValue dense items={[{ label: "Worktrees", value: `${c.worktrees.active} active, unbounded`, mono: true }]} />}
                  {c.providers.map((p) => (
                    <MeterRow key={p.provider} label={`Provider ${p.provider}`} used={p.active} limit={p.maxConcurrency} format={String} hint={p.availability.available ? undefined : `Unavailable until ${p.availability.retryAfter ?? "further notice"}`} />
                  ))}
                  <KeyValue dense items={[{ label: "Active leases", value: c.activeLeases.length === 0 ? "none" : c.activeLeases.map((l) => `${l.runId.slice(0, 12)} / ${l.attemptId.slice(0, 12)}`).join("; "), mono: c.activeLeases.length > 0 }]} />
                </div>
              )}
            </Panel>
          </Section>
        </div>
        <Section card title="Defaults" description="What a Run gets when the operator states nothing else. Set through CONSOLE_* variables at startup.">
          <Panel query={config} skeleton={<Skeleton className="h-32" />}>
            {(c) => (
              <div className="flex flex-col gap-4">
                <KeyValue
                  columns={2}
                  dense
                  items={[
                    { label: "Model", value: `${c.defaults.model} (${c.defaults.effort})` },
                    { label: "Provider", value: `${c.provider.name}${c.provider.continuation ? ", session resumption on" : ""}` },
                    { label: "Run Budget", value: `${usd(c.defaults.budget.maxCostUsd)} · ${tokens(c.defaults.budget.maxTokens)} tokens · ${c.defaults.budget.maxAttempts} attempts · concurrency ${c.defaults.budget.maxConcurrency ?? "∞"}`, mono: true },
                    { label: "Orchestrator allocation", value: allocation(c.defaults.orchestratorAllocation), mono: true },
                    { label: "Node allocation", value: allocation(c.defaults.nodeAllocation), mono: true },
                    { label: "Final reserve (code)", value: allocation(c.defaults.finalReserve.code), mono: true },
                    { label: "Completion check", value: c.defaults.completionCheck?.command ?? "none", mono: c.defaults.completionCheck !== null },
                    { label: "Gate Evaluator", value: c.defaults.evaluator },
                    { label: "Limits", value: `messages ${tokens(c.limits.operatorMessageMaxBytes)}B · bodies ${tokens(c.limits.bodyMaxBytes)}B · pages ≤ ${c.limits.pageLimitMax}`, mono: true },
                  ]}
                />
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace kind</TableHead>
                        <TableHead>Target</TableHead>
                        <TableHead>Publication</TableHead>
                        <TableHead>How the Target is updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.workspaceKinds.map((k) => (
                        <TableRow key={k.kind}>
                          <TableCell className="font-medium">{k.kind}</TableCell>
                          <TableCell className="text-xs">{k.target}</TableCell>
                          <TableCell className="text-xs">{k.publicationStrategies.length === 0 ? <span className="text-muted-foreground">not supported</span> : `${k.publicationStrategies.map(words).join(", ")}${k.atomicPublication ? " (atomic)" : ""}`}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{k.publicationApply}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </Panel>
        </Section>
      </PageBody>
    </div>
  );
}
