import { FileTextIcon, GitCommitHorizontalIcon, ScaleIcon, ShieldCheckIcon } from "lucide-react";
import type { Evaluation, FinalReport, Gate, RunOverview } from "@agentique-console/core";

import { useArtifactText, useRunChangesets, useRunEvaluations, useRunGates } from "@/api/queries";
import { ArtifactContent, ArtifactLink } from "@/artifacts/viewer";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { IdChip } from "@/components/id-chip";
import { PagedList } from "@/components/paging";
import { Panel, Section } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Skeleton } from "@/components/ui/skeleton";
import { count, words } from "@/lib/format";

export function VerificationPanel({ overview }: { overview: RunOverview }) {
  const gates = useRunGates(overview.run.id);
  const evaluations = useRunEvaluations(overview.run.id);
  const changesets = useRunChangesets(overview.run.id);
  return (
    <div className="flex flex-col gap-6">
      {overview.run.failure !== null && (
        <Callout tone="error" title={`The Run failed: ${words(overview.run.failure.kind)}`} testId="run-failure">
          {overview.run.failure.summary}
          {overview.run.failure.evidenceArtifactIds.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-2">
              {overview.run.failure.evidenceArtifactIds.map((id) => (
                <ArtifactLink key={id} artifactId={id} label={`evidence ${id.slice(0, 12)}`} />
              ))}
            </span>
          )}
        </Callout>
      )}
      {overview.finalReportArtifactId !== null && <FinalReportView artifactId={overview.finalReportArtifactId} />}
      <Section title="Gates" description="A Gate judges an integrated Snapshot against Acceptance Criteria: node exits, Run completion, and your signoff.">
        <PagedList query={gates} idOf={(gate) => gate.id} skeleton={<Skeleton className="h-24" />} empty={<EmptyState compact icon={ShieldCheckIcon} title="No Gate yet" description="Gates open as nodes finish and when the Orchestrator requests completion." />} more={{ label: "Load older Gates", testId: "gates-more" }}>
          {(items) => (
            <ul className="flex flex-col gap-1.5" data-testid="gates">
              {items.map((gate) => (
                <GateRow key={gate.id} gate={gate} />
              ))}
            </ul>
          )}
        </PagedList>
      </Section>
      <Section title="Evaluations" description="Each verdict on one criterion, rubric, or route, with the evidence behind it.">
        <PagedList query={evaluations} idOf={(ev) => ev.id} skeleton={<Skeleton className="h-16" />} empty={<p className="text-xs text-muted-foreground">No Evaluation yet.</p>} more={{ label: "Load older Evaluations", testId: "evaluations-more" }}>
          {(items) => (
            <ul className="flex flex-col gap-1" data-testid="evaluations">
              {items.map((ev) => (
                <EvaluationRow key={ev.id} ev={ev} />
              ))}
            </ul>
          )}
        </PagedList>
      </Section>
      <Section title="Changesets" description="What each Invocation changed, and whether it integrated; the Run's final Changeset is what publication applies.">
        <PagedList query={changesets} idOf={(cs) => cs.id} skeleton={<Skeleton className="h-16" />} empty={<p className="text-xs text-muted-foreground">No Changeset yet.</p>} more={{ label: "Load older Changesets", testId: "changesets-more" }}>
          {(items) => (
            <ul className="flex flex-col gap-1" data-testid="changesets">
              {items.map((cs) => (
                <li key={cs.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm">
                  <GitCommitHorizontalIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  <StatusBadge status={cs.integrationStatus} />
                  <span className={cs.kind === "final" ? "font-medium" : ""}>{cs.kind === "final" ? "final Changeset" : "Invocation Changeset"}</span>
                  <IdChip id={cs.id} />
                  <RelativeTime iso={cs.createdAt} className="text-2xs text-muted-foreground" />
                  <span className="flex-1" />
                  <ArtifactLink artifactId={cs.diffArtifactId} label="View diff" />
                </li>
              ))}
            </ul>
          )}
        </PagedList>
      </Section>
    </div>
  );
}

function GateRow({ gate }: { gate: Gate }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2" data-gate={gate.kind}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={gate.status} />
        <span className="font-medium">
          {words(gate.kind)} <span className="font-normal text-muted-foreground">#{gate.ordinal}</span>
        </span>
        <span className="text-2xs text-muted-foreground">
          {count(gate.acceptanceCriterionIds.length, "criterion", "criteria")}
          {gate.requirementIds.length > 0 && ` · ${count(gate.requirementIds.length, "Requirement")}`}
          {" · opened "}
          <RelativeTime iso={gate.openedAt} />
          {gate.closedAt !== null && (
            <>
              {" · closed "}
              <RelativeTime iso={gate.closedAt} />
            </>
          )}
        </span>
        <span className="flex-1" />
        {gate.reportArtifactId !== null && <ArtifactLink artifactId={gate.reportArtifactId} label="Report" />}
      </div>
      {gate.failure !== null && <div className="text-xs text-status-failed">{describeGateFailure(gate.failure)}</div>}
    </li>
  );
}

function EvaluationRow({ ev }: { ev: Evaluation }) {
  const tone = ev.verdict === "pass" ? "passed" : ev.verdict === "fail" ? "failed" : "waiting";
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm">
      <ScaleIcon className="size-3.5 text-muted-foreground" aria-hidden />
      <StatusBadge status={tone} label={ev.verdict} />
      <span>{describeSubject(ev)}</span>
      {ev.context !== null && <span className="text-2xs text-muted-foreground">{ev.context.kind === "publication" ? "publication candidate" : `${words(ev.context.kind)} round ${ev.context.round}/${ev.context.maxRounds}`}</span>}
      <span className="text-2xs text-muted-foreground">by {ev.producedBy.kind}</span>
      {ev.evidence.map((item, i) => (
        <span key={i} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
          {item.kind === "command" ? `$ ${item.command} → ${item.exitCode}` : words(item.kind)}
        </span>
      ))}
      <span className="flex-1" />
      <RelativeTime iso={ev.createdAt} className="text-2xs text-muted-foreground" />
    </li>
  );
}

function describeSubject(ev: Evaluation): string {
  switch (ev.subject.kind) {
    case "acceptance_criterion":
      return `criterion ${ev.subject.acceptanceCriterionId.slice(0, 12)}`;
    case "rubric":
      return `rubric: ${ev.subject.rubric}`;
    case "route_selection":
      return `route selection: ${ev.subject.selectedLabel}`;
    case "optimizer_round":
      return "optimizer round";
  }
}

function describeGateFailure(failure: NonNullable<Gate["failure"]>): string {
  switch (failure.kind) {
    case "criteria_failed":
      return `Criteria failed: ${failure.acceptanceCriterionIds.map((id) => id.slice(0, 12)).join(", ")}`;
    case "evaluator_failed":
    case "final_synthesis_failed":
      return `${words(failure.kind)} (${failure.invocationId.slice(0, 12)})`;
    case "conditions_unmet":
      return `Conditions unmet: ${failure.conditions.map((c) => words(c.kind)).join(", ")}`;
    case "final_reserve_exhausted":
      return `Final reserve exhausted (${words(failure.use)})`;
    case "changes_requested":
      return "Changes requested by the operator";
  }
}

function FinalReportView({ artifactId }: { artifactId: string }) {
  const text = useArtifactText(artifactId);
  return (
    <Section card title="Final report" description="The Orchestrator's synthesis of the verified result." actions={<ArtifactLink artifactId={artifactId} label="Open Artifact" />}>
      <Panel query={text} skeleton={<Skeleton className="h-32" />}>
        {(t) => {
          let report: FinalReport | null = null;
          try {
            report = JSON.parse(t.text) as FinalReport;
          } catch {
            report = null;
          }
          if (report === null || typeof report !== "object" || report.report === undefined) return <ArtifactContent artifactId={artifactId} />;
          return (
            <div className="flex flex-col gap-4" data-testid="final-report">
              <p className="text-sm leading-relaxed">{report.report.summary}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <ReportList title="Completed" items={report.report.completed} />
                <ReportList title="Verification" items={report.report.verification} />
                <ReportList title="Risks" items={report.report.risks} tone="warning" />
                <ReportList title="Follow-ups" items={report.report.followUps} />
              </div>
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <FileTextIcon className="size-3" />
                Snapshot <IdChip id={report.snapshotId} />
              </div>
            </div>
          );
        }}
      </Panel>
    </Section>
  );
}

function ReportList({ title, items, tone }: { title: string; items: string[]; tone?: "warning" }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className={`flex list-disc flex-col gap-0.5 pl-4 text-sm ${tone === "warning" ? "marker:text-status-waiting" : "marker:text-muted-foreground"}`}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
