import { useState } from "react";
import { Folder, Plus } from "lucide-react";

import { useWorkspaces } from "@/api/queries";
import type { Workspace } from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { timeAgo } from "@/lib/status";
import { useScopeStore } from "@/stores/scope";

import { WorkspaceWizard } from "./workspace-wizard";

/**
 * What the console shows before a workspace is chosen. Full-screen and
 * mounted INSTEAD of the shell, never over it — App only renders this once
 * the workspace list has loaded, so there is nothing to spin on here.
 */
export function WorkspaceGate() {
  const workspaces = useWorkspaces();
  const [wizardOpen, setWizardOpen] = useState(false);

  const rows = [...(workspaces.data ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div className="flex h-screen flex-col items-center overflow-y-auto p-10">
      <div className="w-full max-w-xl">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Folder className="size-8 text-muted-foreground" />
            <h1 className="text-lg font-medium">No workspaces yet</h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              A workspace is a directory on this machine where sessions do
              their work. Create one to get started.
            </p>
            <Button className="mt-2 gap-2" onClick={() => setWizardOpen(true)}>
              <Plus className="size-4" />
              New workspace…
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-sm font-medium">Choose a workspace</h1>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setWizardOpen(true)}
              >
                <Plus className="size-3.5" />
                New workspace…
              </Button>
            </div>
            <ScrollArea className="max-h-[60vh]">
              <div className="flex flex-col gap-2">
                {rows.map((workspace) => (
                  <WorkspaceRow key={workspace.id} workspace={workspace} />
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </div>
      <WorkspaceWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const select = useScopeStore((s) => s.select);
  return (
    <button
      type="button"
      onClick={() => select(workspace.id)}
      className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-muted/40"
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {workspace.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {workspace.rootPath}
        </span>
      </span>
      <span className="shrink-0 text-3xs text-muted-foreground">
        {timeAgo(workspace.createdAt)}
      </span>
    </button>
  );
}
