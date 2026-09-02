import { TriangleAlert } from "lucide-react";
import { BrowserRouter } from "react-router";

import { useWorkspaces } from "@/api/queries";
import { Shell } from "@/app/shell";
import { Spinner } from "@/components/ui/spinner";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceGate } from "@/workspaces/workspace-gate";

/**
 * The one branch that decides what fills the viewport: the Workspace gate
 * until a Workspace is chosen (re-validated against the list on every load),
 * then the shell scoped to it.
 */
export function App({ router = true }: { router?: boolean }) {
  const workspaces = useWorkspaces();
  const selectedWorkspaceId = useScopeStore((s) => s.selectedWorkspaceId);

  if (workspaces.isPending) {
    return (
      <div className="flex h-screen items-center justify-center" data-testid="app-loading">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (workspaces.isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2" data-testid="app-unreachable">
        <p className="flex items-center gap-1.5 text-sm text-status-failed">
          <TriangleAlert className="size-4" />
          The console server is unreachable.
        </p>
        <p className="text-xs text-muted-foreground">
          Start it with <code>npm run dev</code>. This page retries on its own.
        </p>
      </div>
    );
  }

  const selected = selectedWorkspaceId !== null ? workspaces.data.items.find((w) => w.workspace.id === selectedWorkspaceId) : undefined;
  if (selected === undefined) return <WorkspaceGate />;
  return router ? (
    <BrowserRouter>
      <Shell workspace={selected} />
    </BrowserRouter>
  ) : (
    <Shell workspace={selected} />
  );
}
