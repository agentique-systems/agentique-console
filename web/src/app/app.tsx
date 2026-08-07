import { TriangleAlert } from "lucide-react";
import { BrowserRouter } from "react-router";

import { useWorkspaces } from "@/api/queries";
import { Shell } from "@/app/shell";
import { Spinner } from "@/components/ui/spinner";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceGate } from "@/workspaces/workspace-gate";

/**
 * The one branch that decides what fills the viewport. The gate renders
 * INSTEAD of the shell, never over it — a shell that mounts against a scope
 * about to be replaced would mint junk cache entries for a workspace the
 * operator never chose.
 */
export function App() {
  const workspaces = useWorkspaces();
  const selectedWorkspaceId = useScopeStore((s) => s.selectedWorkspaceId);

  if (workspaces.isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (workspaces.isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="flex items-center gap-1.5 text-sm text-status-failed">
          <TriangleAlert className="size-4" />
          The console server is unreachable.
        </p>
        <p className="text-xs text-muted-foreground">
          Start it with <code>npm run dev</code> — this page retries on its
          own.
        </p>
      </div>
    );
  }

  // A persisted id whose workspace was deleted elsewhere must not wedge the
  // shell: re-validate against the list on every load.
  const selected =
    selectedWorkspaceId !== null
      ? workspaces.data.find((w) => w.id === selectedWorkspaceId)
      : undefined;

  if (selected === undefined) return <WorkspaceGate />;
  return <BrowserRouter><Shell /></BrowserRouter>;
}
