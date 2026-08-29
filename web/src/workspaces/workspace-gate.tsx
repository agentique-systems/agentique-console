import { useState } from "react";
import { Command, Folder, GitBranch, Plus, Sparkles } from "lucide-react";

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
    <div className="console-grid flex h-screen flex-col items-center overflow-y-auto bg-background p-6 sm:p-10">
      <div className="w-full max-w-3xl">
        <div className="mb-10 flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Command className="size-5" /></div><div><div className="font-semibold tracking-tight">Agentique Console</div><div className="text-2xs text-muted-foreground">Multi-agent operations, without the black box</div></div></div>
        {rows.length === 0 ? (
          <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Folder className="size-5" /></div>
            <span className="sr-only">No workspaces yet</span><h1 className="mt-5 text-balance text-2xl font-semibold tracking-tight">Connect your first workspace</h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">Choose a local project directory. Agentique keeps plans, agent activity, tasks, and approvals organized around that codebase.</p>
            <Button className="mt-6 gap-2" onClick={() => setWizardOpen(true)}><Plus className="size-4" />New workspace</Button>
            <div className="mt-8 grid gap-3 border-t pt-6 sm:grid-cols-2">
              <div className="flex gap-3 rounded-lg bg-muted p-3"><GitBranch className="mt-0.5 size-4 text-primary" /><div><div className="text-xs font-medium">Project-aware sessions</div><div className="mt-1 text-2xs leading-relaxed text-muted-foreground">Every run stays scoped to its repository and history.</div></div></div>
              <div className="flex gap-3 rounded-lg bg-muted p-3"><Sparkles className="mt-0.5 size-4 text-primary" /><div><div className="text-xs font-medium">Observable delegation</div><div className="mt-1 text-2xs leading-relaxed text-muted-foreground">See who is working, why, and what needs your input.</div></div></div>
            </div>
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
