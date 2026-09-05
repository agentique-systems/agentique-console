import { useState } from "react";
import { ArrowLeftIcon, ChevronDownIcon, FileTextIcon } from "lucide-react";
import { Link } from "react-router";
import type { Attempt, AttemptResponse, InvocationResponse } from "@agentique-console/core";

import { useAttempt, useInvocation, useTranscript } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Callout } from "@/components/callout";
import { IdChip } from "@/components/id-chip";
import { KeyValue } from "@/components/key-value";
import { CodeBlock } from "@/components/log-view";
import { Panel, Section } from "@/components/panel";
import { Elapsed, RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { allocation, count, usage, usd, words } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LiveOutput } from "@/run/live-output";
import { useOutputStore } from "@/stores/output";

/** One Invocation: what it was asked to do and with what, then its Attempts, each opening to its output and transcript. */
export function InvocationView({ invocationId, runId }: { invocationId: string; runId: string }) {
  const invocation = useInvocation(invocationId);
  return (
    <Panel
      query={invocation}
      skeleton={
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-56" />
          <SkeletonLines lines={5} />
        </div>
      }
    >
      {(v) => <InvocationDetails v={v} runId={runId} />}
    </Panel>
  );
}

function InvocationDetails({ v, runId }: { v: InvocationResponse; runId: string }) {
  const { invocation } = v;
  const running = invocation.status === "running";
  const [attemptId, setAttemptId] = useState<string | null>(() => (running ? (v.attempts.at(-1)?.id ?? null) : null));
  const position = invocation.patternPosition;
  return (
    <div className="flex flex-col gap-4" data-testid="invocation-view">
      <header className="flex flex-col gap-1.5">
        <Button asChild size="xs" variant="ghost" className="-ml-1 self-start text-muted-foreground">
          <Link to={`/runs/${runId}/plan/${invocation.planNodeId}`}>
            <ArrowLeftIcon />
            Plan Node
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">
            <span className="capitalize">{invocation.role}</span> <span className="font-normal text-muted-foreground">· {words(invocation.purpose)}</span>
          </h2>
          <StatusBadge status={invocation.status} variant="pill" />
          {invocation.waitReason !== null && <span className="text-xs text-status-waiting">waiting on {words(invocation.waitReason)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <IdChip id={invocation.id} />
          {position !== null && <span className="font-mono">{describePosition(position)}</span>}
          <span>
            <span className="text-foreground">{v.definition.modelPolicy.model}</span> · {v.definition.modelPolicy.effort}
          </span>
          <RelativeTime iso={invocation.createdAt} prefix="created" />
          {invocation.startedAt !== null && (
            <span>
              ran <Elapsed from={invocation.startedAt} to={invocation.endedAt} className="font-mono" />
            </span>
          )}
        </div>
      </header>

      {invocation.result !== null && (
        <Callout tone={invocation.result.status === "completed" ? "success" : invocation.result.status === "blocked" ? "warning" : "error"} title={`Result: ${invocation.result.status}`} testId="invocation-result">
          <p>{invocation.result.summary}</p>
          {invocation.result.blocker !== null && <p className="mt-1 text-status-failed">Blocker: {invocation.result.blocker}</p>}
          {invocation.result.openItems.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {invocation.result.openItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
        </Callout>
      )}
      {invocation.failureReason !== null && (
        <Callout tone="error" title="Failed">
          {words(invocation.failureReason)}
        </Callout>
      )}
      {invocation.blockedByDecisionId !== null && (
        <Callout
          tone="warning"
          title="Blocked by an open Decision"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to={`/runs/${runId}/decisions`}>Open Decisions</Link>
            </Button>
          }
        >
          <IdChip id={invocation.blockedByDecisionId} />
        </Callout>
      )}

      <KeyValue
        dense
        columns={2}
        items={[
          { label: "Definition", value: v.definition.provenance.kind === "workspace_file" ? v.definition.provenance.path : v.definition.provenance.kind, hint: `content ${v.definition.contentHash.slice(0, 12)}` },
          { label: "Allocation", value: allocation(invocation.allocation), mono: true, hint: `from the ${words(invocation.allocationSource)}` },
          { label: "Usage", value: usage(v.usage), mono: true },
          { label: "Tasks", value: invocation.taskIds.length === 0 ? null : count(invocation.taskIds.length, "Task") },
          { label: "Inputs", value: v.manifest.content.inputs.length === 0 ? null : v.manifest.content.inputs.map((i) => words(i.kind)).join(", ") },
          { label: "Runtime tools", value: v.manifest.content.runtimeTools.map(words).join(", ") },
          { label: "Capabilities", value: v.manifest.content.capabilities.tools.length === 0 ? "none" : v.manifest.content.capabilities.tools.join(", ") },
          { label: "Runtime tool calls", value: v.runtimeToolCalls.length === 0 ? null : count(v.runtimeToolCalls.length, "call"), hint: v.runtimeToolCalls.length === 0 ? undefined : [...new Set(v.runtimeToolCalls.map((c) => c.tool))].join(", ") },
        ]}
      />

      {v.artifacts.length > 0 && (
        <Section title={`Artifacts (${v.artifacts.length})`}>
          <ul className="flex flex-wrap gap-1.5">
            {v.artifacts.map((a) => (
              <li key={a.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <FileTextIcon className="size-3.5 text-muted-foreground" />
                <ArtifactLink artifact={a} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Attempts (${v.attempts.length})`} description="Each Attempt is one provider session of this Invocation; a retry is a new Attempt.">
        {v.attempts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No Attempt yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {v.attempts.map((a: Attempt) => {
              const open = attemptId === a.id;
              return (
                <li key={a.id} className={cn("rounded-md border bg-card", open ? "border-foreground/30" : "border-border")} data-attempt={a.id}>
                  <button type="button" onClick={() => setAttemptId(open ? null : a.id)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm hover:bg-accent/50" aria-expanded={open}>
                    <span className="font-mono text-xs text-muted-foreground">#{a.number}</span>
                    <StatusBadge status={a.status} />
                    <span className="text-xs text-muted-foreground">
                      {a.kind} · {a.startMode}
                    </span>
                    {a.failureClass !== null && <span className="text-xs text-status-failed">{words(a.failureClass)}</span>}
                    <span className="flex-1" />
                    <RelativeTime iso={a.createdAt} className="text-2xs text-muted-foreground" />
                    <ChevronDownIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
                  </button>
                  {open && (
                    <div className="border-t border-border-subtle px-2.5 py-2.5">
                      <AttemptView attemptId={a.id} runId={runId} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function describePosition(position: NonNullable<InvocationResponse["invocation"]["patternPosition"]>): string {
  switch (position.kind) {
    case "orchestrator":
    case "single":
    case "route_selection":
    case "parallel_aggregation":
    case "coordinator_turn":
      return words(position.kind);
    case "chain_step":
      return `chain step ${position.index + 1} of ${position.count}`;
    case "route_branch":
      return `branch ${position.label}`;
    case "parallel_item":
      return `parallel item ${position.index + 1} of ${position.count}`;
    case "worker_task":
      return `worker task ${position.taskId.slice(0, 12)}`;
    case "producer_round":
      return `producer round ${position.round} of ${position.maxRounds}`;
    case "evaluator_round":
      return `evaluator round ${position.round} of ${position.maxRounds}`;
  }
}

function AttemptView({ attemptId, runId }: { attemptId: string; runId: string }) {
  const attempt = useAttempt(attemptId);
  const [showTranscript, setShowTranscript] = useState(false);
  const transcript = useTranscript(showTranscript ? attemptId : null);
  const hasLive = useOutputStore((s) => (s.byAttempt[attemptId]?.chunks.length ?? 0) > 0);
  return (
    <Panel query={attempt} skeleton={<SkeletonLines lines={3} />}>
      {(a: AttemptResponse) => (
        <div className="flex flex-col gap-3">
          <KeyValue
            dense
            columns={2}
            items={[
              { label: "Status", value: <StatusBadge status={a.attempt.status} /> },
              { label: "Cost", value: usd(a.usage.reduce((sum, u) => sum + u.costUsd, 0)), mono: true, hint: `${count(a.usage.length, "usage row")}` },
              { label: "Failure", value: a.attempt.failureDetail === null ? null : `${a.attempt.failureClass === null ? "" : `${words(a.attempt.failureClass)}: `}${a.attempt.failureDetail.message}` },
              { label: "Retry", value: a.attempt.retryDecision === null ? null : `${a.attempt.retryDecision.permitted ? "permitted" : "refused"} (${words(a.attempt.retryDecision.reason)})` },
              { label: "Tool calls", value: a.runtimeToolCalls.length === 0 ? null : [...new Set(a.runtimeToolCalls.map((c) => c.tool))].join(", ") },
              { label: "Started", value: a.attempt.startedAt === null ? null : <RelativeTime iso={a.attempt.startedAt} /> },
            ]}
          />
          {hasLive && <LiveOutput runId={runId} attemptId={attemptId} maxHeight="12rem" />}
          {a.transcript !== null && (
            <div className="flex flex-col gap-1.5">
              <Button size="sm" variant="outline" className="self-start" onClick={() => setShowTranscript((v) => !v)} data-testid="show-transcript">
                <FileTextIcon />
                {showTranscript ? "Hide transcript" : "Show transcript"}
                <span className="text-muted-foreground">(diagnostic)</span>
              </Button>
              {showTranscript && (
                <Panel query={transcript} skeleton={<SkeletonLines lines={4} />}>
                  {(t) => (
                    <>
                      <CodeBlock text={t.text} />
                      {t.truncated && (
                        <p className="text-2xs text-muted-foreground">
                          Truncated at {t.text.length} characters of {t.byteSize} bytes. <ArtifactLink artifactId={a.transcript!.id} label="Open the whole transcript" />
                        </p>
                      )}
                    </>
                  )}
                </Panel>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
