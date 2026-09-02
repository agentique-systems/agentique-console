import { useState } from "react";
import { Folder, Plus } from "lucide-react";
import type { WorkspaceResponse } from "@agentique-console/core";
import { itemsOf, useWorkspaces } from "@/api/queries";
import { LoadMore } from "@/components/paging";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { timeAgo } from "@/lib/format";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceWizard } from "./workspace-wizard";

/** What the console shows before a Workspace is chosen; mounted instead of the shell. */
export function WorkspaceGate() {
  const workspaces = useWorkspaces();
  const [wizardOpen, setWizardOpen] = useState(false);
  const rows = itemsOf(workspaces.data, (row) => row.workspace.id);
  if (workspaces.isPending) {
    return (
      <div className="flex h-screen items-center justify-center" data-testid="app-loading">
        <span className="text-xs text-muted-foreground">Loading…</span>
      </div>
    );
  }
  if (workspaces.isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2" data-testid="app-unreachable">
        <p className="text-sm text-status-failed">The console server is unreachable.</p>
        <p className="text-xs text-muted-foreground">
          Start it with <code>npm run dev</code>. This page retries on its own.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col items-center overflow-y-auto p-4 sm:p-10" data-testid="workspace-gate">
      <div className="w-full max-w-xl">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Folder className="size-8 text-muted-foreground" />
            <h1 className="text-lg font-medium">No Workspaces yet</h1>
            <p className="max-w-sm text-sm text-muted-foreground">A Workspace is a directory on this machine, usually a git repository, that Runs operate on. Add one to get started.</p>
            <Button className="mt-2 gap-2" onClick={() => setWizardOpen(true)}>
              <Plus className="size-4" />
              New Workspace…
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-sm font-medium">Choose a Workspace</h1>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setWizardOpen(true)}>
                <Plus className="size-3.5" />
                New Workspace…
              </Button>
            </div>
            <ScrollArea className="max-h-[60vh]">
              <div className="flex flex-col gap-2">
                {rows.map((row) => (
                  <WorkspaceRow key={row.workspace.id} row={row} />
                ))}
                <LoadMore query={workspaces} label="Load more Workspaces" testId="workspaces-more" />
              </div>
            </ScrollArea>
          </>
        )}
      </div>
      <WorkspaceWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}

function WorkspaceRow({ row }: { row: WorkspaceResponse }) {
  const select = useScopeStore((s) => s.select);
  return (
    <button type="button" onClick={() => select(row.workspace.id)} className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.workspace.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.workspace.rootPath} · {row.workspace.kind === "git" ? "git repository" : "plain directory (no publication)"}
        </span>
      </span>
      <span className="shrink-0 text-3xs text-muted-foreground">{timeAgo(row.workspace.createdAt)}</span>
    </button>
  );
}
