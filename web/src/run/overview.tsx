import { useMemo } from "react";
import { ArrowRightIcon, CircleCheckIcon, ListChecksIcon, MessageCircleQuestionMarkIcon, PenLineIcon, RocketIcon, WalletIcon, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import type { Decision, PlanNodeStatus, RunOverview, RunPhase } from "@agentique-console/core";

import { useRunPlan } from "@/api/queries";
import { Callout, type CalloutTone } from "@/components/callout";
import { IdChip } from "@/components/id-chip";
import { KeyValue } from "@/components/key-value";
import { Meter, MeterRow, type MeterSegment } from "@/components/meter";
import { Section } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { PHASE_ICONS, StatusBadge, StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { count, sentence, statusTone, tokens, usageTokensIn, usd, words } from "@/lib/format";
import { LiveOutput, useHasLiveOutput } from "@/run/live-output";
import type { RunTab } from "@/run/sections";

export interface NextStep {
  title: string;
  text: string;
  tab: RunTab | null;
  cta: string | null;
  tone: CalloutTone;
}

/** What the operator should do now, in their terms, for each phase. */
export function nextStepOf(overview: RunOverview): NextStep {
  const phase: RunPhase = overview.phase;
  if (overview.openProposal !== null) return { title: "Review the proposed Requirements", text: "The Orchestrator proposed Requirements: approve or reject them so it can plan the work.", tab: "requirements", cta: "Review proposal", tone: "warning" };
  switch (phase) {
    case "created":
      return { title: "Not started", text: "The Run has not started. Start it from the Conversation.", tab: null, cta: null, tone: "info" };
    case "running":
      return { title: "Work in progress", text: "Agents are working. Steer the Orchestrator with a message from the Conversation if needed; nothing needs you right now.", tab: null, cta: null, tone: "info" };
    case "waiting_decision":
      return { title: "A Decision needs you", text: "Work is blocked until you resolve an open Decision.", tab: "decisions", cta: "Open Decisions", tone: "warning" };
    case "waiting_budget":
      return { title: "Budget exhausted", text: "The Run's Budget cannot fund the next work. Approve a Budget Increase, or cancel the Run.", tab: "usage", cta: "Open Budget", tone: "warning" };
    case "waiting_capacity":
      return { title: "Waiting for capacity", text: "Waiting for provider capacity; the runtime resumes on its own.", tab: null, cta: null, tone: "info" };
    case "waiting_conflict":
      return { title: "Integration conflict", text: "A Changeset conflicted during integration; the responsible node's conflict Task resolves it.", tab: "tasks", cta: "Open Tasks", tone: "warning" };
    case "paused":
      return { title: "Paused", text: `Paused (${overview.run.operatorPause ?? "soft"}). Resume to continue.`, tab: null, cta: null, tone: "warning" };
    case "verifying":
      return { title: "Verifying", text: "The completion check and Gate Evaluator are verifying the integrated result.", tab: "verification", cta: "Open Verification", tone: "info" };
    case "awaiting_signoff":
      return { title: "Ready for your signoff", text: "The result is verified. Review the final report and accept it, or request changes.", tab: "publish", cta: "Review and sign off", tone: "warning" };
    case "completed_unpublished":
      return { title: "Signed off, ready to publish", text: "Signed off. Publish the accepted result to the Target when you are ready; nothing has touched it yet.", tab: "publish", cta: "Publish", tone: "success" };
    case "publishing":
      return { title: "Publishing", text: "Publishing to the Target.", tab: "publish", cta: "Follow publication", tone: "info" };
    case "publish_failed":
      return { title: "Publication failed", text: "The last Publication failed and left the Target unchanged. See why, then retry or start a new Run.", tab: "publish", cta: "See why", tone: "error" };
    case "publish_unsupported":
      return { title: "Signed off", text: "Signed off. This Workspace kind cannot be published atomically; apply the final Changeset yourself.", tab: "publish", cta: "Get the Changeset", tone: "success" };
    case "published":
      return { title: "Published", text: "Published. The Target holds the accepted result.", tab: "publish", cta: "See publication", tone: "success" };
    case "failed":
      return { title: "Failed", text: `The Run failed${overview.run.failure ? `: ${overview.run.failure.summary}` : ""}.`, tab: "verification", cta: "See details", tone: "error" };
    case "cancelled":
      return { title: "Cancelled", text: "The Run was cancelled.", tab: null, cta: null, tone: "info" };
  }
}

const NODE_TONE: Record<PlanNodeStatus, MeterSegment["tone"] | null> = { pending: null, ready: null, running: "running", waiting: "waiting", succeeded: "completed", failed: "failed", cancelled: "cancelled", skipped: "cancelled" };

export function OverviewPanel({ overview }: { overview: RunOverview }) {
  const next = nextStepOf(overview);
  const Icon = PHASE_ICONS[overview.phase];
  const hasLive = useHasLiveOutput(overview.run.id);
  const projection = overview.projection;
  const inFlight = projection?.inFlight.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <Callout
        tone={next.tone}
        icon={Icon}
        title={next.title}
        testId="next-step"
        action={
          next.tab !== null && next.cta !== null ? (
            <Button asChild size="sm" variant={next.tone === "warning" || next.tone === "error" ? "default" : "outline"}>
              <Link to={`/runs/${overview.run.id}/${next.tab}`} data-testid="next-step-link">
                {next.cta}
                <ArrowRightIcon />
              </Link>
            </Button>
          ) : undefined
        }
      >
        {next.text}
      </Callout>
      {overview.projectionError !== null && (
        <Callout tone="error" testId="projection-error" title="The scheduler could not project this Run">
          {overview.projectionError}
        </Callout>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AttentionCard overview={overview} />
        <ProgressCard overview={overview} />
        <BudgetCard overview={overview} />
      </div>
      {(hasLive || inFlight > 0) && (
        <Section card title="Live activity" description={inFlight > 0 ? `${count(inFlight, "Invocation")} in flight. Provider output streams here while an Attempt runs; it is display only and not stored.` : "Provider output streams here while an Attempt runs; it is display only and not stored."}>
          {hasLive ? <LiveOutput runId={overview.run.id} /> : <p className="text-xs text-muted-foreground">Waiting for output…</p>}
        </Section>
      )}
      <DetailsCard overview={overview} />
    </div>
  );
}

function dedicatedTabOf(decision: Decision): RunTab {
  switch (decision.kind) {
    case "budget_increase":
      return "usage";
    case "signoff":
    case "publish":
      return "publish";
    default:
      return "decisions";
  }
}

function AttentionCard({ overview }: { overview: RunOverview }) {
  const rows: { key: string; Icon: LucideIcon; title: string; detail: string | null; tab: RunTab }[] = [];
  if (overview.openProposal !== null) rows.push({ key: "proposal", Icon: ListChecksIcon, title: "Proposed Requirements await your review", detail: overview.openProposal.rationale, tab: "requirements" });
  for (const decision of overview.openDecisions) {
    const Icon = decision.kind === "signoff" ? PenLineIcon : decision.kind === "publish" ? RocketIcon : decision.kind === "budget_increase" ? WalletIcon : MessageCircleQuestionMarkIcon;
    rows.push({ key: decision.id, Icon, title: decision.question, detail: sentence(words(decision.kind)), tab: dedicatedTabOf(decision) });
  }
  if (overview.phase === "waiting_budget" && !overview.openDecisions.some((d) => d.kind === "budget_increase")) rows.push({ key: "budget", Icon: WalletIcon, title: "The Budget cannot fund the next work", detail: "Request and approve an increase, or cancel the Run.", tab: "usage" });
  if (overview.phase === "awaiting_signoff" && !overview.openDecisions.some((d) => d.kind === "signoff")) rows.push({ key: "signoff", Icon: PenLineIcon, title: "The verified result awaits your signoff", detail: "Accept it, or request changes.", tab: "publish" });
  if (overview.phase === "completed_unpublished") rows.push({ key: "publish", Icon: RocketIcon, title: "Ready to publish to the Target", detail: "Nothing has touched the Target yet.", tab: "publish" });
  if (overview.phase === "publish_failed") rows.push({ key: "publish-failed", Icon: RocketIcon, title: "The last Publication failed", detail: "The Target is unchanged; see why and retry.", tab: "publish" });
  return (
    <Section card title="Needs you" description={rows.length === 0 ? undefined : `${count(rows.length, "item")} waiting on the operator`} testId="needs-you">
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-status-completed" aria-hidden />
          Nothing needs you right now.
        </div>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {rows.map((row) => (
            <li key={row.key}>
              <Link to={`/runs/${overview.run.id}/${row.tab}`} className="group flex items-start gap-2.5 rounded-md px-1 py-1.5 hover:bg-accent/60">
                <row.Icon className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium leading-5">{row.title}</span>
                  {row.detail !== null && <span className="line-clamp-2 text-xs text-muted-foreground">{row.detail}</span>}
                </span>
                <ArrowRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProgressCard({ overview }: { overview: RunOverview }) {
  const projection = overview.projection;
  const plan = useRunPlan(overview.run.id);
  const titles = useMemo(() => new Map((plan.data?.graph.nodes ?? []).map((n) => [n.id, n.kind === "pattern" ? n.title : "join"] as const)), [plan.data]);
  if (projection === null) {
    return (
      <Section card title="Progress">
        <p className="text-sm text-muted-foreground">No plan yet. The Orchestrator plans from its first turns; the Plan section fills in as nodes are accepted.</p>
      </Section>
    );
  }
  const total = projection.nodes.length;
  const byStatus = new Map<PlanNodeStatus, number>();
  for (const node of projection.nodes) byStatus.set(node.status, (byStatus.get(node.status) ?? 0) + 1);
  const segments: MeterSegment[] = (["succeeded", "running", "waiting", "failed", "cancelled", "skipped"] as const).flatMap((status) => {
    const value = byStatus.get(status) ?? 0;
    const tone = NODE_TONE[status];
    return value > 0 && tone !== null ? [{ value, tone, label: `${value} ${words(status)}` }] : [];
  });
  const done = byStatus.get("succeeded") ?? 0;
  const summary = [`${done} of ${total} nodes done`, ...(["running", "waiting", "failed"] as const).flatMap((s) => ((byStatus.get(s) ?? 0) > 0 ? [`${byStatus.get(s)} ${s}`] : []))].join(" · ");
  return (
    <Section card title="Progress" description={total === 0 ? "The plan has no nodes yet." : summary} testId="progress">
      {total > 0 && <Meter segments={segments} total={total} label="Plan node progress" />}
      <ul className="flex flex-col gap-0.5 text-sm">
        {projection.nodes.map((node) => (
          <li key={node.planNodeId}>
            <Link to={`/runs/${overview.run.id}/plan/${node.planNodeId}`} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60" data-node={node.planNodeId}>
              <StatusDot tone={statusTone(node.status)} />
              <span className="min-w-0 flex-1 truncate">{titles.get(node.planNodeId) ?? node.planNodeId}</span>
              {node.current && <span className="rounded-sm bg-status-running/12 px-1 text-2xs text-status-running">current</span>}
              {node.advice !== null && (
                <span className="truncate rounded-sm bg-muted px-1 text-2xs text-muted-foreground" title="The scheduler's advice for this node">
                  {words(node.advice)}
                </span>
              )}
              <span className="w-16 text-right text-2xs text-muted-foreground">{words(node.status)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <KeyValue
        dense
        columns={2}
        items={[
          { label: "Concurrency", value: `${projection.concurrency.active} / ${projection.concurrency.max ?? "∞"}`, mono: true },
          { label: "In flight", value: projection.inFlight.length === 0 ? "—" : count(projection.inFlight.length, "Invocation") },
          { label: "Next actions", value: projection.nextActions.length === 0 ? "none" : projection.nextActions.map(words).join(", ") },
          { label: "Waiting on", value: projection.waiting.length === 0 ? "—" : projection.waiting.map((w) => `${words(w.reason)}${w.wakeAt ? ` until ${new Date(w.wakeAt).toLocaleTimeString()}` : ""}`).join("; ") },
        ]}
      />
    </Section>
  );
}

function BudgetCard({ overview }: { overview: RunOverview }) {
  const { capacity, usage } = overview;
  return (
    <Section card title="Budget" description={`Final reserve of ${usd(capacity.finalReserve.costUsd)} is held for completion work.`} testId="budget" actions={
      <Button asChild size="xs" variant="ghost" className="text-muted-foreground">
        <Link to={`/runs/${overview.run.id}/usage`}>
          Details
          <ArrowRightIcon />
        </Link>
      </Button>
    }>
      <MeterRow label="Cost" used={usage.costUsd} limit={capacity.limit.costUsd} format={usd} />
      <MeterRow label="Tokens" used={usageTokensIn(usage) + usage.outputTokens} limit={capacity.limit.tokens} format={tokens} />
      <MeterRow label="Attempts" used={usage.rows} limit={capacity.limit.attempts} format={String} />
    </Section>
  );
}

function DetailsCard({ overview }: { overview: RunOverview }) {
  const { run } = overview;
  return (
    <Section card title="Details">
      <KeyValue
        columns={2}
        dense
        items={[
          { label: "Status", value: <StatusBadge status={run.status} /> },
          { label: "Wait reason", value: run.waitReason === null ? null : words(run.waitReason) },
          { label: "Operator pause", value: run.operatorPause },
          { label: "Pending inputs", value: String(overview.pendingInputs), hint: "Operator messages queued for the Orchestrator's next turn" },
          { label: "Created", value: <RelativeTime iso={run.createdAt} /> },
          { label: "Ended", value: run.endedAt === null ? null : <RelativeTime iso={run.endedAt} /> },
          { label: "Plan revision", value: overview.projection === null ? null : String(overview.projection.revisionNumber) },
          { label: "Evaluator", value: run.verificationPolicy.evaluatorAgentDefinitionRevisionId === null ? "none (deterministic Gates only)" : <IdChip id={run.verificationPolicy.evaluatorAgentDefinitionRevisionId} /> },
          { label: "Base Snapshot", value: run.baseSnapshotId === null ? null : <IdChip id={run.baseSnapshotId} /> },
          { label: "Integration Snapshot", value: run.integrationSnapshotId === null ? null : <IdChip id={run.integrationSnapshotId} /> },
          { label: "Final Snapshot", value: run.finalSnapshotId === null ? null : <IdChip id={run.finalSnapshotId} /> },
          { label: "Final Changeset", value: run.finalChangesetId === null ? null : <IdChip id={run.finalChangesetId} /> },
        ]}
      />
    </Section>
  );
}
