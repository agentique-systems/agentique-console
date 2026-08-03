import { useWorkspaces } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { useScopeStore } from "@/stores/scope";

/** Left rail: the session list lands here in M3. */
export function SidebarRegion() {
  const selectedWorkspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const clear = useScopeStore((s) => s.clear);
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find(
    (candidate) => candidate.id === selectedWorkspaceId,
  );

  return (
    <div className="flex min-h-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {workspace?.name ?? "—"}
        </span>
        <Button variant="ghost" size="xs" onClick={clear}>
          switch
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="text-xs text-muted-foreground">sessions</span>
      </div>
    </div>
  );
}
