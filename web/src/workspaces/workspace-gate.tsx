import { useState } from "react";
import { ChevronRightIcon, FolderGit2Icon, FolderIcon, PlusIcon } from "lucide-react";
import type { WorkspaceResponse } from "@agentique-console/core";

import { itemsOf, useWorkspaces } from "@/api/queries";
import { FullScreenLoading, Unreachable } from "@/app/app";
import { BrandMark, Wordmark } from "@/app/brand";
import { ThemeToggle } from "@/app/theme-toggle";
import { LoadMore } from "@/components/paging";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceWizard } from "./workspace-wizard";

/** What the console shows before a Workspace is chosen; mounted instead of the shell. */
export function WorkspaceGate() {
  const workspaces = useWorkspaces();
  const [wizardOpen, setWizardOpen] = useState(false);
  const rows = itemsOf(workspaces.data, (row) => row.workspace.id);
  if (workspaces.isPending) return <FullScreenLoading />;
  if (workspaces.isError) return <Unreachable />;
  return (
    <div className="flex h-screen flex-col overflow-y-auto" data-testid="workspace-gate">
      <header className="flex h-12 shrink-0 items-center justify-between px-4 sm:px-6">
        <span className="flex items-center gap-2">
          <BrandMark />
          <Wordmark />
        </span>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 flex-col items-center px-4 py-8 sm:py-14">
        <div className="w-full max-w-xl">
          {rows.length === 0 ? (
            <div className="surface-raised flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-14 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
                <FolderGit2Icon className="size-6" />
              </span>
              <h1 className="text-lg font-semibold">Add your first Workspace</h1>
              <p className="max-w-sm text-sm text-muted-foreground">A Workspace is a directory on this machine, usually a git repository, that Runs operate on. Nothing in it changes until you sign a result off and publish it.</p>
              <Button className="mt-2" onClick={() => setWizardOpen(true)}>
                <PlusIcon />
                New Workspace
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <h1 className="text-lg font-semibold">Choose a Workspace</h1>
                  <p className="text-sm text-muted-foreground">The console shows one Workspace at a time; switch any time from the sidebar.</p>
                </div>
                <Button variant="outline" onClick={() => setWizardOpen(true)}>
                  <PlusIcon />
                  New Workspace
                </Button>
              </div>
              <div className="surface-raised flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                {rows.map((row, i) => (
                  <WorkspaceRow key={row.workspace.id} row={row} first={i === 0} />
                ))}
              </div>
              <LoadMore query={workspaces} label="Load more Workspaces" testId="workspaces-more" className="flex justify-center pt-3" />
            </>
          )}
        </div>
      </div>
      <WorkspaceWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}

function WorkspaceRow({ row, first }: { row: WorkspaceResponse; first: boolean }) {
  const select = useScopeStore((s) => s.select);
  const KindIcon = row.workspace.kind === "git" ? FolderGit2Icon : FolderIcon;
  return (
    <button type="button" onClick={() => select(row.workspace.id)} className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none ${first ? "" : "border-t border-border-subtle"}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <KindIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.workspace.name}</span>
        <span className="block truncate font-mono text-2xs text-muted-foreground" title={row.workspace.rootPath}>
          {row.workspace.rootPath}
        </span>
      </span>
      <span className="hidden shrink-0 text-2xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
        <span>{row.workspace.kind === "git" ? "git repository" : "plain directory"}</span>
        <RelativeTime iso={row.workspace.createdAt} prefix="added" />
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}
