import { TriangleAlert } from "lucide-react";
import { BrowserRouter } from "react-router";

import { ApiError } from "@/api/client";
import { useWorkspace } from "@/api/queries";
import { Shell } from "@/app/shell";
import { Spinner } from "@/components/ui/spinner";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceGate } from "@/workspaces/workspace-gate";

/**
 * The one branch that decides what fills the viewport: the Workspace gate
 * until a Workspace is chosen (re-validated by a point read on every load,
 * so a Workspace beyond the first page of the list is as valid as any),
 * then the shell scoped to it.
 */
export function App({ router = true }: { router?: boolean }) {
  const selectedWorkspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const clear = useScopeStore((s) => s.clear);
  const selected = useWorkspace(selectedWorkspaceId);

  if (selectedWorkspaceId === null) return <WorkspaceGate />;

  if (selected.isPending) {
    return (
      <div className="flex h-screen items-center justify-center" data-testid="app-loading">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (selected.isError) {
    // A Workspace that no longer exists sends the operator back to the gate; anything else is the server being unreachable.
    if (selected.error instanceof ApiError && selected.error.status === 404) {
      clear();
      return <WorkspaceGate />;
    }
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

  return router ? (
    <BrowserRouter>
      <Shell workspace={selected.data} />
    </BrowserRouter>
  ) : (
    <Shell workspace={selected.data} />
  );
}
