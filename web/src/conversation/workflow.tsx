import { Fragment, type ReactNode } from "react";
import { FinalReportView } from "@/verification/panel";
import { Link } from "react-router";
import type { ConversationMessage, ConversationResponse, RunOverview } from "@agentique-console/core";
import { itemsOf, useConversationRuns, useRun, useRunArtifacts, useRunDecisions, useRunProposals } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Callout } from "@/components/callout";
import { PagedList } from "@/components/paging";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { DecisionCard } from "@/decisions/panel";
import { PublicationPanel } from "@/publication/panel";
import { ProposalReview } from "@/requirements/panel";
import { RunControls } from "@/run/controls";
import { UsagePanel } from "@/run/usage";

/** Every required interaction stays beside the exchange. Execution inspectors remain optional deep links. */
export function ConversationWorkflow({ conversation, messages, children }: { conversation: ConversationResponse; messages: ConversationMessage[]; children: (message: ConversationMessage) => ReactNode }) {
  const runs = useConversationRuns(conversation.conversation.id);
  const work = itemsOf(runs.data, (r) => r.id).filter((r) => r.mode !== "conversation").reverse();
  // Keep each result/interaction at its place in the exchange, including when a later work Run starts.
  const anchors = new Map<string, string | null>();
  for (const run of work) {
    const reply = messages.findLast((message) => message.runId === run.id);
    const request = messages.findLast((message) => message.createdAt <= run.createdAt);
    anchors.set(run.id, reply?.id ?? request?.id ?? null);
  }
  return <>
    {runs.isError && <Callout tone="error">Work updates could not load. <button className="underline" onClick={() => void runs.refetch()}>Retry</button></Callout>}
    {runs.hasNextPage && <Button variant="ghost" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>Earlier work and results</Button>}
    {work.filter((run) => anchors.get(run.id) === null).map((run) => <Work key={run.id} runId={run.id} />)}
    {messages.map((message) => <Fragment key={message.id}>
      {children(message)}
      {work.filter((run) => anchors.get(run.id) === message.id).map((run) => <Work key={run.id} runId={run.id} />)}
    </Fragment>)}
    {conversation.dialogueRun && <DialogueStatus runId={conversation.dialogueRun.id} />}
  </>;
}

function DialogueStatus({ runId }: { runId: string }) {
  const run = useRun(runId);
  if (!run.data) return null;
  if (run.data.run.waitReason === "budget") return <UsagePanel overview={run.data} inline />;
  if (run.data.run.status === "failed") return <Callout tone="error">The Orchestrator could not respond. {run.data.run.failure?.summary}</Callout>;
  const active = (run.data.projection?.inFlight.length ?? 0) > 0 || (run.data.projection?.nextActions.length ?? 0) > 0 || run.data.pendingInputs > 0;
  if (active || run.data.run.operatorPause !== null) return <div className="flex items-center justify-between gap-2"><p role="status" className="text-sm text-muted-foreground">{run.data.run.operatorPause ? "Orchestrator paused" : "Orchestrator is thinking..."}</p><RunControls overview={run.data} inline /></div>;
  return <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Conversation usage and controls</summary><RunControls overview={run.data} inline /><UsagePanel overview={run.data} /></details>;
}

function Work({ runId }: { runId: string }) {
  const run = useRun(runId);
  return <Panel query={run}>{(overview) => <WorkContent overview={overview} />}</Panel>;
}

const phaseText: Record<string, string> = {
  running: "Working on your request", waiting: "Waiting for your input", verifying: "Checking the result",
  awaiting_signoff: "Your result is ready to review", completed: "Result accepted", failed: "Work failed", cancelled: "Work stopped", created: "Preparing your request",
};

function WorkContent({ overview }: { overview: RunOverview }) {
  const { run } = overview;
  const decisions = useRunDecisions(run.id, "open");
  const proposals = useRunProposals(run.id);
  const artifacts = useRunArtifacts(run.id);
  const publish = ["awaiting_signoff", "completed"].includes(run.status);
  return <section className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-4" data-testid="conversation-work" data-work-id={run.id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-sm font-medium">{run.operatorPause ? "Work paused" : phaseText[run.status]}</p>
      <RunControls overview={overview} inline />
    </div>
    {run.failure && <Callout tone="error">{run.failure.summary}</Callout>}
    <PagedList query={proposals} idOf={(p) => p.id} empty={false} more={{ label: "More proposals" }}>{(rows) => <>{rows.filter((p) => p.status === "proposed").map((p) => <ProposalReview key={p.id} proposal={p} overview={overview} inline />)}</>}</PagedList>
    <PagedList query={decisions} idOf={(v) => v.decision.id} empty={false} more={{ label: "More decisions" }}>{(rows) => <>{rows.filter((v) => v.action === "resolve" || v.action === "supersede").map((v) => <DecisionCard key={v.decision.id} view={v} overview={overview} inline />)}</>}</PagedList>
    {(run.waitReason === "budget" || itemsOf(decisions.data, (v) => v.decision.id).some((v) => v.action === "budget_increase")) && <UsagePanel overview={overview} inline />}
    {overview.finalReportArtifactId && <FinalReportView artifactId={overview.finalReportArtifactId} inline />}
    {publish && <PublicationPanel overview={overview} inline />}
    <PagedList query={artifacts} idOf={(a) => a.id} empty={false} more={{ label: "More artifacts" }}>{(rows) => <div className="flex flex-wrap gap-2">{rows.filter((a) => a.producer.kind === "invocation").map((a) => <ArtifactLink key={a.id} artifactId={a.id} label={a.title ?? "View artifact"} />)}</div>}</PagedList>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Inspect execution</summary><div className="pt-2"><Link className="underline" to={`/runs/${run.id}`}>Execution details, audit history and budget</Link></div></details>
  </section>;
}
