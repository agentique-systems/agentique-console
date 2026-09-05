import { useMemo } from "react";
import { useNavigate, useParams } from "react-router";

import { useRun } from "@/api/queries";
import { AgentsPanel } from "@/agents/view";
import { Panel } from "@/components/panel";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { DecisionsPanel } from "@/decisions/panel";
import { useHotkeys, type Hotkey } from "@/lib/hotkeys";
import { useIsWide } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { PlanPanel } from "@/plan/panel";
import { PublicationPanel } from "@/publication/panel";
import { RequirementsPanel } from "@/requirements/panel";
import { RunHeader } from "@/run/header";
import { RunNav } from "@/run/nav";
import { OverviewPanel } from "@/run/overview";
import { isRunTab, RUN_TABS, type RunTab } from "@/run/sections";
import { UsagePanel } from "@/run/usage";
import { TaskLedger } from "@/tasks/ledger";
import { VerificationPanel } from "@/verification/panel";

export { RUN_TABS, type RunTab } from "@/run/sections";

/**
 * One Run: its persistent header, its sections (a rail on a wide viewport, a
 * strip above the content elsewhere), and the section's panel. `[` and `]`
 * step between sections.
 */
export function RunView() {
  const { runId = "", tab: rawTab, entityId } = useParams();
  const tab: RunTab = isRunTab(rawTab) ? rawTab : "overview";
  const run = useRun(runId);
  const wide = useIsWide();
  const navigate = useNavigate();
  const hotkeys = useMemo<Hotkey[]>(() => {
    const step = (delta: number) => {
      const index = RUN_TABS.indexOf(tab);
      const next = RUN_TABS[(index + delta + RUN_TABS.length) % RUN_TABS.length]!;
      void navigate(`/runs/${runId}/${next}`);
    };
    return [
      { key: "[", handler: () => step(-1) },
      { key: "]", handler: () => step(1) },
    ];
  }, [tab, runId, navigate]);
  useHotkeys(hotkeys);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
      <Panel query={run} className="p-6" skeleton={<RunSkeleton />}>
        {(overview) => (
          <>
            <RunHeader overview={overview} />
            <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
              <RunNav overview={overview} active={tab} orientation={wide ? "rail" : "strip"} />
              {tab === "plan" ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="panel-plan">
                  <PlanPanel overview={overview} entityId={entityId ?? null} />
                </div>
              ) : (
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid={`panel-${tab}`}>
                  <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
                    {tab === "overview" && <OverviewPanel overview={overview} />}
                    {tab === "requirements" && <RequirementsPanel overview={overview} />}
                    {tab === "tasks" && <TaskLedger runId={runId} />}
                    {tab === "decisions" && <DecisionsPanel overview={overview} />}
                    {tab === "verification" && <VerificationPanel overview={overview} />}
                    {tab === "publish" && <PublicationPanel overview={overview} />}
                    {tab === "usage" && <UsagePanel overview={overview} />}
                    {tab === "agents" && <AgentsPanel workspaceId={overview.workspace.id} />}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>
      <SkeletonLines lines={2} className="max-w-md" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    </div>
  );
}
