import { TriangleAlertIcon } from "lucide-react";
import { BrowserRouter } from "react-router";

import { ApiError } from "@/api/client";
import { useWorkspace } from "@/api/queries";
import { BrandMark } from "@/app/brand";
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

  if (selected.isPending) return <FullScreenLoading />;

  if (selected.isError) {
    // A Workspace that no longer exists sends the operator back to the gate; anything else is the server being unreachable.
    if (selected.error instanceof ApiError && selected.error.status === 404) {
      clear();
      return <WorkspaceGate />;
    }
    return <Unreachable />;
  }

  return router ? (
    <BrowserRouter>
      <Shell workspace={selected.data} />
    </BrowserRouter>
  ) : (
    <Shell workspace={selected.data} />
  );
}

export function FullScreenLoading() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4" data-testid="app-loading">
      <BrandMark className="size-9 rounded-lg" />
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  );
}

export function Unreachable() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center" data-testid="app-unreachable">
      <span className="flex size-10 items-center justify-center rounded-lg border border-status-failed/40 bg-status-failed/10 text-status-failed">
        <TriangleAlertIcon className="size-5" />
      </span>
      <p className="text-sm font-medium">The console server is unreachable.</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Start it with <code className="rounded-sm bg-muted px-1 py-0.5 font-mono">npm run dev</code>. This page retries on its own.
      </p>
    </div>
  );
}
