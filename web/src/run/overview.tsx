import { useMemo } from "react";
import { Link } from "react-router";
import type { RunOverview, RunPhase } from "@agentique-console/core";
import { Facts, Notice, Section } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { allocation, PHASE_LABELS, timeAgo, usage } from "@/lib/format";
import { useOutputStore } from "@/stores/output";

/** What the operator should do now, in their terms, for each phase. */
export function nextStepOf(overview: RunOverview): { text: string; tab: string | null } {
  const phase: RunPhase = overview.phase;
  if (overview.openProposal !== null) return { text: "The Orchestrator proposed Requirements: review and approve or reject them so it can plan.", tab: "requirements" };
  switch (phase) {
    case "created":
      return { text: "The Run has not started. Start it from the Conversation.", tab: null };
    case "running":
      return { text: "Work is in progress. Steer the Orchestrator with a message from the Conversation if needed.", tab: null };
    case "waiting_decision":
      return { text: "A Decision needs you before work continues.", tab: "decisions" };
    case "waiting_budget":
      return { text: "The Run's Budget cannot fund the next work. Approve a Budget Increase, or cancel.", tab: "usage" };
    case "waiting_capacity":
      return { text: "Waiting for provider capacity; the runtime resumes on its own.", tab: null };
    case "waiting_conflict":
      return { text: "A Changeset conflicted during integration; the responsible node's conflict Task resolves it.", tab: "tasks" };
    case "paused":
      return { text: `Paused (${overview.run.operatorPause}). Resume to continue.`, tab: null };
    case "verifying":
      return { text: "The completion check and Gate Evaluator are verifying the integrated result.", tab: "verification" };
    case "awaiting_signoff":
      return { text: "The result is verified. Review the final report and accept it, or request changes.", tab: "publish" };
    case "completed_unpublished":
      return { text: "Signed off. Publish the accepted result to the Target when you are ready; nothing has touched it yet.", tab: "publish" };
    case "publishing":
      return { text: "Publishing to the Target.", tab: "publish" };
    case "publish_failed":
      return { text: "The last Publication failed and left the Target unchanged. See why, then retry or start a new Run.", tab: "publish" };
    case "publish_unsupported":
      return { text: "Signed off. This Workspace kind cannot be published atomically; apply the final Changeset yourself.", tab: "publish" };
    case "published":
      return { text: "Published. The Target holds the accepted result.", tab: "publish" };
    case "failed":
      return { text: `The Run failed${overview.run.failure ? `: ${overview.run.failure.summary}` : ""}.`, tab: "verification" };
    case "cancelled":
      return { text: "The Run was cancelled.", tab: null };
  }
}

export function OverviewPanel({ overview }: { overview: RunOverview }) {
  const next = nextStepOf(overview);
  // The store slice is selected as-is: a filtered array built inside the selector would be a new snapshot on every read.
  const byAttempt = useOutputStore((s) => s.byAttempt);
  const live = useMemo(() => Object.entries(byAttempt).filter(([, o]) => o.runId === overview.run.id), [byAttempt, overview.run.id]);
  const projection = overview.projection;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Notice tone={overview.phase === "failed" || overview.phase === "publish_failed" ? "error" : overview.phase.startsWith("waiting") || overview.phase === "awaiting_signoff" ? "warning" : "info"} testId="next-step">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm text-foreground">{next.text}</span>
          {next.tab !== null && (
            <Link to={`/runs/${overview.run.id}/${next.tab}`} className="shrink-0 text-xs underline" data-testid="next-step-link">
              Open
            </Link>
          )}
        </div>
      </Notice>
      {overview.projectionError !== null && (
        <Notice tone="error" testId="projection-error">
          The scheduler could not project this Run from its rows: {overview.projectionError}
        </Notice>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <Section title="State">
          <Facts
            items={[
              ["Phase", PHASE_LABELS[overview.phase]],
              ["Status", <StatusBadge key="s" status={overview.run.status} />],
              ["Wait reason", overview.run.waitReason ?? "—"],
              ["Pause", overview.run.operatorPause ?? "—"],
              ["Created", timeAgo(overview.run.createdAt)],
              ["Ended", overview.run.endedAt === null ? "—" : timeAgo(overview.run.endedAt)],
              ["Plan revision", projection?.revisionNumber ?? "—"],
              ["Pending inputs", overview.pendingInputs],
            ]}
          />
        </Section>
        <Section title="Budget and usage">
          <Facts
            items={[
              ["Budget", allocation(overview.capacity.limit)],
              ["Final reserve", allocation(overview.capacity.finalReserve)],
              ["Available (ordinary)", allocation(overview.capacity.ordinary.effectiveAvailable)],
              ["Used", usage(overview.usage)],
              ["Attempts", overview.usage.rows],
            ]}
          />
        </Section>
      </div>
      {projection !== null && (
        <Section title="Progress (from the scheduler's projection)">
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex flex-wrap gap-2">
              {projection.nodes.map((node) => (
                <Link key={node.planNodeId} to={`/runs/${overview.run.id}/plan/${node.planNodeId}`} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted/40">
                  <StatusBadge status={node.status} />
                  <span className="font-mono text-3xs text-muted-foreground">{node.planNodeId.slice(0, 10)}</span>
                  {node.advice !== null && <span className="text-3xs text-muted-foreground">{node.advice}</span>}
                </Link>
              ))}
            </div>
            <Facts
              items={[
                ["Next actions", projection.nextActions.length === 0 ? "none" : projection.nextActions.join(", ")],
                ["Waiting", projection.waiting.length === 0 ? "—" : projection.waiting.map((w) => `${w.reason}${w.wakeAt ? ` until ${w.wakeAt}` : ""}`).join("; ")],
                ["In flight", projection.inFlight.length === 0 ? "—" : projection.inFlight.join(", ")],
                ["Concurrency", `${projection.concurrency.active} / ${projection.concurrency.max ?? "∞"}`],
                ["Next resumption", projection.wakeAt ?? "—"],
              ]}
            />
          </div>
        </Section>
      )}
      {overview.openDecisions.length > 0 && (
        <Section title="Decisions needing you">
          <ul className="flex flex-col gap-1 text-xs">
            {overview.openDecisions.map((d) => (
              <li key={d.id}>
                <Link to={`/runs/${overview.run.id}/decisions`} className="underline">
                  {d.kind.replaceAll("_", " ")}: {d.question}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {live.length > 0 && (
        <Section title="Live provider output (transient, not stored)">
          <div className="flex flex-col gap-2">
            {live.map(([attemptId, output]) => (
              <details key={attemptId} className="rounded-md border border-border p-2 text-2xs" open>
                <summary className="cursor-pointer font-mono">{attemptId}</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-3xs text-muted-foreground">{output.chunks.map((c) => (c.kind === "tool_call" ? `▶ ${c.text}` : c.text)).join("\n")}</pre>
              </details>
            ))}
          </div>
        </Section>
      )}
      {overview.finalReportArtifactId !== null && (
        <Section title="Final report">
          <Link to={`/runs/${overview.run.id}/verification`} className="text-xs underline">
            Read the final report
          </Link>
        </Section>
      )}
    </div>
  );
}
