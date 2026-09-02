import type { FinalReport, RunOverview } from "@agentique-console/core";
import { useArtifactText, useRunChangesets, useRunEvaluations, useRunGates } from "@/api/queries";
import { ArtifactLink, ArtifactContent } from "@/artifacts/viewer";
import { Facts, Notice, Panel, Section } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { timeAgo } from "@/lib/format";

export function VerificationPanel({ overview }: { overview: RunOverview }) {
  const gates = useRunGates(overview.run.id);
  const evaluations = useRunEvaluations(overview.run.id);
  const changesets = useRunChangesets(overview.run.id);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {overview.run.failure !== null && (
        <Notice tone="error" testId="run-failure">
          Failed ({overview.run.failure.kind}): {overview.run.failure.summary}
        </Notice>
      )}
      {overview.finalReportArtifactId !== null && <FinalReportView artifactId={overview.finalReportArtifactId} />}
      <Section title="Gates">
        <Panel query={gates} empty={(g) => g.items.length === 0}>
          {(g) => (
            <ul className="flex flex-col gap-1 text-xs" data-testid="gates">
              {[...g.items].reverse().map((gate) => (
                <li key={gate.id} className="rounded-md border border-border p-2" data-gate={gate.kind}>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={gate.status} />
                    <span className="font-medium">
                      {gate.kind.replaceAll("_", " ")} #{gate.ordinal}
                    </span>
                    <span className="text-3xs text-muted-foreground">
                      {gate.acceptanceCriterionIds.length} criteria · opened {timeAgo(gate.openedAt)}
                    </span>
                  </div>
                  {gate.failure !== null && <div className="mt-1 text-2xs text-status-failed">{describeGateFailure(gate.failure)}</div>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>
      <Section title="Evaluations">
        <Panel query={evaluations} empty={(e) => e.items.length === 0}>
          {(e) => (
            <ul className="flex flex-col gap-1 text-xs" data-testid="evaluations">
              {e.items.map((ev) => (
                <li key={ev.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1">
                  <StatusBadge status={ev.verdict === "pass" ? "passed" : ev.verdict === "fail" ? "failed" : "waiting"} label={ev.verdict} />
                  <span>{ev.subject.kind.replaceAll("_", " ")}</span>
                  <span className="text-3xs text-muted-foreground">by {ev.producedBy.kind}</span>
                  {ev.evidence.map((item, i) => (
                    <span key={i} className="font-mono text-3xs text-muted-foreground">
                      {item.kind === "command" ? `$ ${item.command} → ${item.exitCode}` : item.kind}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>
      <Section title="Changesets">
        <Panel query={changesets} empty={(c) => c.items.length === 0}>
          {(c) => (
            <ul className="flex flex-col gap-1 text-xs" data-testid="changesets">
              {c.items.map((cs) => (
                <li key={cs.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
                  <StatusBadge status={cs.integrationStatus} />
                  <span>{cs.kind}</span>
                  <span className="font-mono text-3xs text-muted-foreground">{cs.id.slice(0, 12)}</span>
                  <span className="flex-1" />
                  <ArtifactLink artifactId={cs.diffArtifactId} label="diff" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>
    </div>
  );
}

function describeGateFailure(failure: NonNullable<import("@agentique-console/core").Gate["failure"]>): string {
  switch (failure.kind) {
    case "criteria_failed":
      return `criteria failed: ${failure.acceptanceCriterionIds.join(", ")}`;
    case "evaluator_failed":
    case "final_synthesis_failed":
      return `${failure.kind.replaceAll("_", " ")} (${failure.invocationId})`;
    case "conditions_unmet":
      return `conditions unmet: ${failure.conditions.map((c) => c.kind).join(", ")}`;
    case "final_reserve_exhausted":
      return `final reserve exhausted (${failure.use})`;
    case "changes_requested":
      return "changes requested by the operator";
  }
}

function FinalReportView({ artifactId }: { artifactId: string }) {
  const text = useArtifactText(artifactId);
  return (
    <Section title="Final report">
      <Panel query={text}>
        {(t) => {
          let report: FinalReport | null = null;
          try {
            report = JSON.parse(t.text) as FinalReport;
          } catch {
            report = null;
          }
          if (report === null) return <ArtifactContent artifactId={artifactId} />;
          return (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-xs" data-testid="final-report">
              <p className="text-sm">{report.report.summary}</p>
              <Facts
                items={[
                  ["Completed", report.report.completed.join("; ") || "—"],
                  ["Verification", report.report.verification.join("; ") || "—"],
                  ["Risks", report.report.risks.join("; ") || "—"],
                  ["Follow-ups", report.report.followUps.join("; ") || "—"],
                  ["Snapshot", report.snapshotId],
                ]}
              />
            </div>
          );
        }}
      </Panel>
    </Section>
  );
}
