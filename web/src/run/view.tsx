import { Link, useNavigate, useParams } from "react-router";
import type { RunOverview } from "@agentique-console/core";
import { useRun } from "@/api/queries";
import { AgentsPanel } from "@/agents/view";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { DecisionsPanel } from "@/decisions/panel";
import { PHASE_LABELS, phaseTone, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PlanPanel } from "@/plan/panel";
import { PublicationPanel } from "@/publication/panel";
import { RequirementsPanel } from "@/requirements/panel";
import { RunControls } from "@/run/controls";
import { OverviewPanel } from "@/run/overview";
import { UsagePanel } from "@/run/usage";
import { TaskLedger } from "@/tasks/ledger";
import { VerificationPanel } from "@/verification/panel";

export const RUN_TABS = ["overview", "requirements", "plan", "tasks", "decisions", "verification", "publish", "usage", "agents"] as const;
export type RunTab = (typeof RUN_TABS)[number];

const TAB_LABELS: Record<RunTab, string> = { overview: "Overview", requirements: "Requirements", plan: "Plan", tasks: "Tasks", decisions: "Decisions", verification: "Verification", publish: "Signoff & publish", usage: "Budget & usage", agents: "Agents" };

export function RunView() {
  const { runId = "", tab: rawTab, entityId } = useParams();
  const tab: RunTab = (RUN_TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as RunTab) : "overview";
  const run = useRun(runId);
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
      <Panel query={run}>
        {(overview) => (
          <>
            <RunHeader overview={overview} />
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3" aria-label="Run sections" role="tablist">
              {RUN_TABS.map((t) => (
                <button key={t} role="tab" aria-selected={t === tab} className={cn("border-b-2 border-transparent px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground", t === tab && "border-primary text-foreground")} onClick={() => void navigate(`/runs/${runId}/${t}`)} data-testid={`tab-${t}`}>
                  {TAB_LABELS[t]}
                  {t === "decisions" && overview.openDecisions.length > 0 && <span className="ml-1 rounded-full bg-status-waiting/20 px-1.5 text-3xs text-status-waiting">{overview.openDecisions.length}</span>}
                  {t === "requirements" && overview.openProposal !== null && <span className="ml-1 rounded-full bg-status-waiting/20 px-1.5 text-3xs text-status-waiting">1</span>}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid={`panel-${tab}`}>
              {tab === "overview" && <OverviewPanel overview={overview} />}
              {tab === "requirements" && <RequirementsPanel overview={overview} />}
              {tab === "plan" && <PlanPanel overview={overview} entityId={entityId ?? null} />}
              {tab === "tasks" && <TaskLedger runId={runId} />}
              {tab === "decisions" && <DecisionsPanel overview={overview} />}
              {tab === "verification" && <VerificationPanel overview={overview} />}
              {tab === "publish" && <PublicationPanel overview={overview} />}
              {tab === "usage" && <UsagePanel overview={overview} />}
              {tab === "agents" && <AgentsPanel workspaceId={overview.workspace.id} />}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function RunHeader({ overview }: { overview: RunOverview }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2" data-testid="run-header">
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2 text-sm">
          <Link to={`/conversations/${overview.conversation.id}`} className="truncate font-medium hover:underline">
            {overview.conversation.title ?? "Untitled conversation"}
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-mono text-2xs text-muted-foreground">{shortId(overview.run.id)}</span>
        </div>
        <div className="flex items-center gap-2 text-3xs text-muted-foreground">
          <span>{overview.run.kind} Run</span>
          <span>·</span>
          <span>target {overview.run.target.kind === "branch" ? overview.run.target.branch : "directory"}</span>
          <span>·</span>
          <span>{overview.workspace.name}</span>
        </div>
      </div>
      <StatusBadge status={overview.phase} tone={phaseTone(overview.phase)} label={PHASE_LABELS[overview.phase]} className="text-xs" />
      <span className="flex-1" />
      <RunControls overview={overview} />
    </header>
  );
}
