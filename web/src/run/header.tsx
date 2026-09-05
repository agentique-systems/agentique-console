import { ArrowLeftIcon, FolderGit2Icon, GitBranchIcon, ExternalLinkIcon } from "lucide-react";
import { Link } from "react-router";
import type { RunOverview } from "@agentique-console/core";

import { IdChip } from "@/components/id-chip";
import { Elapsed, RelativeTime } from "@/components/relative-time";
import { PhaseBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PHASE_LABELS } from "@/lib/format";
import { RunControls } from "@/run/controls";

/** The persistent context of a Run: which Conversation it belongs to, its phase, its bounds, and the controls. */
export function RunHeader({ overview }: { overview: RunOverview }) {
  const { run } = overview;
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-4 py-3 md:px-6" data-testid="run-header">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-x-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon-xs" variant="ghost" className="-ml-1 text-muted-foreground">
                  <Link to={`/conversations/${overview.conversation.id}`} aria-label="Back to the Conversation">
                    <ArrowLeftIcon />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back to the Conversation</TooltipContent>
            </Tooltip>
            <h1 className="min-w-0 truncate text-base font-semibold leading-6">
              <Link to={`/conversations/${overview.conversation.id}`} className="hover:underline">
                {overview.conversation.title ?? "Untitled conversation"}
              </Link>
            </h1>
            <IdChip id={run.id} />
            <PhaseBadge phase={overview.phase} label={PHASE_LABELS[overview.phase]} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{run.kind === "code" ? "Coding Run" : "Run"}</span>
            <span className="flex items-center gap-1" title="The Target the accepted result is published to">
              {run.target.kind === "branch" ? <GitBranchIcon className="size-3" /> : <FolderGit2Icon className="size-3" />}
              <span className="font-mono">{run.target.kind === "branch" ? run.target.branch : "directory"}</span>
            </span>
            <span>
              in <span className="text-foreground">{overview.workspace.name}</span>
            </span>
            <RelativeTime iso={run.createdAt} prefix="started" />
            <span>
              {run.endedAt === null ? "elapsed" : "took"} <Elapsed from={run.createdAt} to={run.endedAt} className="font-mono" />
            </span>
            {overview.deadlineAt !== null && run.endedAt === null && (
              <span title={overview.deadlineAt}>
                deadline <RelativeTime iso={overview.deadlineAt} />
              </span>
            )}
            {run.integrationWorkspacePath !== null && (
              <span className="hidden items-center gap-1 lg:flex" title={run.integrationWorkspacePath}>
                <ExternalLinkIcon className="size-3" />
                <span className="max-w-64 truncate font-mono">{run.integrationWorkspacePath}</span>
              </span>
            )}
          </div>
        </div>
        <RunControls overview={overview} />
      </div>
    </header>
  );
}
