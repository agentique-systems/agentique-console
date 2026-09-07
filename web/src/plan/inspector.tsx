import { ArrowRightIcon } from "lucide-react";
import { Link } from "react-router";
import type { Gate, PlanNodeResponse } from "@agentique-console/core";

import { usePlanNode } from "@/api/queries";
import { IdChip } from "@/components/id-chip";
import { KeyValue } from "@/components/key-value";
import { MeterRow } from "@/components/meter";
import { Panel, Section } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { count, tokens, usage, usd, words } from "@/lib/format";

/** One Plan Node: its state and bounds, then its Invocations, Gates, and Tasks, each one click deeper. */
export function NodeInspector({ planNodeId, runId }: { planNodeId: string; runId: string }) {
  const node = usePlanNode(planNodeId);
  return (
    <Panel
      query={node}
      skeleton={
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-48" />
          <SkeletonLines lines={4} />
        </div>
      }
    >
      {(n) => <NodeDetails n={n} runId={runId} />}
    </Panel>
  );
}

function NodeDetails({ n, runId }: { n: PlanNodeResponse; runId: string }) {
  const node = n.node;
  const title = node.kind === "pattern" ? node.title : "join";
  return (
    <div className="flex flex-col gap-4" data-testid="node-inspector">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <StatusBadge status={node.status} variant="pill" />
          {node.waitReason !== null && <span className="text-xs text-status-waiting">waiting on {words(node.waitReason)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{node.kind === "pattern" ? `${words(node.pattern)} pattern` : `join (${words(node.fanInPolicy)})`}</span>
          <span className="font-mono" title="Position in the plan source">
            {node.sourcePath}
          </span>
          <IdChip id={node.id} />
          <span>revision {node.createdInRevisionNumber}</span>
        </div>
      </header>

      {n.allocation !== null && (
        <Section title="Allocation" description="What this node may spend on its Invocations, and what it has.">
          <MeterRow label="Cost" used={n.allocation.account.consumed.costUsd} limit={n.allocation.effective.costUsd} format={usd} />
          <MeterRow label="Tokens" used={n.allocation.account.consumed.tokens} limit={n.allocation.effective.tokens} format={tokens} />
          <MeterRow label="Attempts" used={n.allocation.account.consumed.attempts} limit={n.allocation.effective.attempts} format={String} hint={n.extensionCount > 0 ? `${count(n.extensionCount, "Allocation Extension")} raised the original allocation.` : undefined} />
        </Section>
      )}

      <KeyValue
        dense
        columns={2}
        items={[
          { label: "Usage", value: usage(n.usage), mono: true },
          { label: "Started", value: node.startedAt === null ? null : <RelativeTime iso={node.startedAt} /> },
          { label: "Ended", value: node.endedAt === null ? null : <RelativeTime iso={node.endedAt} /> },
          { label: "Outputs", value: node.outputArtifactIds === null ? null : count(node.outputArtifactIds.length, "Artifact") },
          ...(node.kind === "pattern" ? [{ label: "On allocation exhausted", value: words(String(node.onAllocationExhausted)) }, { label: "Concurrency", value: node.maxConcurrency === null ? "unbounded" : String(node.maxConcurrency) }] : []),
        ]}
      />

      <Section
        title={`Invocations (${n.invocationCount})`}
        description={n.invocationCount > n.invocations.length ? `The ${n.invocations.length} most recent of ${n.invocationCount}.` : undefined}
        testId={n.invocationCount > n.invocations.length ? "invocations-windowed" : undefined}
      >
        {n.invocations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No Invocation yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {n.invocations.map((i) => (
              <li key={i.id}>
                <Link to={`/runs/${runId}/plan/${i.id}`} className="group flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-accent/60" data-invocation={i.id}>
                  <StatusBadge status={i.status} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{i.role}</span> <span className="text-muted-foreground">· {words(i.purpose)}</span>
                  </span>
                  {i.result !== null && <span className="hidden truncate text-2xs text-muted-foreground sm:inline">{i.result.status}</span>}
                  <span className="font-mono text-2xs text-muted-foreground">{i.id.slice(0, 12)}</span>
                  <ArrowRightIcon className="size-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(n.gates.length > 0 || n.gateCount > 0) && (
        <Section title={`Gates (${n.gateCount})`} description={n.gateCount > n.gates.length ? `The ${n.gates.length} most recent.` : undefined}>
          <ul className="flex flex-col gap-1">
            {n.gates.map((gate: Gate) => (
              <li key={gate.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <StatusBadge status={gate.status} />
                <span>
                  {words(gate.kind)} #{gate.ordinal}
                </span>
                <span className="text-2xs text-muted-foreground">{count(gate.acceptanceCriterionIds.length, "criterion", "criteria")}</span>
                {gate.failure !== null && <span className="text-2xs text-status-failed">{words(gate.failure.kind)}</span>}
                <Link to={`/runs/${runId}/verification`} className="ml-auto text-2xs text-muted-foreground underline decoration-dotted hover:text-foreground">
                  Verification
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {n.taskCount > 0 && (
        <Section title={`Tasks (${n.taskCount})`}>
          <ul className="flex flex-col gap-1">
            {n.tasks.map((task) => (
              <li key={task.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <StatusBadge status={task.status} />
                <span className="min-w-0 flex-1 truncate">{task.subject}</span>
                <span className="text-2xs text-muted-foreground">{task.origin}</span>
              </li>
            ))}
          </ul>
          <Button asChild size="xs" variant="ghost" className="self-start text-muted-foreground">
            <Link to={`/runs/${runId}/tasks`}>
              All Tasks
              <ArrowRightIcon />
            </Link>
          </Button>
        </Section>
      )}

      {n.evaluationCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {count(n.evaluationCount, "Evaluation")} recorded for this node; see{" "}
          <Link to={`/runs/${runId}/verification`} className="underline decoration-dotted hover:text-foreground">
            Verification
          </Link>
          .
        </p>
      )}
    </div>
  );
}

